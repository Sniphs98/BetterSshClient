// Open a URL in the user's default browser via the Electron bridge (replaces
// tauri-plugin-opener). Rejects on failure so the caller can surface it via
// the status bar.
export async function openExternal(url: string): Promise<void> {
  const bridge = window.bsshClient;
  if (!bridge) throw new Error('the Electron bridge (window.bsshClient) is unavailable in this environment');
  await bridge.openExternal(url);
}
