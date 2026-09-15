import { describe, expect, it } from 'vitest';
import {
  AutomationCycleError,
  missingParamValues,
  runFlow,
  substituteTemplate,
  topoOrder,
  validateFlow,
  type RunFlowDeps
} from './engine.js';
import type { Automation, Flow, FlowNode, FlowParam, NodeResult } from './types.js';

function automation(partial: Partial<Automation> & Pick<Automation, 'id' | 'name'>): Automation {
  return { kind: 'local', command: 'echo hi', timeoutSecs: 30, ...partial };
}

function node(partial: Partial<FlowNode> & Pick<FlowNode, 'id' | 'automationId'>): FlowNode {
  return { label: partial.id, continueOnError: false, ...partial };
}

function flow(nodes: FlowNode[], edges: Array<[string, string]> = [], params: FlowParam[] = []): Flow {
  return { name: 'test-flow', params, nodes, edges: edges.map(([from, to]) => ({ from, to })) };
}

const hostParam: FlowParam[] = [{ name: 'host', kind: 'host' }];

describe('topoOrder', () => {
  it('orders a linear chain', () => {
    const f = flow([node({ id: 'a', automationId: 'x' }), node({ id: 'b', automationId: 'x' }), node({ id: 'c', automationId: 'x' })], [
      ['a', 'b'],
      ['b', 'c']
    ]);
    expect(topoOrder(f)).toEqual(['a', 'b', 'c']);
  });

  it('orders a diamond with both middle nodes before the join', () => {
    const f = flow(
      [node({ id: 'a', automationId: 'x' }), node({ id: 'b', automationId: 'x' }), node({ id: 'c', automationId: 'x' }), node({ id: 'd', automationId: 'x' })],
      [
        ['a', 'b'],
        ['a', 'c'],
        ['b', 'd'],
        ['c', 'd']
      ]
    );
    const order = topoOrder(f);
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('c'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('d'));
    expect(order.indexOf('c')).toBeLessThan(order.indexOf('d'));
  });

  it('handles disconnected components', () => {
    const f = flow([node({ id: 'a', automationId: 'x' }), node({ id: 'b', automationId: 'x' })], []);
    expect(topoOrder(f)).toEqual(['a', 'b']);
  });

  it('throws AutomationCycleError naming a node in the cycle', () => {
    const f = flow([node({ id: 'a', automationId: 'x' }), node({ id: 'b', automationId: 'x' })], [
      ['a', 'b'],
      ['b', 'a']
    ]);
    expect(() => topoOrder(f)).toThrow(AutomationCycleError);
    expect(() => topoOrder(f)).toThrow(/cycle/);
  });

  it('ignores a dangling edge rather than crashing', () => {
    const f = flow([node({ id: 'a', automationId: 'x' })], [['a', 'ghost']]);
    expect(topoOrder(f)).toEqual(['a']);
  });
});

