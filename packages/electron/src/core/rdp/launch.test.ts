import { EventEmitter } from 'node:events';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteDesktopConnection } from '../config/remoteDesktop.js';

const spawnMock = vi.fn();
const stageMock = vi.fn();
const removeMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args)
}));
vi.mock('./windowsCredentials.js', () => ({
  stageCredential: (...args: unknown[]) => stageMock(...args),
  removeCredential: (...args: unknown[]) => removeMock(...args)
}));
const maximizeMock = vi.fn(() => Promise.resolve());
vi.mock('./windowsWindow.js', () => ({
  maximizeWhenConnected: (pid: number) => maximizeMock(pid)
}));

// Imported after the mocks so `launch.ts` picks up the mocked modules.
const {
  buildFreerdpArgs,
  buildRdpFileContent,
  CREDENTIAL_AFTER_CONNECT_MS,
  CREDENTIAL_HOLD_MS,
  hasConnection,
  fitToWorkArea,
  freerdpCommands,
  freerdpSearchPath,
  freerdpSettingArgs,
  freerdpStdin,
  launchRdp,
  mstscArgs,
  needsRdpFile,
  pendingCredentialHosts,
  rdpSettingLines,
  selectRdpStrategy,
  setConnectionProbe
} = await import('./launch.js');

const probeMock = vi.fn<(pid: number, port: number) => Promise<boolean>>();

function connection(overrides: Partial<RemoteDesktopConnection> = {}): RemoteDesktopConnection {
  return { id: 'c1', name: 'office-pc', protocol: 'rdp', hostname: '10.0.0.5', port: 3389, ...overrides };
}

type FakeChild = EventEmitter & { unref: () => void; stdin: { end: (s: string) => void; on: () => void }; written: string };

/** A child that, once spawned, starts (or fails to, with `error`) on the next tick
 *  like a real one. Returned by `spawnMock`. */
function fakeChild(error?: NodeJS.ErrnoException): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.unref = vi.fn();
  (child as unknown as { pid: number }).pid = 4242;
  child.written = '';
  child.stdin = { end: (s) => (child.written += s), on: () => {} };
  spawnMock.mockImplementation(() => {
    setImmediate(() => (error ? child.emit('error', error) : child.emit('spawn')));
    return child;
  });
  return child;
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

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

  it('cannot be made to carry extra settings through a newline in a value', () => {
    const content = buildRdpFileContent({ ...connection(), username: 'admin\nalternate shell:s:cmd.exe' });
    expect(content.split('\n').filter((l) => l.startsWith('alternate shell'))).toEqual([]);
  });
});

describe('RDP settings', () => {
  it('leave everything to the client when none are set', () => {
    expect(rdpSettingLines({})).toEqual([]);
    expect(freerdpSettingArgs({})).toEqual([]);
  });

  it('become .rdp lines for mstsc', () => {
    expect(
      rdpSettingLines({
        display: 'window',
        width: 1600,
        height: 900,
        dynamicResolution: true,
        multiMonitor: false,
        clipboard: true,
        drives: true,
        audio: 'remote'
      })
    ).toEqual([
      'screen mode id:i:1',
      'desktopwidth:i:1600',
      'desktopheight:i:900',
      'dynamic resolution:i:1',
      'use multimon:i:0',
      'redirectclipboard:i:1',
      'drivestoredirect:s:*',
      'audiomode:i:1'
    ]);
    expect(rdpSettingLines({ display: 'fullscreen', clipboard: false, drives: false, audio: 'off' })).toEqual([
      'screen mode id:i:2',
      'redirectclipboard:i:0',
      'drivestoredirect:s:',
      'audiomode:i:2'
    ]);
  });

  it('become FreeRDP arguments', () => {
    expect(
      freerdpSettingArgs({ display: 'window', width: 1600, height: 900, dynamicResolution: true, clipboard: true, drives: true, audio: 'local' })
    ).toEqual([
      '/size:1600x900',
      '/dynamic-resolution',
      '+clipboard',
      '/drives',
      '/sound'
    ]);
    expect(freerdpSettingArgs({ display: 'fullscreen', multiMonitor: true, clipboard: false, audio: 'off' })).toEqual([
      '/f',
      '/multimon',
      '-clipboard',
      '/audio-mode:2'
    ]);
  });

  it("resizing a window: the session starts at the screen's size, the window at its own", () => {
    const screen = { width: 2560, height: 1440, scaleFactor: 1 };
    expect(rdpSettingLines({ display: 'window', width: 1280, height: 720, dynamicResolution: true }, screen)).toEqual([
      'screen mode id:i:1',
      'desktopwidth:i:2560',
      'desktopheight:i:1440',
      'winposstr:s:0,1,80,80,1376,839',
      'dynamic resolution:i:1'
    ]);
    // Without the screen (FreeRDP's side never builds one) it stays as asked.
    expect(rdpSettingLines({ display: 'window', width: 1280, height: 720, dynamicResolution: true })).toContain('desktopwidth:i:1280');
    // Fit to screen is already as big as the window can get.
    expect(rdpSettingLines({ display: 'fit', width: 2560, height: 1369, dynamicResolution: true }, screen)).toContain('desktopheight:i:1369');
    // No display mode set: still room to grow.
    expect(rdpSettingLines({ dynamicResolution: true }, screen)).toEqual([
      'desktopwidth:i:2560',
      'desktopheight:i:1440',
      'dynamic resolution:i:1'
    ]);
  });

  it("fit the screen: FreeRDP measures the work area itself, a .rdp file gets the size worked out", () => {
    expect(freerdpSettingArgs({ display: 'fit' })).toEqual(['/workarea']);
    expect(rdpSettingLines({ display: 'fit', width: 2560, height: 1369 })).toEqual([
      'screen mode id:i:1',
      'desktopwidth:i:2560',
      'desktopheight:i:1369'
    ]);
  });

  it('end up in the .rdp file and the FreeRDP command line', () => {
    expect(buildRdpFileContent({ ...connection(), display: 'fullscreen' })).toContain('screen mode id:i:2\n');
    expect(buildFreerdpArgs(connection({ display: 'fullscreen' }))).toContain('/f');
  });
});

