import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  return {
    name: 'deploy',
    params: [],
    nodes: [
      { id: 'n1', snippetId: 'a1', label: 'build', continueOnError: false },
      { id: 'n2', snippetId: 'a2', label: 'deploy', continueOnError: true }
    ],
    edges: [{ from: 'n1', to: 'n2' }],
    ...overrides
  };
}

describe('loadAutomations', () => {
  it('a missing file yields an empty list', async () => {
    expect(await loadAutomations(path)).toEqual([]);
  });

  it('an empty file yields an empty list', async () => {
    await writeFile(path, '', 'utf-8');
    expect(await loadAutomations(path)).toEqual([]);
  });

  it('an automation with no params/nodes/edges tables defaults all to empty arrays', async () => {
    await writeFile(path, '[[automations]]\nname = "empty"\n', 'utf-8');
    expect(await loadAutomations(path)).toEqual([{ name: 'empty', params: [], nodes: [], edges: [] }]);
  });

  it('rejects a node missing required fields', async () => {
    await writeFile(path, '[[automations]]\nname = "f"\n[[automations.nodes]]\nid = "n1"\n', 'utf-8');
    await expect(loadAutomations(path)).rejects.toThrow(/missing "snippetId"/);
  });
});

describe('saveAutomations / loadAutomations round trip', () => {
  it('round-trips nodes and edges', async () => {
    const original = [automation()];
    await saveAutomations(original, path);
    expect(await loadAutomations(path)).toEqual(original);
  });

  it('round-trips a node position', async () => {
    const original = [automation({ nodes: [{ id: 'n1', snippetId: 'a1', label: 'build', continueOnError: false, position: { x: 12, y: 34 } }] })];
    await saveAutomations(original, path);
    expect(await loadAutomations(path)).toEqual(original);
  });

  it('round-trips multiple automations', async () => {
    const original = [automation({ name: 'one' }), automation({ name: 'two', nodes: [], edges: [] })];
    await saveAutomations(original, path);
    expect((await loadAutomations(path)).map((f) => f.name)).toEqual(['one', 'two']);
  });

  it('round-trips parameters, including a text default and an unset label', async () => {
    const original = [
      automation({
        params: [
          { name: 'host', kind: 'host' },
          { name: 'version', kind: 'text', label: 'Version to deploy', default: 'latest' }
        ]
      })
    ];
    await saveAutomations(original, path);
    expect(await loadAutomations(path)).toEqual(original);
  });

  it('round-trips startLinks — the Start node\'s decorative canvas connections', async () => {
    const original = [automation({ startLinks: ['n1', 'n2'] })];
    await saveAutomations(original, path);
    expect(await loadAutomations(path)).toEqual(original);
  });

  it('omits startLinks entirely from the saved file when empty, rather than writing `startLinks = []`', async () => {
    const original = [automation({ startLinks: [] })];
    await saveAutomations(original, path);
    const raw = await readFile(path, 'utf-8');
    expect(raw).not.toContain('startLinks');
    expect((await loadAutomations(path))[0].startLinks).toBeUndefined();
  });
});
