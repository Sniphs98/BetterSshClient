import { describe, expect, it } from 'vitest';

import { addressLine, displayReference } from './onePasswordRef';

describe('displayReference', () => {
  it('shows a reference as its 1Password item, anything else as it is', () => {
    expect(displayReference('op://Servers/web-1/hostname')).toBe('‹web-1›');
    expect(displayReference('op://Servers/web-1/login/username')).toBe('‹web-1›');
    expect(displayReference('10.0.0.1')).toBe('10.0.0.1');
  });
});

describe('addressLine', () => {
  it('is the usual domain\\user@host:port without references', () => {
    expect(addressLine({ hostname: 'pc', port: 3389, user: 'admin', domain: 'CORP' }, 'pc')).toBe('CORP\\admin@pc:3389');
    expect(addressLine({ hostname: 'pc', port: 3389 }, 'pc')).toBe('pc:3389');
  });

  it('leaves out what comes from the same item as the address', () => {
    const all = { hostname: 'op://S/pc/host', portRef: 'op://S/pc/port', port: 3389, user: 'op://S/pc/user', domain: 'op://S/pc/domain' };
    expect(addressLine(all, '‹pc›')).toBe('‹pc›');
    expect(addressLine({ ...all, user: 'admin' }, '‹pc›')).toBe('admin@‹pc›');
  });

  it('names another item where a part comes from one', () => {
    expect(addressLine({ hostname: 'pc.lan', port: 22, portRef: 'op://S/ports/ssh', user: 'op://S/admins/user' }, 'pc.lan')).toBe(
      '‹admins›@pc.lan:‹ports›'
    );
  });
});
