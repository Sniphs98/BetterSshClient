import { execFile } from 'node:child_process';

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

const defaultRunner: OpRunner = (args) =>
  new Promise((resolve, reject) => {
    execFile('op', args, { timeout: OP_TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr: String(stderr) }));
      else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });

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
