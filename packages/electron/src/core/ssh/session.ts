import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Client, type AnyAuthMethod, type ClientChannel, type ConnectConfig } from 'ssh2';

import type { Host } from './client.js';
import { checkKnownHosts, learnKnownHost } from './knownHosts.js';
import { resolveChain, jumpValue } from './jump.js';
import { loadAllHosts } from '../config/hosts.js';

/**
 * SSH session management via `ssh2`. Ported from
 * crates/omnyssh-core/src/ssh/session.rs.
 *
 * Authentication is attempted in order: SSH agent → explicit identity file
 * → default key files → password, all on one connection via ssh2's
 * `authHandler` (see `authenticate` for the per-method fallback).
 *
 * A host with a ProxyJump is reached through its bastion chain: each hop is
 * connected and authenticated in turn, and the next hop rides a
 * `direct-tcpip` stream opened on the previous one (the `ssh -J` model).
 */

/** Per-hop budget for the TCP connect and SSH handshake. */
const CONNECT_TIMEOUT_MS = 10_000;
/** Command execution timeout. */
const EXEC_TIMEOUT_MS = 30_000;

export class SshCommandError extends Error {}
export class SshAuthError extends Error {}

/** The command run (with a PTY attached) to open a terminal already inside a host's
 *  configured default path: `cd` there, then `exec` the user's shell as a login shell
 *  so it replaces the `cd` process rather than leaving it as a parent — indistinguishable
 *  from a plain `ssh -t host` shell once running. `cd` failing (a deleted/renamed
 *  directory) falls through to the login default instead of aborting the connection. */
export function buildCdShellCommand(path: string): string {
  const escaped = path.replaceAll("'", "'\\''");
  return `cd '${escaped}' 2>/dev/null; exec "$SHELL" -l`;
}

/** An authenticated connection to one host, plus the jump-host connections
 *  it is tunnelled through (empty for a direct connection). The bastions
 *  are kept alive for the whole lifetime of the connection; disconnecting
 *  tears the target down first, then each bastion in turn. */
class SshConnection {
  constructor(
    public readonly client: Client,
    private readonly jumps: Client[]
  ) {}

  disconnect(): void {
    this.client.end();
    for (const jump of this.jumps) jump.end();
  }
}

export class SshSession {
  private constructor(private readonly connection: SshConnection) {}

  static async connect(host: Host): Promise<SshSession> {
    return new SshSession(await connectAndAuth(host));
  }

  /** Runs a shell command and returns its stdout. stderr is discarded (to
   *  avoid corrupting stdout-only parser input) and the exit code is
   *  ignored — use `runCommandChecked` when it carries the result. */
  async runCommand(cmd: string): Promise<string> {
    return (await this.exec(cmd)).output;
  }

  /** Like `runCommand`, but throws when the remote command exits non-zero.
   *  A missing exit code is treated as success (a leniency mirrored from
   *  the Rust source: failing a command that likely worked is worse than
   *  missing a rare edge case). */
  async runCommandChecked(cmd: string): Promise<string> {
    const { output, exitCode } = await this.exec(cmd);
    if (exitCode !== undefined && exitCode !== 0) {
      throw new SshCommandError(`remote command exited with status ${exitCode}`);
    }
    return output;
  }

