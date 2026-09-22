import { writable } from 'svelte/store';

// Terminal mouse behaviour. Which one people expect is genuinely split — PuTTY and
// most X11 terminals paste on right-click and copy the moment you select, while
// Windows Terminal and the JetBrains/VS Code terminals open a menu — so both are
// offered rather than picked for the user. Persisted like every other UI pref here:
// canonical value in the settings store, mirrored to localStorage so the first paint
// already has it (see `stores/ui.ts` for the original of this shape).

/** What a right-click inside a terminal does. */
export type TerminalRightClick = 'menu' | 'paste';

const RIGHT_CLICK_LOCAL_KEY = 'omnyssh-terminal-right-click';
const RIGHT_CLICK_STORE_KEY = 'terminalRightClick';
const COPY_ON_SELECT_LOCAL_KEY = 'omnyssh-terminal-copy-on-select';
const COPY_ON_SELECT_STORE_KEY = 'terminalCopyOnSelect';

async function settingsStore() {
  const { loadSettingsStore } = await import('$lib/ipc/settingsStore');
  return loadSettingsStore();
}

/** The shared persistence shape, kept local to this module rather than refactored
 *  across the existing pref stores: read the localStorage mirror synchronously for the
 *  first paint, write both layers on a user change, and let a late `hydrate()` reconcile
 *  with the canonical store unless the user has already touched it. */
function createPref<T>(localKey: string, storeKey: string, parse: (raw: unknown) => T | undefined, fallback: T) {
  function mirrored(): T {
    try {
      const raw = localStorage.getItem(localKey);
      return raw == null ? fallback : (parse(raw) ?? fallback);
    } catch {
      return fallback;
    }
  }

  const initial = mirrored();
  const { subscribe, set: setStore } = writable<T>(initial);
  let interacted = false;

  function apply(value: T, user: boolean): void {
    setStore(value);
    try {
      localStorage.setItem(localKey, String(value));
    } catch {
      // localStorage unavailable (hardened webview): the store copy is canonical.
    }
    if (user) {
      interacted = true;
      void settingsStore()
        .then((store) => store.set(storeKey, value))
        .catch(() => {
          // Not under Electron (tests, vite preview): the mirror suffices.
        });
    }
  }

  return {
    subscribe,
    set: (value: T) => apply(value, true),
    async hydrate(): Promise<void> {
      try {
        const store = await settingsStore();
        const saved = parse(await store.get<unknown>(storeKey));
        if (!interacted && saved !== undefined) apply(saved, false);
      } catch {
        // Store unreachable: keep the mirrored value.
      }
    }
  };
}

function parseRightClick(raw: unknown): TerminalRightClick | undefined {
  return raw === 'paste' || raw === 'menu' ? raw : undefined;
}

function parseBoolean(raw: unknown): boolean | undefined {
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return undefined;
}

/** Defaults to the menu: it's the discoverable option, and a stray right-click can't
 *  dump the clipboard into a live shell. */
export const terminalRightClick = createPref<TerminalRightClick>(
  RIGHT_CLICK_LOCAL_KEY,
  RIGHT_CLICK_STORE_KEY,
  parseRightClick,
  'menu'
);

/** Defaults on — selecting to copy is what most terminals do, and it only ever writes
 *  text the user just highlighted themselves. */
export const terminalCopyOnSelect = createPref<boolean>(
  COPY_ON_SELECT_LOCAL_KEY,
  COPY_ON_SELECT_STORE_KEY,
  parseBoolean,
  true
);
