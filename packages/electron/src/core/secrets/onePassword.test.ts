import { afterEach, describe, expect, it } from 'vitest';

import { isSecretReference, readSecret, setOpRunner } from './onePassword.js';

afterEach(() => setOpRunner(undefined));

describe('isSecretReference', () => {
  it('accepts vault/item/field and vault/item/section/field', () => {
    expect(isSecretReference('op://Servers/web-1/password')).toBe(true);
    expect(isSecretReference(' op://Servers/web-1/login/password ')).toBe(true);
  });

  it('refuses anything else', () => {
    for (const v of ['hunter2', 'op://Servers/web-1', 'op://Servers', 'https://x/y/z', 'op://a b/c/d', 'op://a/b/c/d/e']) {
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
