import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile, chmod } from 'node:fs/promises';
import { parse, stringify } from 'smol-toml';

import type { Host } from '../ssh/client.js';
import { hostFromToml, hostToToml } from '../ssh/client.js';
import { appConfigDir, hostsConfigPath, sshConfigPath } from './platform.js';
import { loadFromFile } from './sshConfig.js';
import { getSecretCipher } from './secretCipher.js';

/**
 * `hosts.toml` I/O + manual/ssh-config merge. Ported from
 * crates/omnyssh-core/src/config/mod.rs.
 */

interface HostsFile {
  hosts: Host[];
}

// A stored password is OS-encrypted via `getSecretCipher()` (see secretCipher.ts) —
// this prefix on the on-disk string is what tells `decryptFromDisk` a value is
// ciphertext rather than a legacy (or encryption-unavailable) plaintext password, so
// it knows whether to run it through the cipher at all.
const ENCRYPTED_PREFIX = 'enc:v1:';

/** Encrypts `host.password` for disk when a cipher is actually available, leaving it
 *  as plaintext otherwise (e.g. no OS keyring on this Linux setup) — better to keep
 *  working than to refuse to save the host at all. */
function encryptForDisk(host: Host): Host {
  if (host.password === undefined) return host;
  const cipher = getSecretCipher();
  if (!cipher.available) return host;
  return { ...host, password: ENCRYPTED_PREFIX + cipher.encrypt(host.password).toString('base64') };
}

/** The inverse of `encryptForDisk`. A value without the prefix is either a
 *  never-encrypted legacy password (a `hosts.toml` from before this existed) or one
 *  saved while encryption was unavailable — both already plaintext, nothing to do.
 *  A value that fails to decrypt (the OS key changed, or this file was copied to a
 *  different user/machine) drops just that one secret rather than failing the whole
 *  file to load — the user simply re-enters it. */
function decryptFromDisk(host: Host): Host {
  if (host.password === undefined || !host.password.startsWith(ENCRYPTED_PREFIX)) return host;
  const ciphertext = Buffer.from(host.password.slice(ENCRYPTED_PREFIX.length), 'base64');
  try {
    return { ...host, password: getSecretCipher().decrypt(ciphertext) };
  } catch {
    return { ...host, password: undefined };
  }
}

function parseHostsFile(content: string): HostsFile {
  if (content.trim() === '') return { hosts: [] };
  const raw = parse(content) as { hosts?: unknown };
  if (raw.hosts === undefined) return { hosts: [] };
  if (!Array.isArray(raw.hosts)) throw new Error('hosts.toml: "hosts" must be an array');
  return { hosts: raw.hosts.map((h) => decryptFromDisk(hostFromToml(h as Record<string, unknown>))) };
}

/** Loads manually-added hosts from `~/.config/omnyssh/hosts.toml`.
 *  Returns `[]` if the file does not exist yet. Throws if it exists but is
 *  unreadable or malformed. */
export async function loadHosts(): Promise<Host[]> {
  const path = hostsConfigPath();
  if (!existsSync(path)) return [];
  const content = await readFile(path, 'utf-8');
  return parseHostsFile(content).hosts;
}

/** Persists the manually-added hosts (`source === 'manual'`) to `hosts.toml`.
 *  SSH-config-derived hosts are intentionally not written — they are
 *  re-imported from `~/.ssh/config` on every startup. */
export async function saveHosts(hosts: Host[]): Promise<void> {
  const dir = appConfigDir();
  await mkdir(dir, { recursive: true });
  const path = hostsConfigPath();

  const manual = hosts.filter((h) => h.source === 'manual');
  const content = stringify({ hosts: manual.map((h) => hostToToml(encryptForDisk(h))) });

  // Write to a temp file and rename for atomic replacement (avoids a corrupt
  // hosts.toml if the process is interrupted mid-write).
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, content, 'utf-8');
  try {
    await rename(tmpPath, path);
  } catch (err) {
    await rm(tmpPath, { force: true });
    throw err;
  }
  // Not applied on Windows (no POSIX mode bits) — the encrypted password above is
  // this platform's actual protection instead: `safeStorage`/DPAPI ties the
  // ciphertext to the current Windows user account, so even another account
  // reading this same file can't decrypt it.
  if (process.platform !== 'win32') {
    await chmod(path, 0o600).catch(() => {});
  }
}

/** Loads all hosts: manually-added (`hosts.toml`) merged with hosts imported
 *  from `~/.ssh/config`. A missing/unreadable `~/.ssh/config` is silently
 *  ignored; a malformed `hosts.toml` still throws. */
export async function loadAllHosts(): Promise<Host[]> {
  const manual = await loadHosts();

  let sshHosts: Host[] = [];
  const sshPath = sshConfigPath();
  if (existsSync(sshPath)) {
    try {
      sshHosts = loadFromFile(sshPath);
    } catch {
      // SSH config parse error — ignored, matches the Rust behaviour.
    }
  }

  return mergeHosts(manual, sshHosts);
}

/**
 * Merges manually-added hosts with hosts imported from `~/.ssh/config`.
 * Manual entries come first and take priority: an SSH-config host is dropped
 * when a manual host already uses its name, or when a manual host records it
 * as a renamed original (via `originalSshHost`).
 */
export function mergeHosts(manual: Host[], sshHosts: Host[]): Host[] {
  const manualNames = new Set(manual.map((h) => h.name));
  const renamedSshHosts = new Set(
    manual.map((h) => h.originalSshHost).filter((n): n is string => n !== undefined)
  );

  const all = [...manual];
  for (const h of sshHosts) {
    if (!manualNames.has(h.name) && !renamedSshHosts.has(h.name)) all.push(h);
  }
  return all;
}
