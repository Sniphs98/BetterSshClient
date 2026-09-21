import { describe, expect, it } from 'vitest';
import { removeRemoteDesktopConnection, upsertRemoteDesktopConnection } from './remoteDesktop.js';
import type { RemoteDesktopConnection } from '../core/config/remoteDesktop.js';
import type { RemoteDesktopConnectionInputDto } from '../dto.js';

function input(overrides: Partial<RemoteDesktopConnectionInputDto> = {}): RemoteDesktopConnectionInputDto {
  return { id: 'c1', name: 'office-pc', protocol: 'rdp', hostname: '10.0.0.5', port: 3389, ...overrides };
}

describe('upsertRemoteDesktopConnection', () => {
  it('appends a new connection', () => {
    const connections: RemoteDesktopConnection[] = [];
    upsertRemoteDesktopConnection(connections, input());
    expect(connections).toHaveLength(1);
  });

  it('replaces an existing connection by id, not name', () => {
    const connections = [{ id: 'c1', name: 'Old name', protocol: 'rdp' as const, hostname: 'h', port: 3389 }];
    upsertRemoteDesktopConnection(connections, input({ id: 'c1', name: 'New name' }));
    expect(connections).toHaveLength(1);
    expect(connections[0].name).toBe('New name');
  });

  it('a different id with the same name is a separate entry', () => {
    const connections = [{ id: 'c1', name: 'office-pc', protocol: 'rdp' as const, hostname: 'h', port: 3389 }];
    upsertRemoteDesktopConnection(connections, input({ id: 'c2' }));
    expect(connections).toHaveLength(2);
  });

  it('a blank password on edit preserves the previously stored one', () => {
    const connections = [
      { id: 'c1', name: 'office-pc', protocol: 'rdp' as const, hostname: 'h', port: 3389, password: 'secret' }
    ];
    upsertRemoteDesktopConnection(connections, input({ password: undefined }));
    expect(connections[0].password).toBe('secret');
  });

  it('a provided password overwrites the old one', () => {
    const connections = [
      { id: 'c1', name: 'office-pc', protocol: 'rdp' as const, hostname: 'h', port: 3389, password: 'old' }
    ];
    upsertRemoteDesktopConnection(connections, input({ password: 'new' }));
    expect(connections[0].password).toBe('new');
  });
});

describe('removeRemoteDesktopConnection', () => {
  it('removes a connection by id', () => {
    const connections = [{ id: 'c1', name: 'office-pc', protocol: 'rdp' as const, hostname: 'h', port: 3389 }];
    removeRemoteDesktopConnection(connections, 'c1');
    expect(connections).toHaveLength(0);
  });

  it('a missing id is a no-op, not an error', () => {
    const connections = [{ id: 'c1', name: 'office-pc', protocol: 'rdp' as const, hostname: 'h', port: 3389 }];
    removeRemoteDesktopConnection(connections, 'ghost');
    expect(connections).toHaveLength(1);
  });
});
