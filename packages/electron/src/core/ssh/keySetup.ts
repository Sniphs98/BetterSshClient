import { chmod, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { Host } from './client.js';
import { connectBudgetMs, SshSession } from './session.js';

const execFileAsync = promisify(execFile);

/**
 * Auto SSH Key Setup. Ported from crates/omnyssh-core/src/ssh/key_setup.rs.
 *
 * Safety invariants (unchanged from the Rust source):
 * - Never disable password authentication without verified key auth.
 * - Append to authorized_keys, never overwrite.
 * - Always back up sshd_config before modification.
 * - Private key 600, .ssh directory 700 (non-Windows).
 * - Never transmit the private key over the network.
 */

const MAX_HOSTNAME_LENGTH = 64;
const TOTAL_TIMEOUT_MS = 60_000;
const STEP_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export type KeySetupStep = 'generateKey' | 'copyPublicKey' | 'verifyKeyAuth' | 'disablePassword' | 'reloadSshd' | 'finalCheck';

export const ALL_STEPS: KeySetupStep[] = ['generateKey', 'copyPublicKey', 'verifyKeyAuth', 'disablePassword', 'reloadSshd', 'finalCheck'];

const STEP_DESCRIPTIONS: Record<KeySetupStep, string> = {
  generateKey: 'Generating Ed25519 key pair',
  copyPublicKey: 'Copying public key to server',
  verifyKeyAuth: 'Verifying key authentication',
  disablePassword: 'Disabling password authentication',
  reloadSshd: 'Reloading SSH service',
  finalCheck: 'Final verification'
};

export function stepDescription(step: KeySetupStep): string {
  return STEP_DESCRIPTIONS[step];
}

export function stepIndex(step: KeySetupStep): number {
  return ALL_STEPS.indexOf(step) + 1;
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export type KeySetupState = 'notStarted' | 'inProgress' | 'success' | 'partialSuccess' | 'failedSafe' | 'needsRollback' | 'rolledBack';

export class KeySetupMachine {
  private _state: KeySetupState = 'notStarted';
  private hasSudo = true;
  passwordDisabled = false;

  get state(): KeySetupState {
    return this._state;
  }

  setHasSudo(value: boolean): void {
    this.hasSudo = value;
  }

  /** Updates the state machine based on which step completed and whether it
   *  succeeded. Mirrors the Rust match's arm order/exclusivity exactly —
   *  only the first matching condition applies. */
  stepResult(step: KeySetupStep, error: Error | undefined): void {
    const ok = error === undefined;
    if ((step === 'generateKey' || step === 'copyPublicKey') && !ok) {
      // Steps 1-2: safe to fail, no changes to the server yet.
      this._state = 'failedSafe';
    } else if (step === 'verifyKeyAuth' && !ok) {
      // Step 3: CRITICAL — never disable password without verified key.
      this._state = 'failedSafe';
    } else if (step === 'verifyKeyAuth' && ok && !this.hasSudo) {
      // Key works, but no sudo — partial success.
      this._state = 'partialSuccess';
    } else if (step === 'disablePassword' && ok) {
      // Step 4: point of no return. Deliberately doesn't touch `state`.
      this.passwordDisabled = true;
    } else if (step === 'disablePassword' && !ok) {
      this._state = 'failedSafe';
    } else if (step === 'reloadSshd' && !ok) {
      // Reload failed, but password is already disabled.
      this._state = 'needsRollback';
    } else if (step === 'finalCheck' && !ok) {
      // Password disabled but key doesn't work post-reload — emergency rollback.
      this._state = 'needsRollback';
    } else if (step === 'finalCheck' && ok) {
      this._state = 'success';
    } else if (ok) {
      this._state = 'inProgress';
    }
  }

  rollbackComplete(): void {
    this._state = 'rolledBack';
    this.passwordDisabled = false;
  }

  /** Key auth is verified and that's all the caller asked for — password auth was
   *  deliberately left untouched, so there's nothing left to check or roll back. */
  markKeyOnlySuccess(): void {
    this._state = 'success';
  }
}

// ---------------------------------------------------------------------------
// Key generation
// ---------------------------------------------------------------------------

/** Sanitizes a hostname for use in a key filename: keeps letters, digits,
 *  `-`, `_`; everything else (including `.`, to block `../../etc/passwd`
 *  traversal) becomes `_`; truncated to 64 code points; `"unnamed_host"`
 *  for empty input. */
export function sanitizeHostname(hostname: string): string {
  if (hostname === '') return 'unnamed_host';
  const taken = Array.from(hostname).slice(0, MAX_HOSTNAME_LENGTH);
  const sanitized = taken.map((c) => (/^[\p{L}\p{N}]$/u.test(c) || c === '-' || c === '_' ? c : '_')).join('');
  return sanitized === '' ? 'unnamed_host' : sanitized;
}

export interface KeyPairPaths {
  privateKeyPath: string;
  publicKeyPath: string;
}

/** Generates an Ed25519 SSH key pair via the system `ssh-keygen` (ensures
 *  OpenSSH format) and writes it to `~/.ssh`. Reuses an existing pair for
 *  the same host rather than regenerating. Private key 0600, `.ssh` 0700
 *  (non-Windows). */
export async function generateKeyPair(hostName: string): Promise<KeyPairPaths> {
  const sanitized = sanitizeHostname(hostName);
  const keyFilename = `bssh_${sanitized}_ed25519`;
  const sshDir = join(homedir(), '.ssh');

  await mkdir(sshDir, { recursive: true });
  if (process.platform !== 'win32') await chmod(sshDir, 0o700).catch(() => {});

  const privateKeyPath = join(sshDir, keyFilename);
  const publicKeyPath = join(sshDir, `${keyFilename}.pub`);

  if (existsSync(privateKeyPath) && existsSync(publicKeyPath)) {
    return { privateKeyPath, publicKeyPath };
  }

  try {
    await execFileAsync('ssh-keygen', ['-t', 'ed25519', '-f', privateKeyPath, '-N', '', '-C', `better-ssh-client-${hostName}`], { windowsHide: true });
  } catch (e) {
    const stderr = (e as { stderr?: string }).stderr ?? (e as Error).message;
    throw new Error(`ssh-keygen failed to generate key: ${stderr}`);
  }

  if (process.platform !== 'win32') await chmod(privateKeyPath, 0o600).catch(() => {});

  return { privateKeyPath, publicKeyPath };
}

// ---------------------------------------------------------------------------
// SSH command builders
// ---------------------------------------------------------------------------

/** Builds the command that appends a public key to `authorized_keys`
 *  (never overwrites). Throws on a public key that isn't a single
 *  recognised-type line — an internal-invariant guard, since the caller
 *  already validated it. */
export function buildAuthorizedKeysCommand(rawPublicKey: string): string {
  const publicKey = rawPublicKey.trim();
  if (publicKey.includes('\n') || publicKey.includes('\r') || publicKey.includes('\0')) {
    throw new Error('Public key file contains invalid characters');
  }
  if (!publicKey.startsWith('ssh-ed25519 ') && !publicKey.startsWith('ssh-rsa ') && !publicKey.startsWith('ecdsa-sha2-')) {
    throw new Error('Public key file has unrecognized key type');
  }
  const escaped = publicKey.replaceAll("'", "'\\''");
  return `mkdir -p ~/.ssh && chmod 700 ~/.ssh && echo '${escaped}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`;
}

function utcTimestamp(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
}

/** Builds the shell fragment that forces `sshd_config` to set
 *  `directive value`: rewrites every existing column-0 occurrence, then —
 *  if the file had none — prepends it so it becomes the first (effective)
 *  global occurrence sshd reads. */
function forceSshdDirective(directive: string, value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(directive)) throw new Error(`directive contains unsafe characters: ${directive}`);
  if (!/^[A-Za-z0-9_ -]+$/.test(value)) throw new Error(`value contains unsafe characters: ${value}`);
  return (
    `sudo sed -i.bak 's/^#\\?${directive}.*/${directive} ${value}/' /etc/ssh/sshd_config && ` +
    `{ sudo grep -qE '^${directive}[[:space:]]' /etc/ssh/sshd_config || sudo sed -i '1i ${directive} ${value}' /etc/ssh/sshd_config; }`
  );
}

/** Builds the command that disables password authentication: checks sudo,
 *  backs up `sshd_config`, comments out `Include .../sshd_config.d/`
 *  (cloud-init drop-ins that would re-enable it), forces
 *  `PasswordAuthentication`/`ChallengeResponseAuthentication`/
 *  `KbdInteractiveAuthentication`/`UsePAM` to `no`, and validates with
 *  `sshd -t` (restoring the backup immediately on failure). */
export function buildDisablePasswordCommand(): string {
  const timestamp = utcTimestamp();
  const password = forceSshdDirective('PasswordAuthentication', 'no');
  const challenge = forceSshdDirective('ChallengeResponseAuthentication', 'no');
  const kbd = forceSshdDirective('KbdInteractiveAuthentication', 'no');
  const pam = forceSshdDirective('UsePAM', 'no');

  return (
    `sudo -n true 2>/dev/null || { echo "BSSH_NO_SUDO"; exit 1; }; ` +
    `sudo cp /etc/ssh/sshd_config /etc/ssh/sshd_config.bssh_backup.${timestamp} && ` +
    `sudo sed -i.bak 's|^Include /etc/ssh/sshd_config.d/|#Include /etc/ssh/sshd_config.d/|' /etc/ssh/sshd_config && ` +
    `${password} && ${challenge} && ${kbd} && ${pam} && sudo sshd -t || ` +
    `{ echo "BSSH_CONFIG_ERROR"; sudo cp /etc/ssh/sshd_config.bssh_backup.${timestamp} /etc/ssh/sshd_config; exit 1; }`
  );
}

/** Reloads (never restarts, so existing connections survive) the SSH daemon. */
export function buildReloadSshdCommand(): string {
  return (
    'if command -v systemctl &>/dev/null; then sudo systemctl reload sshd 2>/dev/null || sudo systemctl reload ssh 2>/dev/null; ' +
    'elif command -v service &>/dev/null; then sudo service sshd reload 2>/dev/null || sudo service ssh reload 2>/dev/null; ' +
    'else echo "BSSH_NO_INIT_SYSTEM"; exit 1; fi'
  );
}

/** Restores the most recent BetterSshClient backup of `sshd_config` and reloads the daemon. */
export function buildRollbackCommand(): string {
  return (
    "BACKUP=$(find /etc/ssh -maxdepth 1 -name 'sshd_config.bssh_backup.*' 2>/dev/null | sort | tail -1); " +
    'if [ -n "$BACKUP" ]; then sudo cp "$BACKUP" /etc/ssh/sshd_config && ' +
    '(sudo systemctl reload sshd 2>/dev/null || sudo systemctl reload ssh 2>/dev/null || sudo service sshd reload 2>/dev/null || sudo service ssh reload); ' +
    'else echo "BSSH_NO_BACKUP"; exit 1; fi'
  );
}

// ---------------------------------------------------------------------------
// High-level orchestrator
// ---------------------------------------------------------------------------

export interface KeySetupResult {
  keyPath: string;
  state: KeySetupState;
  passwordDisabled: boolean;
}

class KeySetupTimeout extends Error {}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new KeySetupTimeout('timed out')), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * Executes the complete key setup process for a host: generate a key pair,
 * copy the public key, verify key auth, disable password auth, reload
 * sshd, and re-verify. Throws on any failure — including, faithfully
 * mirroring the Rust source, when an emergency rollback afterward
 * succeeds: the source only ever returns its original error there (see
 * `setup_key_for_host`'s doc comment in the Rust source for why this
 * duplicates a latent quirk rather than "fixing" it out from under the
 * ported behaviour).
 *
 * `disablePasswordAuth` is a user choice, not a capability probe: when
 * false, the flow stops right after key auth is verified (step 3) and
 * never touches sshd_config at all — no sudo probe, no backup, nothing to
 * roll back.
 */
