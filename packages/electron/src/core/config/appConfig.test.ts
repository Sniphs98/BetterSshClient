import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultAppConfig, defaultUpdateConfig, isValidTheme, loadAppConfig } from './appConfig.js';

// Ported from crates/omnyssh-core/src/config/app_config.rs's #[cfg(test)] module.

describe('UpdateConfig defaults', () => {
  it('defaults to checking on startup with no skipped version', () => {
    const cfg = defaultUpdateConfig();
    expect(cfg.checkOnStartup).toBe(true);
    expect(cfg.skipVersion).toBe('');
  });
});

describe('isValidTheme', () => {
  it('accepts the built-in themes and rejects anything else', () => {
    expect(isValidTheme('dracula')).toBe(true);
    expect(isValidTheme('unknown')).toBe(false);
  });
});

describe('loadAppConfig', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'better-ssh-client-appconfig-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('a missing file yields the default config', async () => {
    const cfg = await loadAppConfig(join(tmp, 'nope.toml'));
    expect(cfg).toEqual(defaultAppConfig());
  });

  it('a config file written by an older release (no [update] section) still parses', async () => {
    const path = join(tmp, 'config.toml');
    await writeFile(path, '[ui]\ntheme = "nord"\n');
    const cfg = await loadAppConfig(path);
    expect(cfg.ui.theme).toBe('nord');
    expect(cfg.update.checkOnStartup).toBe(true);
  });
});
