import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 1Password secret references (`op://<vault>/<item>/<field>`) for host
 * passwords. A host stores the reference, never the password: at connect time
 * the app asks the 1Password CLI (`op read`) for the value, and it lives only
 * in memory for that login.
 *
 * `op` authenticates through the 1Password desktop app ("Integrate with
 * 1Password CLI" in its Developer settings), so the user may get a
 * Windows Hello / Touch ID prompt the first time; op keeps that session alive
 * for a while afterwards.
 */

/** `op://vault/item/field`, optionally with a section: `op://vault/item/section/field`. */
const REFERENCE = /^op:\/\/[^/\s]+\/[^/\s]+(\/[^/\s]+){1,2}$/;

export function isSecretReference(value: string): boolean {
  return REFERENCE.test(value.trim());
}

/** How the CLI is run — replaceable in tests (there is no 1Password in CI). */
export type OpRunner = (args: string[]) => Promise<{ stdout: string; stderr: string }>;

/** Waits long enough for a biometric prompt to be answered. */
const OP_TIMEOUT_MS = 90_000;

/**
 * Where the CLI's usual installers put `op`, tried when it isn't on this process's
 * PATH: an app started from the Finder or Dock gets a PATH without Homebrew's folder,
 * and on Windows a CLI just installed with winget is on the user's PATH only for
 * processes started afterwards — this finds it without restarting the app.
 */
export function opLocations(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'win32') {
    return [
      env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'op.exe'),
      env.ProgramFiles && join(env.ProgramFiles, '1Password CLI', 'op.exe'),
      env.LOCALAPPDATA && join(env.LOCALAPPDATA, '1Password CLI', 'op.exe')
    ].filter((p): p is string => Boolean(p));
  }
  if (platform === 'darwin') return ['/opt/homebrew/bin/op', '/usr/local/bin/op'];
  return ['/usr/local/bin/op', '/usr/bin/op'];
}

function run(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: OP_TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr: String(stderr) }));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

const defaultRunner: OpRunner = async (args) => {
  try {
    return await run('op', args);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    const found = opLocations(process.platform, process.env).find((p) => existsSync(p));
    if (!found) throw err;
    return run(found, args);
  }
};

let runner: OpRunner = defaultRunner;

/** Swaps the CLI runner (tests only); `undefined` restores the real `op`. */
export function setOpRunner(next: OpRunner | undefined): void {
  runner = next ?? defaultRunner;
}

export class OnePasswordError extends Error {}

/** Resolves a secret reference to its value through the 1Password CLI. */
export async function readSecret(reference: string): Promise<string> {
  const ref = reference.trim();
  if (!isSecretReference(ref)) {
    throw new OnePasswordError(`"${ref}" is not a 1Password reference (expected op://vault/item/field)`);
  }
  try {
    const { stdout } = await runner(['read', '--no-newline', ref]);
    if (stdout === '') throw new OnePasswordError(`1Password returned an empty value for ${ref}`);
    return stdout;
  } catch (e) {
    if (e instanceof OnePasswordError) throw e;
    const err = e as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
    if (err.code === 'ENOENT') {
      throw new OnePasswordError(
        '1Password CLI (op) not found. Install it and turn on "Integrate with 1Password CLI" in the 1Password app.'
      );
    }
    if (err.killed) throw new OnePasswordError(`1Password did not answer in time for ${ref}`);
    // op's own message ("[ERROR] 2026/… could not read secret …") is the useful part.
    const detail = (err.stderr ?? err.message ?? '').replace(/^\[ERROR\]\s*\S+\s+\S+\s*/, '').trim();
    throw new OnePasswordError(`1Password: ${detail || 'could not read the secret'}`);
  }
}

/** How long a secret read from 1Password is kept in memory, so new tabs and
 *  reconnects within that window don't prompt again. The same trade-off as a
 *  stored password, which is held decrypted in memory for the whole session. */
export const SECRET_CACHE_MS = 10 * 60_000;
const secretCache = new Map<string, { value: string; expires: number }>();

/** `readSecret`, remembered for `SECRET_CACHE_MS` — shared by SSH hosts and remote
 *  desktop connections, so one reference prompts once however it's used. */
export async function readSecretCached(reference: string): Promise<string> {
  const ref = reference.trim();
  const cached = secretCache.get(ref);
  if (cached && cached.expires > Date.now()) return cached.value;
  const value = await readSecret(ref);
  secretCache.set(ref, { value, expires: Date.now() + SECRET_CACHE_MS });
  return value;
}

/** A field that may hold either its value or a 1Password reference to it (a host's
 *  address or user name): the value, read from 1Password when it is a reference. */
export async function resolveReference(value: string): Promise<string> {
  return isSecretReference(value) ? readSecretCached(value) : value;
}

/** Forgets every remembered secret (tests). */
export function clearSecretCache(): void {
  secretCache.clear();
}

/** The installed 1Password CLI's version, or undefined when `op` isn't there (or
 *  doesn't answer) — for telling the user to install it before a connection fails. */
export async function cliVersion(): Promise<string | undefined> {
  try {
    const { stdout } = await runner(['--version']);
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export interface InstallHint {
  /** A command that installs the CLI, when there is a usual one for this OS. */
  command?: string;
  docsUrl: string;
}

const CLI_DOCS = 'https://developer.1password.com/docs/cli/get-started/';

/** How to install the 1Password CLI here. */
export function installHint(platform: NodeJS.Platform): InstallHint {
  if (platform === 'win32') return { command: 'winget install AgileBits.1Password.CLI', docsUrl: CLI_DOCS };
  if (platform === 'darwin') return { command: 'brew install 1password-cli', docsUrl: CLI_DOCS };
  // Linux: per-distro package repositories — the docs walk through them.
  return { docsUrl: CLI_DOCS };
}
