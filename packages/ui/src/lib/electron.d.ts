// Ambient type for the bridge `packages/electron/src/preload.ts` exposes via
// `contextBridge.exposeInMainWorld('bsshClient', ...)`. Kept independent of the
// electron package (a renderer build has no business depending on it) —
// change one, mirror the other.
export interface BsshClientBridge {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, callback: (payload: unknown) => void): () => void;
  settings: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
  };
  openExternal(url: string): Promise<void>;
  homeDir(): Promise<string>;
  /** The running app's version, e.g. `1.2.0`. */
  appVersion(): Promise<string>;
  getPathForFile(file: File): string;
}

declare global {
  interface Window {
    bsshClient?: BsshClientBridge;
  }
}
