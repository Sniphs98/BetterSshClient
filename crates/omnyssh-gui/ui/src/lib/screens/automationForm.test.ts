import { describe, expect, it } from 'vitest';
import type { AutomationDto } from '$lib/bindings';
import {
  declaredParams,
  describeStep,
  emptyForm,
  filterAutomations,
  formFromAutomation,
  formToAutomation,
  parseStepsText,
  stepsToText,
  type AutomationFormFields
} from './automationForm';

function fields(partial: Partial<AutomationFormFields>): AutomationFormFields {
  return { ...emptyForm(), ...partial };
}

function automation(partial: Partial<AutomationDto>): AutomationDto {
  return { name: 'n', steps: [], ...partial };
}

describe('parseStepsText — mirrors the TUI parse_steps_text', () => {
  it('parses a local step', () => {
    const steps = parseStepsText('local: echo hi');
    expect(steps).toEqual([
      { kind: 'local', command: 'echo hi', continueOnError: false, timeoutSecs: 300 }
    ]);
  });

  it('parses a remote step', () => {
    const steps = parseStepsText('remote: systemctl restart app');
    expect(steps[0]).toMatchObject({ kind: 'remote', command: 'systemctl restart app' });
  });

  it('parses an upload step', () => {
    const steps = parseStepsText('upload: image.tar -> /srv/deploy/image.tar');
    expect(steps[0]).toMatchObject({
      kind: 'upload',
      localPath: 'image.tar',
      remotePath: '/srv/deploy/image.tar'
    });
  });

  it('parses a download step', () => {
    const steps = parseStepsText('download: /var/log/app.log -> ./app.log');
    expect(steps[0]).toMatchObject({
      kind: 'download',
      remotePath: '/var/log/app.log',
      localPath: './app.log'
    });
  });

  it('parses multiple steps in order', () => {
    const steps = parseStepsText('local: docker save x -o x.tar\nupload: x.tar -> /srv/x.tar');
    expect(steps.map((s) => s.kind)).toEqual(['local', 'upload']);
  });

  it('ignores blank lines', () => {
    const steps = parseStepsText('local: a\n\n\nlocal: b\n');
    expect(steps.length).toBe(2);
  });

  it('throws with the line number on an unknown kind', () => {
    expect(() => parseStepsText('local: a\ndocker: b')).toThrow(/Line 2/);
  });

  it('throws on a missing colon', () => {
    expect(() => parseStepsText('just some text')).toThrow(/Line 1/);
  });

  it('throws when upload has no arrow', () => {
    expect(() => parseStepsText('upload: image.tar')).toThrow(/->/);
  });
});

describe('stepsToText round-trips through parseStepsText', () => {
  it('renders and reparses to the same steps', () => {
    const original = 'local: a\nremote: b\nupload: c -> d\ndownload: e -> f';
    const steps = parseStepsText(original);
    const reparsed = parseStepsText(stepsToText(steps));
    expect(reparsed).toEqual(steps);
  });
});

describe('describeStep', () => {
  it('covers every kind', () => {
    expect(describeStep({ kind: 'local', command: 'echo hi', continueOnError: false, timeoutSecs: 300 })).toBe(
      'Local: echo hi'
    );
    expect(
      describeStep({ kind: 'upload', localPath: 'a', remotePath: 'b', continueOnError: false, timeoutSecs: 300 })
    ).toBe('Upload: a → b');
  });
});

describe('formToAutomation — mirrors the TUI to_automation', () => {
  it('rejects an empty name', () => {
    const r = formToAutomation(fields({ name: '  ', steps: 'local: a' }));
    expect(r).toEqual({ ok: false, error: 'Name cannot be empty' });
  });

  it('rejects an automation with no steps', () => {
    const r = formToAutomation(fields({ name: 'n', steps: '' }));
    expect(r).toEqual({ ok: false, error: 'Add at least one step' });
  });

  it('requires a host when a step needs one', () => {
    const r = formToAutomation(fields({ name: 'n', host: '', steps: 'remote: echo hi' }));
    expect(r).toEqual({
      ok: false,
      error: 'This automation has a remote/upload/download step — set a Host'
    });
  });

  it('a local-only automation needs no host', () => {
    const r = formToAutomation(fields({ name: 'n', host: '', steps: 'local: echo hi' }));
    expect(r.ok && r.automation.host).toBeUndefined();
  });

  it('propagates a steps parse error', () => {
    const r = formToAutomation(fields({ name: 'n', steps: 'upload: nofield' }));
    expect(r.ok).toBe(false);
  });

  it('trims and splits params, dropping blanks', () => {
    const r = formToAutomation(fields({ name: 'n', steps: 'local: echo {{a}}', params: 'a, b ,,' }));
    expect(r.ok && r.automation.params).toEqual(['a', 'b']);
  });

  it('drops empty params to undefined so the wire form stays sparse', () => {
    const r = formToAutomation(fields({ name: 'n', steps: 'local: a', params: ' , ' }));
    expect(r.ok && r.automation.params).toBeUndefined();
  });
});

describe('formFromAutomation round-trips through formToAutomation', () => {
  it('reconstructs the same automation from its form fields', () => {
    const original = automation({
      name: 'deploy-image',
      host: 'web-1',
      steps: [
        { kind: 'local', command: 'docker save x -o x.tar', continueOnError: false, timeoutSecs: 300 },
        { kind: 'upload', localPath: 'x.tar', remotePath: '/srv/x.tar', continueOnError: false, timeoutSecs: 300 }
      ],
      params: ['tag']
    });
    const r = formToAutomation(formFromAutomation(original));
    expect(r).toEqual({ ok: true, automation: original });
  });
});

describe('declaredParams', () => {
  it('returns the declared params or an empty list', () => {
    expect(declaredParams(automation({ params: ['a', 'b'] }))).toEqual(['a', 'b']);
    expect(declaredParams(automation({ params: undefined }))).toEqual([]);
  });
});

describe('filterAutomations — mirrors the TUI filter_automations', () => {
  const list: AutomationDto[] = [
    automation({ name: 'deploy', host: 'web-1', steps: [{ kind: 'local', command: 'git pull', continueOnError: false, timeoutSecs: 300 }] }),
    automation({ name: 'backup', host: 'db-1', steps: [{ kind: 'local', command: 'pg_dump db', continueOnError: false, timeoutSecs: 300 }] }),
    automation({ name: 'restart', steps: [{ kind: 'remote', command: 'systemctl restart nginx', continueOnError: false, timeoutSecs: 300 }] })
  ];

  it('returns everything for an empty query, order preserved', () => {
    expect(filterAutomations(list, '').map((a) => a.name)).toEqual(['deploy', 'backup', 'restart']);
  });

  it('matches on name', () => {
    expect(filterAutomations(list, 'depl').map((a) => a.name)).toEqual(['deploy']);
  });

  it('matches on host', () => {
    expect(filterAutomations(list, 'web').map((a) => a.name)).toEqual(['deploy']);
  });

  it('matches on step text', () => {
    expect(filterAutomations(list, 'systemctl').map((a) => a.name)).toEqual(['restart']);
  });

  it('is case-insensitive', () => {
    expect(filterAutomations(list, 'DEPLOY').map((a) => a.name)).toEqual(['deploy']);
  });

  it('returns nothing when there is no match', () => {
    expect(filterAutomations(list, 'zzz')).toEqual([]);
  });
});
