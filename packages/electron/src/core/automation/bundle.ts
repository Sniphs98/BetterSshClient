import { randomUUID } from 'node:crypto';
import type { Automation, AutomationKind, Flow, FlowEdge, FlowNode, FlowParam, FlowParamKind } from './types.js';

/**
 * Export/import file format for sharing a single Automation or Flow between people or
 * machines. A Flow bundle is self-contained — it carries every Automation its nodes
 * reference, not just the Flow's own graph shape, so the file works unchanged on a
 * machine that has never seen those Automations before. Plain JSON (not TOML, unlike
 * the on-disk config) since this is a one-off file meant to be emailed/committed/pasted
 * around, not maintained by hand like flows.toml is.
 */

export const BUNDLE_VERSION = 1;

export interface AutomationBundle {
  kind: 'omnyssh-automation';
  version: number;
  automation: Automation;
}

export interface FlowBundle {
  kind: 'omnyssh-flow';
  version: number;
  flow: Flow;
  automations: Automation[];
}

export type Bundle = AutomationBundle | FlowBundle;

export function buildAutomationBundle(automation: Automation): AutomationBundle {
  return { kind: 'omnyssh-automation', version: BUNDLE_VERSION, automation };
}

/** Gathers exactly the Automations `flow` actually references, in node order and
 *  deduplicated — never the whole library. Throws if a node's `automationId` doesn't
 *  resolve; `save_flow` always validates this first so a flow reached through normal
 *  use can't be in that state, but a hand-edited flows.toml could be. */
export function buildFlowBundle(flow: Flow, automationsById: Map<string, Automation>): FlowBundle {
  const seen = new Set<string>();
  const automations: Automation[] = [];
  for (const node of flow.nodes) {
    if (seen.has(node.automationId)) continue;
    const automation = automationsById.get(node.automationId);
    if (automation === undefined) {
      throw new Error(`flow "${flow.name}" references an unknown automation`);
    }
    seen.add(node.automationId);
    automations.push(automation);
  }
  return { kind: 'omnyssh-flow', version: BUNDLE_VERSION, flow, automations };
}

// ---------------------------------------------------------------------------
// Parsing an imported file's already-`JSON.parse`d contents — the file might be
// hand-edited, from a future app version, or not an OmnySSH bundle at all, so every
// field is checked explicitly and a bad one throws a descriptive `Error`, the same
// discipline core/config/flows.ts's *FromToml functions apply to a hand-edited TOML.
// ---------------------------------------------------------------------------

function str(v: unknown, ctx: string): string {
  if (typeof v !== 'string') throw new Error(`${ctx}: expected a string`);
  return v;
}

function optionalStr(v: unknown, ctx: string): string | undefined {
  return v === undefined ? undefined : str(v, ctx);
}

function num(v: unknown, ctx: string): number {
  if (typeof v !== 'number') throw new Error(`${ctx}: expected a number`);
  return v;
}

function bool(v: unknown, ctx: string): boolean {
  if (typeof v !== 'boolean') throw new Error(`${ctx}: expected a boolean`);
  return v;
}

function obj(v: unknown, ctx: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null) throw new Error(`${ctx}: expected an object`);
  return v as Record<string, unknown>;
}

function arr(v: unknown, ctx: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`${ctx}: expected an array`);
  return v;
}

function parseAutomation(raw: unknown, ctx: string): Automation {
  const o = obj(raw, ctx);
  const kind: AutomationKind | undefined = o.kind === 'local' ? 'local' : o.kind === 'remote' ? 'remote' : undefined;
  if (kind === undefined) throw new Error(`${ctx}.kind: must be "local" or "remote"`);
  return {
    id: str(o.id, `${ctx}.id`),
    name: str(o.name, `${ctx}.name`),
    kind,
    command: str(o.command, `${ctx}.command`),
    timeoutSecs: num(o.timeoutSecs, `${ctx}.timeoutSecs`)
  };
}

function parseFlowNode(raw: unknown, ctx: string): FlowNode {
  const o = obj(raw, ctx);
  let position: { x: number; y: number } | undefined;
  if (o.position !== undefined && o.position !== null) {
    const p = obj(o.position, `${ctx}.position`);
    position = { x: num(p.x, `${ctx}.position.x`), y: num(p.y, `${ctx}.position.y`) };
  }
  return {
    id: str(o.id, `${ctx}.id`),
    automationId: str(o.automationId, `${ctx}.automationId`),
    label: str(o.label, `${ctx}.label`),
    continueOnError: bool(o.continueOnError, `${ctx}.continueOnError`),
    position
  };
}

