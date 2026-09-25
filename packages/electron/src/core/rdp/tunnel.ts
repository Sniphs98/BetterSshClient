import { createHash } from 'node:crypto';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';

/**
 * A local port forwarded through an SSH host to an RDP server — `ssh -L` for one
 * Remote Desktop launch — so a Windows machine only reachable behind a bastion can
 * be connected to without opening 3389 to the world. The native client connects to
 * `address:port` on this machine.
 */

/** The SSH side: a way to open a channel to `host:port` as seen from the SSH host. */
export interface ForwardingSession {
  forward(host: string, port: number): Promise<Duplex>;
  disconnect(): void;
}

export interface RdpTunnel {
  address: string;
  port: number;
  /** Stops listening, drops the open channels and gives the SSH connection back. */
  close(): void;
  /** Resolves when the tunnel has closed, for whatever reason. */
  closed: Promise<void>;
}

/** How long the tunnel waits for the client's first connection, and after its last
 *  one closes, before shutting down on its own — for when there's no client process
 *  to watch (a `.rdp` file opened by some app), and as a backstop otherwise. mstsc
 *  reconnects after a network blip within this window. */
export const TUNNEL_IDLE_MS = 2 * 60_000;

/**
 * The loopback address to listen on. On Windows a stable one per profile out of
 * 127.0.0.0/8 rather than 127.0.0.1: mstsc files the saved password and the
 * certificate it was told to trust under the address it connects to, so two
 * tunnels mustn't share one, and a profile should keep its own across launches.
 * Other systems only route 127.0.0.1 by default (macOS) — FreeRDP doesn't care.
 */
export function tunnelAddress(profileId: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return '127.0.0.1';
  const [a, b, c] = createHash('sha256').update(profileId).digest();
  // 127.0.0.0/24 stays clear of 127.0.0.1 and the like; .0 and .255 are avoided.
  return `127.${(a % 254) + 1}.${b}.${(c % 253) + 1}`;
}

/**
 * Opens the tunnel. The target is checked by opening one channel first, so an
 * unreachable RDP server is an error here rather than a vague failure in the client.
 */
export async function openTunnel(
  session: ForwardingSession,
  target: { host: string; port: number },
  address: string,
  idleMs: number = TUNNEL_IDLE_MS
): Promise<RdpTunnel> {
  try {
    (await session.forward(target.host, target.port)).destroy();
  } catch (err) {
    session.disconnect();
    throw new Error(`The SSH host could not reach ${target.host}:${target.port}: ${(err as Error).message}`);
  }

  const sockets = new Set<Socket>();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let closing = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => (resolveClosed = resolve));

  const server = createServer((socket) => {
    clearTimeout(idleTimer);
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => {
      sockets.delete(socket);
      if (sockets.size === 0) armIdle();
    });
    socket.pause();
    session.forward(target.host, target.port).then(
      (channel) => {
        if (socket.destroyed) {
          channel.destroy();
          return;
        }
        channel.on('error', () => socket.destroy());
        socket.pipe(channel).pipe(socket);
        channel.once('close', () => socket.destroy());
        socket.once('close', () => channel.destroy());
        socket.resume();
      },
      () => socket.destroy()
    );
  });

  const close = (): void => {
    if (closing) return;
    closing = true;
    clearTimeout(idleTimer);
    server.close();
    for (const socket of sockets) socket.destroy();
    session.disconnect();
    resolveClosed();
  };

  function armIdle(): void {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(close, idleMs);
    idleTimer.unref?.();
  }

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, address, () => resolve());
    });
  } catch (err) {
    session.disconnect();
    throw err;
  }
  server.on('error', close);
  armIdle();

  return { address, port: (server.address() as AddressInfo).port, close, closed };
}
