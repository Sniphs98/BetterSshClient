import { shell, type IpcMain } from 'electron';

import { loadRemoteDesktopConnections } from '../core/config/remoteDesktop.js';
import { launchRdp, pendingCredentialHosts, type RdpLaunchResult } from '../core/rdp/launch.js';
import { removeCredentialsOnQuit, sweepStagedCredentials } from '../core/rdp/windowsCredentials.js';
import { toCommandError, type RdpLaunchResultDto } from '../dto.js';

/** What the user should know about a launch that went through, if anything. */
export function launchNotice(result: Pick<RdpLaunchResult, 'credential'>): string | undefined {
  if (result.credential === 'kept-existing') {
    return 'Windows already has a saved password for this host, so Remote Desktop uses that one instead of the one stored here.';
  }
  return undefined;
}

/** `rdp_launch`: resolves once the native client is running (a separate OS window this
 *  app doesn't track further) and rejects if it couldn't be started. */
export function registerRdpIpc(ipcMain: IpcMain): void {
  ipcMain.handle('rdp_launch', async (_event, connectionId: string): Promise<RdpLaunchResultDto> => {
    try {
      const connections = await loadRemoteDesktopConnections();
      const connection = connections.find((c) => c.id === connectionId);
      if (!connection) throw new Error(`unknown remote desktop connection '${connectionId}'`);
      if (connection.protocol !== 'rdp') throw new Error(`connection '${connection.name}' is not an RDP connection`);

      const result = await launchRdp(connection);
      if (result.opened === 'file' && result.filePath) {
        // Only the fallback path needs Electron's `shell` (an OS-native handler for
        // the .rdp file) — `core/rdp/launch.ts` stays Electron-free by leaving this
        // one step to the caller instead of doing it itself.
        const failure = await shell.openPath(result.filePath);
        if (failure) throw new Error(`No app could open the .rdp file: ${failure}`);
      }
      return { notice: launchNotice(result) };
    } catch (err) {
      throw toCommandError(err);
    }
  });

  // A launch staged a password but the app died before taking it out again.
  void sweepStagedCredentials().catch(() => {});
}

/** For `before-quit`: takes out the passwords of launches still starting up. */
export function cleanUpRdpOnQuit(): void {
  if (process.platform === 'win32' && pendingCredentialHosts.size > 0) {
    removeCredentialsOnQuit(pendingCredentialHosts);
    pendingCredentialHosts.clear();
  }
}
