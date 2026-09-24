import type { IpcMain } from 'electron';
import Store from 'electron-store';

/**
 * UI-preference persistence (theme, sidebar collapse, refresh interval,
 * streamer mode). Replaces `tauri-plugin-store`'s `settings.json` — same
 * single-JSON-file, best-effort semantics, just backed by `electron-store`
 * instead of the frontend loading a Tauri plugin directly.
 */

let store: Store | undefined;

function getStore(): Store {
  store ??= new Store({ name: 'settings' });
  return store;
}

export function registerSettingsIpc(ipcMain: IpcMain): void {
  ipcMain.handle('settings:get', (_event, key: string) => getStore().get(key));
  ipcMain.handle('settings:set', (_event, key: string, value: unknown) => {
    getStore().set(key, value);
  });
}
