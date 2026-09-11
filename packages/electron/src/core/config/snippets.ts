import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile, chmod } from 'node:fs/promises';
import { parse, stringify } from 'smol-toml';

import { appConfigDir, snippetsConfigPath } from './platform.js';

/** `snippets.toml` I/O. Ported from crates/omnyssh-core/src/config/snippets.rs. */

export type SnippetScope = 'global' | 'host';

export interface Snippet {
  name: string;
  command: string;
  scope: SnippetScope;
  /** Required when `scope === 'host'`. */
  host?: string;
  tags?: string[];
  /** Named placeholder parameters, e.g. `["service_name"]`. */
  params?: string[];
}

interface SnippetsFile {
  snippets: Snippet[];
}

function snippetFromToml(raw: Record<string, unknown>): Snippet {
  if (typeof raw.name !== 'string') throw new Error('snippet is missing "name"');
  if (typeof raw.command !== 'string') throw new Error('snippet is missing "command"');
  const scope = raw.scope === 'host' ? 'host' : raw.scope === 'global' ? 'global' : undefined;
  if (scope === undefined) throw new Error(`snippet "${raw.name}" has an invalid scope`);
  return {
    name: raw.name,
    command: raw.command,
    scope,
    host: typeof raw.host === 'string' ? raw.host : undefined,
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === 'string') : undefined,
    params: Array.isArray(raw.params) ? raw.params.filter((t): t is string => typeof t === 'string') : undefined
  };
}

function snippetToToml(snippet: Snippet): Record<string, unknown> {
  const out: Record<string, unknown> = { name: snippet.name, command: snippet.command, scope: snippet.scope };
  if (snippet.host !== undefined) out.host = snippet.host;
  if (snippet.tags !== undefined) out.tags = snippet.tags;
  if (snippet.params !== undefined) out.params = snippet.params;
  return out;
}

function parseSnippetsFile(content: string): SnippetsFile {
  if (content.trim() === '') return { snippets: [] };
  const raw = parse(content) as { snippets?: unknown };
  if (raw.snippets === undefined) return { snippets: [] };
  if (!Array.isArray(raw.snippets)) throw new Error('snippets.toml: "snippets" must be an array');
  return { snippets: raw.snippets.map((s) => snippetFromToml(s as Record<string, unknown>)) };
}

/** Loads snippets from `~/.config/omnyssh/snippets.toml`. Returns `[]` if the
 *  file does not exist yet. */
export async function loadSnippets(): Promise<Snippet[]> {
  const path = snippetsConfigPath();
  if (!existsSync(path)) return [];
  const content = await readFile(path, 'utf-8');
  return parseSnippetsFile(content).snippets;
}

/** Persists snippets to `~/.config/omnyssh/snippets.toml`, atomically. */
export async function saveSnippets(snippets: Snippet[]): Promise<void> {
  const dir = appConfigDir();
  await mkdir(dir, { recursive: true });
  const path = snippetsConfigPath();

  const content = stringify({ snippets: snippets.map(snippetToToml) });

  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, content, 'utf-8');
  try {
    await rename(tmpPath, path);
  } catch (err) {
    await rm(tmpPath, { force: true });
    throw err;
  }
  if (process.platform !== 'win32') {
    await chmod(path, 0o600).catch(() => {});
  }
}
