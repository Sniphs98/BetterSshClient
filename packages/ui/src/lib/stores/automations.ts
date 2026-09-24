import { writable } from 'svelte/store';
import type { SnippetDto, AutomationDto, NodeResultDto } from '$lib/bindings';
import { runAutomation } from '$lib/ipc/commands';
import { lastError } from './notifications';

// The reusable Snippet library and the Automations that wire them into a graph, mirroring
// snippets.toml/automations.toml.
export const snippets = writable<SnippetDto[]>([]);
export const automations = writable<AutomationDto[]>([]);

/** Which sub-view `Snippets.svelte` shows. Defaults to `'automations'` — Automations are what
 *  someone actually runs; the reusable Snippet library is secondary, reached via a
 *  small "Manage snippets" link rather than an equal-weight tab. A module-level
 *  store (not component state) so it survives the component being torn down and
 *  recreated — which happens every time an Automation's full-page canvas
 *  (`activeEntity.selectAutomation`) takes over the content area and the user comes back:
 *  without this, the view would silently reset to `'automations'` on every trip into an automation
 *  even if the user had been managing the library. Session-only; no persistence
 *  intended. */
export const automationsTab = writable<'snippets' | 'automations'>('automations');

/** One node's live state within a running automation — 'running' until its `NodeResultDto`
 *  arrives. */
export type NodeRunState = { status: 'running'; label: string } | { status: 'done'; result: NodeResultDto };

export type AutomationRunPhase =
  | { kind: 'running'; nodes: Map<string, NodeRunState> }
  | { kind: 'completed'; results: NodeResultDto[] }
  | { kind: 'failed'; error: string };

export interface AutomationRun {
  automationName: string;
  phase: AutomationRunPhase;
}

// The active (or just-finished) run, or null when no progress panel is shown — one at
// a time, mirroring `stores/keySetup.ts`'s single-popup model.
export const automationRun = writable<AutomationRun | null>(null);

/** Open the panel for `automationName` with no nodes yet — called the moment `run_automation`
 *  fires, before the first `automation-started` arrives. */
export function beginAutomationRun(automationName: string): void {
  automationRun.set({ automationName, phase: { kind: 'running', nodes: new Map() } });
}

/** Starts `automationName` with `paramValues`, opening the run-progress panel immediately —
 *  the one place a run is actually kicked off, shared by the Snippets screen's own
 *  "Run" button and any other entry point (e.g. SFTP's "Run automation with this file"
 *  context menu item) so both get the same progress-panel and error handling for free.
 *  Spread `paramValues` into a plain object first: callers often hand this a `$state`
 *  proxy (a dialog's bound values), and Electron's IPC send uses structured clone,
 *  which throws "An object could not be cloned" on a proxy. */
export async function runAutomationNow(automationName: string, paramValues: Record<string, string>): Promise<void> {
  beginAutomationRun(automationName);
  try {
    await runAutomation(automationName, { ...paramValues });
  } catch (e) {
    lastError.set(e instanceof Error ? e.message : String(e));
  }
}

/** Dismiss the panel. The background run keeps going if it was mid-flight; its
 *  terminal event still lands (on the store) even though nothing renders it until a
 *  new run reopens the panel — matching key setup's dismiss semantics. */
export function dismissAutomationRun(): void {
  automationRun.set(null);
}

/** Fold an `automation-node-started` into the active run. A stray event for a
 *  different (or no longer running) automation is ignored. Pure, so the router and tests
 *  share one definition. */
export function reduceNodeStarted(run: AutomationRun | null, automationName: string, nodeId: string, label: string): AutomationRun | null {
  if (!run || run.automationName !== automationName || run.phase.kind !== 'running') return run;
  const nodes = new Map(run.phase.nodes);
  nodes.set(nodeId, { status: 'running', label });
  return { ...run, phase: { kind: 'running', nodes } };
}

/** Fold an `automation-node-result` into the active run — covers a node that skipped
 *  straight to a result with no `nodeStarted` first (nothing to overwrite; `Map.set`
 *  just adds it). */
export function reduceNodeResult(run: AutomationRun | null, automationName: string, result: NodeResultDto): AutomationRun | null {
  if (!run || run.automationName !== automationName || run.phase.kind !== 'running') return run;
  const nodes = new Map(run.phase.nodes);
  nodes.set(result.nodeId, { status: 'done', result });
  return { ...run, phase: { kind: 'running', nodes } };
}

/** A terminal outcome always replaces whatever phase was active for its automation — even if
 *  the panel was dismissed, so a later reopen (or the toolbar's own state) reflects it. */
export function reduceAutomationCompleted(automationName: string, results: NodeResultDto[]): AutomationRun {
  return { automationName, phase: { kind: 'completed', results } };
}

export function reduceAutomationFailed(automationName: string, error: string): AutomationRun {
  return { automationName, phase: { kind: 'failed', error } };
}
