import { describe, expect, it } from 'vitest';
import {
  buildSnippetBundle,
  buildAutomationBundle,
  mergeSnippetBundle,
  mergeAutomationBundle,
  parseBundle,
  type SnippetBundle,
  type AutomationBundle
} from './bundle.js';
import type { Snippet, Automation, AutomationNode } from './types.js';

function snippet(partial: Partial<Snippet> & Pick<Snippet, 'id' | 'name'>): Snippet {
  return { command: 'echo hi', timeoutSecs: 30, ...partial };
}

function node(partial: Partial<AutomationNode> & Pick<AutomationNode, 'id' | 'snippetId'>): AutomationNode {
  return { label: partial.id, continueOnError: false, target: 'local', ...partial };
}

function automation(partial: Partial<Automation> & Pick<Automation, 'nodes'>): Automation {
  return { name: 'test-automation', params: [], edges: [], ...partial };
}

describe('buildSnippetBundle', () => {
  it('wraps the snippet with a kind/version envelope', () => {
    const a = snippet({ id: 'a1', name: 'Build' });
    expect(buildSnippetBundle(a)).toEqual({ kind: 'better-ssh-client-snippet', version: 1, snippet: a });
  });
});

describe('buildAutomationBundle', () => {
  it('gathers only the snippets the automation actually references, in node order, deduplicated', () => {
    const a1 = snippet({ id: 'a1', name: 'Build' });
    const a2 = snippet({ id: 'a2', name: 'Deploy' });
    const unused = snippet({ id: 'a3', name: 'Unused' });
    const f = automation({ nodes: [node({ id: 'n1', snippetId: 'a2' }), node({ id: 'n2', snippetId: 'a1' }), node({ id: 'n3', snippetId: 'a2' })] });
    const snippetsById = new Map([
      ['a1', a1],
      ['a2', a2],
      ['a3', unused]
    ]);
    const bundle = buildAutomationBundle(f, snippetsById);
    expect(bundle.snippets).toEqual([a2, a1]);
    expect(bundle.automation).toBe(f);
  });

  it('throws if a node references a snippet that no longer exists', () => {
    const f = automation({ nodes: [node({ id: 'n1', snippetId: 'missing' })] });
    expect(() => buildAutomationBundle(f, new Map())).toThrow(/unknown snippet/);
  });
});

describe('parseBundle', () => {
  it('round-trips a built snippet bundle through JSON', () => {
    const a = snippet({ id: 'a1', name: 'Build' });
    const bundle = buildSnippetBundle(a);
    expect(parseBundle(JSON.parse(JSON.stringify(bundle)))).toEqual(bundle);
  });

  it('round-trips a built automation bundle through JSON, including an optional param label/default and a node position', () => {
    const a = snippet({ id: 'a1', name: 'Build' });
    const f = automation({
      name: 'release',
      params: [{ name: 'version', kind: 'text', label: 'Version', default: 'latest' }],
      nodes: [{ id: 'n1', snippetId: 'a1', label: 'build', continueOnError: true, target: 'local', position: { x: 12, y: 34 } }],
      startLinks: ['n1']
    });
    const bundle = buildAutomationBundle(f, new Map([['a1', a]]));
    expect(parseBundle(JSON.parse(JSON.stringify(bundle)))).toEqual(bundle);
  });

  it('rejects a file that is not an object', () => {
    expect(() => parseBundle('nope')).toThrow(/expected an object/);
    expect(() => parseBundle(null)).toThrow(/expected an object/);
  });

  it('rejects an unrecognized "kind"', () => {
    expect(() => parseBundle({ kind: 'something-else' })).toThrow(/not a BetterSshClient/);
  });

  it('rejects a snippet bundle missing a required field', () => {
    expect(() => parseBundle({ kind: 'better-ssh-client-snippet', version: 1, snippet: { id: 'a1', name: 'Build' } })).toThrow(
      /snippet\.command/
    );
  });

  it('rejects an automation bundle whose node is missing a required field', () => {
    const raw = {
      kind: 'better-ssh-client-automation',
      version: 1,
      automation: { name: 'f', params: [], edges: [], nodes: [{ id: 'n1', snippetId: 'a1', label: 'x', target: 'local' }] },
      snippets: []
    };
    expect(() => parseBundle(raw)).toThrow(/continueOnError/);
  });

  it('defaults an automation bundle missing startLinks to undefined, not an empty array', () => {
    const raw = {
      kind: 'better-ssh-client-automation',
      version: 1,
      automation: { name: 'f', params: [], edges: [], nodes: [] },
      snippets: []
    };
    expect((parseBundle(raw) as AutomationBundle).automation.startLinks).toBeUndefined();
  });
});

