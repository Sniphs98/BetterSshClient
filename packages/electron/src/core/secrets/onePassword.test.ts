import { afterEach, describe, expect, it } from 'vitest';

import { cliVersion, installHint, isSecretReference, normalizeReference, opLocations, readSecret, setOpRunner } from './onePassword.js';

afterEach(() => setOpRunner(undefined));

describe('isSecretReference', () => {
  it('accepts vault/item/field and vault/item/section/field', () => {
    expect(isSecretReference('op://Servers/web-1/password')).toBe(true);
    expect(isSecretReference(' op://Servers/web-1/login/password ')).toBe(true);
  });

  it('accepts names with spaces, and the quotes 1Password copies them with', () => {
    expect(isSecretReference('op://IT/e-HPV one/Benutzername')).toBe(true);
    expect(isSecretReference('"op://IT/e-HPV one/Benutzername"')).toBe(true);
    expect(normalizeReference(' "op://IT/e-HPV one/Benutzername" ')).toBe('op://IT/e-HPV one/Benutzername');
  });

  it('refuses anything else', () => {
    for (const v of ['hunter2', 'op://Servers/web-1', 'op://Servers', 'https://x/y/z', 'op://a /c/d', 'op://a/b/c"', 'op://a/b\nc/d', 'op://a/b/c/d/e']) {
      expect(isSecretReference(v), v).toBe(false);
    }
  });
});

describe('readSecret', () => {
  it('asks op for exactly the reference, without a trailing newline', async () => {
    let seen: string[] = [];
    setOpRunner(async (args) => {
      seen = args;
      return { stdout: 's3cret', stderr: '' };
    });
    expect(await readSecret(' op://Servers/web-1/password ')).toBe('s3cret');
    expect(seen).toEqual(['read', '--no-newline', 'op://Servers/web-1/password']);
  });

  it('passes op a quoted reference without its quotes', async () => {
    let seen: string[] = [];
    setOpRunner(async (args) => {
      seen = args;
      return { stdout: 'admin', stderr: '' };
    });
    expect(await readSecret('"op://IT/e-HPV one/Benutzername"')).toBe('admin');
    expect(seen).toEqual(['read', '--no-newline', 'op://IT/e-HPV one/Benutzername']);
  });

  it('never runs op for something that is not a reference', async () => {
    let ran = false;
    setOpRunner(async () => {
      ran = true;
      return { stdout: 'x', stderr: '' };
    });
    await expect(readSecret('op://nope')).rejects.toThrow('not a 1Password reference');
    expect(ran).toBe(false);
  });

  it('explains a missing CLI', async () => {
    setOpRunner(async () => {
      throw Object.assign(new Error('spawn op ENOENT'), { code: 'ENOENT' });
    });
    await expect(readSecret('op://a/b/c')).rejects.toThrow('1Password CLI (op) not found');
  });

  it("passes op's own error on, without its timestamp prefix", async () => {
    setOpRunner(async () => {
      throw Object.assign(new Error('Command failed'), {
        code: 1,
        stderr: '[ERROR] 2026/09/25 20:01:02 could not read secret "op://a/b/c": item "b" not found\n'
      });
    });
    await expect(readSecret('op://a/b/c')).rejects.toThrow('1Password: could not read secret "op://a/b/c": item "b" not found');
  });

  it('refuses an empty value rather than trying an empty password', async () => {
    setOpRunner(async () => ({ stdout: '', stderr: '' }));
    await expect(readSecret('op://a/b/c')).rejects.toThrow('empty value');
  });
});

describe('cliVersion', () => {
  it("is op's version when the CLI is installed", async () => {
    setOpRunner(async (args) => {
      expect(args).toEqual(['--version']);
      return { stdout: '2.31.1\n', stderr: '' };
    });
    expect(await cliVersion()).toBe('2.31.1');
  });

  it("is undefined when it isn't", async () => {
    setOpRunner(async () => Promise.reject(Object.assign(new Error('spawn op ENOENT'), { code: 'ENOENT' })));
    expect(await cliVersion()).toBeUndefined();
  });
});

describe('installHint', () => {
  it('gives the usual install command per OS, and always the docs', () => {
    expect(installHint('win32').command).toBe('winget install AgileBits.1Password.CLI');
    expect(installHint('darwin').command).toBe('brew install 1password-cli');
    expect(installHint('linux').command).toBeUndefined();
    expect(installHint('linux').docsUrl).toMatch(/^https:\/\/developer\.1password\.com\//);
  });
});

describe('opLocations', () => {
  it("knows where winget, Homebrew and the installers put op, for when it isn't on PATH", () => {
    const win = opLocations('win32', { LOCALAPPDATA: 'C:/Users/a/AppData/Local', ProgramFiles: 'C:/Program Files' });
    expect(win[0]).toMatch(/WinGet.Links.op\.exe$/);
    expect(win).toContainEqual(expect.stringMatching(/Program Files.1Password CLI.op\.exe$/));
    expect(opLocations('darwin', {})).toEqual(['/opt/homebrew/bin/op', '/usr/local/bin/op']);
  });
});
