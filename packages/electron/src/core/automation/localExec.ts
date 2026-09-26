import { exec } from 'node:child_process';
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

/**
 * Runs a shell command on the local machine for a Snippet "local" node. Unlike
 * `keySetup.ts`'s `execFileAsync` (a fixed argv, no shell involved), this needs real
 * shell semantics (pipes, `&&`, …) for a user-authored command string, so it goes
 * through `child_process.exec` rather than `execFile`.
 *
 * `timeout`/`killSignal` are `exec`'s own — unlike the `withTimeout` Promise.race
 * helper elsewhere in this codebase (which only stops *waiting* on a promise), this
 * actually kills the child process, so a hung command doesn't keep running in the
 * background after the engine reports it as timed out.
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
  timeoutMs: number
): Promise<{ output: string; ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    exec(
      command,
      // In the home folder: the app's own working directory is wherever it was started
      // from — the install folder, often not writable — so `docker save -o image.tar`
      // had nowhere sensible to go. An upload node's relative path means the same folder.
      { cwd: homedir(), timeout: timeoutMs, killSignal: 'SIGTERM', windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const output = stdout + stderr;
        if (err) {
          const reason = err.killed ? `command timed out after ${Math.round(timeoutMs / 1000)}s` : err.message;
          resolve({ output, ok: false, error: reason });
          return;
        }
        resolve({ output, ok: true });
      }
    );
  });
}
