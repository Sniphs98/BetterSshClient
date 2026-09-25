import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import type { Duplex } from 'node:stream';
import { connect as tlsConnect, type TLSSocket, type PeerCertificate, type DetailedPeerCertificate } from 'node:tls';
import { WebSocketServer, type WebSocket } from 'ws';

import { decodeRDCleanPath, encodeRDCleanPath, GENERAL_ERROR_CODE, RDCLEANPATH_VERSION } from './rdcleanpath.js';

/**
 * The local end of an embedded RDP session: a WebSocket server on 127.0.0.1 that
 * IronRDP's web client connects to (see rdcleanpath.ts for the protocol). It connects
 * to the RDP server itself — directly or through an SSH channel — does the TLS the
 * browser can't, and then relays the plain RDP stream.
 *
 * Nothing but a registered session gets through: each has a random one-time token
 * the client presents as its "proxy auth", and the destination is the one registered
 * with it, never the one the client asks for.
 */

export interface GatewayTarget {
  /** Opens the byte stream to the RDP server (a TCP socket or an SSH channel). */
  open(): Promise<Duplex>;
  /** Shown as the server address; also names the server for TLS. */
  host: string;
  port: number;
  /** Checks the server's certificate before anything is relayed; rejecting stops the
   *  session. */
  verifyCertificate(chain: Buffer[]): Promise<void>;
}

/** Reads one TPKT-framed packet (the X.224 connection confirm) off `stream`. */
function readTpkt(stream: Duplex, timeoutMs = 15_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => done(new Error('the RDP server did not answer')), timeoutMs);
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 4) return;
      if (buf[0] !== 3) return done(new Error('the server did not answer like an RDP server'));
      const length = buf.readUInt16BE(2);
      if (buf.length < length) return;
      // Anything past the confirm would be the server talking before TLS — it doesn't.
      done(undefined, buf.subarray(0, length));
    };
    const onEnd = (): void => done(new Error('the RDP server closed the connection'));
    const onError = (err: Error): void => done(err);
    function done(err?: Error, packet?: Buffer): void {
      clearTimeout(timer);
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onError);
      stream.pause();
      if (err) reject(err);
      else resolve(packet!);
    }
    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('error', onError);
  });
}

/** The DER chain the server presented, leaf first. */
function certificateChain(socket: TLSSocket): Buffer[] {
  const chain: Buffer[] = [];
  let cert: PeerCertificate | DetailedPeerCertificate | undefined = socket.getPeerCertificate(true);
  const seen = new Set<string>();
  while (cert && cert.raw && !seen.has(cert.fingerprint256)) {
    seen.add(cert.fingerprint256);
    chain.push(cert.raw);
    cert = (cert as DetailedPeerCertificate).issuerCertificate;
  }
  return chain;
}

/**
 * TLS 1.2 with RSA key exchange only. Windows' self-signed RDP certificates carry a
 * key usage of "key encipherment" and not "digital signature", which BoringSSL — what
 * Electron runs on — enforces: with an ECDHE suite the server signs the key exchange,
 * and the handshake fails with KEY_USAGE_BIT_INCORRECT. RSA key exchange uses the
 * key exactly as the certificate allows. Only used when the normal handshake failed
 * like that (found against a real Windows).
 */
const RSA_KEY_EXCHANGE = {
  maxVersion: 'TLSv1.2' as const,
  ciphers: 'AES256-GCM-SHA384:AES128-GCM-SHA256:AES256-SHA256:AES128-SHA256:AES256-SHA:AES128-SHA'
};

export function isKeyUsageError(err: unknown): boolean {
  return /KEY_USAGE_BIT_INCORRECT/i.test(String((err as Error)?.message ?? err));
}

function startTls(stream: Duplex, host: string, rsaKeyExchange: boolean): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({
      socket: stream,
      // RDP servers present self-signed certificates; trust is decided by
      // GatewayTarget.verifyCertificate (trust on first use) instead of a CA.
      rejectUnauthorized: false,
      servername: isIP(host) ? undefined : host,
      ...(rsaKeyExchange ? RSA_KEY_EXCHANGE : {})
    });
    socket.once('secureConnect', () => resolve(socket));
    socket.once('error', reject);
  });
}

