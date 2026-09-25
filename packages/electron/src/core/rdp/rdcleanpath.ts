/**
 * RDCleanPath — the handshake IronRDP's web client does with a proxy before speaking
 * RDP over a WebSocket. A browser can't open TCP or do the TLS an RDP server wants,
 * so the client sends its first RDP packet (the X.224 connection request) wrapped in
 * this PDU; the proxy connects, forwards it, completes TLS with the server, and
 * answers with the server's X.224 reply and certificate chain (the client needs the
 * server's public key for CredSSP). From then on the WebSocket carries plain RDP and
 * the proxy relays it into the TLS stream.
 *
 * The PDU is DER, every field EXPLICIT-tagged [n] in one SEQUENCE — as defined in
 * IronRDP's `ironrdp-rdcleanpath` crate:
 *
 *   RDCleanPathPdu ::= SEQUENCE {
 *     version            [0] INTEGER,           -- 3390
 *     error              [1] RDCleanPathErr OPTIONAL,
 *     destination        [2] UTF8String OPTIONAL,
 *     proxyAuth          [3] UTF8String OPTIONAL,
 *     serverAuth         [4] UTF8String OPTIONAL,
 *     preconnectionBlob  [5] UTF8String OPTIONAL,
 *     x224ConnectionPdu  [6] OCTET STRING OPTIONAL,
 *     serverCertChain    [7] SEQUENCE OF OCTET STRING OPTIONAL,
 *     serverAddr         [9] UTF8String OPTIONAL }
 *
 *   RDCleanPathErr ::= SEQUENCE {
 *     errorCode       [0] INTEGER,
 *     httpStatusCode  [1] INTEGER OPTIONAL,
 *     wsaLastError    [2] INTEGER OPTIONAL,
 *     tlsAlertCode    [3] INTEGER OPTIONAL }
 */

export const RDCLEANPATH_VERSION = 3390;
export const GENERAL_ERROR_CODE = 1;

export interface RDCleanPathError {
  errorCode: number;
  httpStatusCode?: number;
  wsaLastError?: number;
  tlsAlertCode?: number;
}

export interface RDCleanPathPdu {
  version: number;
  error?: RDCleanPathError;
  destination?: string;
  proxyAuth?: string;
  serverAuth?: string;
  preconnectionBlob?: string;
  x224ConnectionPdu?: Buffer;
  serverCertChain?: Buffer[];
  serverAddr?: string;
}

const SEQUENCE = 0x30;
const INTEGER = 0x02;
const OCTET_STRING = 0x04;
const UTF8_STRING = 0x0c;
const context = (n: number): number => 0xa0 | n;

function encodeLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  for (let n = length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(value.length), value]);
}

function integer(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0) throw new Error(`cannot encode ${value} as an unsigned INTEGER`);
  const bytes: number[] = [];
  for (let n = value; n > 0; n = Math.floor(n / 256)) bytes.unshift(n % 256);
  if (bytes.length === 0) bytes.push(0);
  if (bytes[0] & 0x80) bytes.unshift(0); // keep it positive
  return tlv(INTEGER, Buffer.from(bytes));
}

const utf8 = (value: string): Buffer => tlv(UTF8_STRING, Buffer.from(value, 'utf8'));
const field = (n: number, value: Buffer): Buffer => tlv(context(n), value);

export function encodeRDCleanPath(pdu: RDCleanPathPdu): Buffer {
  const parts: Buffer[] = [field(0, integer(pdu.version))];
  if (pdu.error) {
    const e = pdu.error;
    const inner = [field(0, integer(e.errorCode))];
    if (e.httpStatusCode !== undefined) inner.push(field(1, integer(e.httpStatusCode)));
    if (e.wsaLastError !== undefined) inner.push(field(2, integer(e.wsaLastError)));
    if (e.tlsAlertCode !== undefined) inner.push(field(3, integer(e.tlsAlertCode)));
    parts.push(field(1, tlv(SEQUENCE, Buffer.concat(inner))));
  }
  if (pdu.destination !== undefined) parts.push(field(2, utf8(pdu.destination)));
  if (pdu.proxyAuth !== undefined) parts.push(field(3, utf8(pdu.proxyAuth)));
  if (pdu.serverAuth !== undefined) parts.push(field(4, utf8(pdu.serverAuth)));
  if (pdu.preconnectionBlob !== undefined) parts.push(field(5, utf8(pdu.preconnectionBlob)));
  if (pdu.x224ConnectionPdu !== undefined) parts.push(field(6, tlv(OCTET_STRING, pdu.x224ConnectionPdu)));
  if (pdu.serverCertChain !== undefined) {
    const certs = Buffer.concat(pdu.serverCertChain.map((c) => tlv(OCTET_STRING, c)));
    parts.push(field(7, tlv(SEQUENCE, certs)));
  }
  if (pdu.serverAddr !== undefined) parts.push(field(9, utf8(pdu.serverAddr)));
  return tlv(SEQUENCE, Buffer.concat(parts));
}

