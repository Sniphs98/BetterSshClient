import { shell, type IpcMain } from 'electron';

import { loadRemoteDesktopConnections } from '../core/config/remoteDesktop.js';
import { launchRdp } from '../core/rdp/launch.js';
import { getSecretCipher } from '../core/config/secretCipher.js';
import { decryptSecret } from '../core/config/secretField.js';
import { toCommandError } from '../dto.js';

/** `rdp_launch`: fire-and-forget, mirroring `keysetup.ts`'s shape — the native client
 *  is a separate OS window, not something this app tracks or streams progress from. */
export function registerRdpIpc(ipcMain: IpcMain): void {
  ipcMain.handle('rdp_launch', async (_event, connectionId: string) => {
    let connection;
    try {
      const connections = await loadRemoteDesktopConnections();
      connection = connections.find((c) => c.id === connectionId);
      if (!connection) throw new Error(`unknown remote desktop connection '${connectionId}'`);
      if (connection.protocol !== 'rdp') throw new Error(`connection '${connection.name}' is not an RDP connection`);
    } catch (err) {
      throw toCommandError(err);
    }

    const password = decryptSecret(connection.password, getSecretCipher());
    void launchRdp({ ...connection, password })
      .then((result) => {
        // Only the fallback path needs Electron's `shell` (an OS-native handler for
        // the .rdp file) — `core/rdp/launch.ts` stays Electron-free by leaving this
        // one step to the caller instead of doing it itself.
        if (result.opened === 'file' && result.filePath) void shell.openPath(result.filePath);
      })
      .catch(() => {
        // Best-effort fire-and-forget: nothing left to report back to a caller that
        // already got its response.
      });
  });
}
