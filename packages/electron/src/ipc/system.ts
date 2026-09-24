import { app, shell, type IpcMain } from 'electron';

/** Small main-process-only OS integrations the renderer can't reach directly
 *  (replaces `tauri-plugin-opener` and `@tauri-apps/api/path`'s `homeDir`). */
export function registerSystemIpc(ipcMain: IpcMain): void {
  ipcMain.handle('shell:open-external', async (_event, url: string) => {
    await shell.openExternal(url);
  });

  ipcMain.handle('system:home-dir', () => app.getPath('home'));
}
