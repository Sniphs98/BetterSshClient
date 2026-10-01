import type { Host, MonitorMode } from '../ssh/client.js';
import { jumpHopHosts, renameJumpHops } from '../ssh/jump.js';
import { isSecretReference, normalizeReference } from '../secrets/onePassword.js';
import { arr, num, obj, optionalStr, port, str, uniqueName } from './bundleFields.js';

/**
 * Export/import file for SSH hosts — a plain JSON file to hand to a colleague or
 * another machine, like the snippet/automation files in `core/automation/bundle.ts`.
 *
 * It never carries a secret: a stored password is left out (`passwordOmitted` says
 * there was one), and so is the identity file — a key path means nothing on someone
 * else's machine, and without one the login tries the SSH agent (1Password's
 * included) and the default keys in ~/.ssh. A 1Password reference is not a secret,
 * so `passwordRef`/`portRef` and `op://` values in hostname or user travel as they
 * are: whoever imports the file signs in to 1Password when connecting.
 *
 * Every host a selected host's ProxyJump names comes along, so the file works on a
 * machine that has never seen those bastions.
 */

export const SSH_HOSTS_KIND = 'remoty-ssh-hosts';
export const CONNECTION_BUNDLE_VERSION = 1;

/** One host as it sits in an export file. */
export interface BundledHost {
  name: string;
  hostname: string;
  user: string;
  port: number;
  passwordRef?: string;
  portRef?: string;
  proxyJump?: string;
  tags: string[];
  notes?: string;
  folder?: string;
  monitoring?: 'ssh' | 'tcpPort';
  monitorPort?: number;
  defaultPath?: string;
  startupCommand?: string;
  /** The exporting machine had a password stored for this host. */
  passwordOmitted?: boolean;
  /** The exporting machine logged in with its own key file. */
  keyOmitted?: boolean;
}

export interface SshHostsBundle {
  kind: typeof SSH_HOSTS_KIND;
  version: number;
  hosts: BundledHost[];
}

/** The entry `name` refers to among `known`: its own name first, then the
 *  `~/.ssh/config` alias a renamed import keeps (as ProxyJump resolution does). */
export function findHost(known: Host[], name: string): Host | undefined {
  return known.find((h) => h.name === name) ?? known.find((h) => h.originalSshHost === name);
}

/** `roots` followed by every host their ProxyJump values name, transitively, each
 *  once. A hop that names no known host is a literal address and needs no entry. */
export function withJumpHosts(roots: Host[], known: Host[]): Host[] {
  const out: Host[] = [];
  const seen = new Set<string>();
  const visit = (host: Host): void => {
    if (seen.has(host.name)) return;
    seen.add(host.name);
    out.push(host);
    for (const hop of jumpHopHosts(host.proxyJump)) {
      const entry = findHost(known, hop);
      if (entry !== undefined) visit(entry);
    }
  };
  roots.forEach(visit);
  return out;
}

/** `host` as written to a file. A ProxyJump naming a renamed import's old alias is
 *  rewritten to the name the file carries that host under. */
export function bundledHostFrom(host: Host, known: Host[]): BundledHost {
  const out: BundledHost = {
    name: host.name,
    hostname: host.hostname,
    user: host.user,
    port: host.port,
    tags: [...host.tags]
  };
  if (host.passwordRef !== undefined) out.passwordRef = host.passwordRef;
  if (host.portRef !== undefined) out.portRef = host.portRef;
  if (host.proxyJump !== undefined) {
    out.proxyJump = renameJumpHops(host.proxyJump, (hop) => {
      const entry = findHost(known, hop);
      return entry !== undefined && entry.name !== hop ? entry.name : undefined;
    });
  }
  if (host.notes !== undefined) out.notes = host.notes;
  if (host.folder !== undefined) out.folder = host.folder;
  if (host.monitoring !== 'ssh') out.monitoring = 'tcpPort';
  if (host.monitorPort !== undefined) out.monitorPort = host.monitorPort;
  if (host.defaultPath !== undefined) out.defaultPath = host.defaultPath;
  if (host.startupCommand !== undefined) out.startupCommand = host.startupCommand;
  if (host.password !== undefined) out.passwordOmitted = true;
  if (host.identityFile !== undefined) out.keyOmitted = true;
  return out;
}