export async function setupKeyForHost(
  host: Host,
  passwordSession: SshSession,
  disablePasswordAuth: boolean,
  onProgress?: (step: KeySetupStep) => void
): Promise<KeySetupResult> {
  const machine = new KeySetupMachine();

  const verifyTimeoutMs = Math.max(STEP_TIMEOUT_MS, await connectBudgetMs(host));
  const totalTimeoutMs = TOTAL_TIMEOUT_MS + Math.max(0, verifyTimeoutMs - STEP_TIMEOUT_MS) * 2;

  let error: Error;
  try {
    const keyPath = await withTimeout(setupKeyInternal(host, passwordSession, verifyTimeoutMs, machine, disablePasswordAuth, onProgress), totalTimeoutMs);
    return { keyPath, state: machine.state, passwordDisabled: machine.passwordDisabled };
  } catch (e) {
    if (e instanceof KeySetupTimeout) {
      // Running out of time is only safe before the point of no return.
      const step: KeySetupStep = machine.passwordDisabled ? 'finalCheck' : 'verifyKeyAuth';
      machine.stepResult(step, new Error('timed out'));
      error = new Error(`Key setup timed out after ${Math.round(totalTimeoutMs / 1000)} seconds`);
    } else {
      error = e as Error;
    }
  }

  if (machine.state === 'needsRollback') {
    try {
      await emergencyRollback(passwordSession);
      machine.rollbackComplete();
    } catch {
      // Rollback failure doesn't change the surfaced error — see the doc
      // comment above.
    }
  }

  throw error;
}

