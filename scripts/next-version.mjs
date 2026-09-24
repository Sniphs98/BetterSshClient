#!/usr/bin/env node
// Works out the next release from the commits merged since the last one, the way
// the Release workflow (.github/workflows/release.yml) needs it: every merge to main
// is a release candidate, and the Conventional Commit types in it decide the bump.
//
//   feat                         → minor   (1.2.3 → 1.3.0)
//   fix, perf                    → patch   (1.2.3 → 1.2.4)
//   `type!:` or BREAKING CHANGE  → major   (1.2.3 → 2.0.0)
//   anything else (docs, test, chore, refactor, ci, merge commits) → no release
//
// A version set by hand in packages/electron/package.json that is ahead of the last
// tag wins outright: that release goes out under exactly that number.
//
// Usage:
//   node scripts/next-version.mjs [--notes <file>]
// Prints the decision as JSON; under GitHub Actions it is also written to
// $GITHUB_OUTPUT (release, version, tag, previous_tag). `--notes` writes the
// release notes (the commits, grouped by type) as Markdown.

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BUMPS = ['patch', 'minor', 'major'];

/** `1.2.3` (optionally `v`-prefixed) → `[1, 2, 3]`, or `undefined`. */
export function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(value).trim());
  return match ? match.slice(1, 4).map(Number) : undefined;
}

export function compareVersions(a, b) {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

export function bumpVersion(version, bump) {
  const [major, minor, patch] = parseVersion(version);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

/** A commit message's Conventional Commit parts, or `undefined` if it isn't one. */
export function parseCommit(message) {
  const [subject = '', ...rest] = message.trim().split('\n');
  const match = /^(\w+)(?:\(([^)]*)\))?(!)?:\s+(.+)$/.exec(subject.trim());
  if (!match) return undefined;
  const body = rest.join('\n');
  return {
    type: match[1].toLowerCase(),
    scope: match[2] || undefined,
    breaking: match[3] === '!' || /^BREAKING[ -]CHANGE:/m.test(body),
    summary: match[4].trim()
  };
}

/** The bump the given commit messages call for: `major`, `minor`, `patch` or `undefined`. */
export function bumpFor(messages) {
  let level = -1;
  for (const message of messages) {
    const commit = parseCommit(message);
    if (!commit) continue;
    if (commit.breaking) level = Math.max(level, 2);
    else if (commit.type === 'feat') level = Math.max(level, 1);
    else if (commit.type === 'fix' || commit.type === 'perf') level = Math.max(level, 0);
  }
  return BUMPS[level];
}

/**
 * The release decision. `lastTag` is the newest release tag reachable from HEAD
 * (or undefined), `packageVersion` the version in package.json.
 */
export function decide({ lastTag, packageVersion, messages }) {
  const bump = bumpFor(messages);
  if (!lastTag) {
    // The very first release goes out as exactly the version in package.json.
    return bump ? { release: true, version: packageVersion, bump: 'initial' } : { release: false, version: packageVersion };
  }
  const released = lastTag.replace(/^v/, '');
  // A version set by hand ahead of the last release is the release.
  if (compareVersions(packageVersion, released) > 0) return { release: true, version: packageVersion, bump: 'manual' };
  return bump ? { release: true, version: bumpVersion(released, bump), bump } : { release: false, version: released };
}

const SECTIONS = [
  ['breaking', '⚠️ Breaking changes'],
  ['feat', 'Features'],
  ['fix', 'Bug fixes'],
  ['perf', 'Performance']
];

/** Markdown release notes: the user-facing commits, grouped by type. */
export function releaseNotes(messages, { previousTag, version, repo } = {}) {
  const groups = new Map(SECTIONS.map(([key]) => [key, []]));
  for (const message of messages) {
    const commit = parseCommit(message);
    if (!commit) continue;
    const line = `- ${commit.scope ? `**${commit.scope}:** ` : ''}${commit.summary}`;
    if (commit.breaking) groups.get('breaking').push(line);
    else if (groups.has(commit.type)) groups.get(commit.type).push(line);
  }
  const parts = [];
  for (const [key, title] of SECTIONS) {
    const lines = groups.get(key);
    if (lines.length) parts.push(`### ${title}\n\n${lines.join('\n')}`);
  }
  if (!parts.length) parts.push('Maintenance release.');
  if (previousTag && version && repo) {
    parts.push(`**Full changelog:** https://github.com/${repo}/compare/${previousTag}...v${version}`);
  }
  return `${parts.join('\n\n')}\n`;
}

// --- CLI ---------------------------------------------------------------------

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function lastReleaseTag() {
  try {
    return git('describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*.[0-9]*.[0-9]*', 'HEAD');
  } catch {
    return undefined; // no release tag yet
  }
}

function commitMessagesSince(tag) {
  const range = tag ? [`${tag}..HEAD`] : ['HEAD'];
  return git('log', '--format=%B%x1e', ...range)
    .split('\x1e')
    .map((m) => m.trim())
    .filter(Boolean);
}

function main(argv) {
  const notesAt = argv.indexOf('--notes');
  const notesFile = notesAt === -1 ? undefined : argv[notesAt + 1];

  const packageVersion = JSON.parse(readFileSync(new URL('../packages/electron/package.json', import.meta.url))).version;
  const lastTag = lastReleaseTag();
  const messages = commitMessagesSince(lastTag);
  const decision = decide({ lastTag, packageVersion, messages });
  const result = { ...decision, tag: `v${decision.version}`, previousTag: lastTag ?? '' };

  if (notesFile) {
    const repo = process.env.GITHUB_REPOSITORY;
    writeFileSync(notesFile, releaseNotes(messages, { previousTag: lastTag, version: decision.version, repo }));
  }
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `release=${result.release}\nversion=${result.version}\ntag=${result.tag}\nprevious_tag=${result.previousTag}\n`
    );
  }
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