function parseFlowEdge(raw: unknown, ctx: string): FlowEdge {
  const o = obj(raw, ctx);
  return { from: str(o.from, `${ctx}.from`), to: str(o.to, `${ctx}.to`) };
}

function parseFlowParam(raw: unknown, ctx: string): FlowParam {
  const o = obj(raw, ctx);
  const kind: FlowParamKind | undefined = o.kind === 'text' ? 'text' : o.kind === 'host' ? 'host' : undefined;
  if (kind === undefined) throw new Error(`${ctx}.kind: must be "text" or "host"`);
  return {
    name: str(o.name, `${ctx}.name`),
    kind,
    label: optionalStr(o.label, `${ctx}.label`),
    default: optionalStr(o.default, `${ctx}.default`)
  };
}

function parseFlow(raw: unknown, ctx: string): Flow {
  const o = obj(raw, ctx);
  return {
    name: str(o.name, `${ctx}.name`),
    params: arr(o.params ?? [], `${ctx}.params`).map((p, i) => parseFlowParam(p, `${ctx}.params[${i}]`)),
    nodes: arr(o.nodes ?? [], `${ctx}.nodes`).map((n, i) => parseFlowNode(n, `${ctx}.nodes[${i}]`)),
    edges: arr(o.edges ?? [], `${ctx}.edges`).map((e, i) => parseFlowEdge(e, `${ctx}.edges[${i}]`)),
    startLinks:
      o.startLinks === undefined
        ? undefined
        : arr(o.startLinks, `${ctx}.startLinks`).map((s, i) => str(s, `${ctx}.startLinks[${i}]`))
  };
}

/** Parses+validates a file's already-`JSON.parse`d contents into a `Bundle`, or throws
 *  a descriptive `Error`. */
export function parseBundle(raw: unknown): Bundle {
  const o = obj(raw, 'file');
  if (o.kind === 'omnyssh-automation') {
    return {
      kind: 'omnyssh-automation',
      version: num(o.version, 'file.version'),
      automation: parseAutomation(o.automation, 'file.automation')
    };
  }
  if (o.kind === 'omnyssh-flow') {
    return {
      kind: 'omnyssh-flow',
      version: num(o.version, 'file.version'),
      flow: parseFlow(o.flow, 'file.flow'),
      automations: arr(o.automations, 'file.automations').map((a, i) => parseAutomation(a, `file.automations[${i}]`))
    };
  }
  throw new Error('not an OmnySSH automation/flow file');
}

export interface ImportResult {
  kind: 'automation' | 'flow';
  name: string;
}

/** `base` if it's not already in `taken`, else `"base (2)"`, `"base (3)"`, … — used for
 *  a Flow's name (the on-disk primary key; see `upsertFlow`) so importing one never
 *  silently overwrites an existing flow of the same name. */
function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base} (${i})`)) i += 1;
  return `${base} (${i})`;
}

/** Adds the bundled Automation to the library under a fresh id. `Automation.id` is a
 *  local implementation detail, not a stable identity across machines (see
 *  `upsertAutomation`'s doc comment) — reusing the exporting machine's id risks
 *  colliding with an unrelated Automation the importer already has. Automation names
 *  don't have to be unique (also `upsertAutomation`), so unlike a Flow's name, nothing
 *  here needs renaming. */
export function mergeAutomationBundle(
  bundle: AutomationBundle,
  automations: Automation[]
): { automations: Automation[]; result: ImportResult } {
  const imported: Automation = { ...bundle.automation, id: randomUUID() };
  return { automations: [...automations, imported], result: { kind: 'automation', name: imported.name } };
}

/** Adds every bundled Automation under a fresh id, remaps the Flow's node
 *  `automationId`s through that mapping, and renames the Flow if its name collides
 *  with one the importer already has (see `uniqueName`). */
export function mergeFlowBundle(
  bundle: FlowBundle,
  automations: Automation[],
  flows: Flow[]
): { automations: Automation[]; flows: Flow[]; result: ImportResult } {
  const idMap = new Map<string, string>();
  const importedAutomations = bundle.automations.map((a) => {
    const id = randomUUID();
    idMap.set(a.id, id);
    return { ...a, id };
  });
  const name = uniqueName(bundle.flow.name, new Set(flows.map((f) => f.name)));
  const importedFlow: Flow = {
    ...bundle.flow,
    name,
    nodes: bundle.flow.nodes.map((n) => ({ ...n, automationId: idMap.get(n.automationId) ?? n.automationId }))
  };
  return {
    automations: [...automations, ...importedAutomations],
    flows: [...flows, importedFlow],
    result: { kind: 'flow', name }
  };
}