describe('validateFlow', () => {
  const automationsById = new Map<string, Automation>([
    ['local-x', automation({ id: 'local-x', name: 'Local X', kind: 'local' })],
    ['remote-y', automation({ id: 'remote-y', name: 'Remote Y', kind: 'remote' })]
  ]);

  it('is empty for a valid flow', () => {
    const f = flow([node({ id: 'a', automationId: 'local-x' })]);
    expect(validateFlow(f, automationsById)).toEqual([]);
  });

  it('is empty for a valid flow with a remote node and a host parameter', () => {
    const f = flow([node({ id: 'a', automationId: 'remote-y' })], [], hostParam);
    expect(validateFlow(f, automationsById)).toEqual([]);
  });

  it('flags an unknown automationId', () => {
    const f = flow([node({ id: 'a', automationId: 'does-not-exist' })]);
    expect(validateFlow(f, automationsById)[0]).toMatch(/unknown automation/);
  });

  it('flags a remote node when the flow has no host parameter', () => {
    const f = flow([node({ id: 'a', automationId: 'remote-y' })]);
    expect(validateFlow(f, automationsById).some((p) => p.includes('no host parameter'))).toBe(true);
  });

  it('flags more than one host parameter', () => {
    const f = flow(
      [node({ id: 'a', automationId: 'local-x' })],
      [],
      [
        { name: 'host', kind: 'host' },
        { name: 'other-host', kind: 'host' }
      ]
    );
    expect(validateFlow(f, automationsById).some((p) => p.includes('at most one host parameter'))).toBe(true);
  });

  it('flags a parameter name declared more than once', () => {
    const f = flow(
      [node({ id: 'a', automationId: 'local-x' })],
      [],
      [
        { name: 'dup', kind: 'text' },
        { name: 'dup', kind: 'text' }
      ]
    );
    expect(validateFlow(f, automationsById).some((p) => p.includes('more than once'))).toBe(true);
  });

  it('flags a command referencing an unknown parameter', () => {
    const referencing = automation({ id: 'ref', name: 'Ref', kind: 'local', command: '{{params.ghost}}' });
    const byId = new Map(automationsById).set('ref', referencing);
    const f = flow([node({ id: 'a', automationId: 'ref' })]);
    expect(validateFlow(f, byId).some((p) => p.includes('unknown parameter'))).toBe(true);
  });

  it('accepts a command referencing a declared parameter, from any node (params are flow-wide)', () => {
    const referencing = automation({ id: 'ref', name: 'Ref', kind: 'local', command: 'echo {{params.version}}' });
    const byId = new Map(automationsById).set('ref', referencing);
    const f = flow([node({ id: 'a', automationId: 'local-x' }), node({ id: 'b', automationId: 'ref' })], [], [{ name: 'version', kind: 'text' }]);
    expect(validateFlow(f, byId)).toEqual([]);
  });

  it('flags duplicate labels', () => {
    const f = flow([node({ id: 'a', automationId: 'local-x', label: 'same' }), node({ id: 'b', automationId: 'local-x', label: 'same' })]);
    expect(validateFlow(f, automationsById).some((p) => p.includes('more than one node'))).toBe(true);
  });

  it('flags a template reference to a label that is not a direct predecessor', () => {
    const referencing = automation({ id: 'ref', name: 'Ref', kind: 'local', command: '{{nodes.a.output}}' });
    const byId = new Map(automationsById).set('ref', referencing);
    // b references "a"'s output but there is no edge a -> b.
    const f = flow([node({ id: 'a', automationId: 'local-x' }), node({ id: 'b', automationId: 'ref' })]);
    expect(validateFlow(f, byId).some((p) => p.includes('not a direct dependency'))).toBe(true);
  });

  it('accepts a template reference to a direct predecessor', () => {
    const referencing = automation({ id: 'ref', name: 'Ref', kind: 'local', command: '{{nodes.a.output}}' });
    const byId = new Map(automationsById).set('ref', referencing);
    const f = flow([node({ id: 'a', automationId: 'local-x' }), node({ id: 'b', automationId: 'ref' })], [['a', 'b']]);
    expect(validateFlow(f, byId)).toEqual([]);
  });

  it('flags a template reference to an unknown label', () => {
    const referencing = automation({ id: 'ref', name: 'Ref', kind: 'local', command: '{{nodes.ghost.output}}' });
    const byId = new Map(automationsById).set('ref', referencing);
    const f = flow([node({ id: 'a', automationId: 'ref' })]);
    expect(validateFlow(f, byId).some((p) => p.includes('unknown label'))).toBe(true);
  });

  it('surfaces a cycle as a problem too', () => {
    const f = flow([node({ id: 'a', automationId: 'local-x' }), node({ id: 'b', automationId: 'local-x' })], [
      ['a', 'b'],
      ['b', 'a']
    ]);
    expect(validateFlow(f, automationsById).some((p) => p.includes('cycle'))).toBe(true);
  });
});

