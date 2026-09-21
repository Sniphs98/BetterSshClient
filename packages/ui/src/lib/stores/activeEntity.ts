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
  /** A single Flow filling the whole content area — the svelte-flow canvas needs the
   *  room a modal can't give it. `flowName: null` is a new, unsaved flow; a string
   *  is the name of the existing Flow being edited (Flow has no separate id — its
   *  name is already the unique key `upsertFlow` keys on). */
  | { kind: 'flow'; flowName: string | null };

function createActiveEntity() {
  const { subscribe, set } = writable<ActiveEntity>({ kind: 'dashboard' });
  return {
    subscribe,
    selectDashboard: () => set({ kind: 'dashboard' }),
    selectAutomations: () => set({ kind: 'automations' }),
    selectRemoteDesktop: () => set({ kind: 'remoteDesktop' }),
    selectSettings: () => set({ kind: 'settings' }),
    activateSession: (id: number) => set({ kind: 'session', id }),
    selectFlow: (flowName: string | null) => set({ kind: 'flow', flowName })
  };
}

export const activeEntity = createActiveEntity();
