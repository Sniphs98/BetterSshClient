import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/** A local file an upload node names: absolute as given, `~/…` in the home folder, and
 *  anything else relative to the home folder too — where local nodes run (see
 *  `runLocalCommand`), so `image.tar.gz` is the file a previous node just wrote. */
export function localUploadPath(from: string, home: string = homedir()): string {
  const p = from.trim();
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(home, p.slice(2));
  return isAbsolute(p) ? p : join(home, p);
}

/** Checks the file an upload node is about to send, so a missing one fails with its
 *  full path rather than SFTP's bare "No such file". */
export async function checkUploadSource(path: string): Promise<void> {
  const info = await stat(path).catch(() => undefined);
  if (info === undefined) throw new Error(`no such file on this computer: ${path}`);
  if (!info.isFile()) throw new Error(`not a file: ${path}`);
}

/** The most a command's output may be — `exec`'s own limit, kept. */
const MAX_OUTPUT = 10 * 1024 * 1024;

/** Stops `child` and everything it started — killing the shell (cmd.exe, wsl.exe, sh)
 *  alone leaves what it runs (`docker save`, a build) going. On Windows that's
 *  `taskkill /T`; elsewhere the child leads its own process group (`detached`, see
 *  `runLocalCommand`), and the whole group is signalled. */
export function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

/** Kills `child` (with what it started) when `signal` aborts; returns the clean-up. */
export function killOnAbort(child: ChildProcess, signal: AbortSignal | undefined): () => void {
  if (signal === undefined) return () => {};
  const onAbort = (): void => killProcessTree(child);
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

/**
 * Runs a shell command on the local machine for a Snippet "local" node. Unlike
 * `keySetup.ts`'s `execFileAsync` (a fixed argv, no shell involved), this needs real
 * shell semantics (pipes, `&&`, …) for a user-authored command string, so it runs
 * through a shell (`spawn` with `shell: true`) rather than `execFile`.
 *
 * The timeout — and a canceled run's `signal` — actually kill the command and
 * everything it started (`killProcessTree`), unlike the `withTimeout` Promise.race
 * helper elsewhere in this codebase (which only stops *waiting* on a promise), so a
 * hung command doesn't keep running in the background after the engine reports it as
 * timed out or canceled.
 *
 * Captures stdout+stderr combined (a failed build's useful message is almost always on
 * stderr), matching the combined-output shape `SshSession.runShell` uses for remote
 * nodes, so `{{nodes.<label>.output}}` means the same thing either way.
 *
 * Trust model: this runs a command the user typed into their own Snippet editor, on
 * their own machine — the same trust tier as the SSH remote-command strings this app
 * already executes with zero sandboxing. Not worth over-designing.
 */
export async function runLocalCommand(
  command: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<{ output: string; ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    // `spawn` with a shell rather than `exec`, which doesn't pass `detached` on: off
    // Windows the command leads its own process group, so a timeout or a cancel stops
    // everything it started, not just the shell.
    const child = spawn(command, {
      shell: true,
      // In the home folder: the app's own working directory is wherever it was started
      // from — the install folder, often not writable — so `docker save -o image.tar`
      // had nowhere sensible to go. An upload node's relative path means the same folder.
      cwd: homedir(),
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let stopped: string | undefined;
    const stop = (reason: string): void => {
      if (stopped !== undefined) return;
      stopped = reason;
      killProcessTree(child);
    };
    const collect = (into: Buffer[]) => (data: Buffer) => {
      size += data.length;
      if (size > MAX_OUTPUT) stop(`output exceeded ${MAX_OUTPUT / 1024 / 1024} MB`);
      else into.push(data);
    };
    child.stdout!.on('data', collect(stdout));
    child.stderr!.on('data', collect(stderr));

    const timer = setTimeout(() => stop(`command timed out after ${Math.round(timeoutMs / 1000)}s`), timeoutMs);
    const onAbort = (): void => stop('canceled');
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });

    let settled = false;
    const finish = (result: { output: string; ok: boolean; error?: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    child.on('error', (err) => finish({ output: '', ok: false, error: err.message }));
    child.on('close', (code) => {
      const err = Buffer.concat(stderr).toString('utf-8');
      const output = Buffer.concat(stdout).toString('utf-8') + err;
      if (stopped !== undefined) finish({ output, ok: false, error: stopped });
      else if (code === 0) finish({ output, ok: true });
      else finish({ output, ok: false, error: `Command failed: ${command}${code === null ? '' : ` (exit code ${code})`}\n${err}`.trim() });
    });
  });
}
