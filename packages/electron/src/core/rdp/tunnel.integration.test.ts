import { connect } from 'node:net';
import { describe, expect, it } from 'vitest';

import { SshSession } from '../ssh/session.js';
import { testTargetHost } from '../../testSupport/sshTestTarget.js';
import { openTunnel } from './tunnel.js';

// The RDP tunnel through a real sshd (the test container — see
// docker/ssh-test-target/README.md). The container has no RDP server, so the target is
// its own sshd on port 22: what comes back through the tunnel is its SSH banner.

function firstBytes(port: number, address: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, address);
    socket.once('data', (d) => {
      resolve(d.toString());
      socket.destroy();
    });
    socket.once('error', reject);
  });
}

describe('RDP tunnel against the test target', () => {
  it('forwards a local port to a service behind the SSH host', async () => {
    const tunnel = await openTunnel(await SshSession.connect(testTargetHost()), { host: '127.0.0.1', port: 22 }, '127.0.0.1');
    try {
      expect(await firstBytes(tunnel.port, tunnel.address)).toMatch(/^SSH-2\.0-/);
      // A second connection, like mstsc's reconnect, gets its own channel.
      expect(await firstBytes(tunnel.port, tunnel.address)).toMatch(/^SSH-2\.0-/);
    } finally {
      tunnel.close();
    }
  });

  it('reports a target the SSH host cannot reach before anything connects', async () => {
    await expect(
      openTunnel(await SshSession.connect(testTargetHost()), { host: '127.0.0.1', port: 3389 }, '127.0.0.1')
    ).rejects.toThrow('The SSH host could not reach 127.0.0.1:3389');
  });
});
