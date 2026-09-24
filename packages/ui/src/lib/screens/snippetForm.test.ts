import { describe, expect, it } from 'vitest';
import type { SnippetDto } from '$lib/bindings';
import { emptyForm, formFromSnippet, formToSnippet, type SnippetFormFields } from './snippetForm';

function fields(partial: Partial<SnippetFormFields>): SnippetFormFields {
  return { ...emptyForm(), ...partial };
}

describe('formToSnippet', () => {
  it('rejects an empty name', () => {
    expect(formToSnippet(fields({ name: '  ', command: 'echo hi' }), 'id1')).toEqual({
      ok: false,
      error: 'Name cannot be empty'
    });
  });

  it('rejects an empty command', () => {
    expect(formToSnippet(fields({ name: 'Build', command: '  ' }), 'id1')).toEqual({
      ok: false,
      error: 'Command cannot be empty'
    });
  });

  it('builds a snippet with a trimmed name/command and the given id', () => {
    const r = formToSnippet(fields({ name: ' Build ', command: ' echo hi ' }), 'id1');
    expect(r.ok && r.snippet).toEqual({
      id: 'id1',
      name: 'Build',
      command: 'echo hi',
      timeoutSecs: 300
    });
  });

  it('builds a snippet with no host and no local/remote field — the placing node decides that', () => {
    const r = formToSnippet(fields({ name: 'Deploy', command: 'docker ps' }), 'id2');
    expect(r.ok && r.snippet).toEqual({
      id: 'id2',
      name: 'Deploy',
      command: 'docker ps',
      timeoutSecs: 300
    });
  });

  it('defaults an empty timeout to 300', () => {
    const r = formToSnippet(fields({ name: 'Build', command: 'echo hi', timeoutSecs: '' }), 'id1');
    expect(r.ok && r.snippet.timeoutSecs).toBe(300);
  });

  it('parses a valid timeout', () => {
    const r = formToSnippet(fields({ name: 'Build', command: 'echo hi', timeoutSecs: '30' }), 'id1');
    expect(r.ok && r.snippet.timeoutSecs).toBe(30);
  });

  it.each(['0', '-1', '1.5', 'abc'])('rejects an invalid timeout %s', (timeoutSecs) => {
    const r = formToSnippet(fields({ name: 'Build', command: 'echo hi', timeoutSecs }), 'id1');
    expect(r.ok).toBe(false);
  });
});

describe('formFromSnippet', () => {
  it('round-trips a snippet', () => {
    const original: SnippetDto = { id: 'id1', name: 'Build', command: 'npm run build', timeoutSecs: 60 };
    const f = formFromSnippet(original);
    const r = formToSnippet(f, original.id);
    expect(r.ok && r.snippet).toEqual(original);
  });

  it('round-trips a snippet with a multi-word name', () => {
    const original: SnippetDto = { id: 'id1', name: 'Deploy to prod', command: 'docker ps', timeoutSecs: 60 };
    const f = formFromSnippet(original);
    const r = formToSnippet(f, original.id);
    expect(r.ok && r.snippet).toEqual(original);
  });
});