describe('hasConnection', () => {
  const netstat = [
    'Aktive Verbindungen',
    '',
    '  Proto  Lokale Adresse         Remoteadresse          Status           PID',
    '  TCP    0.0.0.0:135            0.0.0.0:0              ABHÖREN         1908',
    '  TCP    127.0.0.1:52011        127.0.0.1:13389        HERGESTELLT     4242',
    '  TCP    10.0.0.2:52012         10.0.0.5:3389          ESTABLISHED     777'
  ].join('\r\n');

  it("finds a process's connection to the RDP port, whatever the state is called", () => {
    expect(hasConnection(netstat, 4242, 13389)).toBe(true);
    expect(hasConnection(netstat, 777, 3389)).toBe(true);
  });

  it("does not mistake another process's connection, or a local port, for it", () => {
    expect(hasConnection(netstat, 4242, 3389)).toBe(false);
    expect(hasConnection(netstat, 1908, 135)).toBe(false);
    expect(hasConnection(netstat, 777, 52012)).toBe(false);
  });
});

describe('fitToWorkArea', () => {
  it("is the maximised window's client area: the work area less the title bar", () => {
    // Measured: 2560x1440 screen, taskbar 48 px, 100 % — no scrollbars when maximised.
    expect(fitToWorkArea({ width: 2560, height: 1392 }, 1)).toEqual({ width: 2560, height: 1369 });
  });

  it('counts physical pixels, rounding the title bar up at odd scalings', () => {
    expect(fitToWorkArea({ width: 1536, height: 816 }, 1.25)).toEqual({ width: 1920, height: 1020 - 29 });
    expect(fitToWorkArea({ width: 1280, height: 672 }, 1.5)).toEqual({ width: 1920, height: 1008 - 35 });
  });
});

