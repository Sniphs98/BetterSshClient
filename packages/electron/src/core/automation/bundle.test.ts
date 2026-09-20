import { describe, expect, it } from 'vitest';
import {
  buildAutomationBundle,
  buildFlowBundle,
  mergeAutomationBundle,
  mergeFlowBundle,
  parseBundle,
  type AutomationBundle,
  type FlowBundle
} from './bundle.js';
import type { Automation, Flow, FlowNode } from './types.js';

function automation(partial: Partial<Automation> & Pick<Automation, 'id' | 'name'>): Automation {
  return { kind: 'local', command: 'echo hi', timeoutSecs: 30, ...partial };
}

function node(partial: Partial<FlowNode> & Pick<FlowNode, 'id' | 'automationId'>): FlowNode {
  return { label: partial.id, continueOnError: false, ...partial };
}

function flow(partial: Partial<Flow> & Pick<Flow, 'nodes'>): Flow {
  return { name: 'test-flow', params: [], edges: [], ...partial };
}

describe('buildAutomationBundle', () => {
  it('wraps the automation with a kind/version envelope', () => {
    const a = automation({ id: 'a1', name: 'Build' });
    expect(buildAutomationBundle(a)).toEqual({ kind: 'omnyssh-automation', version: 1, automation: a });
  });
});

describe('buildFlowBundle', () => {
  it('gathers only the automations the flow actually references, in node order, deduplicated', () => {
    const a1 = automation({ id: 'a1', name: 'Build' });
    const a2 = automation({ id: 'a2', name: 'Deploy' });
    const unused = automation({ id: 'a3', name: 'Unused' });
    const f = flow({ nodes: [node({ id: 'n1', automationId: 'a2' }), node({ id: 'n2', automationId: 'a1' }), node({ id: 'n3', automationId: 'a2' })] });
    const automationsById = new Map([
      ['a1', a1],
      ['a2', a2],
      ['a3', unused]
    ]);
    const bundle = buildFlowBundle(f, automationsById);
    expect(bundle.automations).toEqual([a2, a1]);
    expect(bundle.flow).toBe(f);
  });

  it('throws if a node references an automation that no longer exists', () => {
    const f = flow({ nodes: [node({ id: 'n1', automationId: 'missing' })] });
    expect(() => buildFlowBundle(f, new Map())).toThrow(/unknown automation/);
  });
});

describe('parseBundle', () => {
  it('round-trips a built automation bundle through JSON', () => {
    const a = automation({ id: 'a1', name: 'Build' });
    const bundle = buildAutomationBundle(a);
    expect(parseBundle(JSON.parse(JSON.stringify(bundle)))).toEqual(bundle);
  });

  it('round-trips a built flow bundle through JSON, including an optional param label/default and a node position', () => {
    const a = automation({ id: 'a1', name: 'Build' });
    const f = flow({
      name: 'release',
      params: [{ name: 'version', kind: 'text', label: 'Version', default: 'latest' }],
      nodes: [{ id: 'n1', automationId: 'a1', label: 'build', continueOnError: true, position: { x: 12, y: 34 } }],
      startLinks: ['n1']
    });
    const bundle = buildFlowBundle(f, new Map([['a1', a]]));
    expect(parseBundle(JSON.parse(JSON.stringify(bundle)))).toEqual(bundle);
  });

  it('rejects a file that is not an object', () => {
    expect(() => parseBundle('nope')).toThrow(/expected an object/);
    expect(() => parseBundle(null)).toThrow(/expected an object/);
  });

  it('rejects an unrecognized "kind"', () => {
    expect(() => parseBundle({ kind: 'something-else' })).toThrow(/not an OmnySSH/);
  });

  it('rejects an automation bundle missing a required field', () => {
    expect(() => parseBundle({ kind: 'omnyssh-automation', version: 1, automation: { id: 'a1', name: 'Build' } })).toThrow(
      /automation\.kind/
    );
  });

  it('rejects a flow bundle whose node is missing a required field', () => {
    const raw = {
      kind: 'omnyssh-flow',
      version: 1,
      flow: { name: 'f', params: [], edges: [], nodes: [{ id: 'n1', automationId: 'a1', label: 'x' }] },
      automations: []
    };
    expect(() => parseBundle(raw)).toThrow(/continueOnError/);
  });

  it('defaults a flow bundle missing startLinks to undefined, not an empty array', () => {
    const raw = {
      kind: 'omnyssh-flow',
      version: 1,
      flow: { name: 'f', params: [], edges: [], nodes: [] },
      automations: []
    };
    expect((parseBundle(raw) as FlowBundle).flow.startLinks).toBeUndefined();
  });
});

