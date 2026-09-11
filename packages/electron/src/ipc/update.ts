import { app, type IpcMain } from 'electron';

import { loadAppConfig, saveUpdateConfig as persistUpdateConfig, type UpdateConfig } from '../core/config/appConfig.js';
import { checkUpdate as checkForUpdate } from '../core/update.js';
import { toCommandError } from '../dto.js';

/**
 * Update-checker commands. Ported from
 * crates/omnyssh-gui/src/commands/update.rs, minus self-update (see
 * `core/update.ts`'s doc comment).
 */
export function registerUpdateIpc(ipcMain: IpcMain): void {
  ipcMain.handle('check_update', async () => {
    try {
      return await checkForUpdate(app.getVersion());
    } catch (err) {
      throw toCommandError(err);
    }
  });

  ipcMain.handle('install_update', () => {
    throw toCommandError(new Error('Self-update is not available yet.'));
  });

  ipcMain.handle('load_update_config', async () => {
    try {
      return (await loadAppConfig()).update;
    } catch (err) {
      throw toCommandError(err);
    }
  });

  ipcMain.handle('save_update_config', async (_event, config: UpdateConfig) => {
    try {
      await persistUpdateConfig(config);
    } catch (err) {
      throw toCommandError(err);
    }
  });
}
