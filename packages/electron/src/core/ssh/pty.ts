import type { ClientChannel } from 'ssh2';

import type { Host } from './client.js';
import { SshSession } from './session.js';
import type { CoreEvent } from '../../event.js';

/**
 * Multi-session terminal manager. Ported from
 * crates/omnyssh-core/src/ssh/pty.rs, with one deliberate simplification:
 * the Rust source drives a server-side `vt100::Parser` so the TUI frontend
 * (a real terminal itself) can render from parsed screen state. Electron's
 * renderer already embeds `xterm.js`, a full terminal emulator, so there is
 * nothing for the main process to parse — raw bytes are streamed straight
 * through over IPC (see `ipc/terminal.ts`), and `utils/scroll.rs` (mouse
 * wheel / alt-screen handling) has no port at all: xterm.js already owns
 * that behaviour.
 *
 * The locale-forwarding logic (`localeEnv`) is still ported verbatim — it's
 * pure string logic, independent of the parser.
 */

export type SessionId = number;

/** Whether a locale value names the UTF-8 codeset (`en_US.UTF-8`,
 *  `ru_RU.utf8`, `de_DE.UTF-8@euro`, …). */
function isUtf8Locale(value: string): boolean {
  const at = value.lastIndexOf('.');
  if (at === -1) return false;
  const codeset = value.slice(at + 1).split('@')[0];
  return codeset.toLowerCase() === 'utf-8' || codeset.toLowerCase() === 'utf8';
}

/**
 * The locale environment to forward to a remote shell: every `LANG`/`LC_*`
 * variable from `vars`, plus an `LC_CTYPE=C.UTF-8` fallback *only* when the
 * forwarded set doesn't already resolve the character type to UTF-8.
 * Mirrors an ssh client's `SendEnv LANG LC_*` while guaranteeing a UTF-8
 * character type for a process with no locale env — without clobbering an
 * already-UTF-8 `LANG` with a `C.UTF-8` the server may not have.
 */
export function localeEnv(vars: Iterable<[string, string]>): [string, string][] {
  const out: [string, string][] = [];
  let lcAll: string | undefined;
  let lcCtype: string | undefined;
  let lang: string | undefined;

  for (const [name, value] of vars) {
    if (name === 'LANG' || name.startsWith('LC_')) {
      if (name === 'LC_ALL') lcAll = value;
      else if (name === 'LC_CTYPE') lcCtype = value;
      else if (name === 'LANG') lang = value;
      out.push([name, value]);
    }
  }

  // LC_ALL overrides every category, so respect the user's explicit choice
  // verbatim. Otherwise the character type resolves from LC_CTYPE then LANG;
  // force UTF-8 only when neither already provides it, replacing a
  // non-UTF-8 LC_CTYPE rather than sending a duplicate.
  const forceUtf8 = lcAll === undefined && !isUtf8Locale(lcCtype ?? lang ?? '');
  if (forceUtf8) {
    const filtered = out.filter(([name]) => name !== 'LC_CTYPE');
    filtered.push(['LC_CTYPE', 'C.UTF-8']);
    return filtered;
  }
  return out;
}

/** The locale environment to forward for the current process, as a plain
 *  object suitable for `SshSession.openShell`'s `env` option. */
function processLocaleEnv(): Record<string, string> {
  const vars = Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined);
  return Object.fromEntries(localeEnv(vars));
}

/** Above this many buffered bytes a batch goes out at once rather than
 *  waiting for the end of the event-loop turn. */
const MAX_BATCH_BYTES = 256 * 1024;

/**
 * Merges the output chunks a session receives within one event-loop turn
 * into a single delivery. `ssh2` emits one `data` event per SSH packet, so a
 * burst (`cat` of a large file, a build log) arrives as thousands of small
 * chunks — each otherwise its own IPC message and its own `term.write` in the
 * renderer. Flushing on `setImmediate` adds no perceptible latency: a lone
 * keystroke echo still goes out in the same turn it arrived.
 */
export class OutputBatcher {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private scheduled: NodeJS.Immediate | undefined;

  constructor(private readonly deliver: (data: Buffer) => void) {}

  push(data: Buffer): void {
    this.chunks.push(data);
    this.bytes += data.length;
    if (this.bytes >= MAX_BATCH_BYTES) this.flush();
    else this.scheduled ??= setImmediate(() => this.flush());
  }

  /** Delivers whatever is buffered now. */
  flush(): void {
    if (this.scheduled !== undefined) clearImmediate(this.scheduled);
    this.scheduled = undefined;
    if (this.chunks.length === 0) return;
    const data = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.bytes);
    this.chunks = [];
    this.bytes = 0;
    this.deliver(data);
  }

  /** Drops whatever is buffered, undelivered. */
  discard(): void {
    if (this.scheduled !== undefined) clearImmediate(this.scheduled);
    this.scheduled = undefined;
    this.chunks = [];
    this.bytes = 0;
  }
}

interface Session {
  id: SessionId;
  host: Host;
  channel: ClientChannel;
  sshSession: SshSession;
  output: OutputBatcher;
  closedByUser: boolean;
}

export class PtyManager {
  private readonly sessions = new Map<SessionId, Session>();

  constructor(private readonly onOutput: (sessionId: SessionId, data: Buffer) => void) {}

  /** Opens a new terminal tab for `host` under the caller-allocated `id`
   *  (shared with SFTP's session-id space — see `SessionRegistry`) and
   *  returns once the shell is ready; connection/auth errors reject. */
  async open(id: SessionId, host: Host, cols: number, rows: number, emit: (event: CoreEvent) => void): Promise<SessionId> {
    let sshSession: SshSession;
    let channel: ClientChannel;
    try {
      sshSession = await SshSession.connect(host);
      channel = await sshSession.openShell(cols, rows, processLocaleEnv(), host.defaultPath);
    } catch (e) {
      emit({ type: 'error', message: `Terminal: ${(e as Error).message}` });
      emit({ type: 'ptyExited', sessionId: id });
      throw e;
    }

    const output = new OutputBatcher((data) => this.onOutput(id, data));
    const session: Session = { id, host, channel, sshSession, output, closedByUser: false };
    this.sessions.set(id, session);

    channel.on('data', (data: Buffer) => output.push(data));
    channel.stderr.on('data', (data: Buffer) => output.push(data));
    channel.on('close', () => {
      // The shell's last words land before the exit notice that closes the tab.
      if (!session.closedByUser) output.flush();
      this.sessions.delete(id);
      sshSession.disconnect();
      if (!session.closedByUser) emit({ type: 'ptyExited', sessionId: id });
    });

    return id;
  }

  /** Sends raw bytes to the session. Unknown id is a no-op. */
  write(id: SessionId, data: Buffer): void {
    this.sessions.get(id)?.channel.write(data);
  }

  /** Forwards a resize to the session's remote PTY. No-op if not found. */
  resize(id: SessionId, cols: number, rows: number): void {
    this.sessions.get(id)?.channel.setWindow(rows, cols, 0, 0);
  }

  /** Closes and removes the session. Marks it user-initiated so its close
   *  doesn't also emit `ptyExited` (the caller already knows). */
  close(id: SessionId): void {
    const session = this.sessions.get(id);
    if (session === undefined) return;
    session.closedByUser = true;
    session.output.discard();
    session.channel.end();
    this.sessions.delete(id);
    session.sshSession.disconnect();
  }

  /** Gracefully closes every open session. */
  shutdown(): void {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }
}
