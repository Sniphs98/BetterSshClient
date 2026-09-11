import { describe, expect, it } from 'vitest';

import { isNewer } from './update.js';

// Ported from crates/omnyssh-core/src/update.rs's `is_newer_compares_semver` test.

describe('isNewer', () => {
  it('compares semver correctly', () => {
    expect(isNewer('1.0.2', '1.0.1')).toBe(true);
    expect(isNewer('1.1.0', '1.0.9')).toBe(true);
    expect(isNewer('2.0.0', '1.9.9')).toBe(true);
    expect(isNewer('1.0.1', '1.0.1')).toBe(false);
    expect(isNewer('1.0.0', '1.0.1')).toBe(false);
  });

  it('never nags on an unparseable version', () => {
    expect(isNewer('not-a-version', '1.0.1')).toBe(false);
    expect(isNewer('1.0.2', 'garbage')).toBe(false);
  });
});