describe('mergeAutomationBundle', () => {
  it('appends the automation under a freshly minted id, leaving its name untouched', () => {
    const bundle: AutomationBundle = buildAutomationBundle(automation({ id: 'exported-id', name: 'Build' }));
    const existing = [automation({ id: 'local-id', name: 'Something else' })];
    const { automations, result } = mergeAutomationBundle(bundle, existing);
    expect(automations).toHaveLength(2);
    const imported = automations[1];
    expect(imported.id).not.toBe('exported-id');
    expect(imported.name).toBe('Build');
    expect(result).toEqual({ kind: 'automation', name: 'Build' });
  });

  it('never collides with an existing automation even if the exported id happens to match one locally', () => {
    const existing = [automation({ id: 'shared-id', name: 'Local one' })];
    const bundle = buildAutomationBundle(automation({ id: 'shared-id', name: 'Imported one' }));
    const { automations } = mergeAutomationBundle(bundle, existing);
    expect(automations).toHaveLength(2);
    expect(automations[0].id).not.toBe(automations[1].id);
  });
});

describe('mergeFlowBundle', () => {
  it('mints fresh ids for bundled automations and remaps the flow nodes to them', () => {
    const a = automation({ id: 'exported-a1', name: 'Build' });
    const f = flow({ name: 'release', nodes: [node({ id: 'n1', automationId: 'exported-a1' })] });
    const bundle: FlowBundle = { kind: 'omnyssh-flow', version: 1, flow: f, automations: [a] };

    const { automations, flows, result } = mergeFlowBundle(bundle, [], []);
    expect(automations).toHaveLength(1);
    expect(automations[0].id).not.toBe('exported-a1');
    expect(flows).toHaveLength(1);
    expect(flows[0].nodes[0].automationId).toBe(automations[0].id);
    expect(result).toEqual({ kind: 'flow', name: 'release' });
  });

  it('renames the flow on a name collision instead of overwriting the existing one', () => {
    const a = automation({ id: 'a1', name: 'Build' });
    const f = flow({ name: 'release', nodes: [node({ id: 'n1', automationId: 'a1' })] });
    const bundle: FlowBundle = { kind: 'omnyssh-flow', version: 1, flow: f, automations: [a] };
    const existingFlow = flow({ name: 'release', nodes: [] });

    const { flows, result } = mergeFlowBundle(bundle, [], [existingFlow]);
    expect(flows).toHaveLength(2);
    expect(flows[0]).toBe(existingFlow);
    expect(flows[1].name).toBe('release (2)');
    expect(result).toEqual({ kind: 'flow', name: 'release (2)' });
  });

  it('keeps counting past an existing "(2)" to find a free name', () => {
    const a = automation({ id: 'a1', name: 'Build' });
    const f = flow({ name: 'release', nodes: [] });
    const bundle: FlowBundle = { kind: 'omnyssh-flow', version: 1, flow: f, automations: [a] };
    const existing = [flow({ name: 'release', nodes: [] }), flow({ name: 'release (2)', nodes: [] })];

    const { result } = mergeFlowBundle(bundle, [], existing);
    expect(result.name).toBe('release (3)');
  });
});
