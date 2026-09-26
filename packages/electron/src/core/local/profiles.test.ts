import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { unixProfiles, windowsProfiles } from './profiles.js';

describe('windowsProfiles', () => {
  const env = { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', ComSpec: 'C:\\Windows\\System32\\cmd.exe', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' };

  it('offers each shell that is installed, and every WSL distribution', () => {
    const installed = new Set([
      join('C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
      join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      'C:\\Windows\\System32\\cmd.exe',
      join('C:\\Program Files', 'Git', 'bin', 'bash.exe')
    ]);
    const profiles = windowsProfiles(env, ['Ubuntu', 'Debian'], (p) => installed.has(p));
    expect(profiles.map((p) => [p.id, p.label])).toEqual([
      ['pwsh', 'PowerShell'],
      ['powershell', 'Windows PowerShell'],
      ['cmd', 'Command Prompt'],
      ['git-bash', 'Git Bash'],
      ['wsl:Ubuntu', 'Ubuntu (WSL)'],
      ['wsl:Debian', 'Debian (WSL)']
    ]);
    expect(profiles.find((p) => p.id === 'wsl:Ubuntu')?.args).toEqual(['-d', 'Ubuntu', '--cd', '~']);
  });

  it('leaves out what is not installed', () => {
    const profiles = windowsProfiles(env, [], (p) => p === 'C:\\Windows\\System32\\cmd.exe');
    expect(profiles.map((p) => p.id)).toEqual(['cmd']);
  });
});

describe('unixProfiles', () => {
  it('puts the login shell first, each shell once, as a login shell', () => {
    const installed = new Set(['/bin/zsh', '/bin/bash', '/usr/bin/bash', '/bin/sh']);
    const profiles = unixProfiles({ SHELL: '/bin/bash' }, (p) => installed.has(p));
    expect(profiles.map((p) => p.label)).toEqual(['bash', 'zsh', 'sh']);
    expect(profiles[0]).toMatchObject({ id: 'shell:/bin/bash', file: '/bin/bash', args: ['-l'] });
  });
});