export function buildSshHostsBundle(selected: Host[], known: Host[]): SshHostsBundle {
  return {
    kind: SSH_HOSTS_KIND,
    version: CONNECTION_BUNDLE_VERSION,
    hosts: withJumpHosts(selected, known).map((h) => bundledHostFrom(h, known))
  };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** A 1Password reference field: must look like one, stored as `normalizeReference`
 *  cleans it up. */
export function optionalRef(v: unknown, ctx: string): string | undefined {
  const value = optionalStr(v, ctx);
  if (value === undefined || value.trim() === '') return undefined;
  if (!isSecretReference(value)) throw new Error(`${ctx}: must be a 1Password reference like op://vault/item/field`);
  return normalizeReference(value);
}

function name(v: unknown, ctx: string): string {
  const value = str(v, ctx).trim();
  if (value === '') throw new Error(`${ctx}: must not be empty`);
  return value;
}

function optionalTrue(v: unknown): true | undefined {
  return v === true ? true : undefined;
}

/** Parses one host of a file. Anything not listed here — a `password` above all — is
 *  ignored, so even a hand-edited file never brings a secret in. */
export function parseBundledHost(raw: unknown, ctx: string): BundledHost {
  const o = obj(raw, ctx);
  const monitoring = o.monitoring;
  if (monitoring !== undefined && monitoring !== 'ssh' && monitoring !== 'tcpPort') {
    throw new Error(`${ctx}.monitoring: must be "ssh" or "tcpPort"`);
  }
  const out: BundledHost = {
    name: name(o.name, `${ctx}.name`),
    hostname: str(o.hostname, `${ctx}.hostname`),
    user: str(o.user, `${ctx}.user`),
    port: port(o.port, `${ctx}.port`),
    tags: arr(o.tags ?? [], `${ctx}.tags`).map((t, i) => str(t, `${ctx}.tags[${i}]`))
  };
  const optional = {
    passwordRef: optionalRef(o.passwordRef, `${ctx}.passwordRef`),
    portRef: optionalRef(o.portRef, `${ctx}.portRef`),
    proxyJump: optionalStr(o.proxyJump, `${ctx}.proxyJump`)?.trim() || undefined,
    notes: optionalStr(o.notes, `${ctx}.notes`),
    folder: optionalStr(o.folder, `${ctx}.folder`)?.trim() || undefined,
    monitoring: monitoring === 'tcpPort' ? ('tcpPort' as const) : undefined,
    monitorPort: o.monitorPort === undefined ? undefined : port(o.monitorPort, `${ctx}.monitorPort`),
    defaultPath: optionalStr(o.defaultPath, `${ctx}.defaultPath`),
    startupCommand: optionalStr(o.startupCommand, `${ctx}.startupCommand`),
    passwordOmitted: optionalTrue(o.passwordOmitted),
    keyOmitted: optionalTrue(o.keyOmitted)
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) (out as unknown as Record<string, unknown>)[key] = value;
  }
  return out;
}

/** The hosts of a file; two hosts under one name can't both be imported, so that
 *  fails the file. */
export function parseBundledHosts(raw: unknown, ctx: string): BundledHost[] {
  const hosts = arr(raw ?? [], ctx).map((h, i) => parseBundledHost(h, `${ctx}[${i}]`));
  const seen = new Set<string>();
  for (const h of hosts) {
    if (seen.has(h.name)) throw new Error(`${ctx}: the host "${h.name}" is in the file twice`);
    seen.add(h.name);
  }
  return hosts;
}

/** Checks a file's `kind` and `version`, with a clear error for anything else. */
export function checkKind(o: Record<string, unknown>, kind: string, what: string): number {
  if (o.kind !== kind) throw new Error(`not a Remoty ${what} file`);
  const version = num(o.version, 'file.version');
  if (version > CONNECTION_BUNDLE_VERSION) {
    throw new Error(`this file was made by a newer version of Remoty (format ${version}); update Remoty to import it`);
  }
  return version;
}

/** Parses+validates a file's already-`JSON.parse`d contents, or throws a descriptive
 *  `Error`. */
