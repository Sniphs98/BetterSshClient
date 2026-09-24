import { writable } from 'svelte/store';

// Which set of sidebar entry points is shown: the existing SSH-centric app, or the
// new Remote Desktop area. A sticky UI-chrome pref, same persistence shape as
// `stores/ui.ts`'s `sidebarCollapsed` — canonical value in the settings store,
// mirrored to localStorage so the SPA renders the right mode on first paint.
export type SidebarMode = 'ssh' | 'remoteDesktop';

const LOCAL_KEY = 'better-ssh-client-sidebar-mode';
const STORE_KEY = 'sidebarMode';

function mirroredMode(): SidebarMode {
  try {
    return localStorage.getItem(LOCAL_KEY) === 'remoteDesktop' ? 'remoteDesktop' : 'ssh';
  } catch {
    return 'ssh'; // localStorage unavailable: default to the existing SSH view.
  }
}

function mirrorLocal(mode: SidebarMode): void {
  try {
    localStorage.setItem(LOCAL_KEY, mode);
  } catch {
    // localStorage unavailable (hardened webview): the store copy is canonical.
  }
}

async function persistStore(mode: SidebarMode): Promise<void> {
  try {
    const { loadSettingsStore } = await import('$lib/ipc/settingsStore');
    const store = await loadSettingsStore();
    await store.set(STORE_KEY, mode);
  } catch {
    // Not under Electron (tests, vite preview): the localStorage mirror suffices.
  }
}

function createSidebarMode() {
  const initial = mirroredMode();
  const { subscribe, set: setStore } = writable<SidebarMode>(initial);
  let current = initial;
  let interacted = false;

  function apply(mode: SidebarMode, user: boolean): void {
    current = mode;
    setStore(mode);
    mirrorLocal(mode);
    if (user) {
      interacted = true;
      void persistStore(mode);
    }
  }

  return {
    subscribe,
    set: (mode: SidebarMode) => apply(mode, true),
    /** Reconcile with the canonical settings-store value once the Electron bridge is
     *  reachable (called from the layout's onMount). */
    async hydrate(): Promise<void> {
      try {
        const { loadSettingsStore } = await import('$lib/ipc/settingsStore');
        const store = await loadSettingsStore();
        const saved = await store.get<SidebarMode>(STORE_KEY);
        if (!interacted && (saved === 'ssh' || saved === 'remoteDesktop')) apply(saved, false);
      } catch {
        // Store unreachable: keep the mirrored value.
      }
    }
  };
}

export const sidebarMode = createSidebarMode();
