import { writable } from 'svelte/store';

// The app-side source of truth for the active theme (tech-gui.md §5.1). Flipping
// it swaps `data-theme` on the document root — every CSS-variable surface follows
// — then persists the choice (tauri-plugin-store canonical + localStorage mirror
// for the no-FOUC boot) and points the native window decorations at it.
export type Theme = 'light' | 'dark';

const LOCAL_KEY = 'better-ssh-client-theme';
const STORE_KEY = 'theme';

/** The theme the app.html no-FOUC script already painted, so the store agrees
 *  with the first frame. Defaults to dark. */
function paintedTheme(): Theme {
  if (typeof document !== 'undefined') {
    const attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'light' || attr === 'dark') return attr;
  }
  return 'dark';
}

function reflectAttribute(theme: Theme): void {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', theme);
  }
}

function mirrorLocal(theme: Theme): void {
  try {
    localStorage.setItem(LOCAL_KEY, theme);
  } catch {
    // localStorage unavailable (hardened webview): the store copy is canonical.
  }
}

async function persistStore(theme: Theme): Promise<void> {
  try {
    const { loadSettingsStore } = await import('$lib/ipc/settingsStore');
    const store = await loadSettingsStore();
    await store.set(STORE_KEY, theme);
  } catch {
    // Not under Electron (tests, vite preview): the localStorage mirror suffices.
  }
}

function createTheme() {
  const painted = paintedTheme();
  const { subscribe, set: setStore } = writable<Theme>(painted);
  let current = painted;
  let interacted = false;

  // `user` marks a deliberate flip: it writes the canonical store and blocks a
  // late hydrate from reverting it. localStorage is mirrored either way, so the
  // no-FOUC boot always reads the true theme next launch — even after hydrate
  // corrected a stale/evicted mirror.
  function apply(theme: Theme, user: boolean): void {
    current = theme;
    reflectAttribute(theme);
    setStore(theme);
    mirrorLocal(theme);
    if (user) {
      interacted = true;
      void persistStore(theme);
    }
  }

  return {
    subscribe,
    set: (theme: Theme) => apply(theme, true),
    toggle: () => apply(current === 'dark' ? 'light' : 'dark', true),
    /** Reconcile with the canonical settings-store value once the Electron
     *  bridge is reachable (called from the layout's onMount). */
    async hydrate(): Promise<void> {
      try {
        const { loadSettingsStore } = await import('$lib/ipc/settingsStore');
        const store = await loadSettingsStore();
        const saved = await store.get<Theme>(STORE_KEY);
        // Skip if the user already chose during the async load (no clobber).
        if (!interacted && (saved === 'light' || saved === 'dark')) apply(saved, false);
      } catch {
        // Store unreachable: keep the painted/localStorage theme.
      }
    }
  };
}

export const theme = createTheme();