describe('mergeSnippetBundle', () => {
  it('appends the snippet under a freshly minted id, leaving its name untouched', () => {
    const bundle: SnippetBundle = buildSnippetBundle(snippet({ id: 'exported-id', name: 'Build' }));
    const existing = [snippet({ id: 'local-id', name: 'Something else' })];
    const { snippets, result } = mergeSnippetBundle(bundle, existing);
    expect(snippets).toHaveLength(2);
    const imported = snippets[1];
    expect(imported.id).not.toBe('exported-id');
    expect(imported.name).toBe('Build');
    expect(result).toEqual({ kind: 'snippet', name: 'Build' });
  });

  it('never collides with an existing snippet even if the exported id happens to match one locally', () => {
    const existing = [snippet({ id: 'shared-id', name: 'Local one' })];
    const bundle = buildSnippetBundle(snippet({ id: 'shared-id', name: 'Imported one' }));
    const { snippets } = mergeSnippetBundle(bundle, existing);
    expect(snippets).toHaveLength(2);
    expect(snippets[0].id).not.toBe(snippets[1].id);
  });
});

describe('mergeAutomationBundle', () => {
  it('mints fresh ids for bundled snippets and remaps the automation nodes to them', () => {
    const a = snippet({ id: 'exported-a1', name: 'Build' });
    const f = automation({ name: 'release', nodes: [node({ id: 'n1', snippetId: 'exported-a1' })] });
    const bundle: AutomationBundle = { kind: 'better-ssh-client-automation', version: 1, automation: f, snippets: [a] };

    const { snippets, automations, result } = mergeAutomationBundle(bundle, [], []);
    expect(snippets).toHaveLength(1);
    expect(snippets[0].id).not.toBe('exported-a1');
    expect(automations).toHaveLength(1);
    expect(automations[0].nodes[0].snippetId).toBe(snippets[0].id);
    expect(result).toEqual({ kind: 'automation', name: 'release' });
  });

  it('renames the automation on a name collision instead of overwriting the existing one', () => {
    const a = snippet({ id: 'a1', name: 'Build' });
    const f = automation({ name: 'release', nodes: [node({ id: 'n1', snippetId: 'a1' })] });
    const bundle: AutomationBundle = { kind: 'better-ssh-client-automation', version: 1, automation: f, snippets: [a] };
    const existingAutomation = automation({ name: 'release', nodes: [] });

    const { automations, result } = mergeAutomationBundle(bundle, [], [existingAutomation]);
    expect(automations).toHaveLength(2);
    expect(automations[0]).toBe(existingAutomation);
    expect(automations[1].name).toBe('release (2)');
    expect(result).toEqual({ kind: 'automation', name: 'release (2)' });
  });

  it('keeps counting past an existing "(2)" to find a free name', () => {
    const a = snippet({ id: 'a1', name: 'Build' });
    const f = automation({ name: 'release', nodes: [] });
    const bundle: AutomationBundle = { kind: 'better-ssh-client-automation', version: 1, automation: f, snippets: [a] };
    const existing = [automation({ name: 'release', nodes: [] }), automation({ name: 'release (2)', nodes: [] })];

    const { result } = mergeAutomationBundle(bundle, [], existing);
    expect(result.name).toBe('release (3)');
  });
});

describe('bundles exported before the rename', () => {
  it('still import — the old kind is accepted and comes back under the current name', () => {
    const legacy = { kind: 'omnyssh-snippet', version: 1, snippet: snippet({ id: 'a1', name: 'Build' }) };
    const parsed = parseBundle(legacy);
    expect(parsed.kind).toBe('better-ssh-client-snippet');
  });

  it('accepts a legacy automation bundle too', () => {
    const legacy = {
      kind: 'omnyssh-automation',
      version: 1,
      automation: automation({ nodes: [] }),
      snippets: []
    };
    expect(parseBundle(legacy).kind).toBe('better-ssh-client-automation');
  });
});
