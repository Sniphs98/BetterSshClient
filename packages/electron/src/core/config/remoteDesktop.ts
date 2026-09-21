import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile, chmod } from 'node:fs/promises';
import { parse, stringify } from 'smol-toml';

import { appConfigDir, remoteDesktopConfigPath } from './platform.js';
import { getSecretCipher } from './secretCipher.js';
import { decryptSecret, encryptSecret } from './secretField.js';

/**
 * `remote-desktop.toml` I/O, mirroring `core/config/automations.ts`'s shape. RDP is the
 * only reachable protocol from the UI for now — `'vnc'` already exists in the type so a
 * later pass is additive, not a migration, but nothing outside this file constructs one
 * yet.
 */

export type RemoteDesktopProtocol = 'rdp' | 'vnc';

export interface RemoteDesktopConnection {
  id: string;
  name: string;
  protocol: RemoteDesktopProtocol;
  hostname: string;
  port: number;
  username?: string;
  /** Encrypted at rest via `secretField.ts`, same mechanism as `Host.password`. */
  password?: string;
  /** rdp-only. */
  domain?: string;
  /** vnc-only. */
  viewOnly?: boolean;
}

interface RemoteDesktopFile {
  connections: RemoteDesktopConnection[];
}

function encryptForDisk(connection: RemoteDesktopConnection): RemoteDesktopConnection {
  return { ...connection, password: encryptSecret(connection.password, getSecretCipher()) };
}

function decryptFromDisk(connection: RemoteDesktopConnection): RemoteDesktopConnection {
  return { ...connection, password: decryptSecret(connection.password, getSecretCipher()) };
}

function connectionFromToml(raw: Record<string, unknown>): RemoteDesktopConnection {
  if (typeof raw.id !== 'string') throw new Error('remote desktop connection is missing "id"');
  if (typeof raw.name !== 'string') throw new Error('remote desktop connection is missing "name"');
  const protocol = raw.protocol === 'vnc' ? 'vnc' : raw.protocol === 'rdp' ? 'rdp' : undefined;
  if (protocol === undefined) throw new Error(`connection "${raw.name}" has an invalid protocol`);
  if (typeof raw.hostname !== 'string') throw new Error(`connection "${raw.name}" is missing "hostname"`);
  if (typeof raw.port !== 'number') throw new Error(`connection "${raw.name}" is missing "port"`);
  return decryptFromDisk({
    id: raw.id,
    name: raw.name,
    protocol,
    hostname: raw.hostname,
    port: raw.port,
    username: typeof raw.username === 'string' ? raw.username : undefined,
    password: typeof raw.password === 'string' ? raw.password : undefined,
    domain: typeof raw.domain === 'string' ? raw.domain : undefined,
    viewOnly: typeof raw.viewOnly === 'boolean' ? raw.viewOnly : undefined
  });
}

function connectionToToml(connection: RemoteDesktopConnection): Record<string, unknown> {
  const encrypted = encryptForDisk(connection);
  const out: Record<string, unknown> = {
    id: encrypted.id,
    name: encrypted.name,
    protocol: encrypted.protocol,
    hostname: encrypted.hostname,
    port: encrypted.port
  };
  if (encrypted.username !== undefined) out.username = encrypted.username;
  if (encrypted.password !== undefined) out.password = encrypted.password;
  if (encrypted.domain !== undefined) out.domain = encrypted.domain;
  if (encrypted.viewOnly !== undefined) out.viewOnly = encrypted.viewOnly;
  return out;
}

function parseRemoteDesktopFile(content: string): RemoteDesktopFile {
  if (content.trim() === '') return { connections: [] };
  const raw = parse(content) as { connections?: unknown };
  if (raw.connections === undefined) return { connections: [] };
  if (!Array.isArray(raw.connections)) throw new Error('remote-desktop.toml: "connections" must be an array');
  return { connections: raw.connections.map((c) => connectionFromToml(c as Record<string, unknown>)) };
}

/** Loads remote-desktop connections from `~/.config/omnyssh/remote-desktop.toml`.
 *  Returns `[]` if the file does not exist yet. */
export async function loadRemoteDesktopConnections(): Promise<RemoteDesktopConnection[]> {
  const path = remoteDesktopConfigPath();
  if (!existsSync(path)) return [];
  const content = await readFile(path, 'utf-8');
  return parseRemoteDesktopFile(content).connections;
}

/** Persists remote-desktop connections to `remote-desktop.toml`, atomically. */
export async function saveRemoteDesktopConnections(connections: RemoteDesktopConnection[]): Promise<void> {
  const dir = appConfigDir();
  await mkdir(dir, { recursive: true });
  const path = remoteDesktopConfigPath();

  const content = stringify({ connections: connections.map(connectionToToml) });

  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, content, 'utf-8');
  try {
    await rename(tmpPath, path);
  } catch (err) {
    await rm(tmpPath, { force: true });
    throw err;
  }
  if (process.platform !== 'win32') {
    await chmod(path, 0o600).catch(() => {});
  }
}
