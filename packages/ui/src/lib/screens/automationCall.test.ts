import { describe, expect, it } from 'vitest';
import type { AutomationParamDto } from '$lib/bindings';
import { askedParams, callableAutomations, callParamValues } from './automationCall';

const called: { params: AutomationParamDto[] } = {
  params: [
    { name: 'server', kind: 'host' },
    { name: 'tag', kind: 'text' },
    { name: 'image', kind: 'text' },
    { name: 'mode', kind: 'fixed', default: 'prod' }
  ]
};

describe('askedParams', () => {
  it('is what the run would ask for — not its fixed variables', () => {
    expect(askedParams(called).map((p) => p.name)).toEqual(['server', 'tag', 'image']);
  });
});

describe('callParamValues', () => {
  it('hands on the host and same-named parameters, leaves the rest to fill in', () => {
    const own: AutomationParamDto[] = [
      { name: 'host', kind: 'host' },
      { name: 'tag', kind: 'text' }
    ];
    expect(callParamValues(called, own, {})).toEqual({ server: '{{params.host}}', tag: '{{params.tag}}', image: '' });
  });

  it('keeps values already set, and drops ones for parameters it no longer has', () => {
    expect(callParamValues(called, [], { tag: 'v2', gone: 'x' })).toEqual({ server: '', tag: 'v2', image: '' });
  });
});

describe('callableAutomations', () => {
  it('lists every other automation, sorted', () => {
    expect(callableAutomations([{ name: 'deploy' }, { name: 'Backup' }, { name: 'ship' }], 'ship')).toEqual(['Backup', 'deploy']);
  });
});
