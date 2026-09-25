import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CREDENTIAL_COMMENT,
  credentialTarget,
  removeCredential,
  setCredentialRunner,
  stageCredential,
  sweepStagedCredentials
} from './windowsCredentials.js';

// The PowerShell side is exercised against the real credential store by hand (see the
// PR); here the runner is faked to pin down what goes where.

function decode(input: string): Record<string, string> {
  return JSON.parse(Buffer.from(input.trim(), 'base64').toString('utf8')) as Record<string, string>;
}

describe('windowsCredentials', () => {
  const originalPlatform = process.platform;
  const originalAppData = process.env.APPDATA;
  let configRoot: string;
  const runner = vi.fn<(script: string, input: string) => Promise<string>>();

  beforeEach(async () => {
    configRoot = await mkdtemp(join(tmpdir(), 'bssh-cred-'));
    process.env.APPDATA = configRoot;
    process.env.XDG_CONFIG_HOME = configRoot;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    runner.mockReset();
    setCredentialRunner(runner);
  });

  afterEach(async () => {
    setCredentialRunner(null);
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    process.env.APPDATA = originalAppData;
    delete process.env.XDG_CONFIG_HOME;
    await rm(configRoot, { recursive: true, force: true });
  });

  it('targets TERMSRV/<host>, the name mstsc looks up', () => {
    expect(credentialTarget('10.0.0.5')).toBe('TERMSRV/10.0.0.5');
  });

  it('passes the password only as stdin input, never in the script', async () => {
    runner.mockResolvedValue('staged');

    expect(await stageCredential('10.0.0.5', 'CORP\\admin', 'p@ss "x"')).toBe('staged');

    const [script, input] = runner.mock.calls[0];
    expect(script).not.toContain('p@ss');
    expect(decode(input)).toEqual({
      target: 'TERMSRV/10.0.0.5',
      user: 'CORP\\admin',
      password: 'p@ss "x"',
      marker: CREDENTIAL_COMMENT
    });
    // Session-only, and replaces only its own.
    expect(script).toContain('c.Persist = 1');
    expect(script).toContain('-eq "foreign"');
  });

  it('reports a credential the user saved themselves as kept', async () => {
    runner.mockResolvedValue('kept-existing');
    expect(await stageCredential('10.0.0.5', 'admin', 'x')).toBe('kept-existing');
  });

  it('removes only its own credential', async () => {
    runner.mockResolvedValue('');
    await removeCredential('10.0.0.5');
    const [script, input] = runner.mock.calls[0];
    expect(script).toContain('DeleteIfOurs');
    expect(decode(input).target).toBe('TERMSRV/10.0.0.5');
  });

  it('sweeps only after a launch left its marker, and only once', async () => {
    runner.mockResolvedValue('staged');
    expect(await sweepStagedCredentials()).toBe(0);
    expect(runner).not.toHaveBeenCalled();

    await stageCredential('10.0.0.5', 'admin', 'x');
    expect(existsSync(join(configRoot, 'better-ssh-client', 'rdp-staged-credentials'))).toBe(true);

    runner.mockResolvedValue('2');
    expect(await sweepStagedCredentials()).toBe(2);
    expect(runner.mock.calls.at(-1)?.[0]).toContain('Sweep');
    expect(await sweepStagedCredentials()).toBe(0);
    expect(runner).toHaveBeenCalledTimes(2);
  });
});