/** Opens the stream, forwards the client's X.224 request and completes TLS. */
async function establish(
  target: GatewayTarget,
  x224Request: Buffer,
  rsaKeyExchange: boolean
): Promise<{ confirm: Buffer; tls: TLSSocket }> {
  let stream: Duplex;
  try {
    stream = await target.open();
  } catch (err) {
    throw Object.assign(new Error(`could not reach ${target.host}:${target.port}: ${(err as Error).message}`), { status: 502 });
  }
  try {
    stream.write(x224Request);
    const confirm = await readTpkt(stream);
    const tls = await startTls(stream, target.host, rsaKeyExchange);
    return { confirm, tls };
  } catch (err) {
    stream.destroy();
    throw err;
  }
}

function errorPdu(details: { httpStatusCode?: number; tlsAlertCode?: number }): Buffer {
  return encodeRDCleanPath({ version: RDCLEANPATH_VERSION, error: { errorCode: GENERAL_ERROR_CODE, ...details } });
}

export class RdpGateway {
  private server: WebSocketServer | undefined;
  private port = 0;
  private readonly targets = new Map<string, GatewayTarget>();
  /** Why a session's handshake failed, for the UI — the web client only gets a code. */
  private readonly failures = new Map<string, string>();

  /** Starts listening, if not yet, and returns the WebSocket URL. */
  async url(): Promise<string> {
    if (!this.server) {
      const server = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 16 * 1024 * 1024 });
      await new Promise<void>((resolve, reject) => {
        server.once('listening', () => resolve());
        server.once('error', reject);
      });
      server.on('connection', (ws) => this.handle(ws));
      this.server = server;
      this.port = (server.address() as { port: number }).port;
    }
    return `ws://127.0.0.1:${this.port}/`;
  }

  /** Registers a session and returns its one-time token. */
  register(target: GatewayTarget): string {
    const token = randomBytes(24).toString('base64url');
    this.targets.set(token, target);
    return token;
  }

  revoke(token: string): void {
    this.targets.delete(token);
    this.failures.delete(token);
  }

  failure(token: string): string | undefined {
    return this.failures.get(token);
  }

  close(): void {
    this.server?.close();
    this.server = undefined;
    this.targets.clear();
  }

  private handle(ws: WebSocket): void {
    ws.binaryType = 'nodebuffer';
    ws.once('message', (data: Buffer) => void this.handshake(ws, data));
  }

  private async handshake(ws: WebSocket, data: Buffer): Promise<void> {
    let token: string | undefined;
    let stream: Duplex | undefined;
    try {
      const request = decodeRDCleanPath(Buffer.from(data));
      token = request.proxyAuth;
      const target = token ? this.targets.get(token) : undefined;
      if (!token || !target) {
        ws.send(errorPdu({ httpStatusCode: 403 }));
        ws.close();
        return;
      }
      // One connection per token: a replayed token gets nothing.
      this.targets.delete(token);
      if (!request.x224ConnectionPdu) throw Object.assign(new Error('no X.224 connection request'), { status: 400 });

      let established;
      try {
        established = await establish(target, request.x224ConnectionPdu, false);
      } catch (err) {
        if (!isKeyUsageError(err)) throw err;
        established = await establish(target, request.x224ConnectionPdu, true);
      }
      const { confirm, tls } = established;
      stream = tls;
      const chain = certificateChain(tls);
      await target.verifyCertificate(chain);

      ws.send(
        encodeRDCleanPath({
          version: RDCLEANPATH_VERSION,
          x224ConnectionPdu: confirm,
          serverCertChain: chain,
          serverAddr: `${target.host}:${target.port}`
        })
      );
      this.relay(ws, tls);
    } catch (err) {
      const e = err as Error & { status?: number };
      if (token) this.failures.set(token, e.message);
      if (ws.readyState === ws.OPEN) {
        ws.send(errorPdu({ httpStatusCode: e.status ?? 502 }));
        ws.close();
      }
      stream?.destroy();
    }
  }

  private relay(ws: WebSocket, tls: TLSSocket): void {
    ws.on('message', (chunk: Buffer) => {
      if (!tls.destroyed) tls.write(chunk);
    });
    tls.on('data', (chunk: Buffer) => {
      if (ws.readyState === ws.OPEN) ws.send(chunk);
    });
    // Backpressure is left to TCP: RDP's own flow control keeps bursts short.
    const closeBoth = (): void => {
      tls.destroy();
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close();
    };
    ws.once('close', closeBoth);
    ws.once('error', closeBoth);
    tls.once('close', closeBoth);
    tls.once('error', closeBoth);
    tls.resume();
  }
}
