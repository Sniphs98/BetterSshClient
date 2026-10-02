import { describe, expect, it } from 'vitest';

import { defaultHost, type Host } from '../ssh/client.js';
import type { RemoteDesktopConnection } from './remoteDesktop.js';
import {
  buildRdpProfilesBundle,
  mergeRdpImport,
  missingTunnelHosts,
  parseRdpProfilesBundle,
  previewRdpImport,
  profileKey,
  type RdpProfilesBundle
} from './rdpProfileBundle.js';
import { mergeHostImport } from './sshHostBundle.js';

function profile(overrides: Partial<RemoteDesktopConnection> = {}): RemoteDesktopConnection {
  return { id: 'c1', name: 'office-pc', protocol: 'rdp', hostname: '10.0.0.5', port: 3389, ...overrides };
}

function host(name: string, overrides: Partial<Host> = {}): Host {
  return { ...defaultHost(), name, hostname: `${name}.example.com`, user: 'deploy', source: 'manual', ...overrides };
}

function roundTrip(selected: RemoteDesktopConnection[], known: Host[] = []): RdpProfilesBundle {
  return parseRdpProfilesBundle(JSON.parse(JSON.stringify(buildRdpProfilesBundle(selected, known))));
}

describe('buildRdpProfilesBundle', () => {
  it('never writes the password or the id, and says a password was left out', () => {
    const c = profile({ id: 'local-id', password: 'hunter2' });
    const json = JSON.stringify(buildRdpProfilesBundle([c], []));
    expect(json).not.toContain('hunter2');
    expect(json).not.toContain('local-id');
    expect(roundTrip([c]).profiles[0].passwordOmitted).toBe(true);
  });

  it('keeps 1Password references and the display settings', () => {
    const c = profile({
      username: 'op://IT/ts01/username',
      domain: 'CORP',
      passwordRef: 'op://IT/ts01/password',
      portRef: 'op://IT/ts01/port',
      display: 'window',
      width: 1600,
      height: 900,
      clipboard: true,
      drives: false,
      audio: 'remote',
      dynamicResolution: true,
      folder: 'Kunde A'
    });
    const [out] = roundTrip([c]).profiles;
    const { id: _id, ...expected } = c;
    expect(out).toEqual(expected);
  });

  it('carries the SSH host a profile tunnels through, with its jump host', () => {
    const outer = host('outer');
    const bastion = host('bastion', { proxyJump: 'outer', password: 'x' });
    const bundle = roundTrip([profile({ viaHost: 'bastion' })], [outer, bastion, host('unrelated')]);
    expect(bundle.tunnelHosts.map((h) => h.name)).toEqual(['bastion', 'outer']);
    expect(JSON.stringify(bundle)).not.toContain('"x"');
  });

  it('names a renamed ~/.ssh/config import by its current name', () => {
    const bundle = roundTrip([profile({ viaHost: 'bastion' })], [host('Bastion', { originalSshHost: 'bastion' })]);
    expect(bundle.profiles[0].viaHost).toBe('Bastion');
    expect(bundle.tunnelHosts.map((h) => h.name)).toEqual(['Bastion']);
  });
});

describe('parseRdpProfilesBundle', () => {
  const minimal = { name: 'pc', protocol: 'rdp', hostname: 'h', port: 3389 };
  const file = (profiles: unknown[], tunnelHosts?: unknown[]): unknown => ({ kind: 'remoty-rdp-profiles', version: 1, profiles, tunnelHosts });

  it('ignores a password someone put into the file', () => {
    expect(JSON.stringify(parseRdpProfilesBundle(file([{ ...minimal, password: 'hunter2' }])))).not.toContain('hunter2');
  });

  it('rejects other files and bad fields', () => {
    expect(() => parseRdpProfilesBundle({ kind: 'remoty-ssh-hosts', version: 1, hosts: [] })).toThrow(/not a Remoty RDP profiles file/);
    expect(() => parseRdpProfilesBundle(file([{ ...minimal, protocol: 'ftp' }]))).toThrow('file.profiles[0].protocol');
    expect(() => parseRdpProfilesBundle(file([{ ...minimal, port: 70000 }]))).toThrow('file.profiles[0].port');
    expect(() => parseRdpProfilesBundle(file([{ ...minimal, passwordRef: 'nope' }]))).toThrow(/1Password reference/);
    expect(() => parseRdpProfilesBundle(file([minimal], [{ name: 'b' }]))).toThrow('file.tunnelHosts[0]');
  });

  it('drops display settings it does not understand, as for a hand-edited remote-desktop.toml', () => {
    const [out] = parseRdpProfilesBundle(file([{ ...minimal, display: 'huge', width: 5 }])).profiles;
    expect(out.display).toBeUndefined();
    expect(out.width).toBeUndefined();
  });
});

