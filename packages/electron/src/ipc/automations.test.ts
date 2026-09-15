import { describe, expect, it } from 'vitest';
import { removeAutomation, removeFlow, upsertAutomation, upsertFlow } from './automations.js';
import type { Automation, Flow } from '../core/automation/types.js';

function automation(overrides: Partial<Automation> = {}): Automation {
  return { id: 'a1', name: 'Build', kind: 'local', command: 'npm run build', timeoutSecs: 300, ...overrides };
}

function flow(overrides: Partial<Flow> = {}): Flow {
  return { name: 'deploy', params: [], nodes: [], edges: [], ...overrides };
}

describe('upsertAutomation', () => {
  it('appends a new automation', () => {
    const automations: Automation[] = [];
    upsertAutomation(automations, automation());
    expect(automations).toHaveLength(1);
  });

  it('replaces an existing automation by id, not name', () => {
    const automations = [automation({ id: 'a1', name: 'Old name' })];
    upsertAutomation(automations, automation({ id: 'a1', name: 'New name' }));
    expect(automations).toHaveLength(1);
    expect(automations[0].name).toBe('New name');
  });

  it('a different id with the same name is a separate entry', () => {
    const automations = [automation({ id: 'a1' })];
    upsertAutomation(automations, automation({ id: 'a2' }));
    expect(automations).toHaveLength(2);
  });
});

describe('removeAutomation', () => {
  it('removes an unreferenced automation', () => {
    const automations = [automation({ id: 'a1' })];
    removeAutomation(automations, [], 'a1');
    expect(automations).toHaveLength(0);
  });

  it('a missing id is a no-op, not an error', () => {
    const automations = [automation({ id: 'a1' })];
    removeAutomation(automations, [], 'ghost');
    expect(automations).toHaveLength(1);
  });

  it('throws, naming the flow, when a flow still references it', () => {
    const automations = [automation({ id: 'a1' })];
    const flows = [flow({ name: 'deploy', nodes: [{ id: 'n1', automationId: 'a1', label: 'build', continueOnError: false }] })];
    expect(() => removeAutomation(automations, flows, 'a1')).toThrow(/'deploy'/);
    expect(automations).toHaveLength(1); // untouched
  });

  it('names every referencing flow when more than one uses it', () => {
    const automations = [automation({ id: 'a1' })];
    const flows = [
      flow({ name: 'one', nodes: [{ id: 'n1', automationId: 'a1', label: 'x', continueOnError: false }] }),
      flow({ name: 'two', nodes: [{ id: 'n1', automationId: 'a1', label: 'x', continueOnError: false }] })
    ];
    expect(() => removeAutomation(automations, flows, 'a1')).toThrow(/'one'.*'two'/);
  });
});

describe('upsertFlow', () => {
  it('appends a new flow', () => {
    const flows: Flow[] = [];
    upsertFlow(flows, flow());
    expect(flows).toHaveLength(1);
  });

  it('replaces an existing flow by name', () => {
    const flows = [flow({ name: 'deploy', edges: [] })];
    upsertFlow(flows, flow({ name: 'deploy', edges: [{ from: 'a', to: 'b' }] }));
    expect(flows).toHaveLength(1);
    expect(flows[0].edges).toHaveLength(1);
  });
});

describe('removeFlow', () => {
  it('removes a flow by name', () => {
    const flows = [flow({ name: 'deploy' })];
    removeFlow(flows, 'deploy');
    expect(flows).toHaveLength(0);
  });

  it('a missing name is a no-op', () => {
    const flows = [flow({ name: 'deploy' })];
    removeFlow(flows, 'ghost');
    expect(flows).toHaveLength(1);
  });
});
