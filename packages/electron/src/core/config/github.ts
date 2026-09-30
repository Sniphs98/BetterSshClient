import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse, stringify } from 'smol-toml';

import { readSecretCached } from '../secrets/onePassword.js';
import { appConfigDir } from './platform.js';
import { getSecretCipher } from './secretCipher.js';
import { decryptSecret, encryptSecret } from './secretField.js';

/**
 * `github.toml`: how the app signs in to GitHub for the automation's GitHub steps —
 * a 1Password reference read when needed, or a token kept here, encrypted the same way
 * as host passwords. The reference wins when both are set.
 */

export interface GitHubSettings {
  token?: string;
  tokenRef?: string;
}

function path(): string {
  return join(appConfigDir(), 'github.toml');
}

export async function loadGitHubSettings(): Promise<GitHubSettings> {
  if (!existsSync(path())) return {};
  const raw = parse(await readFile(path(), 'utf-8')) as Record<string, unknown>;
  return {
    token: typeof raw.token === 'string' ? decryptSecret(raw.token, getSecretCipher()) : undefined,
    tokenRef: typeof raw.tokenRef === 'string' && raw.tokenRef.trim() ? raw.tokenRef : undefined
  };
}

export async function saveGitHubSettings(settings: GitHubSettings): Promise<void> {
  await mkdir(appConfigDir(), { recursive: true });
  const out: Record<string, unknown> = {};
  if (settings.token) out.token = encryptSecret(settings.token, getSecretCipher());
  if (settings.tokenRef) out.tokenRef = settings.tokenRef;
  const tmp = `${path()}.tmp`;
  await writeFile(tmp, stringify(out), 'utf-8');
  try {
    await rename(tmp, path());
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  if (process.platform !== 'win32') await chmod(path(), 0o600).catch(() => {});
}

/** The token to use, from 1Password or as stored. */
export async function resolveGitHubToken(settings?: GitHubSettings): Promise<string> {
  const s = settings ?? (await loadGitHubSettings());
  if (s.tokenRef) return readSecretCached(s.tokenRef);
  if (s.token) return s.token;
  throw new Error('no GitHub token yet — add one in Settings → GitHub');
}
