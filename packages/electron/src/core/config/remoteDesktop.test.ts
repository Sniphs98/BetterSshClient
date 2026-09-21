import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadRemoteDesktopConnections, saveRemoteDesktopConnections, type RemoteDesktopConnection } from './remoteDesktop.js';
import { getSecretCipher, setSecretCipher, type SecretCipher } from './secretCipher.js';

function fakeCipher(available = true): SecretCipher {
  return {
    available,
    encrypt: (plainText) => Buffer.from(`fake:${plainText}`, 'utf-8'),
    decrypt: (ciphertext) => {
      const s = ciphertext.toString('utf-8');
      if (!s.startsWith('fake:')) throw new Error('not fake-encrypted');
      return s.slice('fake:'.length);
    }
  };
}

function connection(overrides: Partial<RemoteDesktopConnection> = {}): RemoteDesktopConnection {
  return { id: 'c1', name: 'office-pc', protocol: 'rdp', hostname: '10.0.0.5', port: 3389, ...overrides };
}

describe('remote-desktop.toml I/O', () => {
  let tmp: string;
  let prevAppData: string | undefined;
  let prevXdgConfig: string | undefined;
  let prevHome: string | undefined;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'omnyssh-rd-'));
    prevAppData = process.env.APPDATA;
    prevXdgConfig = process.env.XDG_CONFIG_HOME;
    prevHome = process.env.HOME;
    process.env.APPDATA = tmp;
    process.env.XDG_CONFIG_HOME = tmp;
    process.env.HOME = tmp;
  });

  afterEach(async () => {
    if (prevAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = prevAppData;
    if (prevXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdgConfig;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await rm(tmp, { recursive: true, force: true });
    setSecretCipher(fakeCipher(false));
  });

  it('a missing file returns an empty list rather than throwing', async () => {
    expect(await loadRemoteDesktopConnections()).toEqual([]);
  });

  it('round-trips every field', async () => {
    const c = connection({ username: 'admin', domain: 'CORP' });
    await saveRemoteDesktopConnections([c]);
    const loaded = await loadRemoteDesktopConnections();
    expect(loaded).toEqual([c]);
  });

  it('omits optional fields on write', async () => {
    await saveRemoteDesktopConnections([connection()]);
    const content = await readFile(join(tmp, 'omnyssh', 'remote-desktop.toml'), 'utf-8');
    expect(content).not.toContain('username');
    expect(content).not.toContain('password');
    expect(content).not.toContain('domain');
  });

  it('persists a password in plaintext when no cipher is installed', async () => {
    expect(getSecretCipher().available).toBe(false);
    await saveRemoteDesktopConnections([connection({ password: 'secret' })]);
    const loaded = await loadRemoteDesktopConnections();
    expect(loaded[0].password).toBe('secret');
  });

  it('encrypts a password on disk when a cipher is available, and decrypts it back on load', async () => {
    setSecretCipher(fakeCipher());
    await saveRemoteDesktopConnections([connection({ password: 'secret' })]);

    const raw = await readFile(join(tmp, 'omnyssh', 'remote-desktop.toml'), 'utf-8');
    expect(raw).not.toContain('secret');
    expect(raw).toContain('enc:v1:');

    const loaded = await loadRemoteDesktopConnections();
    expect(loaded[0].password).toBe('secret');
  });

  it('rejects an unknown protocol', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const dir = join(tmp, 'omnyssh');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'remote-desktop.toml'),
      '[[connections]]\nid = "c1"\nname = "x"\nprotocol = "telnet"\nhostname = "h"\nport = 23\n'
    );
    await expect(loadRemoteDesktopConnections()).rejects.toThrow(/protocol/);
  });
});