describe('starting mstsc without a .rdp file', () => {
  it('is how every connection goes that does not need one', () => {
    expect(needsRdpFile({ username: 'a', password: 'p' })).toBe(false);
    expect(needsRdpFile({ username: 'a', password: 'p', clipboard: true, audio: 'local', multiMonitor: true })).toBe(false);
  });

  it('is not possible for drives, the clipboard off, sound elsewhere, or a username to prefill', () => {
    expect(needsRdpFile({ drives: true })).toBe(true);
    expect(needsRdpFile({ clipboard: false })).toBe(true);
    expect(needsRdpFile({ audio: 'remote' })).toBe(true);
    expect(needsRdpFile({ username: 'a', password: 'p', dynamicResolution: true })).toBe(true);
    expect(needsRdpFile({ username: 'a' })).toBe(true);
  });

  it('passes display settings as mstsc switches', () => {
    expect(mstscArgs({ hostname: 'pc.local', port: 3389 })).toEqual(['/v:pc.local:3389']);
    expect(mstscArgs({ hostname: '10.0.0.5', port: 13389, display: 'window', width: 1280, height: 720, multiMonitor: true })).toEqual([
      '/v:10.0.0.5:13389',
      '/w:1280',
      '/h:720',
      '/multimon'
    ]);
    expect(mstscArgs({ hostname: 'pc', port: 3389, display: 'fit', width: 2560, height: 1369 })).toEqual(['/v:pc:3389', '/w:2560', '/h:1369']);
  });

  it('refuses a hostname that would smuggle in more switches', () => {
    expect(() => mstscArgs({ hostname: 'pc /admin', port: 3389 })).toThrow('not a valid hostname');
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

describe('FreeRDP arguments', () => {
  it('never put the password on the command line', () => {
    const args = buildFreerdpArgs(connection({ username: 'admin', password: 'secret' }));
    expect(args.join(' ')).not.toContain('secret');
    expect(args).toEqual(['/v:10.0.0.5:3389', '/u:admin', '/from-stdin:force']);
  });

  it('answer the password prompt, the only one with a username on the command line', () => {
    expect(freerdpStdin(connection({ username: 'admin', password: 'secret' }))).toBe('secret\n');
    expect(freerdpStdin(connection({ username: 'admin', domain: 'CORP', password: 'secret' }))).toBe('secret\n');
  });

  it('leave the prompts to the user without a username', () => {
    expect(buildFreerdpArgs(connection({ password: 'secret' }))).not.toContain('/from-stdin:force');
  });

  it('do not ask for anything on stdin without a saved password', () => {
    expect(buildFreerdpArgs(connection({ username: 'admin' }))).not.toContain('/from-stdin:force');
  });
});

describe('finding FreeRDP', () => {
  it('prefers the native SDL client on macOS, the X11 one elsewhere', () => {
    expect(freerdpCommands('darwin')[0]).toBe('sdl-freerdp3');
    expect(freerdpCommands('linux')[0]).toBe('xfreerdp3');
    expect(freerdpCommands('linux')).toContain('sdl-freerdp');
  });

  it("also looks where Homebrew installs on macOS, which a Finder-started app's PATH lacks", () => {
    expect(freerdpSearchPath('darwin', '/usr/bin:/bin', ':')).toEqual([
      '/usr/bin',
      '/bin',
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/opt/local/bin'
    ]);
    expect(freerdpSearchPath('linux', '/usr/bin:/bin', ':')).toEqual(['/usr/bin', '/bin']);
  });
});

describe('launchRdp', () => {
  const originalPlatform = process.platform;
  const originalPath = process.env.PATH;

  function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  }

  beforeEach(() => {
    spawnMock.mockReset();
    stageMock.mockReset().mockResolvedValue('staged');
    removeMock.mockReset().mockResolvedValue(undefined);
    pendingCredentialHosts.clear();
    probeMock.mockReset().mockResolvedValue(false);
    setConnectionProbe(probeMock);
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    process.env.PATH = originalPath;
    vi.useRealTimers();
  });

  it('on Windows: stages the password, starts mstsc on the address alone, and drops it again on exit', async () => {
    setPlatform('win32');
    const child = fakeChild();

    const result = await launchRdp(connection({ username: 'admin', password: 'secret', display: 'fullscreen' }));

    expect(result.opened).toBe('mstsc');
    expect(result.credential).toBe('staged');
    expect(result.filePath).toBeUndefined();
    expect(result.redirectionPrompt).toBe(false);
    expect(stageMock).toHaveBeenCalledWith('10.0.0.5', 'admin', 'secret');
    expect(spawnMock).toHaveBeenCalledWith('mstsc.exe', ['/v:10.0.0.5:3389', '/f'], expect.objectContaining({ detached: true }));
    // Hidden, mstsc's window may never show up (found against a real Windows).
    expect(spawnMock.mock.calls[0][2]).not.toHaveProperty('windowsHide');
    // Nothing spawned carries the password.
    expect(JSON.stringify(spawnMock.mock.calls)).not.toContain('secret');
    expect(pendingCredentialHosts.has('10.0.0.5')).toBe(true);

    child.emit('exit');
    await flush();
    expect(removeMock).toHaveBeenCalledTimes(1);
    expect(removeMock).toHaveBeenCalledWith('10.0.0.5');
    expect(pendingCredentialHosts.has('10.0.0.5')).toBe(false);
  });

  it("on Windows: maximises the session window for 'fit to screen', and only then", async () => {
    setPlatform('win32');
    maximizeMock.mockClear();
    fakeChild();
    await launchRdp(connection({ username: 'admin', password: 'secret', display: 'fit', width: 2560, height: 1369 }));
    expect(maximizeMock).toHaveBeenCalledWith(4242);

    maximizeMock.mockClear();
    fakeChild();
    await launchRdp(connection({ username: 'admin', password: 'secret', display: 'window' }));
    expect(maximizeMock).not.toHaveBeenCalled();
  });

  it('on Windows: opens a .rdp file only for what an address alone cannot say — local drives', async () => {
    setPlatform('win32');
    fakeChild();

    const result = await launchRdp(connection({ username: 'admin', password: 'secret', drives: true }));

    expect(result.redirectionPrompt).toBe(true);
    expect(spawnMock).toHaveBeenCalledWith('mstsc.exe', [result.filePath], expect.anything());
    expect(result.filePath).toMatch(/\.rdp$/);
  });

  it('on Windows: keeps the credential while mstsc waits on its warnings, drops it once mstsc has connected', async () => {
    setPlatform('win32');
    fakeChild();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    await launchRdp(connection({ username: 'admin', password: 'secret' }));
    // The user reads Windows' .rdp warnings for a minute: no connection yet.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(removeMock).not.toHaveBeenCalled();
    expect(probeMock).toHaveBeenCalledWith(4242, 3389);

    // They click Connect.
    probeMock.mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(removeMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(CREDENTIAL_AFTER_CONNECT_MS);
    expect(removeMock).toHaveBeenCalledTimes(1);

    // And it stops watching.
    const calls = probeMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(probeMock.mock.calls.length).toBe(calls);
  });

  it('on Windows: drops the credential after the hold time even while mstsc keeps running — once', async () => {
    setPlatform('win32');
    const child = fakeChild();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    await launchRdp(connection({ username: 'admin', password: 'secret' }));
    expect(removeMock).not.toHaveBeenCalled();

    vi.advanceTimersByTime(CREDENTIAL_HOLD_MS);
    expect(removeMock).toHaveBeenCalledTimes(1);

    child.emit('exit');
    expect(removeMock).toHaveBeenCalledTimes(1);
  });

  it("on Windows: never removes a credential the user saved themselves", async () => {
    setPlatform('win32');
    stageMock.mockResolvedValue('kept-existing');
    const child = fakeChild();

    const result = await launchRdp(connection({ username: 'admin', password: 'secret' }));
    child.emit('exit');
    await flush();

    expect(result.credential).toBe('kept-existing');
    expect(removeMock).not.toHaveBeenCalled();
  });

  it('on Windows: a missing mstsc is an error, and the staged password is taken out again', async () => {
    setPlatform('win32');
    fakeChild(Object.assign(new Error('spawn mstsc.exe ENOENT'), { code: 'ENOENT' }));

    await expect(launchRdp(connection({ username: 'admin', password: 'secret' }))).rejects.toThrow(
      'Remote Desktop (mstsc.exe) was not found'
    );
    await flush();
    expect(removeMock).toHaveBeenCalledWith('10.0.0.5');
  });

  it('on Windows: a failure to stage the password is an error, and mstsc is not started', async () => {
    setPlatform('win32');
    stageMock.mockRejectedValue(new Error('access denied'));

    await expect(launchRdp(connection({ username: 'admin', password: 'secret' }))).rejects.toThrow('access denied');
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('on Windows without a saved password: never touches the credential store', async () => {
    setPlatform('win32');
    const child = fakeChild();

    await launchRdp(connection());
    child.emit('exit');
    await flush();

    expect(stageMock).not.toHaveBeenCalled();
    expect(removeMock).not.toHaveBeenCalled();
  });

  describe('on Linux', () => {
    let binDir: string;

    beforeEach(async () => {
      binDir = await mkdtemp(join(tmpdir(), 'bssh-rdp-bin-'));
      process.env.PATH = binDir;
    });

    afterEach(async () => {
      await rm(binDir, { recursive: true, force: true });
    });

    async function install(cmd: string): Promise<string> {
      const path = join(binDir, cmd);
      await writeFile(path, '#!/bin/sh\n');
      await chmod(path, 0o755);
      return path;
    }

    it('with xfreerdp on PATH: spawns it and types the password into its stdin, no .rdp file', async () => {
      setPlatform('linux');
      const bin = await install('xfreerdp');
      const child = fakeChild();

      const result = await launchRdp(connection({ username: 'admin', password: 'secret' }));

      expect(result.opened).toBe('xfreerdp');
      expect(result.filePath).toBeUndefined();
      expect(spawnMock).toHaveBeenCalledWith(bin, ['/v:10.0.0.5:3389', '/u:admin', '/from-stdin:force'], expect.anything());
      expect(child.written).toBe('secret\n');
    });

    it("prefers FreeRDP 3's xfreerdp3 when both are installed", async () => {
      setPlatform('linux');
      await install('xfreerdp');
      const bin3 = await install('xfreerdp3');
      fakeChild();

      await launchRdp(connection());

      expect(spawnMock.mock.calls[0][0]).toBe(bin3);
    });

    it('without xfreerdp: falls back to writing a .rdp file, does not spawn anything', async () => {
      setPlatform('linux');

      const result = await launchRdp(connection());

      expect(result.opened).toBe('file');
      expect(result.filePath).toBeDefined();
      expect(spawnMock).not.toHaveBeenCalled();
    });
  });
});
