import { connect, createServer, type Server } from 'node:net';
import { PassThrough, type Duplex } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { openTunnel, tunnelAddress, type ForwardingSession } from './tunnel.js';

/** A session whose "SSH host" can reach one TCP server on this machine. */
function sessionTo(server: Server): ForwardingSession & { disconnect: ReturnType<typeof vi.fn> } {
  const { port } = server.address() as { port: number };
  return {
    forward: (host, p) =>
      new Promise<Duplex>((resolve, reject) => {
        if (host !== 'rdp.internal' || p !== 3389) return reject(new Error('connect failed'));
        const socket = connect(port, '127.0.0.1', () => resolve(socket));
        socket.once('error', reject);
      }),
    disconnect: vi.fn()
  };
}

async function echoServer(): Promise<Server> {
  const server = createServer((s) => s.pipe(s));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return server;
}

function roundTrip(port: number, address: string, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, address, () => socket.write(text));
    socket.once('data', (d) => {
      resolve(d.toString());
      socket.destroy();
    });
    socket.once('error', reject);
  });
}

describe('tunnelAddress', () => {
  it('is a stable loopback address per profile on Windows, never 127.0.0.1', () => {
    const a = tunnelAddress('profile-a', 'win32');
    expect(a).toMatch(/^127\.\d+\.\d+\.\d+$/);
    expect(a).not.toBe('127.0.0.1');
    expect(tunnelAddress('profile-a', 'win32')).toBe(a);
    expect(tunnelAddress('profile-b', 'win32')).not.toBe(a);
  });

  it('is 127.0.0.1 elsewhere, the only loopback address macOS routes', () => {
    expect(tunnelAddress('profile-a', 'darwin')).toBe('127.0.0.1');
    expect(tunnelAddress('profile-a', 'linux')).toBe('127.0.0.1');
  });
});

describe('openTunnel', () => {
  let server: Server | undefined;

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it('forwards local connections through the session to the target', async () => {
    server = await echoServer();
    const session = sessionTo(server);
    const tunnel = await openTunnel(session, { host: 'rdp.internal', port: 3389 }, '127.0.0.1');

    expect(await roundTrip(tunnel.port, tunnel.address, 'hello')).toBe('hello');
    expect(await roundTrip(tunnel.port, tunnel.address, 'again')).toBe('again');

    tunnel.close();
    await tunnel.closed;
    expect(session.disconnect).toHaveBeenCalledTimes(1);
    await expect(roundTrip(tunnel.port, tunnel.address, 'x')).rejects.toThrow();
  });

  it('fails up front, and hangs up, when the SSH host cannot reach the target', async () => {
    server = await echoServer();
    const session = sessionTo(server);

    await expect(openTunnel(session, { host: 'elsewhere', port: 3389 }, '127.0.0.1')).rejects.toThrow(
      'The SSH host could not reach elsewhere:3389: connect failed'
    );
    expect(session.disconnect).toHaveBeenCalledTimes(1);
  });

  it('closes on its own when nothing connects, or once the last connection is gone', async () => {
    server = await echoServer();
    const unused = await openTunnel(sessionTo(server), { host: 'rdp.internal', port: 3389 }, '127.0.0.1', 50);
    await unused.closed;

    const used = await openTunnel(sessionTo(server), { host: 'rdp.internal', port: 3389 }, '127.0.0.1', 150);
    const socket = connect(used.port, used.address);
    await new Promise((r) => setTimeout(r, 300));
    let closed = false;
    void used.closed.then(() => (closed = true));
    await new Promise((r) => setImmediate(r));
    expect(closed).toBe(false); // still in use
    socket.destroy();
    await used.closed;
  });
});
