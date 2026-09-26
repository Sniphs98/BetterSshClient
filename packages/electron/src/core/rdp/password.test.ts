import { afterEach, describe, expect, it, vi } from 'vitest';

import { clearSecretCache, setOpRunner } from '../secrets/onePassword.js';
import { connectionPassword } from './password.js';

describe('connectionPassword', () => {
  afterEach(() => {
    setOpRunner(undefined);
    clearSecretCache();
  });

  it('is the stored password when there is no 1Password reference', async () => {
    expect(await connectionPassword({ password: 'stored' })).toBe('stored');
    expect(await connectionPassword({})).toBeUndefined();
  });

  it('comes from 1Password when there is a reference — which wins over a stored one', async () => {
    const op = vi.fn(async () => ({ stdout: 'from-1password', stderr: '' }));
    setOpRunner(op);
    expect(await connectionPassword({ password: 'stored', passwordRef: 'op://Servers/win11/password' })).toBe('from-1password');
    expect(op).toHaveBeenCalledWith(['read', '--no-newline', 'op://Servers/win11/password']);
  });

  it('asks 1Password once for a while, however often it connects', async () => {
    const op = vi.fn(async () => ({ stdout: 'secret', stderr: '' }));
    setOpRunner(op);
    await connectionPassword({ passwordRef: 'op://Servers/win11/password' });
    await connectionPassword({ passwordRef: 'op://Servers/win11/password' });
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("says what's wrong when 1Password can't be asked", async () => {
    setOpRunner(async () => Promise.reject(Object.assign(new Error('spawn op ENOENT'), { code: 'ENOENT' })));
    await expect(connectionPassword({ passwordRef: 'op://Servers/win11/password' })).rejects.toThrow('1Password CLI (op) not found');
  });
});