interface Tlv {
  tag: number;
  value: Buffer;
  /** Offset just past this element. */
  end: number;
}

function readTlv(buf: Buffer, offset: number): Tlv {
  if (offset + 2 > buf.length) throw new Error('RDCleanPath: truncated');
  const tag = buf[offset];
  let length = buf[offset + 1];
  let at = offset + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 4 || at + count > buf.length) throw new Error('RDCleanPath: bad length');
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + buf[at + i];
    at += count;
  }
  if (at + length > buf.length) throw new Error('RDCleanPath: truncated');
  return { tag, value: buf.subarray(at, at + length), end: at + length };
}

function children(buf: Buffer): Tlv[] {
  const out: Tlv[] = [];
  for (let at = 0; at < buf.length; ) {
    const t = readTlv(buf, at);
    out.push(t);
    at = t.end;
  }
  return out;
}

function expect(t: Tlv, tag: number, what: string): Buffer {
  if (t.tag !== tag) throw new Error(`RDCleanPath: ${what} has tag 0x${t.tag.toString(16)}`);
  return t.value;
}

function readInteger(t: Tlv, what: string): number {
  const bytes = expect(t, INTEGER, what);
  if (bytes.length === 0 || bytes.length > 7) throw new Error(`RDCleanPath: ${what} out of range`);
  let n = 0;
  for (const b of bytes) n = n * 256 + b;
  return n;
}

const inner = (t: Tlv): Tlv => readTlv(t.value, 0);

export function decodeRDCleanPath(buf: Buffer): RDCleanPathPdu {
  const outer = readTlv(buf, 0);
  if (outer.end !== buf.length) throw new Error('RDCleanPath: trailing bytes');
  const pdu: Partial<RDCleanPathPdu> = {};
  for (const f of children(expect(outer, SEQUENCE, 'PDU'))) {
    switch (f.tag) {
      case context(0):
        pdu.version = readInteger(inner(f), 'version');
        break;
      case context(1): {
        const err: Partial<RDCleanPathError> = {};
        for (const e of children(expect(inner(f), SEQUENCE, 'error'))) {
          const n = readInteger(inner(e), 'error field');
          if (e.tag === context(0)) err.errorCode = n;
          else if (e.tag === context(1)) err.httpStatusCode = n;
          else if (e.tag === context(2)) err.wsaLastError = n;
          else if (e.tag === context(3)) err.tlsAlertCode = n;
        }
        if (err.errorCode === undefined) throw new Error('RDCleanPath: error without a code');
        pdu.error = err as RDCleanPathError;
        break;
      }
      case context(2):
        pdu.destination = expect(inner(f), UTF8_STRING, 'destination').toString('utf8');
        break;
      case context(3):
        pdu.proxyAuth = expect(inner(f), UTF8_STRING, 'proxy auth').toString('utf8');
        break;
      case context(4):
        pdu.serverAuth = expect(inner(f), UTF8_STRING, 'server auth').toString('utf8');
        break;
      case context(5):
        pdu.preconnectionBlob = expect(inner(f), UTF8_STRING, 'preconnection blob').toString('utf8');
        break;
      case context(6):
        pdu.x224ConnectionPdu = Buffer.from(expect(inner(f), OCTET_STRING, 'X.224 PDU'));
        break;
      case context(7):
        pdu.serverCertChain = children(expect(inner(f), SEQUENCE, 'certificate chain')).map((c) =>
          Buffer.from(expect(c, OCTET_STRING, 'certificate'))
        );
        break;
      case context(9):
        pdu.serverAddr = expect(inner(f), UTF8_STRING, 'server address').toString('utf8');
        break;
      default:
        // An unknown field from a newer client: skipped, as DER SEQUENCE extension allows.
        break;
    }
  }
  if (pdu.version === undefined) throw new Error('RDCleanPath: no version');
  return pdu as RDCleanPathPdu;
}
