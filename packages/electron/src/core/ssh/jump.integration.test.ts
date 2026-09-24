import { afterEach, describe, expect, it } from 'vitest';

import { SshSession, useHosts } from './session.js';
import { testTargetHost } from '../../testSupport/sshTestTarget.js';

// ProxyJump against a real sshd: the test container acts as its own bastion, and the
// "target" is its sshd again as seen from inside the container (`localhost:22`), so the
// second hop really does ride a direct-tcpip stream through the first and authenticates
// over it.

describe('ProxyJump against the test target', () => {
  const bastion = testTargetHost({ name: 'it-bastion' });
  const target = testTargetHost({ name: 'it-behind-bastion', hostname: 'localhost', port: 22, proxyJump: 'it-bastion' });

  afterEach(() => useHosts([]));

  it('reaches a host through its bastion, resolved from the app host list', async () => {
    // Neither host is in any config file — the chain can only come from `useHosts`.
    useHosts([bastion, target]);
    const session = await SshSession.connect(target);
    try {
      // Seen from the target, the connection comes from inside the container.
      const from = (await session.runCommand('echo $SSH_CONNECTION')).trim().split(' ')[0];
      expect(['127.0.0.1', '::1']).toContain(from);
    } finally {
      session.disconnect();
    }
  });

  it('rejects wrong credentials on the far side of the tunnel', async () => {
    const locked = { ...target, password: 'definitely-not-it' };
    useHosts([bastion, locked]);
    await expect(SshSession.connect(locked)).rejects.toThrow(/via 'it-bastion' failed: SSH authentication failed/);
  });
});
