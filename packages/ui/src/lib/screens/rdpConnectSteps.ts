// The steps an embedded RDP tab shows while it connects, so a slow connection reads as
// "working on it" rather than stuck: which steps apply depends on the profile (1Password,
// an SSH tunnel), and the main process reports each one as it gets there
// (`rdp-connect-progress`). Kept apart from RdpView.svelte so it is unit-testable.

import type { RdpConnectStageDto } from '$lib/bindings';

/** `viewer` is the tab's own first step (loading IronRDP); the rest come from the main process. */
export type RdpConnectStage = 'viewer' | RdpConnectStageDto;

export interface RdpConnectStep {
  stage: RdpConnectStage;
  label: string;
}

export type RdpStepStatus = 'done' | 'active' | 'failed' | 'pending';

/** The steps for a connection, in order. `server` names it — its address, or its name
 *  where the address isn't to be shown (streamer mode, 1Password). */
export function rdpConnectSteps(c: { onePassword: boolean; viaHost?: string | null; server: string }): RdpConnectStep[] {
  return [
    { stage: 'viewer', label: 'Starting the viewer' },
    ...(c.onePassword ? [{ stage: 'onePassword' as const, label: 'Reading sign-in from 1Password' }] : []),
    ...(c.viaHost ? [{ stage: 'tunnel' as const, label: `Opening SSH tunnel through ${c.viaHost}` }] : []),
    { stage: 'reach', label: `Reaching ${c.server}` },
    { stage: 'secure', label: 'Securing the connection' },
    { stage: 'signin', label: 'Signing in' }
  ];
}

/** The step to show as current after `next` is reported: never back to an earlier one
 *  (events can arrive late), and a stage these steps don't have changes nothing. */
export function advance(steps: RdpConnectStep[], current: RdpConnectStage, next: RdpConnectStage): RdpConnectStage {
  const from = steps.findIndex((s) => s.stage === current);
  const to = steps.findIndex((s) => s.stage === next);
  return to > from ? next : current;
}

/** Each step's status while connecting at `current` — or stopped there, if `failed`. */
export function stepStatus(steps: RdpConnectStep[], current: RdpConnectStage, index: number, failed: boolean): RdpStepStatus {
  const at = steps.findIndex((s) => s.stage === current);
  if (index < at) return 'done';
  if (index > at) return 'pending';
  return failed ? 'failed' : 'active';
}

/** "12s" — how long the current step has been going, once it's noticeable. */
export function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 3) return '';
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
