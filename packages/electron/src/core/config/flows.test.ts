import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
    params: [],
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

  it('a flow with no params/nodes/edges tables defaults all to empty arrays', async () => {
    await writeFile(path, '[[flows]]\nname = "empty"\n', 'utf-8');
    expect(await loadFlows(path)).toEqual([{ name: 'empty', params: [], nodes: [], edges: [] }]);
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

  it('round-trips parameters, including a text default and an unset label', async () => {
    const original = [
      flow({
        params: [
          { name: 'host', kind: 'host' },
          { name: 'version', kind: 'text', label: 'Version to deploy', default: 'latest' }
        ]
      })
    ];
    await saveFlows(original, path);
    expect(await loadFlows(path)).toEqual(original);
  });

  it('round-trips startLinks — the Start node\'s decorative canvas connections', async () => {
    const original = [flow({ startLinks: ['n1', 'n2'] })];
    await saveFlows(original, path);
    expect(await loadFlows(path)).toEqual(original);
  });

  it('omits startLinks entirely from the saved file when empty, rather than writing `startLinks = []`', async () => {
    const original = [flow({ startLinks: [] })];
    await saveFlows(original, path);
    const raw = await readFile(path, 'utf-8');
    expect(raw).not.toContain('startLinks');
    expect((await loadFlows(path))[0].startLinks).toBeUndefined();
  });
});
