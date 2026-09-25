import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { appConfigDir } from '../config/platform.js';

/**
 * Trust on first use for RDP servers' TLS certificates, like SSH's known_hosts: the
 * embedded client doesn't check them against a CA (RDP servers almost always have a
 * self-signed one), so the first certificate seen for a target is remembered and a
 * different one later is refused — that's what a man in the middle looks like.
 */

export function knownCertsPath(): string {
  return join(appConfigDir(), 'rdp-known-certs.json');
}

/** SHA-256 of a DER certificate, as `AB:CD:…` — the way Windows and browsers show it. */
export function certFingerprint(der: Buffer): string {
  return (createHash('sha256').update(der).digest('hex').toUpperCase().match(/../g) ?? []).join(':');
}

export type CertCheck =
  | { status: 'known' }
  /** First time: now remembered. */
  | { status: 'new'; fingerprint: string }
  | { status: 'changed'; fingerprint: string; expected: string };

async function load(): Promise<Record<string, string>> {
  const path = knownCertsPath();
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

let queue: Promise<unknown> = Promise.resolve();

/** Checks `der` against what's remembered for `target` (e.g. `host:3389` or
 *  `bastion>host:3389`), remembering it if there's nothing yet. */
export function checkCertificate(target: string, der: Buffer): Promise<CertCheck> {
  const run = async (): Promise<CertCheck> => {
    const fingerprint = certFingerprint(der);
    const known = await load();
    const expected = known[target];
    if (expected === fingerprint) return { status: 'known' };
    if (expected !== undefined) return { status: 'changed', fingerprint, expected };
    known[target] = fingerprint;
    await mkdir(appConfigDir(), { recursive: true });
    const tmp = `${knownCertsPath()}.tmp`;
    await writeFile(tmp, JSON.stringify(known, null, 2), 'utf-8');
    await rename(tmp, knownCertsPath());
    return { status: 'new', fingerprint };
  };
  // Serialised: two first connections at once must not overwrite each other's entry.
  const result = queue.then(run, run);
  queue = result.catch(() => undefined);
  return result;
}

/** Forgets `target`'s certificate, so the next connection trusts whatever it gets. */
export async function forgetCertificate(target: string): Promise<void> {
  const known = await load();
  if (!(target in known)) return;
  delete known[target];
  await writeFile(knownCertsPath(), JSON.stringify(known, null, 2), 'utf-8');
}
