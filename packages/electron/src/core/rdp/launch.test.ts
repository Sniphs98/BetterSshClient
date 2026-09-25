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

// Imported after the mocks so `launch.ts` picks up the mocked modules.
const {
  buildFreerdpArgs,
  buildRdpFileContent,
  CREDENTIAL_HOLD_MS,
  freerdpCommands,
  freerdpSearchPath,
  freerdpSettingArgs,
  freerdpStdin,
  launchRdp,
  pendingCredentialHosts,
  rdpSettingLines,
  selectRdpStrategy
} = await import('./launch.js');

function connection(overrides: Partial<RemoteDesktopConnection> = {}): RemoteDesktopConnection {
  return { id: 'c1', name: 'office-pc', protocol: 'rdp', hostname: '10.0.0.5', port: 3389, ...overrides };
}

type FakeChild = EventEmitter & { unref: () => void; stdin: { end: (s: string) => void; on: () => void }; written: string };

/** A child that, once spawned, starts (or fails to, with `error`) on the next tick
 *  like a real one. Returned by `spawnMock`. */
function fakeChild(error?: NodeJS.ErrnoException): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.unref = vi.fn();
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
      rdpSettingLines({ display: 'window', width: 1600, height: 900, multiMonitor: false, clipboard: true, drives: true, audio: 'remote' })
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
    expect(freerdpSettingArgs({ display: 'window', width: 1600, height: 900, clipboard: true, drives: true, audio: 'local' })).toEqual([
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

  it('end up in the .rdp file and the FreeRDP command line', () => {
    expect(buildRdpFileContent({ ...connection(), display: 'fullscreen' })).toContain('screen mode id:i:2\n');
    expect(buildFreerdpArgs(connection({ display: 'fullscreen' }))).toContain('/f');
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

  it('answer the domain prompt blank when there is no domain, then give the password', () => {
    expect(freerdpStdin(connection({ password: 'secret' }))).toBe('\nsecret\n');
    expect(freerdpStdin(connection({ domain: 'CORP', password: 'secret' }))).toBe('secret\n');
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
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    process.env.PATH = originalPath;
    vi.useRealTimers();
  });

  it('on Windows: stages the password, spawns mstsc with a .rdp file, and drops it again on exit', async () => {
    setPlatform('win32');
    const child = fakeChild();

    const result = await launchRdp(connection({ username: 'admin', password: 'secret' }));

    expect(result.opened).toBe('mstsc');
    expect(result.credential).toBe('staged');
    expect(stageMock).toHaveBeenCalledWith('10.0.0.5', 'admin', 'secret');
    expect(spawnMock).toHaveBeenCalledWith('mstsc.exe', [result.filePath], expect.objectContaining({ detached: true }));
    // Nothing spawned carries the password.
    expect(JSON.stringify(spawnMock.mock.calls)).not.toContain('secret');
    expect(pendingCredentialHosts.has('10.0.0.5')).toBe(true);

    child.emit('exit');
    await flush();
    expect(removeMock).toHaveBeenCalledTimes(1);
    expect(removeMock).toHaveBeenCalledWith('10.0.0.5');
    expect(pendingCredentialHosts.has('10.0.0.5')).toBe(false);
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
      expect(child.written).toBe('\nsecret\n');
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
