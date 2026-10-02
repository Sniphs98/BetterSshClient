import { writable } from 'svelte/store';

// Which dashboard sections are collapsed (keys from screens/dashboardSections.ts). A
// per-machine view preference, so localStorage is enough: losing it just opens every
// section again. The Remote Desktop screen has its own set under its own key.
function load(storageKey: string): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
    return new Set(Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string') : []);
  } catch {
    return new Set();
  }
}

function save(storageKey: string, keys: Set<string>): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify([...keys]));
  } catch {
    // localStorage unavailable: collapsing still works for this run.
  }
}

function createCollapsedSections(storageKey: string) {
  const { subscribe, update } = writable<Set<string>>(load(storageKey));
  return {
    subscribe,
    toggle(key: string): void {
      update((keys) => {
        const next = new Set(keys);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        save(storageKey, next);
        return next;
      });
    }
  };
}

export const collapsedSections = createCollapsedSections('remoty-dashboard-collapsed');
export const rdpCollapsedSections = createCollapsedSections('remoty-rdp-collapsed');

// The dashboard's folders, kept so a folder stays until it's removed — also while it
// has no host in it (just made with "New folder", or its last card dragged out). A
// host's own `folder` still decides where its card goes; this only keeps the empty
// sections. Saved in the settings store, since it's the user's organisation rather than
// a view preference. The Remote Desktop screen keeps its folders apart, under its own key.

async function settings() {
  const { loadSettingsStore } = await import('$lib/ipc/settingsStore');
  return loadSettingsStore();
}

function createKeptFolders(settingsKey: string) {
  const { subscribe, update } = writable<string[]>([]);
  let loading: Promise<void> | undefined;

  function persist(folders: string[]): void {
    void settings()
      .then((s) => s.set(settingsKey, folders))
      .catch(() => {
        // No Electron bridge (tests): kept for this run only.
      });
  }

  /** Reads the saved list, once. */
  function load(): Promise<void> {
    loading ??= (async () => {
      try {
        const saved = await (await settings()).get<unknown>(settingsKey);
        if (Array.isArray(saved)) {
          update(() => [...new Set(saved.filter((f): f is string => typeof f === 'string' && f.trim() !== ''))]);
        }
      } catch {
        // No Electron bridge: start empty.
      }
    })();
    return loading;
  }

  // Every change waits for the saved list, so an early one can't overwrite it.
  function change(fn: (folders: string[]) => string[]): void {
    void load().then(() =>
      update((folders) => {
        const next = fn(folders);
        if (next.length === folders.length && next.every((f, i) => f === folders[i])) return folders;
        persist(next);
        return next;
      })
    );
  }

  return {
    subscribe,
    load,
    add(name: string): void {
      change((folders) => (folders.includes(name.trim()) ? folders : [...folders, name.trim()]));
    },
    /** Keeps every folder hosts are in, so it outlives its last card. */
    keepAll(names: string[]): void {
      change((folders) => {
        const missing = names.filter((n) => !folders.includes(n));
        return missing.length > 0 ? [...folders, ...missing] : folders;
      });
    },
    remove(name: string): void {
      change((folders) => folders.filter((f) => f !== name));
    }
  };
}

export const keptFolders = createKeptFolders('dashboardFolders');
export const rdpKeptFolders = createKeptFolders('remoteDesktopFolders');
