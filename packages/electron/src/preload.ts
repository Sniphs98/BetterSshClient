import { contextBridge, ipcRenderer, webUtils } from 'electron';

/**
 * The renderer's only door into the main process. Exposed as `window.omnyssh`;
 * `packages/ui/src/lib/bindings.ts` is the sole consumer — no other renderer
 * code talks to `ipcRenderer` directly (mirrors the old `TAURI_INVOKE`/
 * `TAURI_API_EVENT` boundary in the generated Tauri bindings).
 */
const omnyssh = {
  invoke: (channel: string, ...args: unknown[]): Promise<unknown> => ipcRenderer.invoke(channel, ...args),

  on: (channel: string, callback: (payload: unknown) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown): void => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },

  settings: {
    get: (key: string): Promise<unknown> => ipcRenderer.invoke('settings:get', key),
    set: (key: string, value: unknown): Promise<void> => ipcRenderer.invoke('settings:set', key, value)
  },

  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('shell:open-external', url),
  homeDir: (): Promise<string> => ipcRenderer.invoke('system:home-dir'),

  /** Resolves a dropped `File`'s absolute filesystem path (replaces Tauri's
   *  webview drag/drop payload paths). Must run in the preload/renderer
   *  context — `webUtils` cannot cross a `send`/`invoke` IPC call. */
  getPathForFile: (file: File): string => webUtils.getPathForFile(file)
};

export type OmnysshBridge = typeof omnyssh;

contextBridge.exposeInMainWorld('omnyssh', omnyssh);
