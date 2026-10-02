import { randomUUID } from 'node:crypto';

import type { Host } from '../ssh/client.js';
import { bool, obj, optionalStr, port, str } from './bundleFields.js';
import { rdpSettingsFrom, type RdpSettings, type RemoteDesktopConnection } from './remoteDesktop.js';
import {
  CONNECTION_BUNDLE_VERSION,
  bundledHostFrom,
  checkKind,
  findHost,
  jumpUsers,
  optionalRef,
  parseBundledHosts,
  previewHostImport,
  referencesIn,
  resolveNames,
  withJumpHosts,
  type BundledHost,
  type ImportAction,
  type ImportEntryPreview
} from './sshHostBundle.js';

/**
 * Export/import file for RDP profiles — the counterpart of `sshHostBundle.ts`, with
 * the same rules: no stored password (`passwordOmitted` says there was one), while a
 * 1Password reference travels as it is.
 *
 * A profile tunnelled through an SSH host (`viaHost`) needs that host on the other
 * machine too, so the file carries it — and its jump hosts — under `tunnelHosts`,
 * the way an automation file carries its snippets.
 */

export const RDP_PROFILES_KIND = 'remoty-rdp-profiles';

/** One profile as it sits in an export file. Its `id` stays behind: ids are this
 *  machine's, an import gets fresh ones. */
export interface BundledRdpProfile extends RdpSettings {
  name: string;
  protocol: 'rdp' | 'vnc';
  hostname: string;
  port: number;
  username?: string;
  domain?: string;
  viewOnly?: boolean;
  viaHost?: string;
  passwordRef?: string;
  portRef?: string;
  /** The folder it sat in on the exporting machine. */
  folder?: string;
  /** The exporting machine had a password stored for this profile. */
  passwordOmitted?: boolean;
}

export interface RdpProfilesBundle {
  kind: typeof RDP_PROFILES_KIND;
  version: number;
  profiles: BundledRdpProfile[];
  tunnelHosts: BundledHost[];
}

function bundledProfileFrom(c: RemoteDesktopConnection, viaHost: string | undefined): BundledRdpProfile {
  const out: BundledRdpProfile = { name: c.name, protocol: c.protocol, hostname: c.hostname, port: c.port };
  const optional = {
    username: c.username,
    domain: c.domain,
    viewOnly: c.viewOnly,
    viaHost,
    passwordRef: c.passwordRef,
    portRef: c.portRef,
    folder: c.folder,
    passwordOmitted: c.password !== undefined ? true : undefined
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) (out as unknown as Record<string, unknown>)[key] = value;
  }
  return { ...out, ...rdpSettingsFrom(c as unknown as Record<string, unknown>) };
}

/** A file for `selected`, with the SSH hosts they tunnel through. A `viaHost` naming
 *  no known host is kept as written; the import then says it's missing. */
export function buildRdpProfilesBundle(selected: RemoteDesktopConnection[], knownHosts: Host[]): RdpProfilesBundle {
  const tunnels: Host[] = [];
  const profiles = selected.map((c) => {
    const via = c.viaHost?.trim() || undefined;
    const entry = via === undefined ? undefined : findHost(knownHosts, via);
    if (entry !== undefined) tunnels.push(entry);
    return bundledProfileFrom(c, entry?.name ?? via);
  });
  return {
    kind: RDP_PROFILES_KIND,
    version: CONNECTION_BUNDLE_VERSION,
    profiles,
    tunnelHosts: withJumpHosts(tunnels, knownHosts).map((h) => bundledHostFrom(h, knownHosts))
  };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Parses one profile of a file. Unknown fields — a `password` above all — are
 *  ignored; malformed display settings are dropped as `rdpSettingsFrom` does for a
 *  hand-edited remote-desktop.toml. */
function parseBundledProfile(raw: unknown, ctx: string): BundledRdpProfile {
  const o = obj(raw, ctx);
  if (o.protocol !== 'rdp' && o.protocol !== 'vnc') throw new Error(`${ctx}.protocol: must be "rdp" or "vnc"`);
  const name = str(o.name, `${ctx}.name`).trim();
  if (name === '') throw new Error(`${ctx}.name: must not be empty`);
  const hostname = str(o.hostname, `${ctx}.hostname`).trim();
  if (hostname === '') throw new Error(`${ctx}.hostname: must not be empty`);
  const out: BundledRdpProfile = { name, protocol: o.protocol, hostname, port: port(o.port, `${ctx}.port`) };
  const optional = {
    username: optionalStr(o.username, `${ctx}.username`) || undefined,
    domain: optionalStr(o.domain, `${ctx}.domain`) || undefined,
    viewOnly: o.viewOnly === undefined ? undefined : bool(o.viewOnly, `${ctx}.viewOnly`),
    viaHost: optionalStr(o.viaHost, `${ctx}.viaHost`)?.trim() || undefined,
    passwordRef: optionalRef(o.passwordRef, `${ctx}.passwordRef`),
    portRef: optionalRef(o.portRef, `${ctx}.portRef`),
    folder: optionalStr(o.folder, `${ctx}.folder`)?.trim() || undefined,
    passwordOmitted: o.passwordOmitted === true ? true : undefined
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) (out as unknown as Record<string, unknown>)[key] = value;
  }
  return { ...out, ...rdpSettingsFrom(o) };
}

