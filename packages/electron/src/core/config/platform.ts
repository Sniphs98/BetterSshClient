import { homedir } from 'node:os';
import { join } from 'node:path';

/** Ported from crates/omnyssh-core/src/utils/platform.rs. */

/** `~/.ssh/config` on every platform (Windows: `%USERPROFILE%\.ssh\config`). */
export function sshConfigPath(): string {
  return join(homedir(), '.ssh', 'config');
}

/**
 * The application config directory.
 * - Linux:   `~/.config/remoty/`
 * - macOS:   `~/Library/Application Support/remoty/`
 * - Windows: `%APPDATA%\remoty\`
 */
export function appConfigDir(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'remoty');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'remoty');
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return join(xdgConfig, 'remoty');
}

export function appConfigPath(): string {
  return join(appConfigDir(), 'config.toml');
}

export function hostsConfigPath(): string {
  return join(appConfigDir(), 'hosts.toml');
}

export function snippetsConfigPath(): string {
  return join(appConfigDir(), 'snippets.toml');
}

export function automationsConfigPath(): string {
  return join(appConfigDir(), 'automations.toml');
}

export function remoteDesktopConfigPath(): string {
  return join(appConfigDir(), 'remote-desktop.toml');
}
