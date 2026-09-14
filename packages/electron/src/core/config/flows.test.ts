import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadFlows, saveFlows } from './flows.js';
import type { Flow } from '../automation/types.js';

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'omnyssh-flows-'));
  path = join(dir, 'flows.toml');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function flow(overrides: Partial<Flow> = {}): Flow {
  return {
    name: 'deploy',
    nodes: [
      { id: 'n1', automationId: 'a1', label: 'build', continueOnError: false },
      { id: 'n2', automationId: 'a2', label: 'deploy', continueOnError: true }
    ],
    edges: [{ from: 'n1', to: 'n2' }],
    ...overrides
  };
}

describe('loadFlows', () => {
  it('a missing file yields an empty list', async () => {
    expect(await loadFlows(path)).toEqual([]);
  });

  it('an empty file yields an empty list', async () => {
    await writeFile(path, '', 'utf-8');
    expect(await loadFlows(path)).toEqual([]);
  });

  it('a flow with no nodes/edges tables defaults both to empty arrays', async () => {
    await writeFile(path, '[[flows]]\nname = "empty"\n', 'utf-8');
    expect(await loadFlows(path)).toEqual([{ name: 'empty', nodes: [], edges: [] }]);
  });

  it('rejects a node missing required fields', async () => {
    await writeFile(path, '[[flows]]\nname = "f"\n[[flows.nodes]]\nid = "n1"\n', 'utf-8');
    await expect(loadFlows(path)).rejects.toThrow(/missing "automationId"/);
  });
});

describe('saveFlows / loadFlows round trip', () => {
  it('round-trips nodes and edges', async () => {
    const original = [flow()];
    await saveFlows(original, path);
    expect(await loadFlows(path)).toEqual(original);
  });

  it('round-trips a node position', async () => {
    const original = [flow({ nodes: [{ id: 'n1', automationId: 'a1', label: 'build', continueOnError: false, position: { x: 12, y: 34 } }] })];
    await saveFlows(original, path);
    expect(await loadFlows(path)).toEqual(original);
  });

  it('round-trips multiple flows', async () => {
    const original = [flow({ name: 'one' }), flow({ name: 'two', nodes: [], edges: [] })];
    await saveFlows(original, path);
    expect((await loadFlows(path)).map((f) => f.name)).toEqual(['one', 'two']);
  });
});
