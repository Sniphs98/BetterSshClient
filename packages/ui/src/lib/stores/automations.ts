import { writable } from 'svelte/store';
import type { AutomationDto, FlowDto, NodeResultDto } from '$lib/bindings';
import { runFlow } from '$lib/ipc/commands';
import { lastError } from './notifications';

// The reusable Automation library and the Flows that wire them into a graph, mirroring
// automations.toml/flows.toml (like `stores/snippets.ts` mirrors snippets.toml).
export const automations = writable<AutomationDto[]>([]);
export const flows = writable<FlowDto[]>([]);

/** Which sub-view `Automations.svelte` shows. Defaults to `'flows'` — Flows are what
 *  someone actually runs; the reusable Automation library is secondary, reached via a
 *  small "Manage automations" link rather than an equal-weight tab. A module-level
 *  store (not component state) so it survives the component being torn down and
 *  recreated — which happens every time a Flow's full-page canvas
 *  (`activeEntity.selectFlow`) takes over the content area and the user comes back:
 *  without this, the view would silently reset to `'flows'` on every trip into a flow
 *  even if the user had been managing the library. Session-only; no persistence
 *  intended. */
export const automationsTab = writable<'automations' | 'flows'>('flows');

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

/** Starts `flowName` with `paramValues`, opening the run-progress panel immediately —
 *  the one place a run is actually kicked off, shared by the Automations screen's own
 *  "Run" button and any other entry point (e.g. SFTP's "Run flow with this file"
 *  context menu item) so both get the same progress-panel and error handling for free.
 *  Spread `paramValues` into a plain object first: callers often hand this a `$state`
 *  proxy (a dialog's bound values), and Electron's IPC send uses structured clone,
 *  which throws "An object could not be cloned" on a proxy. */
export async function runFlowNow(flowName: string, paramValues: Record<string, string>): Promise<void> {
  beginFlowRun(flowName);
  try {
    await runFlow(flowName, { ...paramValues });
  } catch (e) {
    lastError.set(e instanceof Error ? e.message : String(e));
  }
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