export function parseSshHostsBundle(raw: unknown): SshHostsBundle {
  const o = obj(raw, 'file');
  const version = checkKind(o, SSH_HOSTS_KIND, 'SSH hosts');
  return { kind: SSH_HOSTS_KIND, version, hosts: parseBundledHosts(o.hosts, 'file.hosts') };
}

// ---------------------------------------------------------------------------
// Importing
// ---------------------------------------------------------------------------

/** What to do with an entry whose name is already taken. */
export type ImportAction = { action: 'overwrite' } | { action: 'rename'; name: string };

/** One entry of a file as the import dialog shows it. */
export interface ImportEntryPreview {
  /** What the dialog's decision for this entry is keyed by. */
  key: string;
  name: string;
  /** `user@hostname:port`, to recognise it by. */
  detail: string;
  /** Something by that name exists here already: overwrite it, or rename this one. */
  conflict: boolean;
  /** The free name offered for a rename. */
  suggestedName: string;
  /** Preselected for a conflict: overwrite when it's the same machine anyway. */
  defaultAction: 'overwrite' | 'rename';
  /** Signs in through 1Password. */
  onePassword: boolean;
  /** Every 1Password reference the entry reads, to check before importing: a
   *  reference sends that item's value to the entry's host when connecting. */
  references: string[];
  /** The exporter had a password stored; it has to be entered again. */
  passwordOmitted: boolean;
  /** The exporter logged in with its own key file. */
  keyOmitted: boolean;
  /** Another entry of the file connects through this one. */
  usedBy: string[];
}

/** The 1Password references among `values`, each once. */
export function referencesIn(...values: (string | undefined)[]): string[] {
  return [...new Set(values.filter((v): v is string => v !== undefined && isSecretReference(v)).map(normalizeReference))];
}

function hostDetail(h: { user: string; hostname: string; port: number }): string {
  return `${h.user}@${h.hostname}:${h.port}`;
}

/** The preview of a file's hosts against the hosts this machine has (`existing`:
 *  hosts.toml and ~/.ssh/config merged). `usedBy` maps a host's name to the entries
 *  connecting through it. */
export function previewHostImport(
  hosts: BundledHost[],
  existing: Host[],
  usedBy: Map<string, string[]> = jumpUsers(hosts)
): ImportEntryPreview[] {
  const taken = new Set([...existing.map((h) => h.name), ...hosts.map((h) => h.name)]);
  return hosts.map((h) => {
    const match = existing.find((e) => e.name === h.name);
    const suggestedName = match === undefined ? h.name : uniqueName(h.name, taken);
    taken.add(suggestedName);
    const same = match !== undefined && match.hostname === h.hostname && match.user === h.user && match.port === h.port;
    return {
      key: h.name,
      name: h.name,
      detail: hostDetail(h),
      conflict: match !== undefined,
      suggestedName,
      defaultAction: same ? 'overwrite' : 'rename',
      onePassword: referencesIn(h.passwordRef, h.portRef, h.hostname, h.user).length > 0,
      references: referencesIn(h.passwordRef, h.portRef, h.hostname, h.user),
      passwordOmitted: h.passwordOmitted === true && h.passwordRef === undefined,
      keyOmitted: h.keyOmitted === true,
      usedBy: usedBy.get(h.name) ?? []
    };
  });
}

/** For each host of the file, the other hosts whose ProxyJump names it. */
export function jumpUsers(hosts: BundledHost[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const h of hosts) {
    for (const hop of jumpHopHosts(h.proxyJump)) {
      if (hop === h.name) continue;
      out.set(hop, [...(out.get(hop) ?? []), h.name]);
    }
  }
  return out;
}

/** The name each entry ends up under, checked: a conflict needs a decision, and a
 *  rename must pick a name nothing here or in the file has. */
