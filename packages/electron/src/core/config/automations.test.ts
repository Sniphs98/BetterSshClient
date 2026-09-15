import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadAutomations, saveAutomations } from './automations.js';
import type { Automation } from '../automation/types.js';

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'omnyssh-automations-'));
  path = join(dir, 'automations.toml');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function automation(overrides: Partial<Automation> = {}): Automation {
  return { id: 'a1', name: 'Build', kind: 'local', command: 'npm run build', timeoutSecs: 300, ...overrides };
}

describe('loadAutomations', () => {
  it('a missing file yields an empty list', async () => {
    expect(await loadAutomations(path)).toEqual([]);
  });

  it('an empty file yields an empty list', async () => {
    await writeFile(path, '', 'utf-8');
    expect(await loadAutomations(path)).toEqual([]);
  });

  it('rejects a non-array "automations" key', async () => {
    await writeFile(path, 'automations = "nope"\n', 'utf-8');
    await expect(loadAutomations(path)).rejects.toThrow(/must be an array/);
  });

  it('rejects an entry missing required fields', async () => {
    await writeFile(path, '[[automations]]\nname = "no id"\n', 'utf-8');
    await expect(loadAutomations(path)).rejects.toThrow(/missing "id"/);
  });

  it('rejects an invalid kind', async () => {
    await writeFile(path, '[[automations]]\nid = "a"\nname = "x"\nkind = "javascript"\ncommand = "x"\ntimeoutSecs = 1\n', 'utf-8');
    await expect(loadAutomations(path)).rejects.toThrow(/invalid kind/);
  });
});

describe('saveAutomations / loadAutomations round trip', () => {
  it('round-trips a local automation', async () => {
    const original = [automation()];
    await saveAutomations(original, path);
    expect(await loadAutomations(path)).toEqual(original);
  });

  it('round-trips a remote automation (no host — that is a flow-level parameter now)', async () => {
    const original = [automation({ id: 'a2', kind: 'remote', command: 'docker ps' })];
    await saveAutomations(original, path);
    expect(await loadAutomations(path)).toEqual(original);
  });

  it('round-trips multiple automations, preserving order', async () => {
    const original = [automation({ id: 'a1', name: 'First' }), automation({ id: 'a2', name: 'Second' })];
    await saveAutomations(original, path);
    expect((await loadAutomations(path)).map((a) => a.name)).toEqual(['First', 'Second']);
  });
});
