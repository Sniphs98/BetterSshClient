import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clearUpdateSplash, updateFlagPath, updateSplashCommand } from './updateSplash.js';

describe('updateSplashCommand', () => {
  const cmd = updateSplashCommand('C:\\Temp\\better-ssh-client-updating', '1.12.0', 'C:\\Apps\\BetterSshClient.exe', { PATH: 'x' });

  it('starts a hidden PowerShell through `cmd /c start`, outside the app', () => {
    expect(cmd.file).toBe('cmd.exe');
    expect(cmd.args[0]).toBe('/d');
    expect(cmd.args[1]).toBe('/c');
    expect(cmd.args[2]).toMatch(/^start "" \/min powershell\.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand [A-Za-z0-9+/=]+$/);
  });

  it('passes what it shows and watches as environment, never inside the script', () => {
    expect(cmd.env).toMatchObject({
      PATH: 'x',
      BSSH_UPDATE_FLAG: 'C:\\Temp\\better-ssh-client-updating',
      BSSH_UPDATE_VERSION: '1.12.0',
      BSSH_APP_EXE: 'C:\\Apps\\BetterSshClient.exe'
    });
    const script = Buffer.from(cmd.args[2].split(' ').pop()!, 'base64').toString('utf16le');
    expect(script).toContain('$env:BSSH_UPDATE_FLAG');
    expect(script).not.toContain('1.12.0');
    expect(script).not.toContain('BetterSshClient.exe');
    // Closes when the flag goes, when the app runs again, and after three minutes at the latest.
    expect(script).toMatch(/Test-Path -LiteralPath \$flag/);
    expect(script).toMatch(/Get-Process -Name \$appName/);
    expect(script).toContain('-gt 180');
  });
});

describe('clearUpdateSplash', () => {
  let dir: string;
  beforeEach(async () => (dir = await mkdtemp(join(tmpdir(), 'bssh-splash-'))));
  afterEach(async () => rm(dir, { recursive: true, force: true }));

  it("removes the flag an update left, so its window closes; nothing to do otherwise", async () => {
    expect(clearUpdateSplash(dir)).toBe(false);
    await writeFile(updateFlagPath(dir), 'shown');
    expect(clearUpdateSplash(dir)).toBe(true);
    expect(existsSync(updateFlagPath(dir))).toBe(false);
  });
});
