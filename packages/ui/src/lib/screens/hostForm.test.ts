import { describe, expect, it } from 'vitest';
import type { HostDto } from '$lib/bindings';
import { emptyForm, formFromHost, formToInput, type HostFormFields } from './hostForm';

function fields(partial: Partial<HostFormFields>): HostFormFields {
  return { ...emptyForm(), ...partial };
}

function host(partial: Partial<HostDto>): HostDto {
  return {
    name: 'web',
    hostname: 'web.example.com',
    user: 'deploy',
    port: 22,
    tags: [],
    source: 'manual',
    hasKey: false,
    monitoring: 'ssh',
    ...partial
  };
}

describe('formToInput — mirrors the TUI to_host', () => {
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

  it('defaults an empty user to root', () => {
    const r = formToInput(fields({ name: 'n', hostname: 'h', user: '  ' }));
    expect(r.ok && r.input.user).toBe('root');
  });

  it('defaults an empty port to 22', () => {
    const r = formToInput(fields({ name: 'n', hostname: 'h', port: '' }));
    expect(r.ok && r.input.port).toBe(22);
  });

  it('parses a valid port', () => {
    const r = formToInput(fields({ name: 'n', hostname: 'h', port: '2222' }));
    expect(r.ok && r.input.port).toBe(2222);
  });

  it('accepts the max port 65535', () => {
    const r = formToInput(fields({ name: 'n', hostname: 'h', port: '65535' }));
    expect(r.ok && r.input.port).toBe(65535);
  });

  it('accepts an optional leading + (parity with Rust u16::parse)', () => {
    const r = formToInput(fields({ name: 'n', hostname: 'h', port: '+22' }));
    expect(r.ok && r.input.port).toBe(22);
  });

  it.each(['0', '65536', '-1', '22.5', 'abc', '2e3', '0x10', '99999'])(
    'rejects an invalid port %s',
    (port) => {
      const r = formToInput(fields({ name: 'n', hostname: 'h', port }));
      expect(r).toEqual({
        ok: false,
        error: `Port must be a number between 1 and 65535, got '${port}'`
      });
    }
  );

  it('trims name/hostname and splits tags, dropping blanks', () => {
    const r = formToInput(fields({ name: '  web ', hostname: ' 10.0.0.1 ', tags: 'prod, , db ,' }));
    expect(r.ok && r.input.name).toBe('web');
    expect(r.ok && r.input.hostname).toBe('10.0.0.1');
    expect(r.ok && r.input.tags).toEqual(['prod', 'db']);
  });

  it('drops blank optionals to undefined so the wire form stays sparse', () => {
    const r = formToInput(fields({ name: 'n', hostname: 'h', identityFile: '  ', password: '', notes: ' ' }));
    expect(r.ok && r.input.identityFile).toBeUndefined();
    expect(r.ok && r.input.password).toBeUndefined();
    expect(r.ok && r.input.notes).toBeUndefined();
  });

  it('drops a blank default path to undefined, keeps a trimmed one', () => {
    const blank = formToInput(fields({ name: 'n', hostname: 'h', defaultPath: '   ' }));
    expect(blank.ok && blank.input.defaultPath).toBeUndefined();

    const set = formToInput(fields({ name: 'n', hostname: 'h', defaultPath: ' /var/www ' }));
    expect(set.ok && set.input.defaultPath).toBe('/var/www');
  });

  it('drops a blank startup command to undefined, keeps a trimmed one as written', () => {
    const blank = formToInput(fields({ name: 'n', hostname: 'h', startupCommand: '  ' }));
    expect(blank.ok && blank.input.startupCommand).toBeUndefined();

    const set = formToInput(fields({ name: 'n', hostname: 'h', startupCommand: ' tmux attach || tmux ' }));
    expect(set.ok && set.input.startupCommand).toBe('tmux attach || tmux');
  });

  it('keeps identity/password/notes when provided', () => {
    const r = formToInput(
      fields({ name: 'n', hostname: 'h', identityFile: '~/.ssh/id', password: 's3cret', notes: 'prod box' })
    );
    expect(r.ok && r.input.identityFile).toBe('~/.ssh/id');
    expect(r.ok && r.input.password).toBe('s3cret');
    expect(r.ok && r.input.notes).toBe('prod box');
  });

  it('always emits a tags array (empty, not undefined)', () => {
    const r = formToInput(fields({ name: 'n', hostname: 'h', tags: '' }));
    expect(r.ok && r.input.tags).toEqual([]);
  });
});

