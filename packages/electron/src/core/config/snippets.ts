import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parse, stringify } from 'smol-toml';

import { snippetsConfigPath } from './platform.js';
import type { Snippet, SnippetKind } from '../automation/types.js';

/** `snippets.toml` I/O — the reusable Snippet library (Automations live separately,
 *  in `automations.ts`/`automations.toml`). */

interface SnippetsFile {
  snippets: Snippet[];
}

function snippetFromToml(raw: Record<string, unknown>): Snippet {
  if (typeof raw.id !== 'string') throw new Error('snippet is missing "id"');
  if (typeof raw.name !== 'string') throw new Error(`snippet "${raw.id}" is missing "name"`);
  const kind: SnippetKind | undefined = raw.kind === 'local' ? 'local' : raw.kind === 'remote' ? 'remote' : undefined;
  if (kind === undefined) throw new Error(`snippet "${raw.name}" has an invalid kind`);
  if (typeof raw.command !== 'string') throw new Error(`snippet "${raw.name}" is missing "command"`);
  if (typeof raw.timeoutSecs !== 'number') throw new Error(`snippet "${raw.name}" is missing "timeoutSecs"`);
  return {
    id: raw.id,
    name: raw.name,
    kind,
    command: raw.command,
    timeoutSecs: raw.timeoutSecs
  };
}

function snippetToToml(snippet: Snippet): Record<string, unknown> {
  return {
    id: snippet.id,
    name: snippet.name,
    kind: snippet.kind,
    command: snippet.command,
    timeoutSecs: snippet.timeoutSecs
  };
}

function parseSnippetsFile(content: string): SnippetsFile {
  if (content.trim() === '') return { snippets: [] };
  const raw = parse(content) as { snippets?: unknown };
  if (raw.snippets === undefined) return { snippets: [] };
  if (!Array.isArray(raw.snippets)) throw new Error('snippets.toml: "snippets" must be an array');
  return { snippets: raw.snippets.map((a) => snippetFromToml(a as Record<string, unknown>)) };
}

/** Loads the Snippet library from `~/.config/omnyssh/snippets.toml` (or
 *  `overridePath`, for tests). Returns `[]` if the file does not exist yet. */
export async function loadSnippets(overridePath?: string): Promise<Snippet[]> {
  const path = overridePath ?? snippetsConfigPath();
  if (!existsSync(path)) return [];
  const content = await readFile(path, 'utf-8');
  return parseSnippetsFile(content).snippets;
}

/** Persists the Snippet library to `~/.config/omnyssh/snippets.toml` (or
 *  `overridePath`, for tests), atomically (tmp file + rename), `chmod 600` on
 *  non-Windows. */
export async function saveSnippets(snippets: Snippet[], overridePath?: string): Promise<void> {
  const path = overridePath ?? snippetsConfigPath();
  await mkdir(dirname(path), { recursive: true });

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