describe('substituteTemplate', () => {
  function result(label: string, output: string): NodeResult {
    return { nodeId: label, label, status: 'success', output, durationMs: 1 };
  }

  it('replaces a single reference', () => {
    const predecessors = new Map([['a', result('a', 'hello')]]);
    expect(substituteTemplate('echo {{nodes.a.output}}', predecessors)).toBe('echo hello');
  });

  it('replaces multiple references', () => {
    const predecessors = new Map([
      ['a', result('a', '1')],
      ['b', result('b', '2')]
    ]);
    expect(substituteTemplate('{{nodes.a.output}}-{{nodes.b.output}}', predecessors)).toBe('1-2');
  });

  it('throws when a referenced label has no result', () => {
    expect(() => substituteTemplate('{{nodes.missing.output}}', new Map())).toThrow(/missing/);
  });

  it('is a no-op when there is nothing to substitute', () => {
    expect(substituteTemplate('echo plain', new Map())).toBe('echo plain');
  });

  it('replaces a parameter reference', () => {
    expect(substituteTemplate('deploy to {{params.host}}', new Map(), { host: 'web-1' })).toBe('deploy to web-1');
  });

  it('replaces both a node reference and a parameter reference in the same command', () => {
    const predecessors = new Map([['build', result('build', 'v1.2.3')]]);
    expect(substituteTemplate('deploy {{nodes.build.output}} to {{params.host}}', predecessors, { host: 'web-1' })).toBe(
      'deploy v1.2.3 to web-1'
    );
  });

  it('throws when a referenced parameter has no value', () => {
    expect(() => substituteTemplate('{{params.missing}}', new Map(), {})).toThrow(/missing/);
  });
});

describe('missingParamValues', () => {
  function flowWithParams(params: FlowParam[]): Flow {
    return { name: 'f', params, nodes: [], edges: [] };
  }

  it('is empty when every declared parameter has a non-blank value', () => {
    const f = flowWithParams([
      { name: 'host', kind: 'host' },
      { name: 'version', kind: 'text' }
    ]);
    expect(missingParamValues(f, { host: 'web-1', version: '1.0' })).toEqual([]);
  });

  it('flags a missing value, naming its label when set', () => {
    const f = flowWithParams([{ name: 'host', kind: 'host', label: 'Target host' }]);
    expect(missingParamValues(f, {})).toEqual(['Target host']);
  });

  it('flags a blank (whitespace-only) value the same as a missing one', () => {
    const f = flowWithParams([{ name: 'version', kind: 'text' }]);
    expect(missingParamValues(f, { version: '   ' })).toEqual(['version']);
  });
});