describe('formFromHost', () => {
  it('seeds the editable fields and leaves secrets blank (the DTO omits them)', () => {
    const f = formFromHost(host({ name: 'db', hostname: '10.0.0.2', user: 'root', port: 2200, tags: ['prod', 'db'], notes: 'primary' }));
    expect(f.name).toBe('db');
    expect(f.hostname).toBe('10.0.0.2');
    expect(f.user).toBe('root');
    expect(f.port).toBe('2200');
    expect(f.tags).toBe('prod, db');
    expect(f.notes).toBe('primary');
    // Backend-only fields are never shown — blank means "keep the stored value".
    expect(f.identityFile).toBe('');
    expect(f.password).toBe('');
  });

  it('seeds the default connection path, blank when unset', () => {
    expect(formFromHost(host({ defaultPath: '/srv/app' })).defaultPath).toBe('/srv/app');
    expect(formFromHost(host({})).defaultPath).toBe('');
  });

  it('seeds the startup command, blank when unset', () => {
    expect(formFromHost(host({ startupCommand: 'sudo -i' })).startupCommand).toBe('sudo -i');
    expect(formFromHost(host({})).startupCommand).toBe('');
  });

  it('round-trips the observable fields back through formToInput', () => {
    const original = host({ name: 'db', hostname: '10.0.0.2', user: 'root', port: 2200, tags: ['ops'], notes: 'x' });
    const r = formToInput(formFromHost(original));
    expect(r.ok && r.input).toEqual({
      name: 'db',
      hostname: '10.0.0.2',
      user: 'root',
      port: 2200,
      identityFile: undefined,
      password: undefined,
      tags: ['ops'],
      notes: 'x',
      monitoring: 'ssh',
      monitorPort: undefined
    });
  });
});

