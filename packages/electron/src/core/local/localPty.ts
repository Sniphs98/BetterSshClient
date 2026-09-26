import { homedir } from 'node:os';
import type { IPty } from 'node-pty';

import { OutputBatcher, type SessionId } from '../ssh/pty.js';
import type { CoreEvent } from '../../event.js';
import { listTerminalProfiles, type TerminalProfile } from './profiles.js';

/**
 * Local terminal tabs: a shell on this machine (PowerShell, cmd, a WSL distribution,
 * zsh, …) in a real pseudo-terminal — node-pty, as VS Code uses, so full-screen
 * programs, colours and line editing behave. Mirrors the SSH `PtyManager`'s surface and
 * shares its session ids and events (`terminal-output-<id>`, `ptyExited`), so the
 * renderer's terminal view drives both the same way.
 *
 * node-pty is loaded on first use, not at startup: a machine where it can't load (an
 * unusual Linux without a built binary) loses only local terminals, with a message
 * saying so, rather than the app.
 */

interface Session {
  id: SessionId;
  pty: IPty;
  output: OutputBatcher;
  closedByUser: boolean;
}

type NodePty = typeof import('node-pty');
let nodePty: Promise<NodePty> | undefined;

function loadNodePty(): Promise<NodePty> {
  nodePty ??= import('node-pty').catch((err: Error) => {
    nodePty = undefined;
    throw new Error(`local terminals are unavailable here (node-pty did not load: ${err.message})`);
  });
  return nodePty;
}

/** What a local shell gets in its environment: the app's own, plus a terminal type
 *  full-screen programs recognise. */
export function localTerminalEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  // Electron-only switches that would otherwise leak into every `node` run inside.
  delete out.ELECTRON_RUN_AS_NODE;
  delete out.ELECTRON_NO_ATTACH_CONSOLE;
  out.TERM = 'xterm-256color';
  out.COLORTERM = 'truecolor';
  out.TERM_PROGRAM = 'BetterSshClient';
  return out;
}

export class LocalPtyManager {
  private readonly sessions = new Map<SessionId, Session>();

  constructor(private readonly onOutput: (sessionId: SessionId, data: Buffer) => void) {}

  /** Opens profile `profileId` as terminal `id` in the home folder; rejects if the
   *  profile isn't on this machine (any more) or the shell can't start. */
  async open(id: SessionId, profileId: string, cols: number, rows: number, emit: (event: CoreEvent) => void): Promise<SessionId> {
    let profile: TerminalProfile | undefined;
    let pty: IPty;
    try {
      profile = (await listTerminalProfiles()).find((p) => p.id === profileId);
      if (profile === undefined) throw new Error(`no terminal profile '${profileId}' on this machine`);
      const { spawn } = await loadNodePty();
      pty = spawn(profile.file, profile.args, {
        name: 'xterm-256color',
        cols: Math.max(cols, 2),
        rows: Math.max(rows, 1),
        cwd: homedir(),
        env: localTerminalEnv(process.env),
        useConpty: true
      });
    } catch (e) {
      emit({ type: 'error', message: `Terminal: ${(e as Error).message}` });
      emit({ type: 'ptyExited', sessionId: id });
      throw e;
    }

    const output = new OutputBatcher((data) => this.onOutput(id, data));
    const session: Session = { id, pty, output, closedByUser: false };
    this.sessions.set(id, session);

    pty.onData((data) => output.push(Buffer.from(data, 'utf8')));
    pty.onExit(() => {
      // The shell's last words land before the exit notice that closes the tab.
      if (!session.closedByUser) output.flush();
      this.sessions.delete(id);
      if (!session.closedByUser) emit({ type: 'ptyExited', sessionId: id });
    });
    return id;
  }

  /** Whether `id` is one of this manager's terminals. */
  has(id: SessionId): boolean {
    return this.sessions.has(id);
  }

  write(id: SessionId, data: Buffer): void {
    this.sessions.get(id)?.pty.write(data.toString('utf8'));
  }

  resize(id: SessionId, cols: number, rows: number): void {
    const session = this.sessions.get(id);
    if (session === undefined || cols < 1 || rows < 1) return;
    try {
      session.pty.resize(cols, rows);
    } catch {
      // The shell has just exited; its onExit tidies up.
    }
  }

  /** Ends the shell. User-initiated, so no `ptyExited` follows. */
  close(id: SessionId): void {
    const session = this.sessions.get(id);
    if (session === undefined) return;
    session.closedByUser = true;
    session.output.discard();
    this.sessions.delete(id);
    try {
      session.pty.kill();
    } catch {
      // Already gone.
    }
  }

  shutdown(): void {
    for (const id of [...this.sessions.keys()]) this.close(id);
  }
}
