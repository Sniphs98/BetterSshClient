import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parse, stringify } from 'smol-toml';

import { flowsConfigPath } from './platform.js';
import type { Flow, FlowEdge, FlowNode, FlowParam, FlowParamKind } from '../automation/types.js';

/** `flows.toml` I/O — Flows wire Automations (loaded separately, from
 *  `automations.ts`/`automations.toml`) together into a graph. Mirrors
 *  `snippets.ts`'s shape, one level deeper (a flow nests its nodes and edges). */

interface FlowsFile {
  flows: Flow[];
}

function flowNodeFromToml(raw: Record<string, unknown>, flowName: string): FlowNode {
  if (typeof raw.id !== 'string') throw new Error(`flow "${flowName}" has a node missing "id"`);
  if (typeof raw.automationId !== 'string') throw new Error(`flow "${flowName}" node "${raw.id}" is missing "automationId"`);
  if (typeof raw.label !== 'string') throw new Error(`flow "${flowName}" node "${raw.id}" is missing "label"`);
  const position =
    raw.position !== undefined && typeof raw.position === 'object' && raw.position !== null
      ? (raw.position as { x?: unknown; y?: unknown })
      : undefined;
  return {
    id: raw.id,
    automationId: raw.automationId,
    label: raw.label,
    continueOnError: raw.continueOnError === true,
    position:
      position !== undefined && typeof position.x === 'number' && typeof position.y === 'number'
        ? { x: position.x, y: position.y }
        : undefined
  };
}

function flowNodeToToml(node: FlowNode): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: node.id,
    automationId: node.automationId,
    label: node.label,
    continueOnError: node.continueOnError
  };
  if (node.position !== undefined) out.position = { x: node.position.x, y: node.position.y };
  return out;
}

function flowEdgeFromToml(raw: Record<string, unknown>, flowName: string): FlowEdge {
  if (typeof raw.from !== 'string' || typeof raw.to !== 'string') {
    throw new Error(`flow "${flowName}" has an edge missing "from"/"to"`);
  }
  return { from: raw.from, to: raw.to };
}

function flowParamFromToml(raw: Record<string, unknown>, flowName: string): FlowParam {
  if (typeof raw.name !== 'string') throw new Error(`flow "${flowName}" has a parameter missing "name"`);
  const kind: FlowParamKind | undefined = raw.kind === 'text' ? 'text' : raw.kind === 'host' ? 'host' : undefined;
  if (kind === undefined) throw new Error(`flow "${flowName}" parameter "${raw.name}" has an invalid kind`);
  return {
    name: raw.name,
    kind,
    label: typeof raw.label === 'string' ? raw.label : undefined,
    default: typeof raw.default === 'string' ? raw.default : undefined
  };
}

function flowParamToToml(param: FlowParam): Record<string, unknown> {
  const out: Record<string, unknown> = { name: param.name, kind: param.kind };
  if (param.label !== undefined) out.label = param.label;
  if (param.default !== undefined) out.default = param.default;
  return out;
}

function flowFromToml(raw: Record<string, unknown>): Flow {
  if (typeof raw.name !== 'string') throw new Error('flow is missing "name"');
  const params = Array.isArray(raw.params) ? raw.params.map((p) => flowParamFromToml(p as Record<string, unknown>, raw.name as string)) : [];
  const nodes = Array.isArray(raw.nodes) ? raw.nodes.map((n) => flowNodeFromToml(n as Record<string, unknown>, raw.name as string)) : [];
  const edges = Array.isArray(raw.edges) ? raw.edges.map((e) => flowEdgeFromToml(e as Record<string, unknown>, raw.name as string)) : [];
  return { name: raw.name, params, nodes, edges };
}

function flowToToml(flow: Flow): Record<string, unknown> {
  return {
    name: flow.name,
    params: flow.params.map(flowParamToToml),
    nodes: flow.nodes.map(flowNodeToToml),
    edges: flow.edges.map((e) => ({ from: e.from, to: e.to }))
  };
}

function parseFlowsFile(content: string): FlowsFile {
  if (content.trim() === '') return { flows: [] };
  const raw = parse(content) as { flows?: unknown };
  if (raw.flows === undefined) return { flows: [] };
  if (!Array.isArray(raw.flows)) throw new Error('flows.toml: "flows" must be an array');
  return { flows: raw.flows.map((f) => flowFromToml(f as Record<string, unknown>)) };
}

/** Loads Flows from `~/.config/omnyssh/flows.toml` (or `overridePath`, for tests).
 *  Returns `[]` if the file does not exist yet. */
export async function loadFlows(overridePath?: string): Promise<Flow[]> {
  const path = overridePath ?? flowsConfigPath();
  if (!existsSync(path)) return [];
  const content = await readFile(path, 'utf-8');
  return parseFlowsFile(content).flows;
}

/** Persists Flows to `~/.config/omnyssh/flows.toml` (or `overridePath`, for tests),
 *  atomically (tmp file + rename), `chmod 600` on non-Windows. */
export async function saveFlows(flows: Flow[], overridePath?: string): Promise<void> {
  const path = overridePath ?? flowsConfigPath();
  await mkdir(dirname(path), { recursive: true });

  const content = stringify({ flows: flows.map(flowToToml) });

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
