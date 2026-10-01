import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadHosts, saveHosts } from '../core/config/hosts.js';
import { buildRdpProfilesBundle, parseRdpProfilesBundle, profileKey } from '../core/config/rdpProfileBundle.js';
import { loadRemoteDesktopConnections, saveRemoteDesktopConnections } from '../core/config/remoteDesktop.js';
import { buildSshHostsBundle, parseSshHostsBundle } from '../core/config/sshHostBundle.js';
import { defaultHost, type Host } from '../core/ssh/client.js';
import { applyImport, PendingImports } from './connectionBundles.js';

function host(name: string, overrides: Partial<Host> = {}): Host {
  return { ...defaultHost(), name, hostname: `${name}.example.com`, user: 'deploy', source: 'manual', ...overrides };
}

const ENV_KEYS = ['APPDATA', 'XDG_CONFIG_HOME', 'HOME', 'USERPROFILE'] as const;

describe('applyImport', () => {
  let tmp: string;
  const prev: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'remoty-bundle-'));
    for (const key of ENV_KEYS) {
      prev[key] = process.env[key];
      process.env[key] = tmp;
    }
  });

  afterEach(async () => {
    for (const key of ENV_KEYS) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
    await rm(tmp, { recursive: true, force: true });
  });

  it('round-trips SSH hosts through a file into hosts.toml', async () => {
    const bastion = host('bastion', { password: 'secret' });
    const web = host('web', { proxyJump: 'bastion', passwordRef: 'op://IT/web/password' });
    const file = parseSshHostsBundle(JSON.parse(JSON.stringify(buildSshHostsBundle([web], [bastion, web]))));

    const result = await applyImport({ kind: 'ssh', hosts: file.hosts }, {});

    expect(result).toEqual({ hosts: 2, profiles: 0 });
    const saved = await loadHosts();
    expect(saved.map((h) => h.name)).toEqual(['web', 'bastion']);
    expect(saved[0]).toMatchObject({ proxyJump: 'bastion', passwordRef: 'op://IT/web/password' });
    expect(saved[1].password).toBeUndefined();
  });

  it('imports RDP profiles with their tunnel host, following a rename', async () => {
    await saveHosts([host('bastion', { hostname: 'mine' })]);
    const file = parseRdpProfilesBundle(
      JSON.parse(
        JSON.stringify(
          buildRdpProfilesBundle(
            [{ id: 'x', name: 'ts01', protocol: 'rdp', hostname: 'ts01', port: 3389, viaHost: 'bastion', passwordRef: 'op://IT/ts01/password' }],
            [host('bastion')]
          )
        )
      )
    );

    const result = await applyImport({ kind: 'rdp', bundle: file }, { hosts: { bastion: { action: 'rename', name: 'bastion-it' } } });

    expect(result).toEqual({ hosts: 1, profiles: 1 });
    expect((await loadHosts()).map((h) => h.name)).toEqual(['bastion', 'bastion-it']);
    const [profile] = await loadRemoteDesktopConnections();
    expect(profile).toMatchObject({ name: 'ts01', viaHost: 'bastion-it', passwordRef: 'op://IT/ts01/password' });
  });

  it('writes nothing when a decision is refused', async () => {
    await saveHosts([host('bastion')]);
    await saveRemoteDesktopConnections([{ id: 'mine', name: 'ts01', protocol: 'rdp', hostname: 'old', port: 3389 }]);
    const file = parseRdpProfilesBundle(
      JSON.parse(
        JSON.stringify(
          buildRdpProfilesBundle([{ id: 'x', name: 'ts01', protocol: 'rdp', hostname: 'new', port: 3389, viaHost: 'bastion' }], [host('bastion', { hostname: 'b2' })])
        )
      )
    );

    // The host decision is fine, the profile one is missing.
    await expect(applyImport({ kind: 'rdp', bundle: file }, { hosts: { bastion: { action: 'overwrite' } } })).rejects.toThrow(/overwrite or rename/);
    expect((await loadHosts())[0].hostname).toBe('bastion.example.com');

    await applyImport({ kind: 'rdp', bundle: file }, { hosts: { bastion: { action: 'overwrite' } }, profiles: { [profileKey(0)]: { action: 'overwrite' } } });
    expect((await loadHosts())[0].hostname).toBe('b2');
    expect(await loadRemoteDesktopConnections()).toEqual([expect.objectContaining({ id: 'mine', hostname: 'new' })]);
  });
});

describe('PendingImports', () => {
  it('keeps the latest preview until it is discarded', () => {
    const pending = new PendingImports();
    const first = pending.add({ kind: 'ssh', hosts: [] });
    const second = pending.add({ kind: 'ssh', hosts: [] });
    expect(() => pending.get(first)).toThrow(/no longer open/);
    expect(pending.get(second)).toEqual({ kind: 'ssh', hosts: [] });
    pending.discard(second);
    expect(() => pending.get(second)).toThrow(/no longer open/);
  });
});