describe('previewRdpImport', () => {
  it('flags a profile whose name is taken, and lists the tunnel hosts', () => {
    const bundle = roundTrip(
      [profile({ viaHost: 'bastion', username: 'op://IT/pc/username', passwordRef: 'op://IT/pc/password' }), profile({ name: 'new' })],
      [host('bastion')]
    );
    const preview = previewRdpImport(bundle, [profile({ hostname: 'elsewhere' })], [host('bastion')]);
    expect(preview.profiles[0]).toMatchObject({ key: profileKey(0), conflict: true, suggestedName: 'office-pc (2)', defaultAction: 'rename', onePassword: true });
    expect(preview.profiles[0].references).toEqual(['op://IT/pc/password', 'op://IT/pc/username']);
    expect(preview.profiles[1]).toMatchObject({ conflict: false });
    expect(preview.tunnelHosts).toEqual([expect.objectContaining({ name: 'bastion', conflict: true, defaultAction: 'overwrite', usedBy: ['office-pc'] })]);
  });

  it('names a tunnel host neither the file nor this machine has', () => {
    const bundle = roundTrip([profile({ viaHost: 'gone' })]);
    expect(missingTunnelHosts(bundle, [])).toEqual(['gone']);
    expect(missingTunnelHosts(bundle, [host('gone')])).toEqual([]);
  });
});

describe('mergeRdpImport', () => {
  it('adds new profiles under fresh ids', () => {
    const out = mergeRdpImport(roundTrip([profile()]), {}, [], new Map());
    expect(out).toHaveLength(1);
    expect(out[0].id).not.toBe('c1');
    expect(out[0].password).toBeUndefined();
  });

  it('overwrites, keeping the id and the stored password', () => {
    const mine = profile({ id: 'mine', hostname: 'old', password: 'secret' });
    const out = mergeRdpImport(roundTrip([profile({ hostname: 'new' })]), { [profileKey(0)]: { action: 'overwrite' } }, [mine], new Map());
    expect(out).toEqual([expect.objectContaining({ id: 'mine', hostname: 'new', password: 'secret' })]);
  });

  it('renames, and refuses a name that is taken', () => {
    const mine = profile({ id: 'mine' });
    const bundle = roundTrip([profile()]);
    const out = mergeRdpImport(bundle, { [profileKey(0)]: { action: 'rename', name: 'office-pc 2' } }, [mine], new Map());
    expect(out.map((c) => c.name)).toEqual(['office-pc', 'office-pc 2']);
    expect(() => mergeRdpImport(bundle, { [profileKey(0)]: { action: 'rename', name: 'office-pc' } }, [mine], new Map())).toThrow(/already exists/);
    expect(() => mergeRdpImport(bundle, {}, [mine], new Map())).toThrow(/overwrite or rename/);
  });

  it('follows a renamed tunnel host', () => {
    const bundle = roundTrip([profile({ viaHost: 'bastion' })], [host('bastion')]);
    const mine = host('bastion', { hostname: 'other' });
    const hosts = mergeHostImport(bundle.tunnelHosts, { bastion: { action: 'rename', name: 'bastion-2' } }, [mine], [mine]);
    const [out] = mergeRdpImport(bundle, {}, [], hosts.names);
    expect(out.viaHost).toBe('bastion-2');
  });
});
