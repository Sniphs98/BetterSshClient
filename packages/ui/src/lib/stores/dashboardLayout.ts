import { writable } from 'svelte/store';

// Which dashboard sections are collapsed (keys from screens/dashboardSections.ts). A
// per-machine view preference, so localStorage is enough: losing it just opens every
// section again.
const KEY = 'better-ssh-client-dashboard-collapsed';

function load(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return new Set(Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string') : []);
  } catch {
    return new Set();
  }
}

function save(keys: Set<string>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...keys]));
  } catch {
    // localStorage unavailable: collapsing still works for this run.
  }
}

function createCollapsedSections() {
  const { subscribe, update } = writable<Set<string>>(load());
  return {
    subscribe,
    toggle(key: string): void {
      update((keys) => {
        const next = new Set(keys);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        save(next);
        return next;
      });
    }
  };
}

export const collapsedSections = createCollapsedSections();
