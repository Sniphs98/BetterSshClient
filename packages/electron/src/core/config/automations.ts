import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parse, stringify } from 'smol-toml';

import { automationsConfigPath } from './platform.js';
import type { Automation, AutomationEdge, AutomationNode, AutomationParam, AutomationParamKind, NodeTarget } from '../automation/types.js';

/** `automations.toml` I/O — Automations wire Snippets (loaded separately, from
 *  `snippets.ts`/`snippets.toml`) together into a graph. Mirrors
 *  `snippets.ts`'s shape, one level deeper (an automation nests its nodes and edges). */

interface AutomationsFile {
  automations: Automation[];
}

function automationNodeFromToml(raw: Record<string, unknown>, automationName: string): AutomationNode {
  if (typeof raw.id !== 'string') throw new Error(`automation "${automationName}" has a node missing "id"`);
  if (typeof raw.snippetId !== 'string') throw new Error(`automation "${automationName}" node "${raw.id}" is missing "snippetId"`);
  if (typeof raw.label !== 'string') throw new Error(`automation "${automationName}" node "${raw.id}" is missing "label"`);
  const target: NodeTarget | undefined = raw.target === 'local' ? 'local' : raw.target === 'remote' ? 'remote' : undefined;
  if (target === undefined) throw new Error(`automation "${automationName}" node "${raw.id}" has an invalid target`);
  const position =
    raw.position !== undefined && typeof raw.position === 'object' && raw.position !== null
      ? (raw.position as { x?: unknown; y?: unknown })
      : undefined;
  return {
    id: raw.id,
    snippetId: raw.snippetId,
    label: raw.label,
    continueOnError: raw.continueOnError === true,
    target,
    position:
      position !== undefined && typeof position.x === 'number' && typeof position.y === 'number'
        ? { x: position.x, y: position.y }
        : undefined
  };
}

function automationNodeToToml(node: AutomationNode): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: node.id,
    snippetId: node.snippetId,
    label: node.label,
    continueOnError: node.continueOnError,
    target: node.target
  };
  if (node.position !== undefined) out.position = { x: node.position.x, y: node.position.y };
  return out;
}

function automationEdgeFromToml(raw: Record<string, unknown>, automationName: string): AutomationEdge {
  if (typeof raw.from !== 'string' || typeof raw.to !== 'string') {
    throw new Error(`automation "${automationName}" has an edge missing "from"/"to"`);
  }
  return { from: raw.from, to: raw.to };
}

function automationParamFromToml(raw: Record<string, unknown>, automationName: string): AutomationParam {
  if (typeof raw.name !== 'string') throw new Error(`automation "${automationName}" has a parameter missing "name"`);
  const kind: AutomationParamKind | undefined = raw.kind === 'text' ? 'text' : raw.kind === 'host' ? 'host' : undefined;
  if (kind === undefined) throw new Error(`automation "${automationName}" parameter "${raw.name}" has an invalid kind`);
  return {
    name: raw.name,
    kind,
    label: typeof raw.label === 'string' ? raw.label : undefined,
    default: typeof raw.default === 'string' ? raw.default : undefined
  };
}

function automationParamToToml(param: AutomationParam): Record<string, unknown> {
  const out: Record<string, unknown> = { name: param.name, kind: param.kind };
  if (param.label !== undefined) out.label = param.label;
  if (param.default !== undefined) out.default = param.default;
  return out;
}

function automationFromToml(raw: Record<string, unknown>): Automation {
  if (typeof raw.name !== 'string') throw new Error('automation is missing "name"');
  const params = Array.isArray(raw.params) ? raw.params.map((p) => automationParamFromToml(p as Record<string, unknown>, raw.name as string)) : [];
  const nodes = Array.isArray(raw.nodes) ? raw.nodes.map((n) => automationNodeFromToml(n as Record<string, unknown>, raw.name as string)) : [];
  const edges = Array.isArray(raw.edges) ? raw.edges.map((e) => automationEdgeFromToml(e as Record<string, unknown>, raw.name as string)) : [];
  const startLinks = Array.isArray(raw.startLinks)
    ? raw.startLinks.filter((s): s is string => typeof s === 'string')
    : undefined;
  return { name: raw.name, params, nodes, edges, startLinks };
}

function automationToToml(automation: Automation): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: automation.name,
    params: automation.params.map(automationParamToToml),
    nodes: automation.nodes.map(automationNodeToToml),
    edges: automation.edges.map((e) => ({ from: e.from, to: e.to }))
  };
  // Omitted when empty, like a node's `position` — keeps an automation with no decorative
  // Start-node links out of the TOML entirely rather than writing `startLinks = []`.
  if (automation.startLinks !== undefined && automation.startLinks.length > 0) out.startLinks = automation.startLinks;
  return out;
}

function parseAutomationsFile(content: string): AutomationsFile {
  if (content.trim() === '') return { automations: [] };
  const raw = parse(content) as { automations?: unknown };
  if (raw.automations === undefined) return { automations: [] };
  if (!Array.isArray(raw.automations)) throw new Error('automations.toml: "automations" must be an array');
  return { automations: raw.automations.map((f) => automationFromToml(f as Record<string, unknown>)) };
}

/** Loads Automations from `~/.config/omnyssh/automations.toml` (or `overridePath`, for tests).
 *  Returns `[]` if the file does not exist yet. */
export async function loadAutomations(overridePath?: string): Promise<Automation[]> {
  const path = overridePath ?? automationsConfigPath();
  if (!existsSync(path)) return [];
  const content = await readFile(path, 'utf-8');
  return parseAutomationsFile(content).automations;
}

/** Persists Automations to `~/.config/omnyssh/automations.toml` (or `overridePath`, for tests),
 *  atomically (tmp file + rename), `chmod 600` on non-Windows. */
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
