import { writable } from 'svelte/store';
import type { AutomationDto, AutomationStepResult } from '$lib/bindings';

// Saved automations, mirroring `automations.toml`. Refreshed from
// `list_automations` after every mutation so the store never drifts from the
// shared on-disk source of truth (the same file the TUI reads/writes).
export const automations = writable<AutomationDto[]>([]);

/** One step's slot in a running automation's results panel, in execution order. */
export interface AutomationResultEntry {
  description: string;
  /** True once the step's `automation-step-started` has arrived. */
  started: boolean;
  /** True until the step's `automation-step-result` arrives. */
  pending: boolean;
  ok: boolean;
  output: string;
}

/** The in-flight (or just-finished) execution the results panel renders. */
export interface AutomationRun {
  automationName: string;
  entries: AutomationResultEntry[];
}

// The active execution, or null when no results panel is open.
export const automationRun = writable<AutomationRun | null>(null);

/** Seed a run with one pending entry per step, in order — called the moment
 *  execute fires, so every step shows as queued before its result streams back. */
export function beginAutomationRun(automationName: string, stepDescriptions: string[]): void {
  automationRun.set({
    automationName,
    entries: stepDescriptions.map((description) => ({
      description,
      started: false,
      pending: true,
      ok: false,
      output: ''
    }))
  });
}

/** Dismiss the results panel. */
export function clearAutomationRun(): void {
  automationRun.set(null);
}

/** Mark every still-pending entry of the active run as failed. Used when the
 *  execute command itself rejects, so no step results will arrive and the panel
 *  would otherwise stay stuck on "Running…". */
export function failPendingAutomationRun(errorMessage: string): void {
  automationRun.update((run) =>
    run
      ? {
          ...run,
          entries: run.entries.map((e) =>
            e.pending ? { ...e, started: true, pending: false, ok: false, output: errorMessage } : e
          )
        }
      : run
  );
}

/** Mark the step at `stepIndex` as started (running), if the run matches. */
export function reduceStepStarted(
  run: AutomationRun | null,
  payload: { automationName: string; stepIndex: number }
): AutomationRun | null {
  if (!run || run.automationName !== payload.automationName) return run;
  return {
    ...run,
    entries: run.entries.map((e, i) => (i === payload.stepIndex ? { ...e, started: true } : e))
  };
}

/** Fold an `automation-step-result` into the active run, filling the matching
 *  step's entry. A result for a different automation (name mismatch) is
 *  ignored. Pure, so the router and the tests share one definition. */
export function reduceStepResult(
  run: AutomationRun | null,
  payload: AutomationStepResult
): AutomationRun | null {
  if (!run || run.automationName !== payload.automationName) return run;
  return {
    ...run,
    entries: run.entries.map((e, i) =>
      i === payload.stepIndex
        ? { ...e, started: true, pending: false, ok: payload.ok, output: payload.output }
        : e
    )
  };
}
