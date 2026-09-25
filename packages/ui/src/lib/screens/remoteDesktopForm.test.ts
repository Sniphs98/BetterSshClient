import { describe, expect, it } from 'vitest';
import type { RemoteDesktopConnectionDto } from '$lib/bindings';
import { defaultPort, describeSettings, emptyForm, filterConnections, formFromConnection, formToInput, type RemoteDesktopFormFields } from './remoteDesktopForm';

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

describe('RDP settings in the form', () => {
  it('start from the usual client defaults', () => {
    const r = formToInput(fields({ name: 'n', hostname: 'h' }));
    expect(r.ok && r.input).toMatchObject({ multiMonitor: false, clipboard: true, drives: false, audio: 'local' });
    expect(r.ok && r.input.display).toBeUndefined();
  });

  it('take a window size only for a window, and only a sensible one', () => {
    const ok = formToInput(fields({ name: 'n', hostname: 'h', display: 'window', width: '1600', height: '900' }));
    expect(ok.ok && [ok.input.width, ok.input.height]).toEqual([1600, 900]);
    const bad = formToInput(fields({ name: 'n', hostname: 'h', display: 'window', width: '1600', height: '' }));
    expect(bad).toEqual({ ok: false, error: 'Window size must be a width and a height between 200 and 8192' });
    const ignored = formToInput(fields({ name: 'n', hostname: 'h', display: 'fullscreen', width: 'x' }));
    expect(ignored.ok && ignored.input.width).toBeUndefined();
  });

  it('carry "fit to screen" and resizing with the window through', () => {
    const r = formToInput(fields({ name: 'n', hostname: 'h', display: 'fit', dynamicResolution: true, width: 'ignored' }));
    expect(r.ok && [r.input.display, r.input.dynamicResolution, r.input.width]).toEqual(['fit', true, undefined]);
    expect(formFromConnection(connection({ display: 'fit', dynamicResolution: true }))).toMatchObject({ display: 'fit', dynamicResolution: true });
  });

  it('round-trip through a saved connection', () => {
    const f = formFromConnection(connection({ display: 'window', width: 1280, height: 720, clipboard: false, audio: 'off' }));
    expect(f).toMatchObject({ display: 'window', width: '1280', height: '720', clipboard: false, audio: 'off', drives: false });
  });
});

describe('describeSettings', () => {
  it('names what is set, in a few words each', () => {
    expect(describeSettings({ display: 'window', width: 1280, height: 720, clipboard: true, drives: true, audio: 'off' })).toEqual([
      'Window 1280×720',
      'Clipboard',
      'Drives',
      'No sound'
    ]);
    expect(describeSettings({ display: 'fullscreen', multiMonitor: true, audio: 'remote' })).toEqual([
      'Full screen',
      'All monitors',
      'Sound on remote'
    ]);
  });

  it('names fitting the screen and resizing with the window', () => {
    expect(describeSettings({ display: 'fit', dynamicResolution: true })).toEqual(['Fit to screen', 'Resizes']);
  });

  it('says so when everything is left to the client', () => {
    expect(describeSettings({ clipboard: false, audio: 'local' })).toEqual(['Client defaults']);
  });
});
