import { describe, expect, it } from 'vitest';

import { decodeRDCleanPath, encodeRDCleanPath, GENERAL_ERROR_CODE, RDCLEANPATH_VERSION } from './rdcleanpath.js';

// Byte-exact vectors from IronRDP's own test suite
// (crates/ironrdp-testsuite-core/tests/rdcleanpath.rs), so this speaks exactly what the
// web client's Rust side encodes and expects.
const hex = (s: string): Buffer => Buffer.from(s.replace(/\s+/g, ''), 'hex');
const DEADBEEF = hex('DEADBEFF');

const REQUEST = hex(
  '30 32 A0 04 02 02 0D 3E A2 0D 0C 0B 64 65 73 74 69 6E 61 74 69 6F 6E A3 0C 0C 0A 70 72 6F 78 79 20 61 75 74 68 A5 05 0C 03 50 43 42 A6 06 04 04 DE AD BE FF'
);
const RESPONSE = hex(
  '30 34 A0 04 02 02 0D 3E A6 06 04 04 DE AD BE FF A7 14 30 12 04 04 DE AD BE FF 04 04 DE AD BE FF 04 04 DE AD BE FF A9 0E 0C 0C 31 39 32 2E 31 36 38 2E 37 2E 39 35'
);
const HTTP_ERROR = hex('30 15 A0 04 02 02 0D 3E A1 0D 30 0B A0 03 02 01 01 A1 04 02 02 01 F4');
const TLS_ERROR = hex('30 14 A0 04 02 02 0D 3E A1 0C 30 0A A0 03 02 01 01 A3 03 02 01 30');

describe('RDCleanPath', () => {
  it("decodes the web client's request", () => {
    expect(decodeRDCleanPath(REQUEST)).toEqual({
      version: RDCLEANPATH_VERSION,
      destination: 'destination',
      proxyAuth: 'proxy auth',
      preconnectionBlob: 'PCB',
      x224ConnectionPdu: DEADBEEF
    });
  });

  it('encodes the response exactly as IronRDP does', () => {
    const response = encodeRDCleanPath({
      version: RDCLEANPATH_VERSION,
      x224ConnectionPdu: DEADBEEF,
      serverCertChain: [DEADBEEF, DEADBEEF, DEADBEEF],
      serverAddr: '192.168.7.95'
    });
    expect(response.toString('hex')).toBe(RESPONSE.toString('hex'));
  });

  it('encodes errors exactly as IronRDP does', () => {
    const http = encodeRDCleanPath({ version: RDCLEANPATH_VERSION, error: { errorCode: GENERAL_ERROR_CODE, httpStatusCode: 500 } });
    expect(http.toString('hex')).toBe(HTTP_ERROR.toString('hex'));
    const tls = encodeRDCleanPath({ version: RDCLEANPATH_VERSION, error: { errorCode: GENERAL_ERROR_CODE, tlsAlertCode: 48 } });
    expect(tls.toString('hex')).toBe(TLS_ERROR.toString('hex'));
  });

  it('round-trips, including long lengths (a real certificate is over 127 bytes)', () => {
    const cert = Buffer.alloc(1500, 7);
    const pdu = { version: RDCLEANPATH_VERSION, serverCertChain: [cert], serverAddr: '10.0.0.5:3389', x224ConnectionPdu: DEADBEEF };
    expect(decodeRDCleanPath(encodeRDCleanPath(pdu))).toEqual(pdu);
  });

  it('rejects truncated or malformed input rather than misreading it', () => {
    expect(() => decodeRDCleanPath(REQUEST.subarray(0, 20))).toThrow('truncated');
    expect(() => decodeRDCleanPath(Buffer.concat([REQUEST, Buffer.from([0])]))).toThrow('trailing');
    expect(() => decodeRDCleanPath(hex('30 00'))).toThrow('no version');
  });
});