describe('runFlow', () => {
  function deps(overrides: Partial<RunFlowDeps> = {}): RunFlowDeps {
    return {
      runLocal: async (command) => ({ output: `ran: ${command}`, ok: true }),
      connectHost: async () => ({ runShell: async () => ({ output: '', ok: true }), disconnect: () => {} }),
      ...overrides
    };
  }

  it('runs nodes in topo order and reports success', async () => {
    const a = automation({ id: 'a', name: 'A' });
    const f = flow([node({ id: 'n1', automationId: 'a', label: 'first' }), node({ id: 'n2', automationId: 'a', label: 'second' })], [
      ['n1', 'n2']
    ]);
    const started: string[] = [];
    const results = await runFlow(f, new Map([['a', a]]), {}, deps(), (e) => {
      if (e.kind === 'nodeStarted') started.push(e.label);
    });
    expect(started).toEqual(['first', 'second']);
    expect(results.map((r) => r.status)).toEqual(['success', 'success']);
  });

  it('skips a dependent when its predecessor fails without continueOnError', async () => {
    const failing = automation({ id: 'fail', name: 'Fail' });
    const dependent = automation({ id: 'dep', name: 'Dep' });
    const f = flow(
      [node({ id: 'n1', automationId: 'fail', label: 'a', continueOnError: false }), node({ id: 'n2', automationId: 'dep', label: 'b' })],
      [['n1', 'n2']]
    );
    const results = await runFlow(
      f,
      new Map([
        ['fail', failing],
        ['dep', dependent]
      ]),
      {},
      deps({ runLocal: async () => ({ output: '', ok: false, error: 'boom' }) })
    );
    expect(results.map((r) => r.status)).toEqual(['failed', 'skipped']);
  });

  it('lets a dependent run when the failing predecessor has continueOnError: true', async () => {
    const failing = automation({ id: 'fail', name: 'Fail' });
    const dependent = automation({ id: 'dep', name: 'Dep' });
    const f = flow(
      [node({ id: 'n1', automationId: 'fail', label: 'a', continueOnError: true }), node({ id: 'n2', automationId: 'dep', label: 'b' })],
      [['n1', 'n2']]
    );
    let runLocalCalls = 0;
    const results = await runFlow(
      f,
      new Map([
        ['fail', failing],
        ['dep', dependent]
      ]),
      {},
      deps({
        runLocal: async () => {
          runLocalCalls += 1;
          return { output: '', ok: false, error: 'boom' };
        }
      })
    );
    // n1 fails (continueOnError true), n2 must still be attempted rather than skipped —
    // 'skipped' would mean runLocal was never called for it.
    expect(results[0].status).toBe('failed');
    expect(results[1].status).toBe('failed'); // it ran (and also failed, since runLocal always fails here)
    expect(runLocalCalls).toBe(2);
  });

  it('cascades a skip two levels deep', async () => {
    const a = automation({ id: 'a', name: 'A' });
    const f = flow(
      [
        node({ id: 'n1', automationId: 'a', label: 'x', continueOnError: false }),
        node({ id: 'n2', automationId: 'a', label: 'y', continueOnError: false }),
        node({ id: 'n3', automationId: 'a', label: 'z' })
      ],
      [
        ['n1', 'n2'],
        ['n2', 'n3']
      ]
    );
    const results = await runFlow(f, new Map([['a', a]]), {}, deps({ runLocal: async () => ({ output: '', ok: false, error: 'boom' }) }));
    expect(results.map((r) => r.status)).toEqual(['failed', 'skipped', 'skipped']);
  });

  it('a diamond: one failed non-continuable parent still skips the child (AND semantics)', async () => {
    const a = automation({ id: 'a', name: 'A' });
    const f = flow(
      [
        node({ id: 'n1', automationId: 'a', label: 'a' }),
        node({ id: 'n2', automationId: 'a', label: 'b', continueOnError: false }),
        node({ id: 'n3', automationId: 'a', label: 'c', continueOnError: false }),
        node({ id: 'n4', automationId: 'a', label: 'd' })
      ],
      [
        ['n1', 'n2'],
        ['n1', 'n3'],
        ['n2', 'n4'],
        ['n3', 'n4']
      ]
    );
    let calls = 0;
    const results = await runFlow(
      f,
      new Map([['a', a]]),
      {},
      deps({
        runLocal: async () => {
          calls += 1;
          // n2 (2nd call) fails; n1 and n3 succeed.
          return calls === 2 ? { output: '', ok: false, error: 'boom' } : { output: 'ok', ok: true };
        }
      })
    );
    const byLabel = new Map(results.map((r) => [r.label, r]));
    expect(byLabel.get('b')?.status).toBe('failed');
    expect(byLabel.get('c')?.status).toBe('success');
    expect(byLabel.get('d')?.status).toBe('skipped');
  });

  it('substitutes a predecessor output into a remote node command', async () => {
    const local = automation({ id: 'local', name: 'Local', command: 'echo build-123' });
    const remote = automation({ id: 'remote', name: 'Remote', kind: 'remote', command: 'deploy {{nodes.build.output}}' });
    const f = flow(
      [node({ id: 'n1', automationId: 'local', label: 'build' }), node({ id: 'n2', automationId: 'remote', label: 'deploy' })],
      [['n1', 'n2']],
      hostParam
    );
    const seenCommands: string[] = [];
    const results = await runFlow(
      f,
      new Map([
        ['local', local],
        ['remote', remote]
      ]),
      { host: 'web-1' },
      deps({
        runLocal: async () => ({ output: 'build-123', ok: true }),
        connectHost: async () => ({
          runShell: async (cmd) => {
            seenCommands.push(cmd);
            return { output: 'deployed', ok: true };
          },
          disconnect: () => {}
        })
      })
    );
    expect(seenCommands).toEqual(['deploy build-123']);
    expect(results.every((r) => r.status === 'success')).toBe(true);
  });

  it('substitutes a text parameter into a remote node command alongside the resolved host', async () => {
    const remote = automation({ id: 'remote', name: 'Remote', kind: 'remote', command: 'deploy --version {{params.version}}' });
    const f = flow([node({ id: 'n1', automationId: 'remote', label: 'a' })], [], [...hostParam, { name: 'version', kind: 'text' }]);
    const seenCommands: string[] = [];
    const seenHosts: string[] = [];
    await runFlow(
      f,
      new Map([['remote', remote]]),
      { host: 'web-1', version: '2.0.0' },
      deps({
        connectHost: async (hostName) => {
          seenHosts.push(hostName);
          return {
            runShell: async (cmd) => {
              seenCommands.push(cmd);
              return { output: '', ok: true };
            },
            disconnect: () => {}
          };
        }
      })
    );
    expect(seenHosts).toEqual(['web-1']);
    expect(seenCommands).toEqual(['deploy --version 2.0.0']);
  });

  it('reuses one connection per host across multiple nodes targeting it', async () => {
    const remote = automation({ id: 'remote', name: 'Remote', kind: 'remote' });
    const f = flow(
      [node({ id: 'n1', automationId: 'remote', label: 'a' }), node({ id: 'n2', automationId: 'remote', label: 'b' })],
      [],
      hostParam
    );
    let connectCount = 0;
    let disconnectCount = 0;
    await runFlow(
      f,
      new Map([['remote', remote]]),
      { host: 'web-1' },
      deps({
        connectHost: async () => {
          connectCount += 1;
          return { runShell: async () => ({ output: '', ok: true }), disconnect: () => (disconnectCount += 1) };
        }
      })
    );
    expect(connectCount).toBe(1);
    expect(disconnectCount).toBe(1);
  });

  it('disconnects opened connections even if a later node throws unexpectedly', async () => {
    const remote = automation({ id: 'remote', name: 'Remote', kind: 'remote' });
    const local = automation({ id: 'local', name: 'Local' });
    const f = flow(
      [node({ id: 'n1', automationId: 'remote', label: 'a' }), node({ id: 'n2', automationId: 'local', label: 'b' })],
      [],
      hostParam
    );
    let disconnected = false;
    await runFlow(
      f,
      new Map([
        ['remote', remote],
        ['local', local]
      ]),
      { host: 'web-1' },
      deps({
        connectHost: async () => ({ runShell: async () => ({ output: '', ok: true }), disconnect: () => (disconnected = true) }),
        runLocal: async () => {
          throw new Error('unexpected local failure');
        }
      })
    );
    expect(disconnected).toBe(true);
  });

  it('reports a failed connectHost as a failed node result rather than throwing', async () => {
    const remote = automation({ id: 'remote', name: 'Remote', kind: 'remote' });
    const f = flow([node({ id: 'n1', automationId: 'remote', label: 'a' })], [], hostParam);
    const results = await runFlow(
      f,
      new Map([['remote', remote]]),
      { host: 'web-1' },
      deps({
        connectHost: async () => {
          throw new Error('connection refused');
        }
      })
    );
    expect(results[0].status).toBe('failed');
    expect(results[0].error).toContain('connection refused');
  });

  it('fails a remote node (rather than throwing) when the flow has a host parameter but no value was supplied', async () => {
    const remote = automation({ id: 'remote', name: 'Remote', kind: 'remote' });
    const f = flow([node({ id: 'n1', automationId: 'remote', label: 'a' })], [], hostParam);
    const results = await runFlow(f, new Map([['remote', remote]]), {}, deps());
    expect(results[0].status).toBe('failed');
    expect(results[0].error).toMatch(/no host parameter value/);
  });
});
