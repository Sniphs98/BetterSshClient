import { afterEach, describe, expect, it } from 'vitest';

import { setOpRunner } from '../secrets/onePassword.js';
import { SshSession } from './session.js';
import { testTargetHost } from '../../testSupport/sshTestTarget.js';

// A host whose password lives in 1Password, against the real test sshd. There is no
// 1Password in CI, so a stand-in `op` answers `op read` the way the real CLI does.

afterEach(() => setOpRunner(undefined));

describe('1Password password references against the test target', () => {
  it('logs in with the password read from the reference', async () => {
    const asked: string[] = [];
    setOpRunner(async (args) => {
      asked.push(args.join(' '));
      return { stdout: 'better-ssh-client', stderr: '' };
    });
    const host = testTargetHost({ password: undefined, passwordRef: 'op://Servers/it-op-ok/password' });
    const session = await SshSession.connect(host);
    try {
      expect((await session.runCommand('echo via-1password')).trim()).toBe('via-1password');
    } finally {
      session.disconnect();
    }
    expect(asked).toEqual(['read --no-newline op://Servers/it-op-ok/password']);
  });

  it("fails with 1Password's reason when the reference can't be read", async () => {
    setOpRunner(async () => {
      throw Object.assign(new Error('Command failed'), {
        code: 1,
        stderr: '[ERROR] 2026/09/25 20:00:00 could not read secret: item "gone" not found\n'
      });
    });
    const host = testTargetHost({ password: undefined, passwordRef: 'op://Servers/it-op-gone/password' });
    await expect(SshSession.connect(host)).rejects.toThrow(/SSH authentication failed .*item "gone" not found/);
  });
});
