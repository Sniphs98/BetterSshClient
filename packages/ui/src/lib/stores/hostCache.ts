import { writable } from 'svelte/store';

// What a host last told us, kept across restarts so an offline card can still show
// which OS it runs and when it was last reachable. A per-machine convenience, so
// localStorage is enough: losing it just leaves those cards without the extra line.
const KEY = 'remoty-host-cache';

/** How often a host that keeps reporting rewrites its `lastSeen` — metrics arrive every
 *  few seconds, and "last seen" never needs to be more precise than this. */
const LAST_SEEN_RESOLUTION_MS = 60_000;

export type HostCacheEntry = { osInfo?: string; lastSeen: number };

function load(): Map<string, HostCacheEntry> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    const map = new Map<string, HostCacheEntry>();
    if (raw && typeof raw === 'object') {
      for (const [name, value] of Object.entries(raw)) {
        const entry = value as Partial<HostCacheEntry> | null;
        if (typeof entry?.lastSeen !== 'number') continue;
        map.set(name, {
          lastSeen: entry.lastSeen,
          osInfo: typeof entry.osInfo === 'string' ? entry.osInfo : undefined
        });
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

function save(map: Map<string, HostCacheEntry>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(map)));
  } catch {
    // localStorage unavailable: the cache still works for this run.
  }
}

/** The updated entry, or `undefined` when nothing worth storing changed. */
export function nextCacheEntry(
  prev: HostCacheEntry | undefined,
  osInfo: string | null | undefined,
  now: number
): HostCacheEntry | undefined {
  const nextOs = osInfo ?? prev?.osInfo;
  if (prev && prev.osInfo === nextOs && now - prev.lastSeen < LAST_SEEN_RESOLUTION_MS) return undefined;
  return { osInfo: nextOs, lastSeen: now };
}

function createHostCache() {
  let current = load();
  const { subscribe, set } = writable<Map<string, HostCacheEntry>>(current);
  return {
    subscribe,
    /** A host just reported metrics, so it is reachable right now. */
    record(hostName: string, osInfo: string | null | undefined, now = Date.now()): void {
      const entry = nextCacheEntry(current.get(hostName), osInfo, now);
      // Most samples change nothing worth keeping; skip the write and the re-render.
      if (!entry) return;
      current = new Map(current).set(hostName, entry);
      save(current);
      set(current);
    }
  };
}

export const hostCache = createHostCache();
