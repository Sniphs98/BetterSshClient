import { describe, expect, it } from 'vitest';

import { displayReference } from './onePasswordRef';

describe('displayReference', () => {
  it('shows a reference as its 1Password item, anything else as it is', () => {
    expect(displayReference('op://Servers/web-1/hostname')).toBe('‹web-1›');
    expect(displayReference('op://Servers/web-1/login/username')).toBe('‹web-1›');
    expect(displayReference('10.0.0.1')).toBe('10.0.0.1');
  });
});
