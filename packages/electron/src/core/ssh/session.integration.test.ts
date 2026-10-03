import { describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
      const output = await session.runCommand('echo hello-from-remoty');
      expect(output.trim()).toBe('hello-from-remoty');
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

  it('says the host key changed — not that sign-in failed — when known_hosts has another key for it', async () => {
    const host = testTargetHost();
    const knownHosts = join(homedir(), '.ssh', 'known_hosts');
    const before = await readFile(knownHosts, 'utf8');
    // Someone else's key for the same address, as after the server is rebuilt.
    const other = 'AAAAC3NzaC1lZDI1NTE5AAAAII1Ttb2Ow0fXVGO5dy/kSR1P9yErPHQ/6gmJp7g57kvS';
    await writeFile(knownHosts, `[${host.hostname}]:${host.port} ssh-ed25519 ${other}\n`);
    try {
      const err = await SshSession.connect(host).then(
        (s) => (s.disconnect(), undefined),
        (e: unknown) => e
      );
      expect((err as Error).message).toMatch(/host key of ssh-test-target .* has changed/);
      expect((err as Error).message).not.toMatch(/authentication failed/);
      expect((err as Error).message).toContain(`ssh-keygen -R "[${host.hostname}]:${host.port}"`);
    } finally {
      await writeFile(knownHosts, before);
    }
  });

  it('rejects a wrong password', async () => {
    await expect(SshSession.connect(testTargetHost({ password: 'definitely-not-it' }))).rejects.toThrow();
  });
});
