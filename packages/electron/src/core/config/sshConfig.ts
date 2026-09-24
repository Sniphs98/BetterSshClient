import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { escape as globEscape, globSync } from 'glob';

import type { Host } from '../ssh/client.js';
import { defaultHost } from '../ssh/client.js';
import { sshConfigPath } from './platform.js';

/**
 * Parser for `~/.ssh/config`. Ported from
 * crates/omnyssh-core/src/config/ssh_config.rs.
 *
 * Supported directives: `Host`, `HostName`, `User`, `Port`, `IdentityFile`,
 * `ProxyJump`, `Include`. The original file is never modified.
 */

/** `~/.ssh` — where `ssh_config(5)` resolves a relative `Include` in a user
 *  configuration. Never the process working directory. */
function defaultIncludeBase(): string {
  return join(homedir(), '.ssh');
}

/** Parses the text of an SSH config file and returns all non-wildcard hosts. */
export function parseSshConfig(content: string): Host[] {
  return parseContent(content, defaultIncludeBase(), 0, new Set<string>());
}

/** Loads and parses an SSH config file from disk. */
export function loadFromFile(path: string): Host[] {
  const content = readFileSync(path, 'utf-8');
  const parent = dirname(path);
  const base = parent === '' ? defaultIncludeBase() : parent;
  return parseContent(content, base, 0, new Set<string>());
}

function parseContent(content: string, base: string | undefined, depth: number, visited: Set<string>): Host[] {
  if (depth > 3) return [];

  const hosts: Host[] = [];
  let current: Host | undefined;
  // Hosts pulled in by an Include that sat inside a Host block. Appended once the
  // enclosing host is flushed, so the list keeps the config's own order.
  let deferred: Host[] = [];
  // True while inside a wildcard `Host *` block (skip directives).
  let inWildcard = false;

  for (const rawLine of content.split(/\r\n|\r|\n/)) {
    const line = stripComment(rawLine).trim();
    if (line === '') continue;

    const kv = splitKv(line);
    if (!kv) continue;
    const [keyword, value] = kv;

    switch (keyword.toLowerCase()) {
      case 'host': {
        if (current) hosts.push(current);
        hosts.push(...deferred);
        deferred = [];
        inWildcard = value.includes('*') || value.includes('?');
        current = inWildcard ? undefined : { ...defaultHost(), name: value, source: 'ssh_config' };
        break;
      }
      case 'hostname':
        if (!inWildcard && current) current.hostname = value;
        break;
      case 'user':
        if (!inWildcard && current) current.user = value;
        break;
      case 'port': {
        if (!inWildcard && current && /^\d+$/.test(value)) {
          const p = Number.parseInt(value, 10);
          if (p >= 0 && p <= 65535) current.port = p;
        }
        break;
      }
      case 'identityfile':
        if (!inWildcard && current) current.identityFile = expandTilde(value);
        break;
      case 'proxyjump':
        if (!inWildcard && current) current.proxyJump = value;
        break;
      case 'include': {
        const sink = current ? deferred : hosts;
        for (const pattern of splitIncludePatterns(value)) {
          const resolved = resolveInclude(pattern, base);
          if (resolved === undefined) {
            continue;
          }
          const matched = expandIncludeGlob(resolved);
          for (const path of matched) {
            let canonical = path;
            try {
              canonical = realpathSync(path);
            } catch {
              // symlink-cycle detection disabled for this path
            }
            if (visited.has(canonical)) continue; // already visited — break cycle
            visited.add(canonical);
            try {
              const sub = readFileSync(path, 'utf-8');
              sink.push(...parseContent(sub, base, depth + 1, visited));
            } catch {
              // Include file unreadable — skip.
            }
          }
        }
        break;
      }
      default:
        break; // Unknown directive — silently ignore.
    }
  }

  if (current) hosts.push(current);
  hosts.push(...deferred);

  // Fallback: if HostName was never set, use the alias as the address.
  for (const h of hosts) {
    if (h.hostname === '') h.hostname = h.name;
  }

  return hosts;
}

/** Removes everything from the first `#` onwards (inline comments). */
function stripComment(line: string): string {
  const pos = line.indexOf('#');
  return pos === -1 ? line : line.slice(0, pos);
}

/** Splits `"Keyword Value"` or `"Keyword=Value"` into `["Keyword", "Value"]`. */
function splitKv(line: string): [string, string] | undefined {
  const idx = line.search(/[\s=]/);
  if (idx === -1) return undefined;
  const keyword = line.slice(0, idx).trim();
  const value = line.slice(idx + 1).replace(/^=+/, '').trim();
  if (keyword === '' || value === '') return undefined;
  return [keyword, value];
}

/** Expands a leading `~/` to the user's home directory. */
function expandTilde(s: string): string {
  if (s.startsWith('~/')) return join(homedir(), s.slice(2));
  if (s === '~') return homedir();
  return s;
}

/** Splits an `Include` value into its pathnames. Several pathnames may share one
 *  line, and a path containing spaces may be double-quoted. */
function splitIncludePatterns(value: string): string[] {
  const patterns: string[] = [];
  let current = '';
  let quoted = false;

  for (const c of value) {
    if (c === '"') {
      quoted = !quoted;
    } else if (/\s/.test(c) && !quoted) {
      if (current !== '') {
        patterns.push(current);
        current = '';
      }
    } else {
      current += c;
    }
  }
  if (current !== '') patterns.push(current);
  return patterns;
}

/**
 * Anchors an `Include` pattern: absolute and `~/` patterns stand alone, a
 * relative one resolves against `base` — never the process working directory.
 * `undefined` when the pattern is relative and there is no base to anchor it
 * to; dropping the include is the only honest option.
 */
function resolveInclude(pattern: string, base: string | undefined): string | undefined {
  const expanded = expandTilde(pattern);
  if (isAbsolute(expanded)) return expanded;
  if (base === undefined) return undefined;
  // The base is a real path, not a pattern: escape it so a home directory
  // containing `[` or `*` cannot swallow the include. Glob patterns are
  // forward-slash regardless of platform, so normalise before escaping —
  // otherwise a Windows backslash path separator collides with `\` as the
  // glob escape character.
  const normalizedBase = base.replace(/\\/g, '/');
  const escapedBase = globEscape(normalizedBase).replace(/\/+$/, '');
  return `${escapedBase}/${expanded}`;
}

/** Resolves an Include pattern to the files it matches, in a stable order.
 *  Full glob(7) syntax, as `ssh_config(5)` specifies. Directories are skipped. */
function expandIncludeGlob(pattern: string): string[] {
  try {
    const matches = globSync(pattern);
    return matches.filter((p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    }).sort();
  } catch {
    return [];
  }
}

/** Convenience: parse `~/.ssh/config` merged with its `Include`s, or `[]` if absent. */
export function loadUserSshConfig(): Host[] {
  const path = sshConfigPath();
  if (!existsSync(path)) return [];
  try {
    return loadFromFile(path);
  } catch {
    return [];
  }
}
