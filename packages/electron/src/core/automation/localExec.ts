import { exec } from 'node:child_process';

/**
 * Runs a shell command on the local machine for an Automation "local" node. Unlike
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
 * Trust model: this runs a command the user typed into their own Automation editor, on
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
      { timeout: timeoutMs, killSignal: 'SIGTERM', windowsHide: true, maxBuffer: 10 * 1024 * 1024 },
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