  /** For a Snippet "remote" node (core/automation/engine.ts): runs `cmd` and
   *  resolves rather than throwing either way, with a caller-supplied timeout
   *  instead of the fixed 30s `EXEC_TIMEOUT_MS` `runCommand`/`runCommandChecked` use.
   *  Captures stdout+stderr combined — unlike those two, which discard stderr to keep
   *  metrics/probe parser input clean — so `{{nodes.<label>.output}}` sees a failed
   *  command's usual diagnostic (almost always on stderr), and so the shape matches
   *  `runLocalCommand`'s local-node output exactly regardless of node kind. A missing
   *  exit code is treated as success, same leniency as `runCommandChecked`. */
  async runShell(cmd: string, timeoutMs: number = EXEC_TIMEOUT_MS): Promise<{ output: string; ok: boolean; error?: string }> {
    const channel = await new Promise<ClientChannel>((resolve, reject) => {
      this.connection.client.exec(cmd, (err, ch) => {
        if (err) reject(err);
        else resolve(ch);
      });
    });

    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let exitCode: number | undefined;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        channel.destroy();
      }, timeoutMs);

      const collect = (data: Buffer): void => void chunks.push(data);
      channel.on('data', collect);
      channel.stderr.on('data', collect);
      channel.on('exit', (code: number | null) => {
        if (code !== null) exitCode = code;
      });
      channel.on('close', () => {
        clearTimeout(timer);
        const output = Buffer.concat(chunks).toString('utf-8');
        if (timedOut) {
          resolve({ output, ok: false, error: `command timed out after ${Math.round(timeoutMs / 1000)}s` });
          return;
        }
        const ok = exitCode === undefined || exitCode === 0;
        resolve({ output, ok, error: ok ? undefined : `remote command exited with status ${exitCode}` });
      });
      channel.on('error', (err: Error) => {
        clearTimeout(timer);
        resolve({ output: Buffer.concat(chunks).toString('utf-8'), ok: false, error: err.message });
      });
    });
  }

  /** Opens a channel with a remote PTY + shell (the `ssh -t` equivalent),
   *  for the terminal (pty.ts). `env` forwards the locale, mirroring an ssh
   *  client's default `SendEnv LANG LC_*` (best-effort — servers without
   *  `AcceptEnv` ignore it). A `cwd` (the host's configured default path)
   *  runs as an explicit `exec` command instead of a bare `shell` request —
   *  see `buildCdShellCommand` — so the terminal opens already there rather
   *  than landing on the login default and having a visible `cd` typed at it. */
  async openShell(cols: number, rows: number, env?: Record<string, string>, cwd?: string): Promise<ClientChannel> {
    const pty = { term: 'xterm-256color', cols, rows };
    if (cwd === undefined || cwd.trim() === '') {
      return new Promise((resolve, reject) => {
        this.connection.client.shell(pty, { env }, (err, channel) => {
          if (err) reject(err);
          else resolve(channel);
        });
      });
    }
    return new Promise((resolve, reject) => {
      this.connection.client.exec(buildCdShellCommand(cwd), { pty, env }, (err, channel) => {
        if (err) reject(err);
        else resolve(channel);
      });
    });
  }

  /** Opens the SFTP subsystem (Phase 3). */
  async openSftp(): Promise<import('ssh2').SFTPWrapper> {
    return new Promise((resolve, reject) => {
      this.connection.client.sftp((err, sftp) => {
        if (err) reject(err);
        else resolve(sftp);
      });
    });
  }

  disconnect(): void {
    this.connection.disconnect();
  }

  private async exec(cmd: string): Promise<{ output: string; exitCode: number | undefined }> {
    const channel = await new Promise<ClientChannel>((resolve, reject) => {
      this.connection.client.exec(cmd, (err, ch) => {
        if (err) reject(err);
        else resolve(ch);
      });
    });

    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let exitCode: number | undefined;
      const timer = setTimeout(() => {
        channel.destroy();
        reject(new SshCommandError(`command timed out (30 s): ${cmd}`));
      }, EXEC_TIMEOUT_MS);

      channel.on('data', (data: Buffer) => chunks.push(data));
      channel.stderr.on('data', () => {
        // Discarded — stdout-only parser input, matching the Rust behaviour.
      });
      channel.on('exit', (code: number | null) => {
        if (code !== null) exitCode = code;
      });
      channel.on('close', () => {
        clearTimeout(timer);
        const raw = Buffer.concat(chunks).toString('utf-8');
        // `.lines()` semantics: normalise \r\n → \n for cross-platform safety.
        const normalised = raw
          .split(/\r\n|\r|\n/)
          .map((l) => `${l}\n`)
          .join('');
        resolve({ output: normalised, exitCode });
      });
      channel.on('error', (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Connection + authentication
// ---------------------------------------------------------------------------

/** Wall-clock budget one `SshSession.connect()` needs for `host`: the
 *  per-hop connect timeout once for every bastion in its ProxyJump chain,
 *  plus the target. A chain that fails to resolve costs nothing to
 *  connect; the caller's own attempt reports why. */
export async function connectBudgetMs(host: Host): Promise<number> {
  const hops = await jumpChain(host).then((c) => c.length).catch(() => 0);
  return CONNECT_TIMEOUT_MS * (hops + 1);
}

async function jumpChain(host: Host): Promise<Host[]> {
  if (jumpValue(host) === undefined) return [];
  const known = await loadAllHosts();
  return resolveChain(host, known);
}

async function connectAndAuth(host: Host): Promise<SshConnection> {
  const chain = await jumpChain(host);

  const jumps: Client[] = [];
  for (const hop of chain) {
    try {
      const client = jumps.length === 0 ? await connectDirect(hop) : await connectTunnelled(jumps[jumps.length - 1], hop);
      jumps.push(client);
    } catch (e) {
      for (const j of jumps) j.end();
      throw new SshAuthError(`ProxyJump via '${hop.name}' failed: ${(e as Error).message}`);
    }
  }

  let target: Client;
  try {
    target = jumps.length === 0 ? await connectDirect(host) : await connectTunnelled(jumps[jumps.length - 1], host);
  } catch (e) {
    for (const j of jumps) j.end();
    const via = chain.length > 0 ? chain[chain.length - 1].name : undefined;
    throw new SshAuthError(via !== undefined ? `connecting via '${via}' failed: ${(e as Error).message}` : (e as Error).message);
  }

  return new SshConnection(target, jumps);
}

/** Opens a TCP connection to `host` and authenticates. */
async function connectDirect(host: Host): Promise<Client> {
  return authenticate(host, {});
}

/** Reaches `host` through the already-connected bastion `via`: a
 *  `direct-tcpip` channel on the bastion carries a second SSH session to
 *  the target, which is verified and authenticated in its own right. */
async function connectTunnelled(via: Client, host: Host): Promise<Client> {
  const stream = await new Promise<import('ssh2').ClientChannel>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('SSH connection timed out (10 s)')), CONNECT_TIMEOUT_MS);
    // The originator address is informational; servers only log it.
    via.forwardOut('127.0.0.1', 0, host.hostname, host.port, (err, channel) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(channel);
    });
  });
  return authenticate(host, { sock: stream });
}

