import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parse, stringify } from 'smol-toml';

import { appConfigPath } from './platform.js';

/** Main application configuration. Ported from
 *  crates/omnyssh-core/src/config/app_config.rs. Every section falls back to
 *  its default when absent, so a config file from an older release still
 *  parses (`#[serde(default)]` everywhere in the Rust struct). */

export interface GeneralConfig {
  refreshInterval: number;
  defaultShell: string;
  sshCommand: string;
  maxConcurrentConnections: number;
}

export interface UiConfig {
  theme: string;
  showIp: boolean;
  showUptime: boolean;
  cardLayout: string;
  borderStyle: string;
}

export const AVAILABLE_THEMES = ['default', 'dracula', 'nord', 'gruvbox'] as const;

export function isValidTheme(name: string): boolean {
  return (AVAILABLE_THEMES as readonly string[]).includes(name);
}

export interface KeybindingsConfig {
  quit: string;
  search: string;
  dashboard: string;
  fileManager: string;
  nextScreen: string;
  nextTab: string;
}

export interface AutoKeySetupConfig {
  enabled: boolean;
  suggestOnPasswordAuth: boolean;
  disablePasswordAuth: boolean;
  keyType: string;
  keyDirectory: string;
  backupSshdConfig: boolean;
  confirmBeforeDisable: boolean;
}

export interface UpdateConfig {
  checkOnStartup: boolean;
  skipVersion: string;
}

export interface AppConfig {
  general: GeneralConfig;
  ui: UiConfig;
  keybindings: KeybindingsConfig;
  autoKeySetup: AutoKeySetupConfig;
  update: UpdateConfig;
}

function defaultGeneral(): GeneralConfig {
  return { refreshInterval: 30, defaultShell: '/bin/bash', sshCommand: 'ssh', maxConcurrentConnections: 10 };
}

function defaultUi(): UiConfig {
  return { theme: 'default', showIp: true, showUptime: true, cardLayout: 'grid', borderStyle: 'rounded' };
}

function defaultKeybindings(): KeybindingsConfig {
  return {
    quit: 'q',
    search: '/',
    dashboard: 'F1',
    fileManager: 'F2',
    nextScreen: 'Tab',
    nextTab: 'Ctrl+N'
  };
}

function defaultAutoKeySetup(): AutoKeySetupConfig {
  return {
    enabled: true,
    suggestOnPasswordAuth: true,
    disablePasswordAuth: true,
    keyType: 'ed25519',
    keyDirectory: '~/.ssh',
    backupSshdConfig: true,
    confirmBeforeDisable: true
  };
}

export function defaultUpdateConfig(): UpdateConfig {
  return { checkOnStartup: true, skipVersion: '' };
}

export function defaultAppConfig(): AppConfig {
  return {
    general: defaultGeneral(),
    ui: defaultUi(),
    keybindings: defaultKeybindings(),
    autoKeySetup: defaultAutoKeySetup(),
    update: defaultUpdateConfig()
  };
}

function section<T extends object>(defaults: T, raw: unknown): T {
  if (raw === undefined || raw === null || typeof raw !== 'object') return defaults;
  return { ...defaults, ...(raw as Partial<T>) };
}

const TOML_KEY_MAP: Record<string, string> = {
  refresh_interval: 'refreshInterval',
  default_shell: 'defaultShell',
  ssh_command: 'sshCommand',
  max_concurrent_connections: 'maxConcurrentConnections',
  show_ip: 'showIp',
  show_uptime: 'showUptime',
  card_layout: 'cardLayout',
  border_style: 'borderStyle',
  file_manager: 'fileManager',
  next_screen: 'nextScreen',
  next_tab: 'nextTab',
  suggest_on_password_auth: 'suggestOnPasswordAuth',
  disable_password_auth: 'disablePasswordAuth',
  key_type: 'keyType',
  key_directory: 'keyDirectory',
  backup_sshd_config: 'backupSshdConfig',
  confirm_before_disable: 'confirmBeforeDisable',
  check_on_startup: 'checkOnStartup',
  skip_version: 'skipVersion'
};
const REVERSE_KEY_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(TOML_KEY_MAP).map(([snake, camel]) => [camel, snake])
);

function fromTomlKeys(raw: unknown): unknown {
  if (raw === null || typeof raw !== 'object') return raw;
  if (Array.isArray(raw)) return raw.map(fromTomlKeys);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    out[TOML_KEY_MAP[k] ?? k] = v;
  }
  return out;
}

function toTomlKeys(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(toTomlKeys);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[REVERSE_KEY_MAP[k] ?? k] = v;
  }
  return out;
}

function parseAppConfig(content: string): AppConfig {
  const raw = fromTomlKeys(parse(content)) as Record<string, unknown>;
  return {
    general: section(defaultGeneral(), raw.general),
    ui: section(defaultUi(), raw.ui),
    keybindings: section(defaultKeybindings(), raw.keybindings),
    autoKeySetup: section(defaultAutoKeySetup(), raw.autoKeySetup),
    update: section(defaultUpdateConfig(), raw.update)
  };
}

/** Loads the application config from `path`, or the default location when
 *  omitted. A missing file yields the default config; a malformed one throws. */
export async function loadAppConfig(path?: string): Promise<AppConfig> {
  const configPath = path ?? appConfigPath();
  if (!existsSync(configPath)) return defaultAppConfig();
  const content = await readFile(configPath, 'utf-8');
  return parseAppConfig(content);
}

/** Reads the on-disk config (or the default), applies `mutate`, and writes it
 *  back. Reading fresh from disk avoids clobbering unrelated edits. */
async function persistConfig(mutate: (config: AppConfig) => void): Promise<void> {
  const configPath = appConfigPath();
  await mkdir(dirname(configPath), { recursive: true });

  const config = existsSync(configPath) ? parseAppConfig(await readFile(configPath, 'utf-8')) : defaultAppConfig();
  mutate(config);

  const content = stringify(toTomlKeys(config) as Record<string, unknown>);
  await writeFile(configPath, content, 'utf-8');
  if (process.platform !== 'win32') {
    await chmod(configPath, 0o600).catch(() => {});
  }
}

export async function saveThemeToConfig(themeName: string): Promise<void> {
  await persistConfig((config) => {
    config.ui.theme = themeName;
  });
}

export async function saveUpdateConfig(update: UpdateConfig): Promise<void> {
  await persistConfig((config) => {
    config.update = { ...update };
  });
}
