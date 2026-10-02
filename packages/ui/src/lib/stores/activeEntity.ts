import { writable } from 'svelte/store';

// The one entity Content shows (tech-gui.md §2, §3.5): a selector screen or one
// session, never both. This store is the sole writer of "what's active", so the
// exactly-one-active invariant holds by construction — a new active value replaces
// the previous one whatever its kind. Switching selectors deactivates any session;
// activating a session deactivates the selectors.
export type ActiveEntity =
  | { kind: 'dashboard' }
  | { kind: 'automations' }
  | { kind: 'remoteDesktop' }
  | { kind: 'settings' }
  | { kind: 'session'; id: number }
  /** A single Automation filling the whole content area — the svelte-flow canvas needs the
   *  room a modal can't give it. `automationName: null` is a new, unsaved automation; a string
   *  is the name of the existing Automation being edited (Automation has no separate id — its
   *  name is already the unique key `upsertAutomation` keys on). */
  | { kind: 'automation'; automationName: string | null };

/** Asked before Content switches away from what's active; returns `true` to hold the
 *  switch (an editor with unsaved changes asking first), calling `leave` later to let
 *  it through. */
export type LeaveGuard = (leave: () => void) => boolean;

function createActiveEntity() {
  const { subscribe, set } = writable<ActiveEntity>({ kind: 'dashboard' });
  let guard: LeaveGuard | null = null;

  // Every way to another entity — the sidebar, the palette, a back button, a session
  // opening — comes through here, so one guard covers them all.
  function go(next: ActiveEntity): void {
    if (guard?.(() => set(next))) return;
    set(next);
  }

  return {
    subscribe,
    selectDashboard: () => go({ kind: 'dashboard' }),
    selectAutomations: () => go({ kind: 'automations' }),
    selectRemoteDesktop: () => go({ kind: 'remoteDesktop' }),
    selectSettings: () => go({ kind: 'settings' }),
    activateSession: (id: number) => go({ kind: 'session', id }),
    selectAutomation: (automationName: string | null) => go({ kind: 'automation', automationName }),
    /** Installs `g` until the returned function removes it — one at a time, the
     *  editor that's showing. */
    setLeaveGuard: (g: LeaveGuard): (() => void) => {
      guard = g;
      return () => {
        if (guard === g) guard = null;
      };
    }
  };
}

export const activeEntity = createActiveEntity();
