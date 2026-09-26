import { execFile } from 'node:child_process';
import { homedir } from 'node:os';

/**
 * Runs a Snippet "wsl" node: the command in a WSL distribution on this Windows machine
 * (Ubuntu with its own Docker, say), rather than in cmd.exe.
 *
 * The command travels as an environment variable (shared into WSL through `WSLENV`)
 * and runs as `bash -lc 'eval "$BSSH_COMMAND"'` via `wsl.exe --exec`, so no quote, `$`
 * or line break in it is ever re-parsed by Windows or by a shell in between. `-l` gives
 * the login environment (PATH additions from ~/.profile, as in a terminal).
 *
 * It starts in the Windows home folder — `/mnt/c/Users/<you>` inside WSL — the same
 * folder local nodes run in, so a file one of them writes is where the other (and an
 * upload node's relative path) expects it.
 */

const COMMAND_VAR = 'BSSH_COMMAND';

/** wsl.exe's own messages ("There is no distribution with the supplied name") are
 *  UTF-16 on older builds even when asked for UTF-8; a command's output is UTF-8. */
export function decodeWslOutput(buf: Buffer): string {
  const sample = buf.subarray(0, 64);
  let zeros = 0;
  for (let i = 1; i < sample.length; i += 2) if (sample[i] === 0) zeros += 1;
  const utf16 = sample.length >= 4 && zeros >= sample.length / 4;
  return (utf16 ? buf.toString('utf16le') : buf.toString('utf8')).replace(/^﻿/, '');
}

/** The names `wsl.exe -l -q` prints, without Docker Desktop's internal distributions
 *  (docker-desktop, docker-desktop-data), which aren't for running commands in. */
export function parseDistroList(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((l) => l.replace(/\0/g, '').trim())
    .filter((l) => l !== '' && !/^docker-desktop(-data)?$/i.test(l));
}

/** The WSL distributions on this machine; `[]` off Windows or without WSL. */
export function listWslDistros(): Promise<string[]> {
  if (process.platform !== 'win32') return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile('wsl.exe', ['-l', '-q'], { windowsHide: true, encoding: 'buffer', timeout: 15_000 }, (err, stdout) => {
      resolve(err ? [] : parseDistroList(decodeWslOutput(stdout)));
    });
  });
}

/** The `wsl.exe` arguments for running `bash` in `distro` (the default one when unset). */
export function wslArgs(distro: string | undefined): string[] {
  return [...(distro ? ['-d', distro] : []), '--exec', 'bash', '-lc', `eval "$${COMMAND_VAR}"`];
}

export async function runWslCommand(
  distro: string | undefined,
  command: string,
  timeoutMs: number
): Promise<{ output: string; ok: boolean; error?: string }> {
  if (process.platform !== 'win32') return { output: '', ok: false, error: 'WSL is only available on Windows' };
  const wslenv = [process.env.WSLENV, `${COMMAND_VAR}/u`].filter(Boolean).join(':');
  return new Promise((resolve) => {
    execFile(
      'wsl.exe',
      wslArgs(distro),
      {
        cwd: homedir(),
        env: { ...process.env, [COMMAND_VAR]: command, WSLENV: wslenv, WSL_UTF8: '1' },
        timeout: timeoutMs,
        killSignal: 'SIGTERM',
        windowsHide: true,
        encoding: 'buffer',
        maxBuffer: 10 * 1024 * 1024
      },
      (err, stdout, stderr) => {
        const output = decodeWslOutput(stdout) + decodeWslOutput(stderr);
        if (!err) {
          resolve({ output, ok: true });
          return;
        }
        const e = err as NodeJS.ErrnoException & { killed?: boolean };
        const code = e.code as unknown;
        const reason = e.killed
          ? `command timed out after ${Math.round(timeoutMs / 1000)}s`
          : code === 'ENOENT'
            ? 'WSL is not installed (wsl.exe not found)'
            : typeof code === 'number' && code > 255
              ? // Not the command's exit code but wsl.exe's own failure (no such
                // distribution, WSL not set up): its message says what's wrong.
                `WSL: ${output.trim().split(/\r?\n/)[0] || `failed with code ${code}`}`
              : typeof code === 'number'
                ? `exited with code ${code}`
                : e.message;
        resolve({ output, ok: false, error: reason });
      }
    );
  });
}
