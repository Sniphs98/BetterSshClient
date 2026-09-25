import { clipboard, shell, type IpcMain } from 'electron';

import { loadRemoteDesktopConnections, type RemoteDesktopConnection } from '../core/config/remoteDesktop.js';
import { launchRdp, pendingCredentialHosts, type RdpLaunchResult } from '../core/rdp/launch.js';
import { openTunnel, tunnelAddress, type RdpTunnel } from '../core/rdp/tunnel.js';
import { removeCredentialsOnQuit, sweepStagedCredentials } from '../core/rdp/windowsCredentials.js';
import { SshSession } from '../core/ssh/session.js';
import { toCommandError, type RdpLaunchResultDto } from '../dto.js';
import type { GuiState } from '../state/guiState.js';

/** How long a password handed over on the clipboard stays there. */
export const CLIPBOARD_CLEAR_MS = 45_000;

type TextClipboard = Pick<typeof clipboard, 'writeText' | 'readText' | 'clear'>;

/** For a `.rdp` file opened by whatever app handles it (macOS's Windows App, say),
 *  which can't be given a password: puts it on the clipboard to paste at the prompt,
 *  and takes it off again after `CLIPBOARD_CLEAR_MS` — unless something else has been
 *  copied since, which is left alone. */
export function offerPasswordOnClipboard(password: string, board: TextClipboard = clipboard): void {
  board.writeText(password);
  const timer = setTimeout(() => {
    if (board.readText() === password) board.clear();
  }, CLIPBOARD_CLEAR_MS);
  timer.unref?.();
}

/** What the user should know about a launch that went through, if anything. */
export function launchNotice(result: Pick<RdpLaunchResult, 'credential' | 'opened'>, passwordOnClipboard = false): string | undefined {
  if (result.credential === 'kept-existing') {
    return 'Windows already has a saved password for this host, so Remote Desktop uses that one instead of the one stored here.';
  }
  if (passwordOnClipboard) {
    return `The password is on the clipboard for ${CLIPBOARD_CLEAR_MS / 1000} seconds — paste it when Remote Desktop asks for it. Installing FreeRDP lets the app sign in for you.`;
  }
  return undefined;
}

/** Tunnels still open, for `before-quit`. */
const openTunnels = new Set<RdpTunnel>();

/** For a profile with `viaHost`: a tunnel through that SSH host (over a connection of
 *  its own, so a busy desktop doesn't slow down terminals on the same host). */
async function tunnelFor(state: GuiState, connection: RemoteDesktopConnection): Promise<RdpTunnel | undefined> {
  if (!connection.viaHost) return undefined;
  const host = state.hostByName(connection.viaHost);
  if (!host) throw new Error(`SSH host '${connection.viaHost}' to tunnel through no longer exists`);
  let session: SshSession;
  try {
    session = await SshSession.connect(host);
  } catch (err) {
    throw new Error(`Could not connect to SSH host '${host.name}' for the tunnel: ${(err as Error).message}`);
  }
  const tunnel = await openTunnel(session, { host: connection.hostname, port: connection.port }, tunnelAddress(connection.id));
  openTunnels.add(tunnel);
  void tunnel.closed.then(() => openTunnels.delete(tunnel));
  return tunnel;
}

/** `rdp_launch`: resolves once the native client is running (a separate OS window this
 *  app doesn't track further) and rejects if it couldn't be started. */
export function registerRdpIpc(ipcMain: IpcMain, state: GuiState): void {
  ipcMain.handle('rdp_launch', async (_event, connectionId: string): Promise<RdpLaunchResultDto> => {
    try {
      const connections = await loadRemoteDesktopConnections();
      const connection = connections.find((c) => c.id === connectionId);
      if (!connection) throw new Error(`unknown remote desktop connection '${connectionId}'`);
      if (connection.protocol !== 'rdp') throw new Error(`connection '${connection.name}' is not an RDP connection`);

      const tunnel = await tunnelFor(state, connection);
      try {
        const target = tunnel ? { ...connection, hostname: tunnel.address, port: tunnel.port } : connection;
        const result = await launchRdp(target);
        if (result.opened === 'file' && result.filePath) {
          // Only the fallback path needs Electron's `shell` (an OS-native handler for
          // the .rdp file) — `core/rdp/launch.ts` stays Electron-free by leaving this
          // one step to the caller instead of doing it itself.
          const failure = await shell.openPath(result.filePath);
          if (failure) {
            throw new Error(
              `No app could open the .rdp file (${failure}). Install FreeRDP, or on macOS Microsoft's "Windows App".`
            );
          }
          if (connection.password) offerPasswordOnClipboard(connection.password);
        }
        // With a client to watch, the tunnel goes with it; otherwise it closes once idle.
        if (tunnel) result.child?.once('exit', () => tunnel.close());
        return { notice: launchNotice(result, result.opened === 'file' && Boolean(connection.password)) };
      } catch (err) {
        tunnel?.close();
        throw err;
      }
    } catch (err) {
      throw toCommandError(err);
    }
  });

  // A launch staged a password but the app died before taking it out again.
  void sweepStagedCredentials().catch(() => {});
}

/** For `before-quit`: takes out the passwords of launches still starting up. */
export function cleanUpRdpOnQuit(): void {
  for (const tunnel of openTunnels) tunnel.close();
  if (process.platform === 'win32' && pendingCredentialHosts.size > 0) {
    removeCredentialsOnQuit(pendingCredentialHosts);
    pendingCredentialHosts.clear();
  }
}
