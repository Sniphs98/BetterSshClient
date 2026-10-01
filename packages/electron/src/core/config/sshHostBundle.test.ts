import { describe, expect, it } from 'vitest';

import { defaultHost, type Host } from '../ssh/client.js';
import {
  buildSshHostsBundle,
  mergeHostImport,
  parseSshHostsBundle,
  previewHostImport,
  type BundledHost
} from './sshHostBundle.js';

function host(name: string, overrides: Partial<Host> = {}): Host {
  return { ...defaultHost(), name, hostname: `${name}.example.com`, user: 'deploy', source: 'manual', ...overrides };
}

/** What a file looks like after it was written out and read back in. */
function roundTrip(selected: Host[], known: Host[]): BundledHost[] {
  return parseSshHostsBundle(JSON.parse(JSON.stringify(buildSshHostsBundle(selected, known)))).hosts;
}

describe('buildSshHostsBundle', () => {
  it('never writes a password or a key path, and says which were left out', () => {
    const web = host('web', { password: 'hunter2', identityFile: '~/.ssh/id_ed25519', keySetupDate: '2026-01-01' });
    const json = JSON.stringify(buildSshHostsBundle([web], [web]));
    expect(json).not.toContain('hunter2');
    expect(json).not.toContain('id_ed25519');
    expect(json).not.toContain('2026-01-01');
    const [out] = roundTrip([web], [web]);
    expect(out.passwordOmitted).toBe(true);
    expect(out.keyOmitted).toBe(true);
  });

  it('keeps 1Password references exactly as they are', () => {
    const web = host('web', {
      hostname: 'op://IT/web one/hostname',
      user: 'op://IT/web one/username',
      passwordRef: 'op://IT/web one/password',
      portRef: 'op://IT/web one/port'
    });
    const [out] = roundTrip([web], [web]);
    expect(out).toMatchObject({
      hostname: 'op://IT/web one/hostname',
      user: 'op://IT/web one/username',
      passwordRef: 'op://IT/web one/password',
      portRef: 'op://IT/web one/port'
    });
  });

  it('keeps everything the form edits', () => {
    const web = host('web', {
      port: 2222,
      tags: ['prod'],
      notes: 'n',
      folder: 'Prod',
      monitoring: 'tcp_port',
      monitorPort: 443,
      defaultPath: '/srv',
      startupCommand: 'sudo -i'
    });
    const [out] = roundTrip([web], [web]);
    expect(out).toEqual({
      name: 'web',
      hostname: 'web.example.com',
      user: 'deploy',
      port: 2222,
      tags: ['prod'],
      notes: 'n',
      folder: 'Prod',
      monitoring: 'tcpPort',
      monitorPort: 443,
      defaultPath: '/srv',
      startupCommand: 'sudo -i'
    });
  });

  it('brings along the jump hosts a host goes through, nested ones too, each once', () => {
    const outer = host('outer');
    const bastion = host('bastion', { proxyJump: 'outer' });
    const web = host('web', { proxyJump: 'ops@bastion:2222' });
    const db = host('db', { proxyJump: 'bastion,literal.example.com' });
    const other = host('other');
    const names = roundTrip([web, db], [outer, bastion, web, db, other]).map((h) => h.name);
    expect(names).toEqual(['web', 'bastion', 'outer', 'db']);
  });

  it('names a renamed ~/.ssh/config import by its current name in ProxyJump', () => {
    const bastion = host('Bastion (prod)', { originalSshHost: 'bastion' });
    const web = host('web', { proxyJump: 'ops@bastion:2222' });
    const out = roundTrip([web], [bastion, web]);
    expect(out.map((h) => h.name)).toEqual(['web', 'Bastion (prod)']);
    expect(out[0].proxyJump).toBe('ops@Bastion (prod):2222');
  });
});

describe('parseSshHostsBundle', () => {
  const file = (hosts: unknown[]): unknown => ({ kind: 'remoty-ssh-hosts', version: 1, hosts });
  const minimal = { name: 'web', hostname: 'h', user: 'u', port: 22 };

  it('ignores a password someone put into the file', () => {
    const [out] = parseSshHostsBundle(file([{ ...minimal, password: 'hunter2', identityFile: '/k' }])).hosts;
    expect(JSON.stringify(out)).not.toContain('hunter2');
    expect(JSON.stringify(out)).not.toContain('/k');
  });

  it('rejects something that is not a Remoty SSH hosts file', () => {
    expect(() => parseSshHostsBundle({ kind: 'remoty-automation', version: 1 })).toThrow(/not a Remoty SSH hosts file/);
    expect(() => parseSshHostsBundle([])).toThrow();
  });

  it('rejects a file from a newer format', () => {
    expect(() => parseSshHostsBundle({ kind: 'remoty-ssh-hosts', version: 2, hosts: [] })).toThrow(/newer version/);
  });

  it('says which field is wrong', () => {
    expect(() => parseSshHostsBundle(file([{ ...minimal, port: 0 }]))).toThrow('file.hosts[0].port');
    expect(() => parseSshHostsBundle(file([{ ...minimal, name: ' ' }]))).toThrow('file.hosts[0].name');
    expect(() => parseSshHostsBundle(file([{ ...minimal, passwordRef: 'hunter2' }]))).toThrow(/1Password reference/);
    expect(() => parseSshHostsBundle(file([minimal, minimal]))).toThrow(/twice/);
  });

  it('cleans up a quoted 1Password reference', () => {
    const [out] = parseSshHostsBundle(file([{ ...minimal, passwordRef: '"op://IT/web one/password"' }])).hosts;
    expect(out.passwordRef).toBe('op://IT/web one/password');
  });
});