/** The auth methods to offer `host`, in priority order: agent → explicit
 *  identity file → default key files → password. Unreadable key files are
 *  left out; an unparseable (e.g. passphrase-protected) one is skipped by
 *  `ssh2` itself. */
function authMethods(host: Host): AnyAuthMethod[] {
  const username = host.user;
  const methods: AnyAuthMethod[] = [];

  const agentPath = defaultAgentPath();
  if (agentPath !== undefined) methods.push({ type: 'agent', username, agent: agentPath });

  const keyPaths = host.identityFile !== undefined ? [expandTilde(host.identityFile)] : [];
  for (const path of defaultKeyPaths()) if (existsSync(path)) keyPaths.push(path);
  for (const path of keyPaths) {
    const key = tryReadKey(path);
    if (key !== undefined) methods.push({ type: 'publickey', username, key });
  }

  if (host.password !== undefined) methods.push({ type: 'password', username, password: host.password });
  return methods;
}

/** Authenticates against `host` over a connection carrying `extra` (either
 *  nothing, for a direct dial, or a tunnel `sock`).
 *
 *  Every method is tried in turn on a single connection, so a host that only
 *  accepts the last method (typically the password) costs one TCP connect and
 *  one key exchange rather than one per method. A server with a low
 *  `MaxAuthTries` can drop that connection before the list is exhausted
 *  ("Too many authentication failures"); only then does it fall back to a
 *  fresh connection per method, so every method still gets its turn. */
