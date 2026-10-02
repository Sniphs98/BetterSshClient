import { writable } from 'svelte/store';
import type { SnippetDto, AutomationDto, NodeResultDto } from '$lib/bindings';
import { cancelAutomation, runAutomation } from '$lib/ipc/commands';
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

/** One node's live state within a running automation — 'running' (since `startedAt`, a
 *  `Date.now()`, for the panel's clock) until its `NodeResultDto` arrives. */
export type NodeRunState = { status: 'running'; label: string; startedAt: number } | { status: 'done'; result: NodeResultDto };

export type AutomationRunPhase =
  | { kind: 'running'; nodes: Map<string, NodeRunState> }
  | { kind: 'completed'; results: NodeResultDto[] }
  | { kind: 'failed'; error: string };

export interface AutomationRun {
  automationName: string;
  phase: AutomationRunPhase;
  /** Lines of news from long-running nodes (a GitHub run's progress, its link), by
   *  node id — kept once the run ends, so the links stay. */
  progress?: Record<string, string[]>;
  /** `Date.now()` when the run was started here, and when it ended — the panel's total
   *  time. Unset for a run this window didn't start (nothing to measure from). */
  startedAt?: number;
  finishedAt?: number;
  /** Stop was pressed; the run is winding down. */
  stopping?: boolean;
}

/** The automations running right now, by name — kept apart from `automationRun`, which
 *  closing the panel clears, so an automation's card still knows it's running (and
 *  offers Stop) with the panel closed. `stopping`: Stop was pressed. */
export const activeRuns = writable<Record<string, { stopping: boolean }>>({});

/** A run ended (completed or failed): its card goes back to Run. */
export function endActiveRun(automationName: string): void {
  activeRuns.update((runs) => {
    const { [automationName]: _ended, ...rest } = runs;
    return rest;
  });
}

/** The error a step stopped by Stop carries (the engine's `CANCELED`). */
export const CANCELED = 'canceled';

/** Stops `automationName`'s run (issue: a running automation couldn't be stopped). The
 *  panel says "Stopping…" until the run's results arrive. */
export async function stopAutomationRun(automationName: string): Promise<void> {
  activeRuns.update((runs) => (automationName in runs ? { ...runs, [automationName]: { stopping: true } } : runs));
  automationRun.update((run) => (run?.automationName === automationName && run.phase.kind === 'running' ? { ...run, stopping: true } : run));
  try {
    await cancelAutomation(automationName);
  } catch (e) {
    lastError.set(e instanceof Error ? e.message : String(e));
  }
}

/** A run or step's time for the panel: `0.4s`, `12s`, `3m 05s`, `1h 02m`. */
export function formatDuration(ms: number): string {
  const ms0 = Math.max(0, ms);
  if (ms0 < 10_000) return `${(Math.floor(ms0 / 100) / 10).toFixed(1)}s`;
  const secs = Math.floor(ms0 / 1000);
  if (secs < 60) return `${secs}s`;
  const pad = (n: number) => String(n).padStart(2, '0');
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${pad(secs % 60)}s`;
  return `${Math.floor(mins / 60)}h ${pad(mins % 60)}m`;
}

// The active (or just-finished) run, or null when no progress panel is shown — one at
// a time, mirroring `stores/keySetup.ts`'s single-popup model.
export const automationRun = writable<AutomationRun | null>(null);

/** Open the panel for `automationName` with no nodes yet — called the moment `run_automation`
 *  fires, before the first `automation-started` arrives. */
export function beginAutomationRun(automationName: string, now: number = Date.now()): void {
  activeRuns.update((runs) => ({ ...runs, [automationName]: { stopping: false } }));
  automationRun.set({ automationName, phase: { kind: 'running', nodes: new Map() }, startedAt: now });
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
    endActiveRun(automationName);
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
export function reduceNodeStarted(
  run: AutomationRun | null,
  automationName: string,
  nodeId: string,
  label: string,
  now: number = Date.now()
): AutomationRun | null {
  if (!run || run.automationName !== automationName || run.phase.kind !== 'running') return run;
  const nodes = new Map(run.phase.nodes);
  nodes.set(nodeId, { status: 'running', label, startedAt: now });
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

/** Fold an `automation-node-progress` line into the active run. */
export function reduceNodeProgress(run: AutomationRun | null, automationName: string, nodeId: string, message: string): AutomationRun | null {
  if (!run || run.automationName !== automationName) return run;
  const progress = { ...(run.progress ?? {}) };
  progress[nodeId] = [...(progress[nodeId] ?? []), message];
  return { ...run, progress };
}

/** A terminal outcome always replaces whatever phase was active for its automation — even if
 *  the panel was dismissed, so a later reopen (or the toolbar's own state) reflects it. */
export function reduceAutomationCompleted(
  automationName: string,
  results: NodeResultDto[],
  previous: AutomationRun | null = null,
  now: number = Date.now()
): AutomationRun {
  const same = previous?.automationName === automationName ? previous : undefined;
  return {
    automationName,
    phase: { kind: 'completed', results },
    ...(same?.progress ? { progress: same.progress } : {}),
    ...(same?.startedAt !== undefined ? { startedAt: same.startedAt, finishedAt: now } : {})
  };
}

export function reduceAutomationFailed(automationName: string, error: string): AutomationRun {
  return { automationName, phase: { kind: 'failed', error } };
}
