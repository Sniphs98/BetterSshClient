import { describe, expect, it } from 'vitest';
import type { AutomationDto } from '$lib/bindings';
import { emptyForm, formFromAutomation, formToAutomation, type AutomationFormFields } from './automationForm';

function fields(partial: Partial<AutomationFormFields>): AutomationFormFields {
  return { ...emptyForm(), ...partial };
}

describe('formToAutomation', () => {
  it('rejects an empty name', () => {
    expect(formToAutomation(fields({ name: '  ', command: 'echo hi' }), 'id1')).toEqual({
      ok: false,
      error: 'Name cannot be empty'
    });
  });

  it('rejects an empty command', () => {
    expect(formToAutomation(fields({ name: 'Build', command: '  ' }), 'id1')).toEqual({
      ok: false,
      error: 'Command cannot be empty'
    });
  });

  it('rejects a remote automation with no host picked', () => {
    const r = formToAutomation(fields({ name: 'Deploy', command: 'echo hi', kind: 'remote' }), 'id1');
    expect(r).toEqual({ ok: false, error: 'Pick a host for a remote automation' });
  });

  it('builds a local automation with a trimmed name/command and the given id', () => {
    const r = formToAutomation(fields({ name: ' Build ', command: ' echo hi ' }), 'id1');
    expect(r.ok && r.automation).toEqual({
      id: 'id1',
      name: 'Build',
      kind: 'local',
      hostName: undefined,
      command: 'echo hi',
      timeoutSecs: 300
    });
  });

  it('builds a remote automation with its hostName', () => {
    const r = formToAutomation(fields({ name: 'Deploy', command: 'docker ps', kind: 'remote', hostName: 'web-1' }), 'id2');
    expect(r.ok && r.automation.hostName).toBe('web-1');
  });

  it('drops hostName for a local automation even if one was typed', () => {
    const r = formToAutomation(fields({ name: 'Build', command: 'echo hi', kind: 'local', hostName: 'web-1' }), 'id1');
    expect(r.ok && r.automation.hostName).toBeUndefined();
  });

  it('defaults an empty timeout to 300', () => {
    const r = formToAutomation(fields({ name: 'Build', command: 'echo hi', timeoutSecs: '' }), 'id1');
    expect(r.ok && r.automation.timeoutSecs).toBe(300);
  });

  it('parses a valid timeout', () => {
    const r = formToAutomation(fields({ name: 'Build', command: 'echo hi', timeoutSecs: '30' }), 'id1');
    expect(r.ok && r.automation.timeoutSecs).toBe(30);
  });

  it.each(['0', '-1', '1.5', 'abc'])('rejects an invalid timeout %s', (timeoutSecs) => {
    const r = formToAutomation(fields({ name: 'Build', command: 'echo hi', timeoutSecs }), 'id1');
    expect(r.ok).toBe(false);
  });
});

describe('formFromAutomation', () => {
  it('round-trips a local automation', () => {
    const original: AutomationDto = { id: 'id1', name: 'Build', kind: 'local', command: 'npm run build', timeoutSecs: 60 };
    const f = formFromAutomation(original);
    const r = formToAutomation(f, original.id);
    expect(r.ok && r.automation).toEqual(original);
  });

  it('round-trips a remote automation, leaving hostName blank when unset', () => {
    expect(formFromAutomation({ id: 'id1', name: 'Build', kind: 'local', command: 'x', timeoutSecs: 1 }).hostName).toBe('');
  });
});
