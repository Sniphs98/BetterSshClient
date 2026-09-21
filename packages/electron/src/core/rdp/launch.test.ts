import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteDesktopConnection } from '../config/remoteDesktop.js';

const execFileMock = vi.fn();
const spawnMock = vi.fn();

vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
  spawn: (...args: unknown[]) => spawnMock(...args)
}));

// Imported after the mock so `launch.ts` picks up the mocked module.
const { buildRdpFileContent, selectRdpStrategy, launchRdp } = await import('./launch.js');

function connection(overrides: Partial<RemoteDesktopConnection> = {}): RemoteDesktopConnection {
  return { id: 'c1', name: 'office-pc', protocol: 'rdp', hostname: '10.0.0.5', port: 3389, ...overrides };
}

type Listener = () => void;

function fakeChild(): { unref: () => void; once: (event: string, cb: Listener) => void; trigger: (event: string) => void } {
  const listeners: Record<string, Listener[]> = {};
  return {
    unref: vi.fn(),
    once: (event, cb) => {
      (listeners[event] ??= []).push(cb);
    },
    trigger: (event) => listeners[event]?.forEach((cb) => cb())
  };
}

describe('buildRdpFileContent', () => {
  it('always includes the full address', () => {
    const content = buildRdpFileContent(connection());
    expect(content).toContain('full address:s:10.0.0.5:3389');
  });

  it('never includes a password', () => {
    const content = buildRdpFileContent({ ...connection(), username: 'admin' });
    expect(content).not.toMatch(/password/i);
  });

  it('qualifies the username with a domain when given', () => {
    const content = buildRdpFileContent({ ...connection(), username: 'admin', domain: 'CORP' });
    expect(content).toContain('username:s:CORP\\admin');
  });

  it('omits the username line when none is given', () => {
    const content = buildRdpFileContent(connection());
    expect(content).not.toContain('username:s:');
  });
});

describe('selectRdpStrategy', () => {
  it('always chooses mstsc on Windows, regardless of xfreerdp', () => {
    expect(selectRdpStrategy('win32', false)).toBe('mstsc');
    expect(selectRdpStrategy('win32', true)).toBe('mstsc');
  });

  it('chooses xfreerdp on macOS/Linux when it is on PATH', () => {
    expect(selectRdpStrategy('darwin', true)).toBe('xfreerdp');
    expect(selectRdpStrategy('linux', true)).toBe('xfreerdp');
  });

  it('falls back to writing a .rdp file when xfreerdp is absent', () => {
    expect(selectRdpStrategy('darwin', false)).toBe('file');
    expect(selectRdpStrategy('linux', false)).toBe('file');
  });
});

describe('launchRdp', () => {
  const originalPlatform = process.platform;

  function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  }

  beforeEach(() => {
    execFileMock.mockReset();
    spawnMock.mockReset();
    execFileMock.mockImplementation((_cmd, _args, _options, callback) => callback(null, '', ''));
  });

  afterEach(() => {
    setPlatform(originalPlatform);
  });

  it('on Windows: stages the password via cmdkey, spawns mstsc with a .rdp file, then cleans up on exit', async () => {
    setPlatform('win32');
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const result = await launchRdp(connection({ username: 'admin', password: 'secret' }));

    expect(result.opened).toBe('mstsc');
    expect(spawnMock).toHaveBeenCalledWith('mstsc.exe', [result.filePath], expect.objectContaining({ detached: true }));

    // cmdkey /generic:... was invoked before mstsc, with the password, never landing in the .rdp file.
    const cmdkeyAddCall = execFileMock.mock.calls.find((c) => c[1]?.[0]?.startsWith('/generic:'));
    expect(cmdkeyAddCall).toBeDefined();
    expect(cmdkeyAddCall![1]).toEqual(expect.arrayContaining([expect.stringContaining('/pass:secret')]));

    child.trigger('exit');
    // cmdkey /delete runs asynchronously off the 'exit' listener — give the microtask queue a turn.
    await Promise.resolve();
    await Promise.resolve();
    const cmdkeyDeleteCall = execFileMock.mock.calls.find((c) => c[1]?.[0]?.startsWith('/delete:'));
    expect(cmdkeyDeleteCall).toBeDefined();
  });

  it('on Windows without a saved password: never calls cmdkey', async () => {
    setPlatform('win32');
    spawnMock.mockReturnValue(fakeChild());

    await launchRdp(connection());

    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('on Linux with xfreerdp available: spawns it directly, no .rdp file', async () => {
    setPlatform('linux');
    spawnMock.mockReturnValue(fakeChild());

    const result = await launchRdp(connection({ username: 'admin', password: 'secret' }));

    expect(result.opened).toBe('xfreerdp');
    expect(result.filePath).toBeUndefined();
    expect(spawnMock).toHaveBeenCalledWith(
      'xfreerdp',
      expect.arrayContaining(['/v:10.0.0.5:3389', '/u:admin', '/p:secret']),
      expect.anything()
    );
  });

  it('on Linux without xfreerdp: falls back to writing a .rdp file, does not spawn anything', async () => {
    setPlatform('linux');
    execFileMock.mockImplementation((_cmd, _args, _options, callback) => callback(new Error('not found')));

    const result = await launchRdp(connection());

    expect(result.opened).toBe('file');
    expect(result.filePath).toBeDefined();
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
