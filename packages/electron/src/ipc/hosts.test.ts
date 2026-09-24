import { describe, expect, it } from 'vitest';

import { defaultHost, type Host } from '../core/ssh/client.js';
import type { HostInputDto } from '../dto.js';
import { removeHost, upsertHost } from './hosts.js';

// Ported from crates/omnyssh-gui/src/commands/hosts.rs's #[cfg(test)] module.

function input(name: string): HostInputDto {
  return { name, hostname: 'example.com', user: 'root', port: 22, tags: [] };
}

describe('upsertHost', () => {
  it('appends a new manual host', () => {
    const hosts: Host[] = [];
    upsertHost(hosts, input('web'), undefined);
    expect(hosts).toHaveLength(1);
    expect(hosts[0].name).toBe('web');
    expect(hosts[0].source).toBe('manual');
  });

  it('replaces editable fields in place', () => {
    const hosts: Host[] = [{ ...defaultHost(), name: 'web', hostname: 'old.example.com', notes: 'old', source: 'manual' }];
    const edit = { ...input('web'), hostname: 'new.example.com', notes: 'new' };
    upsertHost(hosts, edit, undefined);
    expect(hosts).toHaveLength(1);
    expect(hosts[0].hostname).toBe('new.example.com');
    expect(hosts[0].notes).toBe('new');
  });

  it('preserves secrets and metadata the form cannot see', () => {
    const hosts: Host[] = [
      {
        ...defaultHost(),
        name: 'web',
        password: 'keep-me',
        identityFile: '/keys/id',
        proxyJump: 'bastion',
        keySetupDate: '2026-01-01',
        passwordAuthDisabled: true,
        originalSshHost: 'web-old',
        source: 'manual'
      }
    ];
    upsertHost(hosts, input('web'), undefined);
    const h = hosts[0];
    expect(h.password).toBe('keep-me');
    expect(h.identityFile).toBe('/keys/id');
    expect(h.proxyJump).toBe('bastion');
    expect(h.keySetupDate).toBe('2026-01-01');
    expect(h.passwordAuthDisabled).toBe(true);
    expect(h.originalSshHost).toBe('web-old');
  });

  it('adopting an ssh-config host keeps its bastion and key', () => {
    const imported: Host = {
      ...defaultHost(),
      name: 'internal',
      hostname: '10.0.0.9',
      proxyJump: 'public-proxy',
      identityFile: '/keys/id_ed25519',
      source: 'ssh_config'
    };
    const hosts: Host[] = [];
    const edit = { ...input('internal'), notes: 'adopted' };
    upsertHost(hosts, edit, imported);

    expect(hosts).toHaveLength(1);
    const h = hosts[0];
    expect(h.source).toBe('manual');
    expect(h.proxyJump).toBe('public-proxy');
    expect(h.identityFile).toBe('/keys/id_ed25519');
    expect(h.notes).toBe('adopted');
    expect(h.originalSshHost).toBe('internal');
  });

  it('an explicit identity wins over the imported one', () => {
    const imported: Host = { ...defaultHost(), name: 'internal', identityFile: '/keys/from-ssh-config', source: 'ssh_config' };
    const hosts: Host[] = [];
    const edit = { ...input('internal'), identityFile: '/keys/typed-by-hand' };
    upsertHost(hosts, edit, imported);
    expect(hosts[0].identityFile).toBe('/keys/typed-by-hand');
  });

  it('keeps a monitoring mode the payload left out', () => {
    const hosts: Host[] = [{ ...defaultHost(), name: 'fw', monitoring: 'tcp_port', monitorPort: 8443, source: 'manual' }];
    upsertHost(hosts, input('fw'), undefined);
    expect(hosts[0].monitoring).toBe('tcp_port');
    expect(hosts[0].monitorPort).toBe(8443);
  });

  it('applies a monitoring mode the payload carries', () => {
    const hosts: Host[] = [{ ...defaultHost(), name: 'fw', monitoring: 'tcp_port', monitorPort: 8443, source: 'manual' }];
    const backToSsh = { ...input('fw'), monitoring: 'ssh' as const };
    upsertHost(hosts, backToSsh, undefined);
    expect(hosts[0].monitoring).toBe('ssh');
  });

  it('overwrites a secret when a new one is provided', () => {
    const hosts: Host[] = [{ ...defaultHost(), name: 'web', password: 'old', source: 'manual' }];
    const edit = { ...input('web'), password: 'rotated' };
    upsertHost(hosts, edit, undefined);
    expect(hosts[0].password).toBe('rotated');
  });
});

describe('removeHost', () => {
  it('drops only the named host', () => {
    const hosts: Host[] = [
      { ...defaultHost(), name: 'a' },
      { ...defaultHost(), name: 'b' }
    ];
    removeHost(hosts, 'a');
    expect(hosts).toHaveLength(1);
    expect(hosts[0].name).toBe('b');
  });

  it('is a no-op for a missing name', () => {
    const hosts: Host[] = [{ ...defaultHost(), name: 'a' }];
    removeHost(hosts, 'ghost');
    expect(hosts).toHaveLength(1);
    expect(hosts[0].name).toBe('a');
  });
});