describe('previewHostImport', () => {
  it('flags conflicts and offers a free name', () => {
    const existing = [host('web'), host('web (2)')];
    const bundled = roundTrip([host('web', { hostname: 'other' }), host('db')], [host('web', { hostname: 'other' }), host('db')]);
    const [web, db] = previewHostImport(bundled, existing);
    expect(web).toMatchObject({ conflict: true, suggestedName: 'web (3)', defaultAction: 'rename' });
    expect(db).toMatchObject({ conflict: false, suggestedName: 'db' });
  });

  it('suggests overwriting when it is the same machine', () => {
    const [web] = previewHostImport(roundTrip([host('web')], [host('web')]), [host('web')]);
    expect(web.defaultAction).toBe('overwrite');
  });

  it('notes 1Password, a password to enter again and who goes through a jump host', () => {
    const bastion = host('bastion', { password: 'x' });
    const web = host('web', { passwordRef: 'op://IT/web/password', password: 'y', proxyJump: 'bastion' });
    const [w, b] = previewHostImport(roundTrip([web], [bastion, web]), []);
    expect(w).toMatchObject({ onePassword: true, references: ['op://IT/web/password'], passwordOmitted: false });
    expect(b).toMatchObject({ onePassword: false, references: [], passwordOmitted: true, usedBy: ['web'] });
  });
});

describe('mergeHostImport', () => {
  it('adds new hosts as manual ones', () => {
    const { manual } = mergeHostImport(roundTrip([host('web')], [host('web')]), {}, [], []);
    expect(manual).toHaveLength(1);
    expect(manual[0]).toMatchObject({ name: 'web', source: 'manual', monitoring: 'ssh' });
    expect(manual[0].password).toBeUndefined();
  });

  it('needs a decision for a conflict', () => {
    expect(() => mergeHostImport(roundTrip([host('web')], [host('web')]), {}, [host('web')], [host('web')])).toThrow(
      /overwrite or rename/
    );
  });

  it('overwrites, keeping what only this machine knows', () => {
    const mine = host('web', {
      hostname: 'old',
      password: 'secret',
      identityFile: '~/.ssh/id',
      keySetupDate: '2026-01-01',
      passwordAuthDisabled: true,
      originalSshHost: 'web'
    });
    const { manual } = mergeHostImport(
      roundTrip([host('web', { hostname: 'new', notes: 'from file' })], [host('web', { hostname: 'new', notes: 'from file' })]),
      { web: { action: 'overwrite' } },
      [mine],
      [mine]
    );
    expect(manual).toHaveLength(1);
    expect(manual[0]).toMatchObject({
      hostname: 'new',
      notes: 'from file',
      password: 'secret',
      identityFile: '~/.ssh/id',
      keySetupDate: '2026-01-01',
      passwordAuthDisabled: true,
      originalSshHost: 'web'
    });
  });

  it('overwriting an ~/.ssh/config import adopts it', () => {
    const imported = host('web', { source: 'ssh_config', identityFile: '~/.ssh/work' });
    const { manual } = mergeHostImport(roundTrip([host('web')], [host('web')]), { web: { action: 'overwrite' } }, [], [imported]);
    expect(manual).toEqual([expect.objectContaining({ name: 'web', source: 'manual', originalSshHost: 'web', identityFile: '~/.ssh/work' })]);
  });

  it('renames, and ProxyJump follows the rename', () => {
    const bastion = host('bastion');
    const web = host('web', { proxyJump: 'ops@bastion:2222,bastion' });
    const mine = host('bastion', { hostname: 'somewhere-else' });
    const { manual, names } = mergeHostImport(
      roundTrip([web], [bastion, web]),
      { bastion: { action: 'rename', name: 'bastion-b' } },
      [mine],
      [mine]
    );
    expect(manual.map((h) => h.name)).toEqual(['bastion', 'web', 'bastion-b']);
    expect(manual[1].proxyJump).toBe('ops@bastion-b:2222,bastion-b');
    expect(names.get('bastion')).toBe('bastion-b');
  });

  it('refuses a rename to a name that is taken or empty', () => {
    const bundled = roundTrip([host('web'), host('db')], [host('web'), host('db')]);
    const existing = [host('web'), host('api')];
    expect(() => mergeHostImport(bundled, { web: { action: 'rename', name: 'api' } }, existing, existing)).toThrow(/already exists/);
    expect(() => mergeHostImport(bundled, { web: { action: 'rename', name: 'db' } }, existing, existing)).toThrow(/already exists/);
    expect(() => mergeHostImport(bundled, { web: { action: 'rename', name: ' ' } }, existing, existing)).toThrow(/empty/);
  });
});
