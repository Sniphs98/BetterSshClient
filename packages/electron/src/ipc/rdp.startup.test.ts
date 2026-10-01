import { afterEach, describe, expect, it, vi } from 'vitest';

// The app start must not touch the Windows credential store, nor start any process
// (it used to run a PowerShell credential sweep here).
const spawned = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawned('spawn', ...args),
  execFile: (...args: unknown[]) => spawned('execFile', ...args),
  exec: (...args: unknown[]) => spawned('exec', ...args),
  execFileSync: (...args: unknown[]) => spawned('execFileSync', ...args),
  execSync: (...args: unknown[]) => spawned('execSync', ...args)
}));
const loadApi = vi.fn();
vi.mock('../core/rdp/credentials/windowsCredentialStore.js', () => ({
  CRED_TYPE_GENERIC: 1,
  loadWindowsCredentialApi: () => loadApi()
}));
vi.mock('electron', () => ({ clipboard: {}, screen: {}, shell: {} }));

const { cleanUpRdpOnQuit, registerRdpIpc } = await import('./rdp.js');

describe('app start', () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  });

  it('on Windows, registering RDP neither starts a process nor opens the credential store', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const handle = vi.fn();

    registerRdpIpc({ handle } as never, {} as never);
    cleanUpRdpOnQuit();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(handle).toHaveBeenCalledWith('rdp_launch', expect.any(Function));
    expect(spawned).not.toHaveBeenCalled();
    expect(loadApi).not.toHaveBeenCalled();
  });
});
