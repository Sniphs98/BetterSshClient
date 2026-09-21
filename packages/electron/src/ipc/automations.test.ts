import { describe, expect, it } from 'vitest';
import { removeSnippet, removeAutomation, upsertSnippet, upsertAutomation } from './automations.js';
import type { Snippet, Automation } from '../core/automation/types.js';

function snippet(overrides: Partial<Snippet> = {}): Snippet {
  return { id: 'a1', name: 'Build', kind: 'local', command: 'npm run build', timeoutSecs: 300, ...overrides };
}

function automation(overrides: Partial<Automation> = {}): Automation {
  return { name: 'deploy', params: [], nodes: [], edges: [], ...overrides };
}

describe('upsertSnippet', () => {
  it('appends a new snippet', () => {
    const snippets: Snippet[] = [];
    upsertSnippet(snippets, snippet());
    expect(snippets).toHaveLength(1);
  });

  it('replaces an existing snippet by id, not name', () => {
    const snippets = [snippet({ id: 'a1', name: 'Old name' })];
    upsertSnippet(snippets, snippet({ id: 'a1', name: 'New name' }));
    expect(snippets).toHaveLength(1);
    expect(snippets[0].name).toBe('New name');
  });

  it('a different id with the same name is a separate entry', () => {
    const snippets = [snippet({ id: 'a1' })];
    upsertSnippet(snippets, snippet({ id: 'a2' }));
    expect(snippets).toHaveLength(2);
  });
});

describe('removeSnippet', () => {
  it('removes an unreferenced snippet', () => {
    const snippets = [snippet({ id: 'a1' })];
    removeSnippet(snippets, [], 'a1');
    expect(snippets).toHaveLength(0);
  });

  it('a missing id is a no-op, not an error', () => {
    const snippets = [snippet({ id: 'a1' })];
    removeSnippet(snippets, [], 'ghost');
    expect(snippets).toHaveLength(1);
  });

  it('throws, naming the automation, when an automation still references it', () => {
    const snippets = [snippet({ id: 'a1' })];
    const automations = [automation({ name: 'deploy', nodes: [{ id: 'n1', snippetId: 'a1', label: 'build', continueOnError: false }] })];
    expect(() => removeSnippet(snippets, automations, 'a1')).toThrow(/'deploy'/);
    expect(snippets).toHaveLength(1); // untouched
  });

  it('names every referencing automation when more than one uses it', () => {
    const snippets = [snippet({ id: 'a1' })];
    const automations = [
      automation({ name: 'one', nodes: [{ id: 'n1', snippetId: 'a1', label: 'x', continueOnError: false }] }),
      automation({ name: 'two', nodes: [{ id: 'n1', snippetId: 'a1', label: 'x', continueOnError: false }] })
    ];
    expect(() => removeSnippet(snippets, automations, 'a1')).toThrow(/'one'.*'two'/);
  });
});

describe('upsertAutomation', () => {
  it('appends a new automation', () => {
    const automations: Automation[] = [];
    upsertAutomation(automations, automation());
    expect(automations).toHaveLength(1);
  });

  it('replaces an existing automation by name', () => {
    const automations = [automation({ name: 'deploy', edges: [] })];
    upsertAutomation(automations, automation({ name: 'deploy', edges: [{ from: 'a', to: 'b' }] }));
    expect(automations).toHaveLength(1);
    expect(automations[0].edges).toHaveLength(1);
  });
});

describe('removeAutomation', () => {
  it('removes an automation by name', () => {
    const automations = [automation({ name: 'deploy' })];
    removeAutomation(automations, 'deploy');
    expect(automations).toHaveLength(0);
  });

  it('a missing name is a no-op', () => {
    const automations = [automation({ name: 'deploy' })];
    removeAutomation(automations, 'ghost');
    expect(automations).toHaveLength(1);
  });
});
