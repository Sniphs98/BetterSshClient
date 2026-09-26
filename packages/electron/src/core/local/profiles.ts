import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';

import { listWslDistros } from '../automation/wslExec.js';

/**
 * The shells a local terminal tab can open — what VS Code and Windows Terminal call
 * profiles: found on this machine, never configured. Windows: PowerShell 7, Windows
 * PowerShell, Command Prompt, Git Bash, and every WSL distribution; macOS and Linux:
 * the login shell plus the other usual ones installed.
 */
export interface TerminalProfile {
  /** Stable across runs, so a tab can be reopened with the same one: `pwsh`, `wsl:Ubuntu`, … */
  id: string;
  /** What the menu and the tab say: "PowerShell", "Ubuntu (WSL)", … */
  label: string;
  /** Which of the app's icons fits it. */
  kind: 'powershell' | 'cmd' | 'bash' | 'wsl' | 'shell';
  file: string;
  args: string[];
}

type Env = Record<string, string | undefined>;

/** The first of `paths` that exists. */
function firstExisting(paths: Array<string | undefined>, exists: (p: string) => boolean): string | undefined {
  return paths.find((p): p is string => p !== undefined && exists(p));
}

/** Windows' profiles, from where the installers put each shell. `distros` are the WSL
 *  distributions (see `listWslDistros`). Pure, for tests. */
export function windowsProfiles(env: Env, distros: string[], exists: (p: string) => boolean = existsSync): TerminalProfile[] {
  const out: TerminalProfile[] = [];
  const systemRoot = env.SystemRoot ?? 'C:\\Windows';
  const programFiles = env.ProgramFiles ?? 'C:\\Program Files';

  const pwsh = firstExisting(
    [join(programFiles, 'PowerShell', '7', 'pwsh.exe'), env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'pwsh.exe')],
    exists
  );
  if (pwsh) out.push({ id: 'pwsh', label: 'PowerShell', kind: 'powershell', file: pwsh, args: ['-NoLogo'] });

  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  if (exists(powershell)) {
    out.push({ id: 'powershell', label: 'Windows PowerShell', kind: 'powershell', file: powershell, args: ['-NoLogo'] });
  }

  const cmd = firstExisting([env.ComSpec, join(systemRoot, 'System32', 'cmd.exe')], exists);
  if (cmd) out.push({ id: 'cmd', label: 'Command Prompt', kind: 'cmd', file: cmd, args: [] });

  const gitBash = firstExisting(
    [join(programFiles, 'Git', 'bin', 'bash.exe'), env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe')],
    exists
  );
  if (gitBash) out.push({ id: 'git-bash', label: 'Git Bash', kind: 'bash', file: gitBash, args: ['--login', '-i'] });

  const wsl = join(systemRoot, 'System32', 'wsl.exe');
  for (const distro of distros) {
    // `--cd ~`: the distribution's own home, as a WSL terminal usually starts.
    out.push({ id: `wsl:${distro}`, label: `${distro} (WSL)`, kind: 'wsl', file: wsl, args: ['-d', distro, '--cd', '~'] });
  }
  return out;
}

/** macOS/Linux: the login shell first, then the other common ones present, each as a
 *  login shell (`-l`) so it reads the same profile a new Terminal window would. */
export function unixProfiles(env: Env, exists: (p: string) => boolean = existsSync): TerminalProfile[] {
  const candidates = [env.SHELL, '/bin/zsh', '/bin/bash', '/usr/bin/zsh', '/usr/bin/bash', '/usr/bin/fish', '/opt/homebrew/bin/fish', '/bin/sh'];
  const seen = new Set<string>();
  const out: TerminalProfile[] = [];
  for (const file of candidates) {
    if (!file || !exists(file)) continue;
    const name = basename(file);
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ id: `shell:${file}`, label: name, kind: name === 'bash' ? 'bash' : 'shell', file, args: ['-l'] });
  }
  return out;
}

/** This machine's profiles, the default one first. */
export async function listTerminalProfiles(): Promise<TerminalProfile[]> {
  if (process.platform === 'win32') return windowsProfiles(process.env, await listWslDistros());
  return unixProfiles(process.env);
}
