// Thin wrapper over the Electron settings bridge (electron-store, main
// process). Mirrors the `tauri-plugin-store` `load(file)` shape the UI-pref
// stores (theme/ui/settings/streamer) used to call directly, so swapping the
// backend only changes what they import.

export interface SettingsStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

export async function loadSettingsStore(): Promise<SettingsStore> {
  const bridge = window.omnyssh;
  if (!bridge) throw new Error('the Electron bridge (window.omnyssh) is unavailable in this environment');
  return {
    get: <T>(key: string) => bridge.settings.get(key) as Promise<T | undefined>,
    set: (key: string, value: unknown) => bridge.settings.set(key, value)
  };
}
