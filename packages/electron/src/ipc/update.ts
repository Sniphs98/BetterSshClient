import { readdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { app, type IpcMain } from 'electron';
import { autoUpdater, type ProgressInfo } from 'electron-updater';

import { loadAppConfig, saveUpdateConfig as persistUpdateConfig, type UpdateConfig } from '../core/config/appConfig.js';
import { selfUpdateSupport, type SelfUpdateSupport } from '../core/selfUpdate.js';
import { checkUpdate as checkForUpdate } from '../core/update.js';
import { toCommandError } from '../dto.js';
import type { GuiState } from '../state/guiState.js';

/**
 * Update commands. Detecting a newer release works everywhere
 * (`core/update.ts`); installing it goes through electron-updater, which reads
 * the `latest*.yml` manifests the Release workflow attaches to every GitHub
 * release, downloads the matching installer, and runs it on restart:
 *
 *   install_update     download the update, reporting `update-download-progress`,
 *                      then `update-downloaded`
 *   restart_to_update  quit and install it (the app restarts on the new version)
 *
 * Only where this copy can update itself — see `core/selfUpdate.ts`; elsewhere
 * the banner links to the release page instead.
 */

/** Whether the NSIS installer put this copy here: it leaves `Uninstall <product>.exe`
 *  next to the executable. Matched by pattern — the packaged `app.getName()` is the
 *  package.json name, not the product name the installer uses. */
function hasNsisUninstaller(): boolean {
  try {
    return readdirSync(dirname(process.execPath)).some((f) => /^Uninstall .+\.exe$/i.test(f));
  } catch {
    return false;
  }
}

/** Whether the running app can install updates itself, and if not, why. */
export function currentSelfUpdateSupport(): SelfUpdateSupport {
  return selfUpdateSupport({
    platform: process.platform,
    isPackaged: app.isPackaged,
    env: process.env,
    hasNsisUninstaller: process.platform === 'win32' && hasNsisUninstaller()
  });
}

/** The update the renderer is offered, with whether it can install it in place. */
export function checkForAppUpdate(): ReturnType<typeof checkForUpdate> {
  return checkForUpdate(app.getVersion(), currentSelfUpdateSupport().supported);
}

async function downloadUpdate(state: GuiState): Promise<void> {
  autoUpdater.autoDownload = false;
  // A downloaded update the user never restarts for still installs when they quit.
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  const onProgress = (p: ProgressInfo): void =>
    state.emit('update-download-progress', { percent: p.percent, transferred: p.transferred, total: p.total });
  autoUpdater.on('download-progress', onProgress);
  try {
    const result = await autoUpdater.checkForUpdates();
    if (result === null || !result.isUpdateAvailable) throw new Error('There is no newer release to install.');
    await autoUpdater.downloadUpdate();
    state.emit('update-downloaded', { version: result.updateInfo.version });
  } finally {
    autoUpdater.off('download-progress', onProgress);
  }
}

export function registerUpdateIpc(ipcMain: IpcMain, state: GuiState): void {
  ipcMain.handle('check_update', async () => {
    try {
      return await checkForAppUpdate();
    } catch (err) {
      throw toCommandError(err);
    }
  });

  // One download at a time: a second click joins the one already running.
  let downloading: Promise<void> | undefined;
  ipcMain.handle('install_update', async () => {
    const support = currentSelfUpdateSupport();
    if (!support.supported) {
      throw toCommandError(new Error(`Updating in place isn't available for ${support.reason}.`));
    }
    downloading ??= downloadUpdate(state).finally(() => (downloading = undefined));
    try {
      await downloading;
    } catch (err) {
      throw toCommandError(err);
    }
  });

  ipcMain.handle('restart_to_update', () => {
    // After the reply has gone out: quitting closes the window that is waiting for it.
    // Silent, and relaunched afterwards — the user already chose to update.
    setImmediate(() => autoUpdater.quitAndInstall(true, true));
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
