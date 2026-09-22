import { homedir } from 'node:os';
import { join } from 'node:path';

/** Ported from crates/omnyssh-core/src/utils/platform.rs. */

/** `~/.ssh/config` on every platform (Windows: `%USERPROFILE%\.ssh\config`). */
export function sshConfigPath(): string {
  return join(homedir(), '.ssh', 'config');
}

/**
 * The application config directory.
 * - Linux:   `~/.config/better-ssh-client/`
 * - macOS:   `~/Library/Application Support/better-ssh-client/`
 * - Windows: `%APPDATA%\better-ssh-client\`
 */
export function appConfigDir(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'better-ssh-client');
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'better-ssh-client');
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return join(xdgConfig, 'better-ssh-client');
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
