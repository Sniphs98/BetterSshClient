import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { appConfigDir } from '../config/platform.js';
import { parseManifest, type PluginManifest } from './manifest.js';

/** `<config dir>/plugins` — one folder per plugin. */
export function pluginsDir(): string {
  return join(appConfigDir(), 'plugins');
}

/** One folder found in the plugins directory: its manifest, or why it can't be used. */
export type FoundPlugin =
  | { folder: string; dir: string; manifest: PluginManifest; error?: undefined; readme?: string }
  | { folder: string; dir: string; manifest?: undefined; error: string; readme?: string };

/** The plugin's own documentation: a README.md next to its plugin.json, any case. */
async function findReadme(pluginDir: string): Promise<string | undefined> {
  try {
    return (await readdir(pluginDir)).find((f) => f.toLowerCase() === 'readme.md');
  } catch {
    return undefined;
  }
}

/**
 * Reads every plugin folder. A broken plugin (unreadable or invalid
 * `plugin.json`, missing main script) is returned with its error rather than
 * thrown, so one bad plugin never hides the others. A missing plugins
 * directory simply means no plugins.
 */
export async function discoverPlugins(dir: string = pluginsDir()): Promise<FoundPlugin[]> {
  let entries: string[];
  try {
    entries = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }

  const found: FoundPlugin[] = [];
  for (const folder of entries.sort()) {
    const pluginDir = join(dir, folder);
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(join(pluginDir, 'plugin.json'), 'utf-8'));
    } catch (e) {
      found.push({ folder, dir: pluginDir, error: `plugin.json unreadable: ${(e as Error).message}` });
      continue;
    }
    const result = parseManifest(raw, folder);
    if (!result.ok) {
      found.push({ folder, dir: pluginDir, error: result.error });
      continue;
    }
    try {
      if (!(await stat(join(pluginDir, result.manifest.main))).isFile()) throw new Error('not a file');
    } catch {
      found.push({ folder, dir: pluginDir, error: `main script "${result.manifest.main}" not found` });
      continue;
    }
    found.push({ folder, dir: pluginDir, manifest: result.manifest, readme: await findReadme(pluginDir) });
  }
  return found;
}
