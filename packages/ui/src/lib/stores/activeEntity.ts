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
  | { kind: 'plugins' }
  | { kind: 'session'; id: number }
  /** A single Automation filling the whole content area — the svelte-flow canvas needs the
   *  room a modal can't give it. `automationName: null` is a new, unsaved automation; a string
   *  is the name of the existing Automation being edited (Automation has no separate id — its
   *  name is already the unique key `upsertAutomation` keys on). */
  | { kind: 'automation'; automationName: string | null };

function createActiveEntity() {
  const { subscribe, set } = writable<ActiveEntity>({ kind: 'dashboard' });
  return {
    subscribe,
    selectDashboard: () => set({ kind: 'dashboard' }),
    selectAutomations: () => set({ kind: 'automations' }),
    selectRemoteDesktop: () => set({ kind: 'remoteDesktop' }),
    selectSettings: () => set({ kind: 'settings' }),
    selectPlugins: () => set({ kind: 'plugins' }),
    activateSession: (id: number) => set({ kind: 'session', id }),
    selectAutomation: (automationName: string | null) => set({ kind: 'automation', automationName })
  };
}

export const activeEntity = createActiveEntity();
