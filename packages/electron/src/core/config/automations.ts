import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parse, stringify } from 'smol-toml';

import { automationsConfigPath } from './platform.js';
import type { Automation, AutomationKind } from '../automation/types.js';

/** `automations.toml` I/O — the reusable Automation library (Flows live separately,
 *  in `flows.ts`/`flows.toml`). */

interface AutomationsFile {
  automations: Automation[];
}

function automationFromToml(raw: Record<string, unknown>): Automation {
  if (typeof raw.id !== 'string') throw new Error('automation is missing "id"');
  if (typeof raw.name !== 'string') throw new Error(`automation "${raw.id}" is missing "name"`);
  const kind: AutomationKind | undefined = raw.kind === 'local' ? 'local' : raw.kind === 'remote' ? 'remote' : undefined;
  if (kind === undefined) throw new Error(`automation "${raw.name}" has an invalid kind`);
  if (typeof raw.command !== 'string') throw new Error(`automation "${raw.name}" is missing "command"`);
  if (typeof raw.timeoutSecs !== 'number') throw new Error(`automation "${raw.name}" is missing "timeoutSecs"`);
  return {
    id: raw.id,
    name: raw.name,
    kind,
    command: raw.command,
    timeoutSecs: raw.timeoutSecs
  };
}

function automationToToml(automation: Automation): Record<string, unknown> {
  return {
    id: automation.id,
    name: automation.name,
    kind: automation.kind,
    command: automation.command,
    timeoutSecs: automation.timeoutSecs
  };
}

function parseAutomationsFile(content: string): AutomationsFile {
  if (content.trim() === '') return { automations: [] };
  const raw = parse(content) as { automations?: unknown };
  if (raw.automations === undefined) return { automations: [] };
  if (!Array.isArray(raw.automations)) throw new Error('automations.toml: "automations" must be an array');
  return { automations: raw.automations.map((a) => automationFromToml(a as Record<string, unknown>)) };
}

/** Loads the Automation library from `~/.config/omnyssh/automations.toml` (or
 *  `overridePath`, for tests). Returns `[]` if the file does not exist yet. */
export async function loadAutomations(overridePath?: string): Promise<Automation[]> {
  const path = overridePath ?? automationsConfigPath();
  if (!existsSync(path)) return [];
  const content = await readFile(path, 'utf-8');
  return parseAutomationsFile(content).automations;
}

/** Persists the Automation library to `~/.config/omnyssh/automations.toml` (or
 *  `overridePath`, for tests), atomically (tmp file + rename), `chmod 600` on
 *  non-Windows. */
export async function saveAutomations(automations: Automation[], overridePath?: string): Promise<void> {
  const path = overridePath ?? automationsConfigPath();
  await mkdir(dirname(path), { recursive: true });

  const content = stringify({ automations: automations.map(automationToToml) });

  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, content, 'utf-8');
  try {
    await rename(tmpPath, path);
  } catch (err) {
    await rm(tmpPath, { force: true });
    throw err;
  }
  if (process.platform !== 'win32') {
    await chmod(path, 0o600).catch(() => {});
  }
}
