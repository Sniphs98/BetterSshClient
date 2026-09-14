import { describe, expect, it } from 'vitest';
import { SshSession } from './session.js';
import { testTargetHost } from '../../testSupport/sshTestTarget.js';

// Runs against the disposable local SSH test container (`docker compose up -d --build`
// at the repo root — see docker/ssh-test-target/README.md). Everything else in this
// package mocks ssh2 or tests pure logic; this is the one place that actually speaks
// SSH to a real sshd. Opt-in only — `npm run test:integration`.

describe('SshSession against the test target', () => {
  it('connects with a password and runs a command', async () => {
    const session = await SshSession.connect(testTargetHost());
    try {
      const output = await session.runCommand('echo hello-from-omnyssh');
      expect(output.trim()).toBe('hello-from-omnyssh');
    } finally {
      session.disconnect();
    }
  });

  it('learns the host key on first connect (TOFU) and accepts it again on a second connection', async () => {
    // Two connections both succeeding is exactly what "the second one found an
    // already-known, matching host key" looks like from the outside — a mismatch or an
    // unreadable known_hosts would instead reject the connection (knownHosts.ts).
    const a = await SshSession.connect(testTargetHost());
    a.disconnect();
    const b = await SshSession.connect(testTargetHost());
    b.disconnect();
  });

  it('runCommandChecked throws on a non-zero exit, runCommand does not', async () => {
    const session = await SshSession.connect(testTargetHost());
    try {
      await expect(session.runCommandChecked('exit 7')).rejects.toThrow();
      await expect(session.runCommand('exit 7').then((o) => o.trim())).resolves.toBe('');
    } finally {
      session.disconnect();
    }
  });

  it('rejects a wrong password', async () => {
    await expect(SshSession.connect(testTargetHost({ password: 'definitely-not-it' }))).rejects.toThrow();
  });
});