export function resolveNames<T>(
  entries: T[],
  keyOf: (e: T) => string,
  nameOf: (e: T) => string,
  existingNames: Set<string>,
  decisions: Record<string, ImportAction>,
  what: string
): Map<string, { name: string; overwrite: boolean }> {
  const out = new Map<string, { name: string; overwrite: boolean }>();
  const claimed = new Set<string>();
  // Names the file keeps as they are come first, so a rename can't take one.
  for (const e of entries) {
    const decision = decisions[keyOf(e)];
    if (!existingNames.has(nameOf(e)) || decision?.action === 'overwrite') claimed.add(nameOf(e));
  }
  for (const e of entries) {
    const key = keyOf(e);
    const original = nameOf(e);
    if (!existingNames.has(original)) {
      out.set(key, { name: original, overwrite: false });
      continue;
    }
    const decision = decisions[key];
    if (decision === undefined) throw new Error(`choose whether to overwrite or rename the ${what} "${original}"`);
    if (decision.action === 'overwrite') {
      out.set(key, { name: original, overwrite: true });
      continue;
    }
    if (typeof decision.name !== 'string') throw new Error(`the new name for the ${what} "${original}" is missing`);
    const renamed = decision.name.trim();
    if (renamed === '') throw new Error(`the new name for the ${what} "${original}" is empty`);
    if (existingNames.has(renamed) || claimed.has(renamed)) {
      throw new Error(`a ${what} named "${renamed}" already exists; pick another name for "${original}"`);
    }
    claimed.add(renamed);
    out.set(key, { name: renamed, overwrite: false });
  }
  return out;
}

function hostFromBundled(b: BundledHost, name: string, rename: (hop: string) => string | undefined): Host {
  const host: Host = {
    name,
    hostname: b.hostname,
    user: b.user,
    port: b.port,
    tags: [...b.tags],
    source: 'manual',
    monitoring: (b.monitoring === 'tcpPort' ? 'tcp_port' : 'ssh') as MonitorMode
  };
  if (b.passwordRef !== undefined) host.passwordRef = b.passwordRef;
  if (b.portRef !== undefined) host.portRef = b.portRef;
  if (b.proxyJump !== undefined) host.proxyJump = renameJumpHops(b.proxyJump, rename);
  if (b.notes !== undefined) host.notes = b.notes;
  if (b.folder !== undefined) host.folder = b.folder;
  if (b.monitorPort !== undefined) host.monitorPort = b.monitorPort;
  if (b.defaultPath !== undefined) host.defaultPath = b.defaultPath;
  if (b.startupCommand !== undefined) host.startupCommand = b.startupCommand;
  return host;
}

export interface HostImportResult {
  /** The new hosts.toml list. */
  manual: Host[];
  /** Each imported host's name in the file → its name here now. */
  names: Map<string, string>;
}

/**
 * Merges a file's hosts into the manual list (`manual`, hosts.toml) per the user's
 * `decisions` (keyed by the host's name in the file). `all` is the merged list the
 * names were checked against, ~/.ssh/config imports included.
 *
 * Overwriting keeps what only this machine knows — the stored password, key file,
 * key-setup state — and overwriting an ~/.ssh/config import adopts it, as editing one
 * does (`upsertHost`). ProxyJump values follow any renames.
 */
export function mergeHostImport(
  hosts: BundledHost[],
  decisions: Record<string, ImportAction>,
  manual: Host[],
  all: Host[]
): HostImportResult {
  const resolved = resolveNames(hosts, (h) => h.name, (h) => h.name, new Set(all.map((h) => h.name)), decisions, 'host');
  const names = new Map([...resolved].map(([key, r]) => [key, r.name]));
  const rename = (hop: string): string | undefined => {
    const to = names.get(hop);
    return to !== undefined && to !== hop ? to : undefined;
  };

  const out = [...manual];
  for (const b of hosts) {
    const { name, overwrite } = resolved.get(b.name)!;
    const host = hostFromBundled(b, name, rename);
    if (!overwrite) {
      out.push(host);
      continue;
    }
    const i = out.findIndex((h) => h.name === name);
    if (i !== -1) {
      const existing = out[i];
      host.password = existing.password;
      host.identityFile = existing.identityFile;
      host.keySetupDate = existing.keySetupDate;
      host.passwordAuthDisabled = existing.passwordAuthDisabled;
      host.originalSshHost = existing.originalSshHost;
      out[i] = host;
    } else {
      // Only in ~/.ssh/config: this copy now stands in for it.
      const imported = all.find((h) => h.name === name);
      host.identityFile = imported?.identityFile;
      host.originalSshHost = name;
      out.push(host);
    }
  }
  return { manual: out, names };
}
