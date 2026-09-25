import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { discoverPlugins } from './loader.js';
import { PLUGIN_API_VERSION } from './manifest.js';

let dir: string;

async function plugin(folder: string, manifest: unknown, main: string | null = 'bssh.log("hi")'): Promise<void> {
  await mkdir(join(dir, folder), { recursive: true });
  await writeFile(join(dir, folder, 'plugin.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  if (main !== null) await writeFile(join(dir, folder, 'main.js'), main);
}

const manifest = (id: string) => ({ id, name: id, version: '1.0.0', apiVersion: PLUGIN_API_VERSION, main: 'main.js', permissions: [] });

describe('discoverPlugins', () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bssh-plugins-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('finds valid plugins, in folder order', async () => {
    await plugin('b-plugin', manifest('b-plugin'));
    await plugin('a-plugin', manifest('a-plugin'));
    const found = await discoverPlugins(dir);
    expect(found.map((p) => p.manifest?.id)).toEqual(['a-plugin', 'b-plugin']);
  });

  it('reports a broken plugin next to the good ones instead of failing', async () => {
    await plugin('good', manifest('good'));
    await plugin('bad-json', '{ not json');
    await plugin('no-main', manifest('no-main'), null);
    await plugin('wrong-id', manifest('other'));
    const found = await discoverPlugins(dir);
    expect(found.find((p) => p.folder === 'good')?.manifest).toBeDefined();
    expect(found.find((p) => p.folder === 'bad-json')?.error).toContain('unreadable');
    expect(found.find((p) => p.folder === 'no-main')?.error).toContain('not found');
    expect(found.find((p) => p.folder === 'wrong-id')?.error).toContain('does not match');
  });

  it('means no plugins when the directory does not exist', async () => {
    expect(await discoverPlugins(join(dir, 'missing'))).toEqual([]);
  });
});
