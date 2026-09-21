import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadSnippets, saveSnippets } from './snippets.js';
import type { Snippet } from '../automation/types.js';

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'omnyssh-snippets-'));
  path = join(dir, 'snippets.toml');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function snippet(overrides: Partial<Snippet> = {}): Snippet {
  return { id: 'a1', name: 'Build', kind: 'local', command: 'npm run build', timeoutSecs: 300, ...overrides };
}

describe('loadSnippets', () => {
  it('a missing file yields an empty list', async () => {
    expect(await loadSnippets(path)).toEqual([]);
  });

  it('an empty file yields an empty list', async () => {
    await writeFile(path, '', 'utf-8');
    expect(await loadSnippets(path)).toEqual([]);
  });

  it('rejects a non-array "snippets" key', async () => {
    await writeFile(path, 'snippets = "nope"\n', 'utf-8');
    await expect(loadSnippets(path)).rejects.toThrow(/must be an array/);
  });

  it('rejects an entry missing required fields', async () => {
    await writeFile(path, '[[snippets]]\nname = "no id"\n', 'utf-8');
    await expect(loadSnippets(path)).rejects.toThrow(/missing "id"/);
  });

  it('rejects an invalid kind', async () => {
    await writeFile(path, '[[snippets]]\nid = "a"\nname = "x"\nkind = "javascript"\ncommand = "x"\ntimeoutSecs = 1\n', 'utf-8');
    await expect(loadSnippets(path)).rejects.toThrow(/invalid kind/);
  });
});

describe('saveSnippets / loadSnippets round trip', () => {
  it('round-trips a local snippet', async () => {
    const original = [snippet()];
    await saveSnippets(original, path);
    expect(await loadSnippets(path)).toEqual(original);
  });

  it('round-trips a remote snippet (no host — that is an automation-level parameter now)', async () => {
    const original = [snippet({ id: 'a2', kind: 'remote', command: 'docker ps' })];
    await saveSnippets(original, path);
    expect(await loadSnippets(path)).toEqual(original);
  });

  it('round-trips multiple snippets, preserving order', async () => {
    const original = [snippet({ id: 'a1', name: 'First' }), snippet({ id: 'a2', name: 'Second' })];
    await saveSnippets(original, path);
    expect((await loadSnippets(path)).map((a) => a.name)).toEqual(['First', 'Second']);
  });
});
