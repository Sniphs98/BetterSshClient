// The steps an SSH terminal tab shows while it connects, and where a failed connection
// stopped — like the RDP tab's (rdpConnectSteps.ts). Which steps apply depends on the
// host (1Password, a jump host); the main process reports each as it gets there
// (`ssh-connect-progress`). Kept apart from TerminalView.svelte so it is unit-testable.

import type { HostDto, SshConnectStageDto } from '$lib/bindings';
import { isOnePasswordReference } from './onePasswordRef';

export interface SshConnectStep {
  stage: SshConnectStageDto;
  label: string;
}

export type SshStepStatus = 'done' | 'active' | 'failed' | 'pending';

/** The steps for `host`, in order. `address` is how to show where it connects (masked
 *  in streamer mode, a 1Password item's name instead of its reference). */
export function sshConnectSteps(
  host: Pick<HostDto, 'hostname' | 'user' | 'portRef' | 'passwordRef' | 'proxyJump'>,
  address: string,
  user: string
): SshConnectStep[] {
  const onePassword =
    isOnePasswordReference(host.hostname) || isOnePasswordReference(host.user) || Boolean(host.portRef) || Boolean(host.passwordRef);
  return [
    ...(onePassword ? [{ stage: 'onePassword' as const, label: 'Reading sign-in from 1Password' }] : []),
    ...(host.proxyJump ? [{ stage: 'jump' as const, label: `Connecting through ${host.proxyJump}` }] : []),
    { stage: 'reach', label: `Reaching ${address}` },
    { stage: 'hostKey', label: 'Checking the host key' },
    { stage: 'signIn', label: `Signing in as ${user}` },
    { stage: 'shell', label: 'Opening the shell' }
  ];
}

/** The step to show after `next` is reported — never back to an earlier one (late
 *  events), and a stage these steps don't have changes nothing. `current` null: none yet. */
export function advance(steps: SshConnectStep[], current: SshConnectStageDto | null, next: SshConnectStageDto): SshConnectStageDto | null {
  const from = current === null ? -1 : steps.findIndex((s) => s.stage === current);
  const to = steps.findIndex((s) => s.stage === next);
  return to > from ? next : current;
}

/** Each step's status at `current` — stopped there if `failed`. Before any report, the
 *  first step is the one going on. */
export function stepStatus(steps: SshConnectStep[], current: SshConnectStageDto | null, index: number, failed: boolean): SshStepStatus {
  const at = current === null ? 0 : steps.findIndex((s) => s.stage === current);
  if (index < at) return 'done';
  if (index > at) return 'pending';
  return failed ? 'failed' : 'active';
}

/** The `ssh-keygen -R …` a changed-host-key error suggests, to offer as a copy button. */
export function suggestedCommand(error: string): string | null {
  const m = /ssh-keygen -R "[^"]+"/.exec(error);
  return m ? m[0] : null;
}