describe('formToInput — monitoring mode', () => {
  it('defaults to ssh and sends no probe port', () => {
    const result = formToInput({ ...emptyForm(), name: 'web', hostname: '10.0.0.1' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input.monitoring).toBe('ssh');
      expect(result.input.monitorPort).toBeUndefined();
    }
  });

  it('carries a probe port for a reachability host', () => {
    const result = formToInput({
      ...emptyForm(),
      name: 'fw',
      hostname: '10.0.0.9',
      monitoring: 'tcpPort',
      monitorPort: '8443'
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input.monitoring).toBe('tcpPort');
      expect(result.input.monitorPort).toBe(8443);
    }
  });

  it('falls back to the host port when the probe port is blank', () => {
    const result = formToInput({ ...emptyForm(), name: 'fw', hostname: '10.0.0.9', monitoring: 'tcpPort' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.input.monitorPort).toBeUndefined();
  });

  it('rejects an out-of-range probe port', () => {
    for (const monitorPort of ['0', '99999', 'ssh']) {
      const result = formToInput({
        ...emptyForm(),
        name: 'fw',
        hostname: '10.0.0.9',
        monitoring: 'tcpPort',
        monitorPort
      });
      expect(result.ok).toBe(false);
    }
  });

  it('ignores a probe port left over from switching back to ssh', () => {
    const result = formToInput({
      ...emptyForm(),
      name: 'web',
      hostname: '10.0.0.1',
      monitoring: 'ssh',
      monitorPort: '8443'
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.input.monitorPort).toBeUndefined();
  });

  it('round-trips a reachability host through the edit form', () => {
    const fields = formFromHost(host({ monitoring: 'tcpPort', monitorPort: 8443 }));
    expect(fields.monitoring).toBe('tcpPort');
    expect(fields.monitorPort).toBe('8443');
  });
});

describe('folder', () => {
  it('is saved trimmed, blank meaning none, and comes back on edit', () => {
    const inFolder = formToInput(fields({ name: 'n', hostname: 'h', folder: ' Homelab ' }));
    expect(inFolder.ok && inFolder.input.folder).toBe('Homelab');
    const none = formToInput(fields({ name: 'n', hostname: 'h', folder: '  ' }));
    expect(none.ok && none.input.folder).toBeUndefined();
    expect(formFromHost(host({ folder: 'Homelab' })).folder).toBe('Homelab');
  });
});

describe('1Password reference', () => {
  it('passes the password reference through, trimmed, while the password is switched to 1Password', () => {
    const set = formToInput(fields({ name: 'n', hostname: 'h', passwordFrom1P: true, passwordRef: ' op://Servers/web-1/password ' }));
    expect(set.ok && set.input.passwordRef).toBe('op://Servers/web-1/password');
  });

  it('drops the password reference once switched back to typing', () => {
    const off = formToInput(fields({ name: 'n', hostname: 'h', passwordFrom1P: false, passwordRef: 'op://Servers/web-1/password' }));
    expect(off.ok && off.input.passwordRef).toBeUndefined();
  });

  it('refuses a field switched to 1Password that holds no reference', () => {
    const error = (field: string) => ({ ok: false, error: `${field}: 1Password reference must look like op://vault/item/field` });
    expect(formToInput(fields({ name: 'n', hostname: 'h', passwordFrom1P: true, passwordRef: 'hunter2' }))).toEqual(error('Password'));
    expect(formToInput(fields({ name: 'n', hostname: '10.0.0.1', hostnameFrom1P: true }))).toEqual(error('Hostname / IP'));
    expect(formToInput(fields({ name: 'n', hostname: 'h', user: '', userFrom1P: true }))).toEqual(error('User'));
  });

  it('keeps a hostname and user reference in the field itself', () => {
    const r = formToInput(
      fields({ name: 'n', hostname: 'op://Servers/web-1/hostname', hostnameFrom1P: true, user: 'op://Servers/web-1/username', userFrom1P: true })
    );
    expect(r.ok && [r.input.hostname, r.input.user]).toEqual(['op://Servers/web-1/hostname', 'op://Servers/web-1/username']);
  });

  it('takes the port from 1Password — the port keeps the default on disk', () => {
    const r = formToInput(fields({ name: 'n', hostname: 'h', port: '2222', portFrom1P: true, portRef: 'op://S/web-1/port' }));
    expect(r.ok && [r.input.port, r.input.portRef]).toEqual([22, 'op://S/web-1/port']);
    expect(formToInput(fields({ name: 'n', hostname: 'h', portFrom1P: true, portRef: '2222' }))).toEqual({
      ok: false,
      error: 'Port: 1Password reference must look like op://vault/item/field'
    });
    expect(formFromHost(host({ portRef: 'op://S/web-1/port' }))).toMatchObject({ portFrom1P: true, portRef: 'op://S/web-1/port' });
  });

  it('takes the default path from 1Password, the reference in the field itself', () => {
    const r = formToInput(fields({ name: 'n', hostname: 'h', defaultPath: '"op://S/web 1/path"', defaultPathFrom1P: true }));
    expect(r.ok && r.input.defaultPath).toBe('op://S/web 1/path');
    expect(formToInput(fields({ name: 'n', hostname: 'h', defaultPath: '/var/www', defaultPathFrom1P: true }))).toEqual({
      ok: false,
      error: 'Default path: 1Password reference must look like op://vault/item/field'
    });
    expect(formFromHost(host({ defaultPath: 'op://S/web-1/path' })).defaultPathFrom1P).toBe(true);
    expect(formFromHost(host({ defaultPath: '/var/www' })).defaultPathFrom1P).toBe(false);
  });

  it('seeds the edit form with the stored references, switched on', () => {
    const f = formFromHost(host({ passwordRef: 'op://a/b/c', hostname: 'op://a/b/host', user: 'deploy' }));
    expect(f).toMatchObject({ passwordRef: 'op://a/b/c', passwordFrom1P: true, hostnameFrom1P: true, userFrom1P: false });
  });
});
