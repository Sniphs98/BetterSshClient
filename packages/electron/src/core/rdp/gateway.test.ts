import { Duplex } from 'node:stream';
import WebSocket from 'ws';
import { afterAll, describe, expect, it } from 'vitest';

import { RdpGateway, type GatewayStage } from './gateway.js';
import { decodeRDCleanPath, encodeRDCleanPath, RDCLEANPATH_VERSION, type RDCleanPathPdu } from './rdcleanpath.js';

// The stages the gateway reports for the "connecting" screen, without a real RDP server:
// a target that can't be opened, and one that answers like no RDP server would.
const X224_REQUEST = Buffer.from('030000130ee000000000000100080003000000', 'hex');

function handshake(url: string, token: string): Promise<RDCleanPathPdu> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = 'nodebuffer';
    ws.once('open', () =>
      ws.send(encodeRDCleanPath({ version: RDCLEANPATH_VERSION, destination: 'x', proxyAuth: token, x224ConnectionPdu: X224_REQUEST }))
    );
    ws.once('message', (data: Buffer) => {
      resolve(decodeRDCleanPath(data));
      ws.close();
    });
    ws.once('error', reject);
  });
}

describe('RdpGateway stages', () => {
  const gateway = new RdpGateway();
  afterAll(() => gateway.close());

  it('reports reaching the server, and stops there when it cannot be reached', async () => {
    const stages: GatewayStage[] = [];
    const token = gateway.register({
      host: '10.0.0.5',
      port: 3389,
      open: () => Promise.reject(new Error('connection refused')),
      verifyCertificate: async () => {},
      onStage: (s) => stages.push(s)
    });
    expect((await handshake(await gateway.url(), token)).error).toBeDefined();
    expect(stages).toEqual(['reach']);
    expect(gateway.failure(token)).toMatch(/could not reach 10\.0\.0\.5:3389: connection refused/);
  });

  it('reports securing once the server is reached, and never signing in when the handshake fails', async () => {
    const stages: GatewayStage[] = [];
    const token = gateway.register({
      host: '10.0.0.5',
      port: 3389,
      open: async () => {
        // Answers the X.224 request with something that isn't TPKT.
        const stream: Duplex = new Duplex({
          read() {},
          write(_chunk, _encoding, done) {
            stream.push(Buffer.from('HTTP/1.1 400 Bad Request\r\n\r\n'));
            done();
          }
        });
        return stream;
      },
      verifyCertificate: async () => {},
      onStage: (s) => stages.push(s)
    });
    expect((await handshake(await gateway.url(), token)).error).toBeDefined();
    expect(stages).toEqual(['reach', 'secure']);
    expect(gateway.failure(token)).toMatch(/did not answer like an RDP server/);
  });
});
