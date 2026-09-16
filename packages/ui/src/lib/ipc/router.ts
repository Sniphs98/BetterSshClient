// Pure event->store routing (tech-gui.md §3.5). Kept free of the Tauri runtime
// so it is unit-testable; `subscribe.ts` wires these to the generated events.

import { get } from 'svelte/store';
import type {
  AutomationFlowCompleted,
  AutomationFlowFailed,
  AutomationFlowStarted,
  AutomationNodeResult,
  AutomationNodeStarted,
  ConnectionStatusDto,
  FilePreview,
  HostDto,
  KeySetupComplete,
  KeySetupFailed,
  KeySetupProgress,
  KeySetupRollback,
  MetricsDto,
  ServiceDto,
  SftpConnected,
  SftpDirListed,
  SftpDisconnected,
  SftpOpDone,
  SnippetResult,
  TransferProgressDto
} from '$lib/bindings';
import {
  flowRun,
  reduceFlowCompleted,
  reduceFlowFailed,
  reduceNodeResult,
  reduceNodeStarted
} from '$lib/stores/automations';
import { hosts } from '$lib/stores/hosts';
import { statuses } from '$lib/stores/statuses';
import { metrics, mergeMetrics } from '$lib/stores/metrics';
import { services } from '$lib/stores/services';
import { snippetRun, reduceRunResult } from '$lib/stores/snippets';
import { sessions } from '$lib/stores/sessions';
import { sftp } from '$lib/stores/sftp';
import { closeSession } from '$lib/stores/navigation';
import { lastError } from '$lib/stores/notifications';
import {
  keySetup,
  reduceComplete,
  reduceFailed,
  reduceProgress,
  reduceRollback
} from '$lib/stores/keySetup';
import { offerUpdate } from '$lib/stores/update';
import type { UpdateAvailable } from '$lib/bindings';

export function applyHostsLoaded(payload: HostDto[]): void {
  hosts.set(payload);
  // Drop status/metrics for hosts that are gone, so a name reused by a new host
  // never inherits the old host's stale sample.
  const names = new Set(payload.map((h) => h.name));
  const prune = <V>(m: Map<string, V>) => new Map([...m].filter(([name]) => names.has(name)));
  statuses.update(prune);
  metrics.update(prune);
  services.update(prune);
}

export function applyHostStatusChanged(payload: {
  hostName: string;
  status: ConnectionStatusDto;
}): void {
  statuses.update((m) => new Map(m).set(payload.hostName, payload.status));
}

export function applyMetricsUpdated(payload: { hostName: string; metrics: MetricsDto }): void {
  metrics.update((m) => new Map(m).set(payload.hostName, mergeMetrics(m.get(payload.hostName), payload.metrics)));
}

export function applyServicesDetected(payload: { hostName: string; services: ServiceDto[] }): void {
  services.update((m) =>
    new Map(m).set(payload.hostName, { kind: 'detected', services: payload.services })
  );
}

export function applyServicesFailed(payload: { hostName: string; message: string }): void {
  services.update((m) => new Map(m).set(payload.hostName, { kind: 'failed', message: payload.message }));
}

export function applySnippetResult(payload: SnippetResult): void {
  snippetRun.update((run) => reduceRunResult(run, payload));
}

// A terminal's remote shell exited or its connection dropped (tech-gui.md §3.4). The
// backend already tore down its session; drop the matching tab (by its backend id).
// A user-initiated close never emits this, so there is no double-teardown.
//
// An instant-fail connect can emit terminal-exited before terminalOpen resolves, so
// the tab has no termId yet: park the id and let the tab reconcile once it records
// its backend id (`terminalDidExit`), rather than stranding a dead tab open.
const exitedBeforeMapped = new Set<number>();

// A terminal that isn't a sidebar tab at all — e.g. the SFTP view's embedded drawer
// terminal (SftpTerminalDrawer.svelte) — has no `sessions` entry for
// applyTerminalExited to find, so it would otherwise just fall into
// exitedBeforeMapped and sit there unconsumed forever, with nothing ever telling that
// component its shell exited. `onOrphanTerminalExit` is the same one-shot-notification
// idea as `terminalDidExit`, generalized to an arbitrary callback instead of a specific
// tab's close.
const orphanExitListeners = new Map<number, () => void>();

export function applyTerminalExited(sessionId: number): void {
  const target = get(sessions).find((s) => s.termId === sessionId);
  if (target) {
    closeSession(target.id);
    return;
  }
  const listener = orphanExitListeners.get(sessionId);
  if (listener) {
    orphanExitListeners.delete(sessionId);
    listener();
    return;
  }
  exitedBeforeMapped.add(sessionId);
}