async function authenticate(host: Host, extra: Partial<ConnectConfig>): Promise<Client> {
  const base: ConnectConfig = {
    host: host.hostname,
    port: host.port,
    username: host.user,
    readyTimeout: CONNECT_TIMEOUT_MS,
    keepaliveInterval: 15_000,
    keepaliveCountMax: 3,
    hostVerifier: makeHostVerifier(host.hostname, host.port),
    ...extra
  };

  const methods = authMethods(host);
  if (methods.length > 0) {
    const attempt = await tryConnect({ ...base, authHandler: methods });
    if (attempt.client) return attempt.client;

    // A tunnel `sock` is consumed by its first connection, so a per-method
    // retry can't reuse it — and there is nothing left to retry when the
    // server rejected every method, or never got as far as asking.
    if (attempt.handshake && !attempt.exhausted && extra.sock === undefined && methods.length > 1) {
      for (const method of methods) {
        const retry = await tryConnect({ ...base, authHandler: [method] });
        if (retry.client) return retry.client;
      }
    }
  }

  throw new SshAuthError(`SSH authentication failed for ${host.name}`);
}

interface ConnectAttempt {
  client?: Client;
  /** The key exchange completed, so the failure happened during auth. */
  handshake: boolean;
  /** The server rejected every offered method (as opposed to hanging up early). */
  exhausted: boolean;
}

async function tryConnect(config: ConnectConfig): Promise<ConnectAttempt> {
  return new Promise((resolve) => {
    const client = new Client();
    let settled = false;
    let handshake = false;
    const fail = (exhausted: boolean): void => {
      if (settled) return;
      settled = true;
      resolve({ handshake, exhausted });
    };
    client.on('handshake', () => {
      handshake = true;
    });
    client.on('ready', () => {
      if (settled) return;
      settled = true;
      resolve({ client, handshake: true, exhausted: false });
    });
    client.on('error', (err: Error & { level?: string }) => {
      // An unreachable agent (no agent running) is reported as an error, but
      // `ssh2` carries on with the next method on the same connection.
      if (err.level === 'agent') return;
      fail(err.level === 'client-authentication');
    });
    client.on('close', () => fail(false));
    try {
      client.connect(config);
    } catch {
      fail(false);
    }
  });
}

/** The host-key verifier for `host`. `ssh2` hands the raw SSH wire-format
 *  public key to the callback (no `hostHash` option set). */
function makeHostVerifier(hostname: string, port: number): NonNullable<ConnectConfig['hostVerifier']> {
  return (keyBlob: Buffer, callback: (valid: boolean) => void): void => {
    checkKnownHosts(hostname, port, keyBlob)
      .then(async (verdict) => {
        switch (verdict) {
          case 'known-match':
            callback(true);
            return;
          case 'unknown':
            // Trust On First Use: accept, and record best-effort. Recording
            // failure must never fail the connection it accepted.
            await learnKnownHost(hostname, port, keyBlob);
            callback(true);
            return;
          case 'key-changed':
          case 'unreadable':
            callback(false);
        }
      })
      .catch(() => callback(false));
  };
}

function defaultAgentPath(): string | undefined {
  if (process.platform === 'win32') return '\\\\.\\pipe\\openssh-ssh-agent';
  return process.env.SSH_AUTH_SOCK;
}

/** Returns the standard default SSH private key paths, in priority order. */
function defaultKeyPaths(): string[] {
  const ssh = join(homedir(), '.ssh');
  return ['id_ed25519', 'id_rsa', 'id_ecdsa', 'id_ecdsa_sk', 'id_ed25519_sk'].map((name) => join(ssh, name));
}

function tryReadKey(path: string): Buffer | undefined {
  try {
    return readFileSync(path);
  } catch {
    return undefined;
  }
}

function expandTilde(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}
