import { describe, expect, it } from 'vitest';

import {
  ALL_STEPS,
  KeySetupMachine,
  buildAuthorizedKeysCommand,
  buildDisablePasswordCommand,
  buildReloadSshdCommand,
  sanitizeHostname
} from './keySetup.js';

// Ported from crates/omnyssh-core/src/ssh/key_setup.rs's #[cfg(test)] module.

describe('sanitizeHostname', () => {
  it('keeps alphanumerics, hyphens and underscores as-is', () => {
    expect(sanitizeHostname('web-prod-1')).toBe('web-prod-1');
  });

  it('replaces spaces and parentheses with underscores', () => {
    expect(sanitizeHostname('my server (prod)')).toBe('my_server__prod_');
  });

  it('replaces dots too, to block path traversal', () => {
    expect(sanitizeHostname('../../etc/passwd')).toBe('______etc_passwd');
  });

  it('empty input becomes "unnamed_host"', () => {
    expect(sanitizeHostname('')).toBe('unnamed_host');
  });

  it('replaces every other punctuation character', () => {
    expect(sanitizeHostname('a/b\\c:d*e?f')).toBe('a_b_c_d_e_f');
  });

  it('truncates to 64 characters', () => {
    const long = 'a'.repeat(100);
    expect(sanitizeHostname(long)).toHaveLength(64);
  });
});

describe('KeySetupStep ordering', () => {
  it('has 6 steps, GenerateKey first and FinalCheck last', () => {
    expect(ALL_STEPS).toHaveLength(6);
    expect(ALL_STEPS[0]).toBe('generateKey');
    expect(ALL_STEPS[5]).toBe('finalCheck');
  });
});

describe('KeySetupMachine', () => {
  it('a VerifyKeyAuth failure stops the process — password must not be disabled', () => {
    const machine = new KeySetupMachine();
    machine.stepResult('generateKey', undefined);
    machine.stepResult('copyPublicKey', undefined);
    machine.stepResult('verifyKeyAuth', new Error('connection refused'));

    expect(machine.state).toBe('failedSafe');
    expect(machine.passwordDisabled).toBe(false);
  });

  it('key works but no sudo → partial success', () => {
    const machine = new KeySetupMachine();
    machine.setHasSudo(false);

    machine.stepResult('generateKey', undefined);
    machine.stepResult('copyPublicKey', undefined);
    machine.stepResult('verifyKeyAuth', undefined);

    expect(machine.state).toBe('partialSuccess');
    expect(machine.passwordDisabled).toBe(false);
  });

  it('markKeyOnlySuccess reaches success without disabling the password (user opted out)', () => {
    const machine = new KeySetupMachine();
    machine.stepResult('generateKey', undefined);
    machine.stepResult('copyPublicKey', undefined);
    machine.stepResult('verifyKeyAuth', undefined);
    machine.markKeyOnlySuccess();

    expect(machine.state).toBe('success');
    expect(machine.passwordDisabled).toBe(false);
  });

  it('a FinalCheck failure after DisablePassword triggers rollback', () => {
    const machine = new KeySetupMachine();
    machine.stepResult('generateKey', undefined);
    machine.stepResult('copyPublicKey', undefined);
    machine.stepResult('verifyKeyAuth', undefined);
    machine.stepResult('disablePassword', undefined);
    machine.stepResult('reloadSshd', undefined);
    machine.stepResult('finalCheck', new Error('timeout'));

    expect(machine.state).toBe('needsRollback');
    expect(machine.passwordDisabled).toBe(true);
  });

  it('the full happy path reaches success', () => {
    const machine = new KeySetupMachine();
    machine.stepResult('generateKey', undefined);
    machine.stepResult('copyPublicKey', undefined);
    machine.stepResult('verifyKeyAuth', undefined);
    machine.stepResult('disablePassword', undefined);
    machine.stepResult('reloadSshd', undefined);
    machine.stepResult('finalCheck', undefined);

    expect(machine.state).toBe('success');
    expect(machine.passwordDisabled).toBe(true);
  });

  it('rollbackComplete clears passwordDisabled and sets rolledBack', () => {
    const machine = new KeySetupMachine();
    machine.stepResult('disablePassword', undefined);
    machine.rollbackComplete();
    expect(machine.state).toBe('rolledBack');
    expect(machine.passwordDisabled).toBe(false);
  });
});

describe('buildAuthorizedKeysCommand', () => {
  it('escapes single quotes', () => {
    const cmd = buildAuthorizedKeysCommand("ssh-ed25519 AAAA... user's key");
    expect(cmd).toContain("user'\\''s");
  });

  it('appends, never overwrites', () => {
    const cmd = buildAuthorizedKeysCommand('ssh-ed25519 AAAA...');
    expect(cmd).toContain('>> ~/.ssh/authorized_keys');
    expect(cmd).not.toContain(' > ~/.ssh/authorized_keys');
  });

  it('rejects a multi-line or null-containing key', () => {
    expect(() => buildAuthorizedKeysCommand('ssh-ed25519 AAA\nAAA')).toThrow();
    expect(() => buildAuthorizedKeysCommand('ssh-ed25519 AAA\0AAA')).toThrow();
  });

  it('rejects an unrecognised key type', () => {
    expect(() => buildAuthorizedKeysCommand('ssh-dss AAAA...')).toThrow();
  });

  it('accepts ssh-rsa and ecdsa-sha2- key types', () => {
    expect(() => buildAuthorizedKeysCommand('ssh-rsa AAAA...')).not.toThrow();
    expect(() => buildAuthorizedKeysCommand('ecdsa-sha2-nistp256 AAAA...')).not.toThrow();
  });
});

describe('buildDisablePasswordCommand', () => {
  const cmd = buildDisablePasswordCommand();

  it('creates a timestamped backup and validates with sshd -t', () => {
    expect(cmd).toContain('omnyssh_backup.');
    expect(cmd).toContain('sshd -t');
  });

  it('comments out the cloud-init Include directive', () => {
    expect(cmd).toContain("'s|^Include /etc/ssh/sshd_config.d/|#Include /etc/ssh/sshd_config.d/|'");
  });

  it('disables every password-adjacent auth method', () => {
    expect(cmd).toContain('PasswordAuthentication no');
    expect(cmd).toContain('ChallengeResponseAuthentication no');
    expect(cmd).toContain('KbdInteractiveAuthentication no');
    expect(cmd).toContain('UsePAM no');
  });

  it('prepends each directive when the config has no existing occurrence', () => {
    expect(cmd).toContain("grep -qE '^PasswordAuthentication[[:space:]]'");
    expect(cmd).toContain("sed -i '1i PasswordAuthentication no'");
    expect(cmd).toContain("grep -qE '^UsePAM[[:space:]]'");
    expect(cmd).toContain("sed -i '1i UsePAM no'");
  });
});

describe('buildReloadSshdCommand', () => {
  it('uses reload, not restart', () => {
    const cmd = buildReloadSshdCommand();
    expect(cmd).toContain('reload');
    expect(cmd).not.toContain('restart');
  });
});
