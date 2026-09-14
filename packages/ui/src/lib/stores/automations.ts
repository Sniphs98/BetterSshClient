import { writable } from 'svelte/store';
import type { AutomationDto, FlowDto, NodeResultDto } from '$lib/bindings';

// The reusable Automation library and the Flows that wire them into a graph, mirroring
// automations.toml/flows.toml (like `stores/snippets.ts` mirrors snippets.toml).
export const automations = writable<AutomationDto[]>([]);
export const flows = writable<FlowDto[]>([]);

/** One node's live state within a running flow — 'running' until its `NodeResultDto`
 *  arrives. */
export type NodeRunState = { status: 'running'; label: string } | { status: 'done'; result: NodeResultDto };

export type FlowRunPhase =
  | { kind: 'running'; nodes: Map<string, NodeRunState> }
  | { kind: 'completed'; results: NodeResultDto[] }
  | { kind: 'failed'; error: string };

export interface FlowRun {
  flowName: string;
  phase: FlowRunPhase;
}

// The active (or just-finished) run, or null when no progress panel is shown — one at
// a time, mirroring `stores/keySetup.ts`'s single-popup model.
export const flowRun = writable<FlowRun | null>(null);

/** Open the panel for `flowName` with no nodes yet — called the moment `run_flow`
 *  fires, before the first `automation-flow-started` arrives. */
export function beginFlowRun(flowName: string): void {
  flowRun.set({ flowName, phase: { kind: 'running', nodes: new Map() } });
}

/** Dismiss the panel. The background run keeps going if it was mid-flight; its
 *  terminal event still lands (on the store) even though nothing renders it until a
 *  new run reopens the panel — matching key setup's dismiss semantics. */
export function dismissFlowRun(): void {
  flowRun.set(null);
}

/** Fold an `automation-node-started` into the active run. A stray event for a
 *  different (or no longer running) flow is ignored. Pure, so the router and tests
 *  share one definition. */
export function reduceNodeStarted(run: FlowRun | null, flowName: string, nodeId: string, label: string): FlowRun | null {
  if (!run || run.flowName !== flowName || run.phase.kind !== 'running') return run;
  const nodes = new Map(run.phase.nodes);
  nodes.set(nodeId, { status: 'running', label });
  return { ...run, phase: { kind: 'running', nodes } };
}

/** Fold an `automation-node-result` into the active run — covers a node that skipped
 *  straight to a result with no `nodeStarted` first (nothing to overwrite; `Map.set`
 *  just adds it). */
export function reduceNodeResult(run: FlowRun | null, flowName: string, result: NodeResultDto): FlowRun | null {
  if (!run || run.flowName !== flowName || run.phase.kind !== 'running') return run;
  const nodes = new Map(run.phase.nodes);
  nodes.set(result.nodeId, { status: 'done', result });
  return { ...run, phase: { kind: 'running', nodes } };
}

/** A terminal outcome always replaces whatever phase was active for its flow — even if
 *  the panel was dismissed, so a later reopen (or the toolbar's own state) reflects it. */
export function reduceFlowCompleted(flowName: string, results: NodeResultDto[]): FlowRun {
  return { flowName, phase: { kind: 'completed', results } };
}

export function reduceFlowFailed(flowName: string, error: string): FlowRun {
  return { flowName, phase: { kind: 'failed', error } };
}
