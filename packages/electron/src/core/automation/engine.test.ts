import { describe, expect, it } from 'vitest';
import {
  AutomationCycleError,
  missingParamValues,
  runAutomation,
  substituteTemplate,
  topoOrder,
  validateAutomation,
  type RunAutomationDeps
} from './engine.js';
import type { Snippet, Automation, AutomationNode, AutomationParam, NodeResult } from './types.js';

function snippet(partial: Partial<Snippet> & Pick<Snippet, 'id' | 'name'>): Snippet {
  return { command: 'echo hi', timeoutSecs: 30, ...partial };
}

function node(partial: Partial<AutomationNode> & Pick<AutomationNode, 'id' | 'snippetId'>): AutomationNode {
  return { label: partial.id, continueOnError: false, target: 'local', ...partial };
}

function automation(nodes: AutomationNode[], edges: Array<[string, string]> = [], params: AutomationParam[] = []): Automation {
  return { name: 'test-automation', params, nodes, edges: edges.map(([from, to]) => ({ from, to })) };
}

const hostParam: AutomationParam[] = [{ name: 'host', kind: 'host' }];

describe('topoOrder', () => {
  it('orders a linear chain', () => {
    const f = automation([node({ id: 'a', snippetId: 'x' }), node({ id: 'b', snippetId: 'x' }), node({ id: 'c', snippetId: 'x' })], [
      ['a', 'b'],
      ['b', 'c']
    ]);
    expect(topoOrder(f)).toEqual(['a', 'b', 'c']);
  });

  it('orders a diamond with both middle nodes before the join', () => {
    const f = automation(
      [node({ id: 'a', snippetId: 'x' }), node({ id: 'b', snippetId: 'x' }), node({ id: 'c', snippetId: 'x' }), node({ id: 'd', snippetId: 'x' })],
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
    const f = automation([node({ id: 'a', snippetId: 'x' }), node({ id: 'b', snippetId: 'x' })], []);
    expect(topoOrder(f)).toEqual(['a', 'b']);
  });

  it('throws AutomationCycleError naming a node in the cycle', () => {
    const f = automation([node({ id: 'a', snippetId: 'x' }), node({ id: 'b', snippetId: 'x' })], [
      ['a', 'b'],
      ['b', 'a']
    ]);
    expect(() => topoOrder(f)).toThrow(AutomationCycleError);
    expect(() => topoOrder(f)).toThrow(/cycle/);
  });

  it('ignores a dangling edge rather than crashing', () => {
    const f = automation([node({ id: 'a', snippetId: 'x' })], [['a', 'ghost']]);
    expect(topoOrder(f)).toEqual(['a']);
  });
});

describe('validateAutomation', () => {
  const snippetsById = new Map<string, Snippet>([
    ['local-x', snippet({ id: 'local-x', name: 'Local X' })],
    ['remote-y', snippet({ id: 'remote-y', name: 'Remote Y' })]
  ]);

  it('is empty for a valid automation', () => {
    const f = automation([node({ id: 'a', snippetId: 'local-x' })]);
    expect(validateAutomation(f, snippetsById)).toEqual([]);
  });

  it('is empty for a valid automation with a remote node and a host parameter', () => {
    const f = automation([node({ id: 'a', snippetId: 'remote-y', target: 'remote' })], [], hostParam);
    expect(validateAutomation(f, snippetsById)).toEqual([]);
  });

  it('flags an unknown snippetId', () => {
    const f = automation([node({ id: 'a', snippetId: 'does-not-exist' })]);
    expect(validateAutomation(f, snippetsById)[0]).toMatch(/unknown snippet/);
  });

  it('flags a remote node when the automation has no host parameter', () => {
    const f = automation([node({ id: 'a', snippetId: 'remote-y', target: 'remote' })]);
    expect(validateAutomation(f, snippetsById).some((p) => p.includes('no host parameter'))).toBe(true);
  });

  it('flags more than one host parameter', () => {
    const f = automation(
      [node({ id: 'a', snippetId: 'local-x' })],
      [],
      [
        { name: 'host', kind: 'host' },
        { name: 'other-host', kind: 'host' }
      ]
    );
    expect(validateAutomation(f, snippetsById).some((p) => p.includes('at most one host parameter'))).toBe(true);
  });

  it('flags a parameter name declared more than once', () => {
    const f = automation(
      [node({ id: 'a', snippetId: 'local-x' })],
      [],
      [
        { name: 'dup', kind: 'text' },
        { name: 'dup', kind: 'text' }
      ]
    );
    expect(validateAutomation(f, snippetsById).some((p) => p.includes('more than once'))).toBe(true);
  });

  it('flags a command referencing an unknown parameter', () => {
    const referencing = snippet({ id: 'ref', name: 'Ref', command: '{{params.ghost}}' });
    const byId = new Map(snippetsById).set('ref', referencing);
    const f = automation([node({ id: 'a', snippetId: 'ref' })]);
    expect(validateAutomation(f, byId).some((p) => p.includes('unknown parameter'))).toBe(true);
  });

  it('accepts a command referencing a declared parameter, from any node (params are automation-wide)', () => {
    const referencing = snippet({ id: 'ref', name: 'Ref', command: 'echo {{params.version}}' });
    const byId = new Map(snippetsById).set('ref', referencing);
    const f = automation([node({ id: 'a', snippetId: 'local-x' }), node({ id: 'b', snippetId: 'ref' })], [], [{ name: 'version', kind: 'text' }]);
    expect(validateAutomation(f, byId)).toEqual([]);
  });

  it('flags duplicate labels', () => {
    const f = automation([node({ id: 'a', snippetId: 'local-x', label: 'same' }), node({ id: 'b', snippetId: 'local-x', label: 'same' })]);
    expect(validateAutomation(f, snippetsById).some((p) => p.includes('more than one node'))).toBe(true);
  });

  it('flags a template reference to a label that is not a direct predecessor', () => {
    const referencing = snippet({ id: 'ref', name: 'Ref', command: '{{nodes.a.output}}' });
    const byId = new Map(snippetsById).set('ref', referencing);
    // b references "a"'s output but there is no edge a -> b.
    const f = automation([node({ id: 'a', snippetId: 'local-x' }), node({ id: 'b', snippetId: 'ref' })]);
    expect(validateAutomation(f, byId).some((p) => p.includes('not a direct dependency'))).toBe(true);
  });

  it('accepts a template reference to a direct predecessor', () => {
    const referencing = snippet({ id: 'ref', name: 'Ref', command: '{{nodes.a.output}}' });
    const byId = new Map(snippetsById).set('ref', referencing);
    const f = automation([node({ id: 'a', snippetId: 'local-x' }), node({ id: 'b', snippetId: 'ref' })], [['a', 'b']]);
    expect(validateAutomation(f, byId)).toEqual([]);
  });

  it('flags a template reference to an unknown label', () => {
    const referencing = snippet({ id: 'ref', name: 'Ref', command: '{{nodes.ghost.output}}' });
    const byId = new Map(snippetsById).set('ref', referencing);
    const f = automation([node({ id: 'a', snippetId: 'ref' })]);
    expect(validateAutomation(f, byId).some((p) => p.includes('unknown label'))).toBe(true);
  });

  it('surfaces a cycle as a problem too', () => {
    const f = automation([node({ id: 'a', snippetId: 'local-x' }), node({ id: 'b', snippetId: 'local-x' })], [
      ['a', 'b'],
      ['b', 'a']
    ]);
    expect(validateAutomation(f, snippetsById).some((p) => p.includes('cycle'))).toBe(true);
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
  function automationWithParams(params: AutomationParam[]): Automation {
    return { name: 'f', params, nodes: [], edges: [] };
  }

  it('is empty when every declared parameter has a non-blank value', () => {
    const f = automationWithParams([
      { name: 'host', kind: 'host' },
      { name: 'version', kind: 'text' }
    ]);
    expect(missingParamValues(f, { host: 'web-1', version: '1.0' })).toEqual([]);
  });

  it('flags a missing value, naming its label when set', () => {
    const f = automationWithParams([{ name: 'host', kind: 'host', label: 'Target host' }]);
    expect(missingParamValues(f, {})).toEqual(['Target host']);
  });

  it('flags a blank (whitespace-only) value the same as a missing one', () => {
    const f = automationWithParams([{ name: 'version', kind: 'text' }]);
    expect(missingParamValues(f, { version: '   ' })).toEqual(['version']);
  });
});

describe('runAutomation', () => {
  function deps(overrides: Partial<RunAutomationDeps> = {}): RunAutomationDeps {
    return {
      runLocal: async (command) => ({ output: `ran: ${command}`, ok: true }),
      connectHost: async () => ({ runShell: async () => ({ output: '', ok: true }), disconnect: () => {} }),
      ...overrides
    };
  }

  it('runs nodes in topo order and reports success', async () => {
    const a = snippet({ id: 'a', name: 'A' });
    const f = automation([node({ id: 'n1', snippetId: 'a', label: 'first' }), node({ id: 'n2', snippetId: 'a', label: 'second' })], [
      ['n1', 'n2']
    ]);
    const started: string[] = [];
    const results = await runAutomation(f, new Map([['a', a]]), {}, deps(), (e) => {
      if (e.kind === 'nodeStarted') started.push(e.label);
    });
    expect(started).toEqual(['first', 'second']);
    expect(results.map((r) => r.status)).toEqual(['success', 'success']);
  });

  it('skips a dependent when its predecessor fails without continueOnError', async () => {
    const failing = snippet({ id: 'fail', name: 'Fail' });
    const dependent = snippet({ id: 'dep', name: 'Dep' });
    const f = automation(
      [node({ id: 'n1', snippetId: 'fail', label: 'a', continueOnError: false }), node({ id: 'n2', snippetId: 'dep', label: 'b' })],
      [['n1', 'n2']]
    );
    const results = await runAutomation(
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
    const failing = snippet({ id: 'fail', name: 'Fail' });
    const dependent = snippet({ id: 'dep', name: 'Dep' });
    const f = automation(
      [node({ id: 'n1', snippetId: 'fail', label: 'a', continueOnError: true }), node({ id: 'n2', snippetId: 'dep', label: 'b' })],
      [['n1', 'n2']]
    );
    let runLocalCalls = 0;
    const results = await runAutomation(
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
    const a = snippet({ id: 'a', name: 'A' });
    const f = automation(
      [
        node({ id: 'n1', snippetId: 'a', label: 'x', continueOnError: false }),
        node({ id: 'n2', snippetId: 'a', label: 'y', continueOnError: false }),
        node({ id: 'n3', snippetId: 'a', label: 'z' })
      ],
      [
        ['n1', 'n2'],
        ['n2', 'n3']
      ]
    );
    const results = await runAutomation(f, new Map([['a', a]]), {}, deps({ runLocal: async () => ({ output: '', ok: false, error: 'boom' }) }));
    expect(results.map((r) => r.status)).toEqual(['failed', 'skipped', 'skipped']);
  });

  it('a diamond: one failed non-continuable parent still skips the child (AND semantics)', async () => {
    const a = snippet({ id: 'a', name: 'A' });
    const f = automation(
      [
        node({ id: 'n1', snippetId: 'a', label: 'a' }),
        node({ id: 'n2', snippetId: 'a', label: 'b', continueOnError: false }),
        node({ id: 'n3', snippetId: 'a', label: 'c', continueOnError: false }),
        node({ id: 'n4', snippetId: 'a', label: 'd' })
      ],
      [
        ['n1', 'n2'],
        ['n1', 'n3'],
        ['n2', 'n4'],
        ['n3', 'n4']
      ]
    );
    let calls = 0;
    const results = await runAutomation(
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
    const local = snippet({ id: 'local', name: 'Local', command: 'echo build-123' });
    const remote = snippet({ id: 'remote', name: 'Remote', command: 'deploy {{nodes.build.output}}' });
    const f = automation(
      [node({ id: 'n1', snippetId: 'local', label: 'build' }), node({ id: 'n2', snippetId: 'remote', label: 'deploy', target: 'remote' })],
      [['n1', 'n2']],
      hostParam
    );
    const seenCommands: string[] = [];
    const results = await runAutomation(
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
    const remote = snippet({ id: 'remote', name: 'Remote', command: 'deploy --version {{params.version}}' });
    const f = automation([node({ id: 'n1', snippetId: 'remote', label: 'a', target: 'remote' })], [], [...hostParam, { name: 'version', kind: 'text' }]);
    const seenCommands: string[] = [];
    const seenHosts: string[] = [];
    await runAutomation(
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
    const remote = snippet({ id: 'remote', name: 'Remote' });
    const f = automation(
      [node({ id: 'n1', snippetId: 'remote', label: 'a', target: 'remote' }), node({ id: 'n2', snippetId: 'remote', label: 'b', target: 'remote' })],
      [],
      hostParam
    );
    let connectCount = 0;
    let disconnectCount = 0;
    await runAutomation(
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
    const remote = snippet({ id: 'remote', name: 'Remote' });
    const local = snippet({ id: 'local', name: 'Local' });
    const f = automation(
      [node({ id: 'n1', snippetId: 'remote', label: 'a', target: 'remote' }), node({ id: 'n2', snippetId: 'local', label: 'b' })],
      [],
      hostParam
    );
    let disconnected = false;
    await runAutomation(
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
    const remote = snippet({ id: 'remote', name: 'Remote' });
    const f = automation([node({ id: 'n1', snippetId: 'remote', label: 'a', target: 'remote' })], [], hostParam);
    const results = await runAutomation(
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

  it('fails a remote node (rather than throwing) when the automation has a host parameter but no value was supplied', async () => {
    const remote = snippet({ id: 'remote', name: 'Remote' });
    const f = automation([node({ id: 'n1', snippetId: 'remote', label: 'a', target: 'remote' })], [], hostParam);
    const results = await runAutomation(f, new Map([['remote', remote]]), {}, deps());
    expect(results[0].status).toBe('failed');
    expect(results[0].error).toMatch(/no host parameter value/);
  });
});
