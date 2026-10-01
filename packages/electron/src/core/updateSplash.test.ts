import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clearUpdateSplash, updateFlagPath } from './updateSplash.js';

describe('clearUpdateSplash', () => {
  let dir: string;
  beforeEach(async () => (dir = await mkdtemp(join(tmpdir(), 'remoty-splash-'))));
  afterEach(async () => rm(dir, { recursive: true, force: true }));

  it("removes the flag an update left, so its window closes; nothing to do otherwise", async () => {
    expect(clearUpdateSplash(dir)).toBe(false);
    await writeFile(updateFlagPath(dir), 'shown');
    expect(clearUpdateSplash(dir)).toBe(true);
    expect(existsSync(updateFlagPath(dir))).toBe(false);
  });
});
