/**
 * In-app update checker. Ported from crates/omnyssh-core/src/update.rs,
 * minus the bespoke self-update mechanism (`perform_update`, checksum
 * verification, binary self-replace) — Electron has its own mature
 * auto-update tooling (`electron-updater`) for that, which needs signed
 * releases and a publish provider configured before it can do anything
 * real. Until then `install_update` reports "not available yet", matching
 * the Tauri build's own unconfigured updater.
 */

const REPO = 'Sniphs98/better-ssh-client';
const HTTP_TIMEOUT_MS = 8000;

export interface UpdateInfo {
  /** Latest released version (without a leading `v`). */
  version: string;
  /** Release page URL. */
  url: string;
  /** Git tag of the latest release (e.g. `v1.0.2`). */
  tag: string;
  canSelfUpdate: boolean;
}

interface GithubRelease {
  tag_name: string;
}

/** Queries GitHub for the latest release. Returns `undefined` unless a
 *  strictly newer version exists. Any network/parse error yields
 *  `undefined` too, so a failed check never disrupts startup. */
export async function checkUpdate(currentVersion: string): Promise<UpdateInfo | undefined> {
  let tag: string;
  try {
    tag = await fetchLatestTag();
  } catch {
    return undefined;
  }
  const version = tag.replace(/^v/, '');

  if (!isNewer(version, currentVersion)) return undefined;

  return {
    version,
    tag,
    url: `https://github.com/${REPO}/releases/tag/${tag}`,
    // No self-update mechanism wired up yet (see module doc comment).
    canSelfUpdate: false
  };
}

/** Returns `true` when `latest` is a strictly greater semver than
 *  `current`. An unparseable version yields `false` — never nag on bad data. */
export function isNewer(latest: string, current: string): boolean {
  const l = parseSemver(latest);
  const c = parseSemver(current);
  if (l === undefined || c === undefined) return false;
  if (l.major !== c.major) return l.major > c.major;
  if (l.minor !== c.minor) return l.minor > c.minor;
  return l.patch > c.patch;
}

function parseSemver(value: string): { major: number; minor: number; patch: number } | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  if (match === null) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

async function fetchLatestTag(): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      // GitHub requires a User-Agent header on API requests.
      headers: { 'User-Agent': 'better-ssh-client', Accept: 'application/vnd.github+json' },
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`release request returned ${res.status}`);
    const release = (await res.json()) as GithubRelease;
    return release.tag_name;
  } finally {
    clearTimeout(timer);
  }
}
