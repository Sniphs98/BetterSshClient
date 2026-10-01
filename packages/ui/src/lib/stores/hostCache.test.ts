import { describe, expect, it } from 'vitest';
import { nextCacheEntry } from './hostCache';

describe('nextCacheEntry', () => {
  it('stores the first sample', () => {
    expect(nextCacheEntry(undefined, 'Ubuntu', 1_000)).toEqual({ osInfo: 'Ubuntu', lastSeen: 1_000 });
  });

  it('skips a sample that changes nothing within the last-seen resolution', () => {
    expect(nextCacheEntry({ osInfo: 'Ubuntu', lastSeen: 1_000 }, null, 30_000)).toBeUndefined();
  });

  it('refreshes last-seen once the resolution has passed, keeping the known OS', () => {
    expect(nextCacheEntry({ osInfo: 'Ubuntu', lastSeen: 1_000 }, null, 61_000)).toEqual({
      osInfo: 'Ubuntu',
      lastSeen: 61_000
    });
  });

  it('stores a changed OS straight away', () => {
    expect(nextCacheEntry({ osInfo: 'Ubuntu', lastSeen: 1_000 }, 'Debian', 2_000)).toEqual({
      osInfo: 'Debian',
      lastSeen: 2_000
    });
  });
});
