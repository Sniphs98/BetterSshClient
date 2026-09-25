import { describe, expect, it } from 'vitest';
import type { RemoteDesktopConnectionDto } from '$lib/bindings';
import { defaultPort, emptyForm, filterConnections, formFromConnection, formToInput, type RemoteDesktopFormFields } from './remoteDesktopForm';

function fields(partial: Partial<RemoteDesktopFormFields>): RemoteDesktopFormFields {
  return { ...emptyForm(), ...partial };
}

function connection(partial: Partial<RemoteDesktopConnectionDto>): RemoteDesktopConnectionDto {
  return {
    id: 'c1',
    name: 'office-pc',
    protocol: 'rdp',
    hostname: '10.0.0.5',
    port: 3389,
    hasPassword: false,
    ...partial
  };
}

describe('defaultPort', () => {
  it('rdp defaults to 3389', () => {
    expect(defaultPort('rdp')).toBe(3389);
  });

  it('vnc defaults to 5900', () => {
    expect(defaultPort('vnc')).toBe(5900);
  });
});

describe('emptyForm', () => {
  it('mints a fresh id and defaults to rdp', () => {
    const a = emptyForm();
    const b = emptyForm();
    expect(a.id).not.toBe(b.id);
    expect(a.protocol).toBe('rdp');
  });
});

describe('formToInput', () => {
  it('rejects an empty name', () => {
    expect(formToInput(fields({ name: '  ', hostname: 'h' }))).toEqual({
      ok: false,
      error: 'Name cannot be empty'
    });
  });

  it('rejects an empty hostname', () => {
    expect(formToInput(fields({ name: 'n', hostname: '  ' }))).toEqual({
      ok: false,
      error: 'Hostname / IP cannot be empty'
    });
  });

  it('defaults an empty port to the protocol default (3389 for rdp)', () => {
    const r = formToInput(fields({ name: 'n', hostname: 'h', port: '' }));
    expect(r.ok && r.input.port).toBe(3389);
  });

  it('parses a valid port', () => {
    const r = formToInput(fields({ name: 'n', hostname: 'h', port: '3390' }));
    expect(r.ok && r.input.port).toBe(3390);
  });

  it('rejects an out-of-range port', () => {
    const r = formToInput(fields({ name: 'n', hostname: 'h', port: '70000' }));
    expect(r.ok).toBe(false);
  });

  it('rejects a non-numeric port', () => {
    const r = formToInput(fields({ name: 'n', hostname: 'h', port: 'abc' }));
    expect(r.ok).toBe(false);
  });

  it('drops blank username/password/domain to undefined', () => {
    const r = formToInput(fields({ name: 'n', hostname: 'h', username: '  ', password: '  ', domain: '  ' }));
    expect(r.ok && r.input.username).toBeUndefined();
    expect(r.ok && r.input.password).toBeUndefined();
    expect(r.ok && r.input.domain).toBeUndefined();
  });

  it('connects directly unless an SSH host to tunnel through is chosen', () => {
    const direct = formToInput(fields({ name: 'n', hostname: 'h' }));
    expect(direct.ok && direct.input.viaHost).toBeUndefined();
    const tunnelled = formToInput(fields({ name: 'n', hostname: 'h', viaHost: 'bastion' }));
    expect(tunnelled.ok && tunnelled.input.viaHost).toBe('bastion');
  });

  it('keeps a provided username/password/domain, trimmed', () => {
    const r = formToInput(fields({ name: 'n', hostname: 'h', username: ' admin ', password: ' pw ', domain: ' CORP ' }));
    expect(r.ok && r.input.username).toBe('admin');
    expect(r.ok && r.input.password).toBe('pw');
    expect(r.ok && r.input.domain).toBe('CORP');
  });

  it('carries the id through unchanged', () => {
    const r = formToInput(fields({ id: 'fixed-id', name: 'n', hostname: 'h' }));
    expect(r.ok && r.input.id).toBe('fixed-id');
  });
});

describe('formFromConnection', () => {
  it('leaves the password blank — the DTO never carries one', () => {
    const f = formFromConnection(connection({ hasPassword: true }));
    expect(f.password).toBe('');
  });

  it('round-trips the other fields', () => {
    const c = connection({ username: 'admin', domain: 'CORP' });
    const f = formFromConnection(c);
    expect(f.name).toBe(c.name);
    expect(f.hostname).toBe(c.hostname);
    expect(f.port).toBe('3389');
    expect(f.username).toBe('admin');
    expect(f.domain).toBe('CORP');
  });
});

describe('filterConnections', () => {
  const list = [connection({ name: 'office-pc', hostname: '10.0.0.5' }), connection({ id: 'c2', name: 'lab-vm', hostname: '10.0.0.9' })];

  it('an empty query keeps everything', () => {
    expect(filterConnections(list, '')).toEqual(list);
  });

  it('matches by name, case-insensitively', () => {
    expect(filterConnections(list, 'OFFICE')).toEqual([list[0]]);
  });

  it('matches by hostname', () => {
    expect(filterConnections(list, '10.0.0.9')).toEqual([list[1]]);
  });
});
