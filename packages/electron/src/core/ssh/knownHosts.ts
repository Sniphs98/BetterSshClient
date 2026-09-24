import { appendFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Host-key verification against `~/.ssh/known_hosts`. Ported from the
 * `KnownHostsHandler` policy in crates/omnyssh-core/src/ssh/session.rs — a
 * plain-format (non-hashed) TOFU implementation, since `ssh2` has no
 * built-in known_hosts support.
 *
 * Policy:
 * - Known and matches → accept.
 * - Unknown → accept and record (Trust On First Use); recording is
 *   best-effort and never fails the connection.
 * - Key changed → reject (possible MITM).
 * - `known_hosts` unreadable/corrupt → fail closed.
 *
 * Only plain (non-`HashKnownHosts`) entries are matched. A hashed entry is
 * neither matched nor overwritten — it is simply invisible to this check,
 * so a host recorded only in hashed form is treated as unknown (TOFU
 * re-adds it in plain form alongside).
 */

export type KnownHostsVerdict = 'known-match' | 'unknown' | 'key-changed' | 'unreadable';

interface ParsedEntry {
  hosts: string[];
  keyType: string;
  keyBase64: string;
}

function knownHostsPath(): string {
  return join(homedir(), '.ssh', 'known_hosts');
}

function hostPattern(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

function parseLine(line: string): ParsedEntry | undefined {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#')) return undefined;
  const parts = trimmed.split(/\s+/);
  if (parts.length < 3) return undefined;
  const [hostField, keyType, keyBase64] = parts;
  if (hostField.startsWith('|1|')) return undefined; // hashed entry — not matched here
  return { hosts: hostField.split(','), keyType, keyBase64 };
}

/** SSH wire format: a `string` field is a 4-byte big-endian length prefix
 *  followed by that many bytes. The public key blob starts with its own
 *  algorithm name encoded this way. */
function algorithmNameOf(keyBlob: Buffer): string {
  const len = keyBlob.readUInt32BE(0);
  return keyBlob.subarray(4, 4 + len).toString('utf8');
}

async function readEntries(path: string): Promise<ParsedEntry[]> {
  const content = await readFile(path, 'utf-8');
  return content
    .split('\n')
    .map(parseLine)
    .filter((e): e is ParsedEntry => e !== undefined);
}

/** Checks `keyBlob` (the raw SSH wire-format public key) against
 *  `~/.ssh/known_hosts` for `host:port`. */
export async function checkKnownHosts(host: string, port: number, keyBlob: Buffer): Promise<KnownHostsVerdict> {
  const path = knownHostsPath();
  if (!existsSync(path)) return 'unknown';

  let entries: ParsedEntry[];
  try {
    entries = await readEntries(path);
  } catch {
    return 'unreadable';
  }

  const pattern = hostPattern(host, port);
  const keyType = algorithmNameOf(keyBlob);
  const keyBase64 = keyBlob.toString('base64');

  const matchingHost = entries.filter((e) => e.hosts.includes(pattern));
  if (matchingHost.length === 0) return 'unknown';

  const sameKey = matchingHost.some((e) => e.keyType === keyType && e.keyBase64 === keyBase64);
  return sameKey ? 'known-match' : 'key-changed';
}

/** Records `keyBlob` for `host:port` in `~/.ssh/known_hosts` (Trust On
 *  First Use). Best-effort — a write failure must never fail the connection
 *  it accepted, so this never throws; callers should still log a rejection. */
export async function learnKnownHost(host: string, port: number, keyBlob: Buffer): Promise<boolean> {
  try {
    const path = knownHostsPath();
    await mkdir(dirname(path), { recursive: true });
    const pattern = hostPattern(host, port);
    const keyType = algorithmNameOf(keyBlob);
    const line = `${pattern} ${keyType} ${keyBlob.toString('base64')}\n`;
    await appendFile(path, line, 'utf-8');
    return true;
  } catch {
    return false;
  }
}
