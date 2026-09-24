import type { ClientChannel } from 'ssh2';
import { describe, expect, it } from 'vitest';

import { SshSession } from './session.js';
import { SftpManager } from './sftp.js';
import { testTargetHost } from '../../testSupport/sshTestTarget.js';

// Connection sharing against a real sshd. `$SSH_CONNECTION` names the client's source
// port, so two sessions reporting the same one are riding the same TCP connection.

async function sourcePort(session: SshSession): Promise<string> {
  const out = await session.runCommand('echo $SSH_CONNECTION');
  return out.trim().split(' ')[1];
}

describe('shared SSH sessions against the test target', () => {
  it('rides one connection for every shared session on a host', async () => {
    const a = await SshSession.shared(testTargetHost());
    const b = await SshSession.shared(testTargetHost());
    try {
      expect(await sourcePort(a)).toBe(await sourcePort(b));
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });

  it('closes the connection with its last session, so the next one dials afresh', async () => {
    const a = await SshSession.shared(testTargetHost());
    const first = await sourcePort(a);
    a.disconnect();
    const b = await SshSession.shared(testTargetHost());
    try {
      expect(await sourcePort(b)).not.toBe(first);
    } finally {
      b.disconnect();
    }
  });

  it('keeps an own connection (connect) out of the pool', async () => {
    const shared = await SshSession.shared(testTargetHost());
    const own = await SshSession.connect(testTargetHost());
    try {
      expect(await sourcePort(own)).not.toBe(await sourcePort(shared));
    } finally {
      shared.disconnect();
      own.disconnect();
    }
  });

  it('closing SFTP leaves the shared connection up for the rest', async () => {
    const shell = await SshSession.shared(testTargetHost());
    const sftp = await SftpManager.connect(testTargetHost());
    try {
      await sftp.listDir('/');
      sftp.disconnect();
      expect((await shell.runCommand('echo still-up')).trim()).toBe('still-up');
    } finally {
      shell.disconnect();
    }
  });

  it('moves to a connection of its own when the server refuses more channels', async () => {
    // sshd's default MaxSessions is 10: fifteen shells can't all fit on one connection.
    const sessions = await Promise.all(Array.from({ length: 3 }, () => SshSession.shared(testTargetHost())));
    const shells: ClientChannel[] = [];
    try {
      for (let i = 0; i < 15; i++) shells.push(await sessions[i % sessions.length].openShell(80, 24));
      expect(shells).toHaveLength(15);
      for (const s of sessions) expect((await s.runCommand('echo ok')).trim()).toBe('ok');
      // …which means at least one session really did leave the shared connection.
      const ports = new Set(await Promise.all(sessions.map(sourcePort)));
      expect(ports.size).toBeGreaterThan(1);
    } finally {
      for (const shell of shells) shell.end();
      for (const s of sessions) s.disconnect();
    }
  });
});
