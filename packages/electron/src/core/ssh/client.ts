/**
 * Host model. Ported from crates/omnyssh-core/src/ssh/client.rs.
 *
 * The in-memory shape is camelCase (idiomatic TS); `hostFromToml`/`hostToToml`
 * translate to/from the on-disk `hosts.toml` shape, which keeps the exact
 * snake_case keys and enum spellings the Rust `Host` struct used, so an
 * existing `hosts.toml` from the old Rust build still parses unchanged.
 */

export type HostSource = 'ssh_config' | 'manual';

export type MonitorMode = 'ssh' | 'tcp_port';

export interface Host {
  name: string;
  hostname: string;
  user: string;
  port: number;
  identityFile?: string;
  password?: string;
  /** A 1Password secret reference (`op://vault/item/field`) to read the password
   *  from at connect time, instead of storing it. Takes precedence over `password`. */
  passwordRef?: string;
  /** A 1Password reference the port is read from at connect time; `port` then keeps
   *  the default. (Hostname and user carry theirs in the field itself.) */
  portRef?: string;
  proxyJump?: string;
  tags: string[];
  notes?: string;
  /** The dashboard folder the host's card sits in; unset means none. */
  folder?: string;
  source: HostSource;
  originalSshHost?: string;
  monitoring: MonitorMode;
  monitorPort?: number;
  keySetupDate?: string;
  passwordAuthDisabled?: boolean;
  /** Remote directory to land in on connect — `cd`'d into for a terminal, and the
   *  SFTP browser's initial remote listing. Unset means the login default / `/`. */
  defaultPath?: string;
  /** A command typed into every new terminal on this host once it opens (after the
   *  `cd` into `defaultPath`), e.g. `sudo -i` or `tmux attach`. Unset means none. */
  startupCommand?: string;
}

export function defaultUser(): string {
  return process.env.USER ?? process.env.LOGNAME ?? 'root';
}

export const DEFAULT_PORT = 22;

export function defaultHost(): Host {
  return {
    name: '',
    hostname: '',
    user: defaultUser(),
    port: DEFAULT_PORT,
    tags: [],
    source: 'manual',
    monitoring: 'ssh'
  };
}

/**
 * The wire and the TUI form spell the monitoring mode differently, so a
 * hand-edited file is likely to carry either — and a rejected value fails
 * the whole file, taking every manual host with it (client.rs:28-31).
 */
export function normalizeMonitorMode(value: unknown): MonitorMode {
  if (value === 'ssh') return 'ssh';
  if (value === 'tcp_port' || value === 'tcp' || value === 'tcpPort') return 'tcp_port';
  throw new Error(`invalid monitoring mode: ${JSON.stringify(value)}`);
}

/** Parses one `[[hosts]]` TOML table into a `Host`. Throws on a malformed row. */
export function hostFromToml(raw: Record<string, unknown>): Host {
  if (typeof raw.name !== 'string') throw new Error('host is missing "name"');
  const source: HostSource =
    raw.source === 'ssh_config' ? 'ssh_config' : raw.source === 'manual' || raw.source === undefined ? 'manual' : (() => {
      throw new Error(`invalid host source: ${JSON.stringify(raw.source)}`);
    })();
  return {
    name: raw.name,
    hostname: typeof raw.hostname === 'string' ? raw.hostname : '',
    user: typeof raw.user === 'string' ? raw.user : defaultUser(),
    port: typeof raw.port === 'number' ? raw.port : DEFAULT_PORT,
    identityFile: typeof raw.identity_file === 'string' ? raw.identity_file : undefined,
    password: typeof raw.password === 'string' ? raw.password : undefined,
    passwordRef: typeof raw.password_ref === 'string' ? raw.password_ref : undefined,
    portRef: typeof raw.port_ref === 'string' ? raw.port_ref : undefined,
    proxyJump: typeof raw.proxy_jump === 'string' ? raw.proxy_jump : undefined,
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === 'string') : [],
    notes: typeof raw.notes === 'string' ? raw.notes : undefined,
    folder: typeof raw.folder === 'string' && raw.folder.trim() !== '' ? raw.folder : undefined,
    source,
    originalSshHost: typeof raw.original_ssh_host === 'string' ? raw.original_ssh_host : undefined,
    monitoring: raw.monitoring === undefined ? 'ssh' : normalizeMonitorMode(raw.monitoring),
    monitorPort: typeof raw.monitor_port === 'number' ? raw.monitor_port : undefined,
    keySetupDate: typeof raw.key_setup_date === 'string' ? raw.key_setup_date : undefined,
    passwordAuthDisabled:
      typeof raw.password_auth_disabled === 'boolean' ? raw.password_auth_disabled : undefined,
    defaultPath: typeof raw.default_path === 'string' ? raw.default_path : undefined,
    startupCommand: typeof raw.startup_command === 'string' ? raw.startup_command : undefined
  };
}

/**
 * Serialises a `Host` back to its TOML table shape. Omits fields the Rust
 * struct also omits at their default (`Option::is_none`, and `monitoring`
 * only when it's the default `ssh`), so an unmodified host round-trips
 * byte-identical (client.rs:150-160).
 */
export function hostToToml(host: Host): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: host.name,
    hostname: host.hostname,
    user: host.user,
    port: host.port
  };
  if (host.identityFile !== undefined) out.identity_file = host.identityFile;
  if (host.password !== undefined) out.password = host.password;
  if (host.passwordRef !== undefined) out.password_ref = host.passwordRef;
  if (host.portRef !== undefined) out.port_ref = host.portRef;
  if (host.proxyJump !== undefined) out.proxy_jump = host.proxyJump;
  if (host.tags.length > 0) out.tags = host.tags;
  if (host.notes !== undefined) out.notes = host.notes;
  if (host.folder !== undefined) out.folder = host.folder;
  out.source = host.source;
  if (host.originalSshHost !== undefined) out.original_ssh_host = host.originalSshHost;
  if (host.monitoring !== 'ssh') out.monitoring = host.monitoring;
  if (host.monitorPort !== undefined) out.monitor_port = host.monitorPort;
  if (host.keySetupDate !== undefined) out.key_setup_date = host.keySetupDate;
  if (host.passwordAuthDisabled !== undefined) out.password_auth_disabled = host.passwordAuthDisabled;
  if (host.defaultPath !== undefined) out.default_path = host.defaultPath;
  if (host.startupCommand !== undefined) out.startup_command = host.startupCommand;
  return out;
}