/** Whether backend session `termId` already exited before its tab recorded it (the
 *  fast-fail race); consumes the pending flag. Called right after a tab sets termId. */
export function terminalDidExit(termId: number): boolean {
  return exitedBeforeMapped.delete(termId);
}

/** Registers `cb` to fire once when `termId`'s shell exits, for a terminal with no
 *  `sessions` tab of its own. Covers the same fast-fail race `terminalDidExit` guards
 *  against (call this right after `terminalOpen` resolves with the id): if the exit
 *  already arrived and got parked, `cb` fires immediately instead of being registered. */
export function onOrphanTerminalExit(termId: number, cb: () => void): void {
  if (terminalDidExit(termId)) {
    cb();
    return;
  }
  orphanExitListeners.set(termId, cb);
}

/** Cancels a pending `onOrphanTerminalExit` registration — call when the caller is
 *  tearing down `termId` itself (e.g. the user closed the drawer), so a later, unrelated
 *  reuse of a numeric id can never fire a stale callback. */
export function offOrphanTerminalExit(termId: number): void {
  orphanExitListeners.delete(termId);
}

// SFTP events (tech-gui.md §3.4/§4.3). Each carries the backend session id the sftp
// store is keyed by, so the per-session forwarder's stamping routes it to the right
// tab with no path-based guessing. `SftpView` mirrors the store status to the sidebar.
export function applySftpConnected(payload: SftpConnected): void {
  sftp.setStatus(payload.sessionId, 'connected');
}

export function applySftpDirListed(payload: SftpDirListed): void {
  sftp.listing(payload.sessionId, 'remote', payload.path, payload.entries);
}

export function applySftpOpDone(payload: SftpOpDone): void {
  sftp.opDone(payload.sessionId, payload.ok, payload.error ?? undefined);
}

// The core emits `sftp-disconnected` on a listing error, not a hard teardown (§4.3);
// surface the reason but keep the tab — the user closes it explicitly.
export function applySftpDisconnected(payload: SftpDisconnected): void {
  sftp.sessionError(payload.sessionId, payload.reason);
}

export function applyFilePreview(payload: FilePreview): void {
  sftp.setPreview(payload.sessionId, { path: payload.path, content: payload.content });
}

export function applyTransferProgress(payload: TransferProgressDto): void {
  sftp.progress(payload.sessionId, payload);
}

// Auto key-setup events (tech-gui.md §4.2/§4.3). Progress advances only the active
// host's run; a terminal outcome always shows for its host. The card refresh on
// completion is driven by the progress panel component (an ipc call), so this stays a
// pure store update.
export function applyKeySetupProgress(payload: KeySetupProgress): void {
  keySetup.update((run) => reduceProgress(run, payload.hostName, payload.step));
}

export function applyKeySetupComplete(payload: KeySetupComplete): void {
  keySetup.set(reduceComplete(payload.hostName, payload.keyPath));
}

export function applyKeySetupFailed(payload: KeySetupFailed): void {
  keySetup.set(reduceFailed(payload.hostName, payload.error));
}

export function applyKeySetupRollback(payload: KeySetupRollback): void {
  keySetup.set(reduceRollback(payload.hostName, payload.result));
}

// Automations/Flow-run events. Mirrors key setup's shape: progress advances only the
// active flow's run, a terminal outcome always lands (dismissed or not) so a reopen
// (or the flows list's own "last run" state, if one is ever added) reflects it.
export function applyAutomationFlowStarted(_payload: AutomationFlowStarted): void {
  // No store change needed — beginFlowRun() (called by the UI the moment `run_flow`
  // fires) already opened the panel; this event is here for symmetry/future use
  // (e.g. a toast) rather than driving state today.
}

export function applyAutomationNodeStarted(payload: AutomationNodeStarted): void {
  flowRun.update((run) => reduceNodeStarted(run, payload.flowName, payload.nodeId, payload.label));
}

export function applyAutomationNodeResult(payload: AutomationNodeResult): void {
  // Strip `flowName` — it's routing information (which run this belongs to), not
  // part of the NodeResultDto the store keeps.
  const { flowName, ...result } = payload;
  flowRun.update((run) => reduceNodeResult(run, flowName, result));
}

export function applyAutomationFlowCompleted(payload: AutomationFlowCompleted): void {
  flowRun.set(reduceFlowCompleted(payload.flowName, payload.results));
}

export function applyAutomationFlowFailed(payload: AutomationFlowFailed): void {
  flowRun.set(reduceFlowFailed(payload.flowName, payload.error));
}

// A newer release found by the startup check (tech-gui.md §4.3) → the update banner.
export function applyUpdateAvailable(payload: UpdateAvailable): void {
  offerUpdate(payload.info);
}

export function applyError(message: string): void {
  lastError.set(message);
}
