import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultHost, type Host, type HostSource } from '../ssh/client.js';
import { loadHosts, mergeHosts, saveHosts } from './hosts.js';
import { getSecretCipher, setSecretCipher, type SecretCipher } from './secretCipher.js';

/** A reversible fake cipher — no real crypto needed to prove `saveHosts`/`loadHosts`
 *  actually route a password through whatever `getSecretCipher()` returns. */
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

// Ported from crates/omnyssh-core/src/config/mod.rs's #[cfg(test)] module.

function host(name: string, source: HostSource): Host {
  return { ...defaultHost(), name, source };
}

function renamed(name: string, original: string): Host {
  return { ...defaultHost(), name, source: 'manual', originalSshHost: original };
}

function names(hosts: Host[]): string[] {
  return hosts.map((h) => h.name);
}

describe('mergeHosts', () => {
  it('both empty', () => {
    expect(mergeHosts([], [])).toEqual([]);
  });

  it('manual only', () => {
    expect(names(mergeHosts([host('a', 'manual')], []))).toEqual(['a']);
  });

  it('ssh-config only', () => {
    expect(names(mergeHosts([], [host('a', 'ssh_config')]))).toEqual(['a']);
  });

  it('manual is listed before ssh-config', () => {
    expect(names(mergeHosts([host('m', 'manual')], [host('s', 'ssh_config')]))).toEqual(['m', 's']);
  });

  it('a name collision: manual wins', () => {
    const out = mergeHosts([host('web', 'manual')], [host('web', 'ssh_config')]);
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe('manual');
  });

  it('a renamed ssh-config host is excluded', () => {
    const out = mergeHosts([renamed('new', 'old')], [host('old', 'ssh_config')]);
    expect(names(out)).toEqual(['new']);
  });

  it('a rename and a name collision combined', () => {
    // Manual "a" was renamed from ssh "b"; ssh has both "a" and "b".
    const out = mergeHosts([renamed('a', 'b')], [host('a', 'ssh_config'), host('b', 'ssh_config')]);
    expect(names(out)).toEqual(['a']);
  });

  it('multiple distinct ssh-config names are all kept', () => {
    const out = mergeHosts([], [host('a', 'ssh_config'), host('b', 'ssh_config'), host('c', 'ssh_config')]);
    expect(names(out)).toEqual(['a', 'b', 'c']);
  });

  it('a rename keeps an unrelated ssh-config host', () => {
    const out = mergeHosts([renamed('a', 'b')], [host('b', 'ssh_config'), host('c', 'ssh_config')]);
    expect(names(out)).toEqual(['a', 'c']);
  });
});

describe('hosts.toml I/O', () => {
  let tmp: string;
  let prevAppData: string | undefined;
  let prevXdgConfig: string | undefined;
  let prevHome: string | undefined;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'better-ssh-client-hosts-'));
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
    // Tests below install a fake cipher — never leak it past the test that set it.
    setSecretCipher(fakeCipher(false));
  });

  it('round-trips fields and filters to manual hosts only', async () => {
    const manual: Host = { ...defaultHost(), name: 'web', hostname: '10.0.0.1', user: 'deploy', port: 2222, tags: ['prod'] };
    const sshDerived: Host = { ...defaultHost(), name: 's', hostname: '10.0.0.2', source: 'ssh_config' };

    await saveHosts([manual, sshDerived]);
    const loaded = await loadHosts();

    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe('web');
    expect(loaded[0].hostname).toBe('10.0.0.1');
    expect(loaded[0].user).toBe('deploy');
    expect(loaded[0].port).toBe(2222);
    expect(loaded[0].tags).toEqual(['prod']);
  });

  it('writes atomically (no leftover .tmp file) and sets 0600 perms on non-Windows', async () => {
    await saveHosts([host('a', 'manual')]);
    const path = join(tmp, 'better-ssh-client', 'hosts.toml');
    expect(existsSync(path)).toBe(true);
    expect(existsSync(`${path}.tmp`)).toBe(false);

    if (process.platform !== 'win32') {
      const { stat } = await import('node:fs/promises');
      const mode = (await stat(path)).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it('an empty file parses to an empty host list', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const dir = join(tmp, 'better-ssh-client');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'hosts.toml'), '');
    expect(await loadHosts()).toEqual([]);
  });

  it('a missing file returns an empty list rather than throwing', async () => {
    expect(await loadHosts()).toEqual([]);
  });

  it('omits optional fields on write, matching the Rust struct', async () => {
    await saveHosts([host('a', 'manual')]);
    const content = await readFile(join(tmp, 'better-ssh-client', 'hosts.toml'), 'utf-8');
    expect(content).not.toContain('identity_file');
    expect(content).not.toContain('password');
  });

  it('persists a password in plaintext when no cipher is installed (the default)', async () => {
    expect(getSecretCipher().available).toBe(false);
    await saveHosts([{ ...defaultHost(), name: 'a', password: 'secret' }]);
    const loaded = await loadHosts();
    expect(loaded[0].password).toBe('secret');
  });

  it('encrypts a password on disk when a cipher is available, and decrypts it back on load', async () => {
    setSecretCipher(fakeCipher());
    await saveHosts([{ ...defaultHost(), name: 'a', password: 'secret' }]);

    const raw = await readFile(join(tmp, 'better-ssh-client', 'hosts.toml'), 'utf-8');
    expect(raw).not.toContain('secret');
    expect(raw).toContain('enc:v1:');

    const loaded = await loadHosts();
    expect(loaded[0].password).toBe('secret');
  });

  it('still loads a legacy plaintext password even once a cipher is available', async () => {
    // A hosts.toml from before this feature, or written while encryption was
    // unavailable — either way, a bare `password = "secret"` with no "enc:v1:"
    // prefix is already plaintext and must not be run through the cipher.
    const { mkdir, writeFile } = await import('node:fs/promises');
    const dir = join(tmp, 'better-ssh-client');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'hosts.toml'), '[[hosts]]\nname = "a"\npassword = "secret"\n');

    setSecretCipher(fakeCipher());
    const loaded = await loadHosts();
    expect(loaded[0].password).toBe('secret');
  });

  it('falls back to plaintext on save when the cipher reports itself unavailable', async () => {
    setSecretCipher(fakeCipher(false));
    await saveHosts([{ ...defaultHost(), name: 'a', password: 'secret' }]);
    const raw = await readFile(join(tmp, 'better-ssh-client', 'hosts.toml'), 'utf-8');
    expect(raw).toContain('password = "secret"');
  });

  it('drops an undecryptable password rather than failing the whole file to load', async () => {
    // Simulates the OS key having changed (a new machine, a restored profile, …) —
    // the ciphertext this cipher wrote is no longer valid for it.
    setSecretCipher(fakeCipher());
    await saveHosts([{ ...defaultHost(), name: 'a', password: 'secret' }, { ...defaultHost(), name: 'b' }]);

    setSecretCipher({ ...fakeCipher(), decrypt: () => { throw new Error('wrong key'); } });
    const loaded = await loadHosts();
    expect(loaded.map((h) => h.name)).toEqual(['a', 'b']);
    expect(loaded[0].password).toBeUndefined();
  });
});
