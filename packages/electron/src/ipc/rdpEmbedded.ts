import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { app, BrowserWindow, dialog, shell, type IpcMain } from 'electron';

import { loadRemoteDesktopConnections, type RemoteDesktopConnection } from '../core/config/remoteDesktop.js';
import { RdpGateway } from '../core/rdp/gateway.js';
import { checkCertificate, forgetCertificate } from '../core/rdp/knownCerts.js';
import { resolveConnection } from '../core/rdp/password.js';
import { saveReceivedFile } from '../core/rdp/savedFiles.js';
import { SshSession } from '../core/ssh/session.js';
import { toCommandError, type RdpCredentialsDto, type RdpEmbeddedOpenDto, type RdpEmbeddedStatusDto } from '../dto.js';
import type { GuiState } from '../state/guiState.js';

/**
 * Remote desktop inside the app: the renderer runs IronRDP's web client, which
 * connects through `RdpGateway` on 127.0.0.1. `rdp_embedded_open` registers the
 * session and hands the client what it needs — including the password, which the
 * client needs for CredSSP (NLA) itself. The external client (`rdp_launch`) stays
 * the fallback.
 */

const gateway = new RdpGateway();

interface OpenSession {
  ssh?: SshSession;
  /** What happened during the handshake that the user should hear about. */
  notice?: string;
}
const open = new Map<string, OpenSession>();
/** Folders the user chose in `rdp_pick_save_folder` — the only ones `rdp_save_file` writes to. */
const pickedFolders = new Set<string>();

function openTcp(host: string, port: number): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    socket.setNoDelay(true);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

export function registerRdpEmbeddedIpc(ipcMain: IpcMain, state: GuiState): void {
  ipcMain.handle(
    'rdp_embedded_open',
    async (_event, connectionId: string, typed?: RdpCredentialsDto): Promise<RdpEmbeddedOpenDto> => {
    try {
      const saved = (await loadRemoteDesktopConnections()).find((c) => c.id === connectionId);
      if (!saved) throw new Error(`unknown remote desktop connection '${connectionId}'`);
      if (saved.protocol !== 'rdp') throw new Error(`connection '${saved.name}' is not an RDP connection`);
      // Address, user and password from 1Password where the profile says so.
      const connection = await resolveConnection(saved);
      // A profile without a stored password (or user) asks in the tab; what's typed
      // there is used for this connection only, and wins over the profile's.
      const username = typed?.username || connection.username;
      const password = typed?.password || connection.password;
      const domain = typed ? typed.domain || undefined : connection.domain;
      if (!username || !password) {
        return { kind: 'credentials', username: connection.username, domain: connection.domain };
      }

      const session: OpenSession = {};
      let ssh: SshSession | undefined;
      if (connection.viaHost) {
        const host = state.hostByName(connection.viaHost);
        if (!host) throw new Error(`SSH host '${connection.viaHost}' to tunnel through no longer exists`);
        try {
          ssh = await SshSession.connect(host);
        } catch (err) {
          throw new Error(`Could not connect to SSH host '${host.name}' for the tunnel: ${(err as Error).message}`);
        }
        session.ssh = ssh;
      }

      // Keyed by the saved address, so a 1Password reference keeps its certificate.
      const certKey = certificateKey(saved);
      const token = gateway.register({
        host: connection.hostname,
        port: connection.port,
        open: () => (ssh ? ssh.forward(connection.hostname, connection.port) : openTcp(connection.hostname, connection.port)),
        async verifyCertificate(chain) {
          if (chain.length === 0) throw new Error('the RDP server presented no certificate');
          const check = await checkCertificate(certKey, chain[0]);
          if (check.status === 'changed') {
            throw new Error(
              `The server's certificate has changed since the last connection (it was ${check.expected.slice(0, 23)}…, ` +
                `now ${check.fingerprint.slice(0, 23)}…). That can mean someone is in between. If you expect the change ` +
                `(the server was reinstalled, say), choose "Trust new certificate" and connect again.`
            );
          }
          if (check.status === 'new') {
            session.notice = `First connection: remembered the server's certificate (SHA-256 ${check.fingerprint.slice(0, 23)}…).`;
          }
        }
      });
      open.set(token, session);

      return {
        kind: 'ready',
        token,
        proxyUrl: await gateway.url(),
        // What the client puts in its request; the gateway ignores it for the registered target.
        destination: `${connection.hostname}:${connection.port}`,
        username,
        password,
        domain
      };
    } catch (err) {
      throw toCommandError(err);
    }
    }
  );

  ipcMain.handle('rdp_embedded_status', (_event, token: string): RdpEmbeddedStatusDto => ({
    failure: gateway.failure(token),
    notice: open.get(token)?.notice
  }));

  ipcMain.handle('rdp_embedded_close', (_event, token: string) => {
    closeSession(token);
  });

  // Files copied on the remote desktop, saved here: only into a folder the user picked
  // in this dialog, so a renderer can't write anywhere else.
  ipcMain.handle('rdp_pick_save_folder', async (event): Promise<string | null> => {
    const window = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const options = {
      title: 'Save files from the remote desktop',
      defaultPath: defaultSaveFolder(),
      properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>
    };
    const { canceled, filePaths } = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (canceled || !filePaths[0]) return null;
    pickedFolders.add(filePaths[0]);
    return filePaths[0];
  });

  ipcMain.handle(
    'rdp_save_file',
    async (_event, folder: string, relativePath: string | undefined, name: string, bytes: Uint8Array): Promise<string> => {
      try {
        if (!pickedFolders.has(folder)) throw new Error('not a folder chosen for saving');
        return await saveReceivedFile(folder, relativePath, name, bytes);
      } catch (err) {
        throw toCommandError(err);
      }
    }
  );

  ipcMain.handle('rdp_show_saved', (_event, path: string) => {
    if ([...pickedFolders].some((f) => path.startsWith(f))) shell.showItemInFolder(path);
  });

  ipcMain.handle('rdp_forget_certificate', async (_event, connectionId: string) => {
    try {
      const connection = (await loadRemoteDesktopConnections()).find((c) => c.id === connectionId);
      if (!connection) throw new Error(`unknown remote desktop connection '${connectionId}'`);
      await forgetCertificate(certificateKey(connection));
    } catch (err) {
      throw toCommandError(err);
    }
  });
}

/** Where a profile's certificate is remembered: its target as the SSH host (if any)
 *  sees it, as saved. */
function certificateKey(connection: RemoteDesktopConnection): string {
  return `${connection.viaHost ? `${connection.viaHost}>` : ''}${connection.hostname}:${connection.portRef ?? connection.port}`;
}

function closeSession(token: string): void {
  gateway.revoke(token);
  open.get(token)?.ssh?.disconnect();
  open.delete(token);
}

/** Downloads, or the home folder where there is none (Electron throws then). */
function defaultSaveFolder(): string {
  try {
    return app.getPath('downloads');
  } catch {
    return app.getPath('home');
  }
}

/** For `before-quit`. */
export function closeEmbeddedRdp(): void {
  for (const token of [...open.keys()]) closeSession(token);
  gateway.close();
}