async function setupKeyInternal(
  host: Host,
  passwordSession: SshSession,
  verifyTimeoutMs: number,
  machine: KeySetupMachine,
  disablePasswordAuth: boolean,
  onProgress?: (step: KeySetupStep) => void
): Promise<string> {
  // Step 1: generate key pair.
  onProgress?.('generateKey');
  let privateKeyPath: string;
  let publicKeyPath: string;
  try {
    ({ privateKeyPath, publicKeyPath } = await generateKeyPair(host.name));
    machine.stepResult('generateKey', undefined);
  } catch (e) {
    machine.stepResult('generateKey', new Error('Generation failed'));
    throw e;
  }

  // Step 2: copy public key to server.
  onProgress?.('copyPublicKey');
  const publicKeyContent = (await readFile(publicKeyPath, 'utf-8')).trim();
  if (publicKeyContent.includes('\n') || publicKeyContent.includes('\r') || publicKeyContent.includes('\0')) {
    throw new Error('Public key file contains invalid characters');
  }
  if (!publicKeyContent.startsWith('ssh-ed25519 ') && !publicKeyContent.startsWith('ssh-rsa ') && !publicKeyContent.startsWith('ecdsa-sha2-')) {
    throw new Error('Public key file has unrecognized key type');
  }
  const copyCmd = buildAuthorizedKeysCommand(publicKeyContent);
  try {
    await withTimeout(passwordSession.runCommand(copyCmd), STEP_TIMEOUT_MS);
    machine.stepResult('copyPublicKey', undefined);
  } catch (e) {
    machine.stepResult('copyPublicKey', new Error('Copy failed'));
    const reason = e instanceof KeySetupTimeout ? 'timeout' : (e as Error).message;
    throw new Error(`Failed to copy public key to server: ${reason}`);
  }

  // Step 3: verify key authentication (CRITICAL).
  onProgress?.('verifyKeyAuth');
  const testHost: Host = { ...host, identityFile: privateKeyPath, password: undefined };
  try {
    const testSession = await withTimeout(SshSession.connect(testHost), verifyTimeoutMs);
    testSession.disconnect();
    machine.stepResult('verifyKeyAuth', undefined);
  } catch (e) {
    machine.stepResult('verifyKeyAuth', new Error('Verify failed'));
    if (e instanceof KeySetupTimeout) {
      throw new Error('Key authentication verification timed out. Password NOT disabled.');
    }
    throw new Error(`Key authentication verification failed: ${(e as Error).message}. Password NOT disabled.`);
  }

  // The user chose to keep password auth as-is — key auth is verified, so we're done.
  // Skip the sudo probe entirely; nothing below this needs it.
  if (!disablePasswordAuth) {
    machine.markKeyOnlySuccess();
    return privateKeyPath;
  }

  // Sudo availability. `runCommandChecked` is required — the probe's exit
  // status is the answer, and a plain run ignores it.
  try {
    await passwordSession.runCommandChecked('sudo -n true 2>/dev/null');
  } catch {
    machine.setHasSudo(false);
    machine.stepResult('verifyKeyAuth', undefined); // Re-fire to trigger PartialSuccess.
    return privateKeyPath;
  }

  // Step 4: disable password authentication.
  onProgress?.('disablePassword');
  const disableCmd = buildDisablePasswordCommand();
  let disableOutput: string;
  try {
    disableOutput = await withTimeout(passwordSession.runCommand(disableCmd), STEP_TIMEOUT_MS);
  } catch (e) {
    machine.stepResult('disablePassword', new Error('Disable failed'));
    const reason = e instanceof KeySetupTimeout ? 'timeout' : (e as Error).message;
    throw new Error(`Failed to disable password authentication: ${reason}`);
  }
  if (disableOutput.includes('BSSH_NO_SUDO')) {
    machine.setHasSudo(false);
    machine.stepResult('verifyKeyAuth', undefined);
    return privateKeyPath;
  }
  if (disableOutput.includes('BSSH_CONFIG_ERROR')) {
    machine.stepResult('disablePassword', new Error('Config error'));
    throw new Error('sshd config validation failed. Backup restored.');
  }
  machine.stepResult('disablePassword', undefined);

  // Step 5: reload sshd.
  onProgress?.('reloadSshd');
  try {
    await withTimeout(passwordSession.runCommand(buildReloadSshdCommand()), STEP_TIMEOUT_MS);
    machine.stepResult('reloadSshd', undefined);
  } catch (e) {
    machine.stepResult('reloadSshd', new Error('Reload failed'));
    const reason = e instanceof KeySetupTimeout ? 'timeout' : (e as Error).message;
    throw new Error(`Failed to reload SSH daemon: ${reason}`);
  }

  // Step 6: final check — verify key still works after reload.
  onProgress?.('finalCheck');
  try {
    const finalSession = await withTimeout(SshSession.connect(testHost), verifyTimeoutMs);
    finalSession.disconnect();
    machine.stepResult('finalCheck', undefined);
    return privateKeyPath;
  } catch (e) {
    machine.stepResult('finalCheck', new Error('Final check failed'));
    if (e instanceof KeySetupTimeout) {
      throw new Error('Final verification timed out after disabling password. Attempting rollback.');
    }
    throw new Error('Final verification failed after disabling password. Attempting rollback.');
  }
}

async function emergencyRollback(session: SshSession): Promise<void> {
  let output: string;
  try {
    output = await withTimeout(session.runCommand(buildRollbackCommand()), STEP_TIMEOUT_MS);
  } catch (e) {
    const reason = e instanceof KeySetupTimeout ? 'timeout' : (e as Error).message;
    throw new Error(`Rollback failed: ${reason}`);
  }
  if (output.includes('BSSH_NO_BACKUP')) {
    throw new Error('No backup file found for rollback');
  }
}