/** Parses+validates a file's already-`JSON.parse`d contents, or throws a descriptive
 *  `Error`. */
export function parseRdpProfilesBundle(raw: unknown): RdpProfilesBundle {
  const o = obj(raw, 'file');
  const version = checkKind(o, RDP_PROFILES_KIND, 'RDP profiles');
  if (!Array.isArray(o.profiles)) throw new Error('file.profiles: expected an array');
  return {
    kind: RDP_PROFILES_KIND,
    version,
    profiles: o.profiles.map((p, i) => parseBundledProfile(p, `file.profiles[${i}]`)),
    tunnelHosts: parseBundledHosts(o.tunnelHosts, 'file.tunnelHosts')
  };
}

// ---------------------------------------------------------------------------
// Importing
// ---------------------------------------------------------------------------

/** A profile's decision key: its place in the file, since two profiles may share a
 *  name. */
export function profileKey(index: number): string {
  return `profile-${index}`;
}

export interface RdpImportPreview {
  profiles: ImportEntryPreview[];
  tunnelHosts: ImportEntryPreview[];
}

/** The preview of a file against this machine's profiles and SSH hosts. */
export function previewRdpImport(
  bundle: RdpProfilesBundle,
  existingProfiles: RemoteDesktopConnection[],
  existingHosts: Host[]
): RdpImportPreview {
  const usedBy = jumpUsers(bundle.tunnelHosts);
  for (const p of bundle.profiles) {
    if (p.viaHost !== undefined) usedBy.set(p.viaHost, [...(usedBy.get(p.viaHost) ?? []), p.name]);
  }
  const taken = new Set(existingProfiles.map((c) => c.name));
  const takenForSuggestions = new Set([...taken, ...bundle.profiles.map((p) => p.name)]);
  const profiles = bundle.profiles.map((p, i): ImportEntryPreview => {
    const match = existingProfiles.find((c) => c.name === p.name);
    let suggestedName = p.name;
    if (match !== undefined) {
      let n = 2;
      while (takenForSuggestions.has(`${p.name} (${n})`)) n += 1;
      suggestedName = `${p.name} (${n})`;
      takenForSuggestions.add(suggestedName);
    }
    const same = match !== undefined && match.hostname === p.hostname && match.port === p.port && match.username === p.username;
    const references = referencesIn(p.passwordRef, p.portRef, p.hostname, p.username, p.domain);
    return {
      key: profileKey(i),
      name: p.name,
      detail: `${p.username ? `${p.username}@` : ''}${p.hostname}:${p.port}${p.viaHost ? ` via ${p.viaHost}` : ''}`,
      conflict: match !== undefined,
      suggestedName,
      defaultAction: same ? 'overwrite' : 'rename',
      onePassword: references.length > 0,
      references,
      passwordOmitted: p.passwordOmitted === true && p.passwordRef === undefined,
      keyOmitted: false,
      usedBy: []
    };
  });
  return { profiles, tunnelHosts: previewHostImport(bundle.tunnelHosts, existingHosts, usedBy) };
}

/** A tunnel host the file names but neither carries nor finds here — the profile
 *  would not connect, so the import says so up front. */
export function missingTunnelHosts(bundle: RdpProfilesBundle, existingHosts: Host[]): string[] {
  const carried = new Set(bundle.tunnelHosts.map((h) => h.name));
  const missing = new Set<string>();
  for (const p of bundle.profiles) {
    if (p.viaHost !== undefined && !carried.has(p.viaHost) && findHost(existingHosts, p.viaHost) === undefined) {
      missing.add(p.viaHost);
    }
  }
  return [...missing];
}

/**
 * Merges a file's profiles into `existing` per the user's `decisions` (keyed by
 * `profileKey`). `hostNames` maps each tunnel host's name in the file to its name
 * here after the host import, so `viaHost` follows a rename.
 *
 * Overwriting keeps the existing profile's id (what open tabs and saved files refer
 * to) and its stored password; everything else comes from the file.
 */
export function mergeRdpImport(
  bundle: RdpProfilesBundle,
  decisions: Record<string, ImportAction>,
  existing: RemoteDesktopConnection[],
  hostNames: Map<string, string>
): RemoteDesktopConnection[] {
  const indexed = bundle.profiles.map((p, i) => ({ p, key: profileKey(i) }));
  const resolved = resolveNames(
    indexed,
    (e) => e.key,
    (e) => e.p.name,
    new Set(existing.map((c) => c.name)),
    decisions,
    'profile'
  );

  const out = [...existing];
  const replaced = new Set<string>();
  for (const { p, key } of indexed) {
    const { name, overwrite } = resolved.get(key)!;
    const { passwordOmitted: _omitted, ...fields } = p;
    const connection: RemoteDesktopConnection = {
      ...fields,
      id: randomUUID(),
      name,
      viaHost: p.viaHost === undefined ? undefined : (hostNames.get(p.viaHost) ?? p.viaHost)
    };
    // Each existing profile is replaced once; a second same-named entry of the file
    // is added beside it.
    const i = overwrite ? out.findIndex((c, j) => j < existing.length && c.name === name && !replaced.has(c.id)) : -1;
    if (i === -1) {
      out.push(connection);
      continue;
    }
    connection.id = out[i].id;
    connection.password = out[i].password;
    replaced.add(connection.id);
    out[i] = connection;
  }
  return out;
}
