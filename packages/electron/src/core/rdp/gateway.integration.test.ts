import { connect, type Socket } from 'node:net';
import WebSocket from 'ws';
import { afterAll, describe, expect, it } from 'vitest';

import { RdpGateway } from './gateway.js';
import { decodeRDCleanPath, encodeRDCleanPath, RDCLEANPATH_VERSION, type RDCleanPathPdu } from './rdcleanpath.js';

// The embedded viewer's gateway against a real Windows RDP server: the optional
// docker/windows-rdp-target container (see its README). Skipped when it isn't running —
// it's heavy, and not what CI starts.
const HOST = '127.0.0.1';
const PORT = 13389;

function reachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect(PORT, HOST);
    s.setTimeout(1500, () => (s.destroy(), resolve(false)));
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
  });
}
const windowsRunning = await reachable();

// A client's X.224 Connection Request asking for TLS or CredSSP (TPKT + X.224 CR +
// RDP_NEG_REQ with PROTOCOL_SSL | PROTOCOL_HYBRID).
const X224_REQUEST = Buffer.from('030000130ee000000000000100080003000000', 'hex');

function handshake(url: string, token: string): Promise<RDCleanPathPdu> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = 'nodebuffer';
    ws.once('open', () =>
      ws.send(encodeRDCleanPath({ version: RDCLEANPATH_VERSION, destination: 'ignored', proxyAuth: token, x224ConnectionPdu: X224_REQUEST }))
    );
    ws.once('message', (data: Buffer) => {
      resolve(decodeRDCleanPath(data));
      ws.close();
    });
    ws.once('error', reject);
  });
}

describe.skipIf(!windowsRunning)('RDP gateway against the Windows test target', () => {
  const gateway = new RdpGateway();
  afterAll(() => gateway.close());

  const target = (verify = async (): Promise<void> => {}) => ({
    host: HOST,
    port: PORT,
    open: () =>
      new Promise<Socket>((resolve, reject) => {
        const s = connect(PORT, HOST, () => resolve(s));
        s.once('error', reject);
      }),
    verifyCertificate: verify
  });

  it("answers with the server's X.224 confirm and certificate, then refuses the token again", async () => {
    const url = await gateway.url();
    let seen: Buffer[] = [];
    const token = gateway.register(target(async (chain) => void (seen = chain)));

    const response = await handshake(url, token);
    expect(response.error).toBeUndefined();
    // TPKT + X.224 Connection Confirm.
    expect(response.x224ConnectionPdu?.[0]).toBe(3);
    expect(response.x224ConnectionPdu?.[5]).toBe(0xd0);
    expect(response.serverCertChain?.length).toBeGreaterThan(0);
    expect(response.serverCertChain?.[0]).toEqual(seen[0]);
    expect(response.serverAddr).toBe(`${HOST}:${PORT}`);

    expect((await handshake(url, token)).error?.httpStatusCode).toBe(403);
  });

  it('stops when the certificate is refused, and says why', async () => {
    const url = await gateway.url();
    const token = gateway.register(target(async () => Promise.reject(new Error('certificate changed'))));
    expect((await handshake(url, token)).error).toBeDefined();
    expect(gateway.failure(token)).toBe('certificate changed');
  });
});
