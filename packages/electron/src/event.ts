import type { ProcessInfo } from './core/ssh/metrics.js';
import type { DetectedService } from './core/ssh/services/types.js';

/**
 * Internal domain events. Ported from crates/omnyssh-core/src/event.rs's
 * `CoreEvent`, trimmed to what's wired up so far (Phase 2: hosts/terminal/
 * metrics/discovery). Background tasks (pollers, PTY sessions, discovery)
 * report these to `GuiState`, which maps them to IPC events sent to the
 * renderer — see `dto.ts` for the outbound shapes.
 */

export type ConnectionStatus = { kind: 'unknown' } | { kind: 'connecting' } | { kind: 'connected' } | { kind: 'failed'; message: string };

/** Live metrics collected from a remote server. `lastUpdated` is an epoch-ms
 *  timestamp (mirrors the Rust `Instant`); the DTO layer flattens it to
 *  `ageSeconds` at emit time. */
export interface Metrics {
  cpuPercent?: number;
  ramPercent?: number;
  diskPercent?: number;
  uptime?: string;
  loadAvg?: string;
  osInfo?: string;
  topProcesses?: ProcessInfo[];
  lastUpdated: number;
}

export function emptyMetrics(): Metrics {
  return { lastUpdated: Date.now() };
}

export type CoreEvent =
  | { type: 'metricsUpdate'; hostName: string; metrics: Metrics }
  | { type: 'hostStatusChanged'; hostName: string; status: ConnectionStatus }
  | { type: 'error'; message: string }
  | { type: 'ptyExited'; sessionId: number }
  | { type: 'discoveryQuickScanDone'; hostName: string; services: DetectedService[] }
  | { type: 'discoveryFailed'; hostName: string; message: string };
