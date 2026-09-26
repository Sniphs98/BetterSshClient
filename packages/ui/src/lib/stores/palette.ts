import { writable } from 'svelte/store';
import type { SnippetDto, ConnectionStatusDto, HostDto } from '$lib/bindings';
import type { Status } from '$lib/theme';
import type { Session } from './sessions';

// The ⌘K overlay and every action-scoped picker are one component in several modes
// (tech-gui.md §2): `navigate` lists open sessions + hosts (jump to a session, or open
// a host); `pickHost` is scoped to "pick a host for this action" and hands the choice
// back to its caller; `pickSnippet` is the same idea for "pick (or create) an
// Snippet for this automation node" (AutomationEditor.svelte's "+"/drag-to-empty).
export type PaletteMode = 'navigate' | 'pickHost' | 'pickSnippet';

// A selectable row. Sessions surface only in the navigator; a picker mode is scoped to
// its own kind. `newSnippet` is a pinned, always-matching row — not a real
// Snippet — offered first in `pickSnippet` mode so creating one inline never
// needs a separate "no results" state.
export type PaletteItem =
  | { kind: 'session'; session: Session }
  | { kind: 'host'; host: HostDto }
  | { kind: 'snippet'; snippet: SnippetDto }
  | { kind: 'newSnippet' }
  /** Pinned in `pickSnippet` mode too: a built-in upload step instead of a snippet. */
  | { kind: 'uploadStep' };

function hostHaystack(h: HostDto): string {
  return `${h.name} ${h.hostname} ${h.user} ${h.tags.join(' ')}`.toLowerCase();
}

function sessionHaystack(s: Session): string {
  return `${s.hostName} ${s.kind}`.toLowerCase();
}

function snippetHaystack(a: SnippetDto): string {
  return a.name.toLowerCase();
}

// All whitespace-separated tokens must appear (AND), so "web prod" narrows to a host
// tagged prod named web-* — an empty query keeps everything.
function matches(haystack: string, query: string): boolean {
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => haystack.includes(token));
}

/** The filtered, ordered rows for the current mode: sessions first, then hosts (the
 *  host picker drops the sessions); the snippet picker is its own list entirely,
 *  the pinned "new" row always first. Order mirrors the stores so the list is stable. */
export function paletteItems(
  mode: PaletteMode,
  hosts: HostDto[],
  sessions: Session[],
  snippets: SnippetDto[],
  query: string
): PaletteItem[] {
  if (mode === 'pickSnippet') {
    const snippetRows: PaletteItem[] = snippets
      .filter((a) => matches(snippetHaystack(a), query))
      .map((snippet) => ({ kind: 'snippet', snippet }));
    return [{ kind: 'newSnippet' }, { kind: 'uploadStep' }, ...snippetRows];
  }
  const hostRows: PaletteItem[] = hosts
    .filter((h) => matches(hostHaystack(h), query))
    .map((host) => ({ kind: 'host', host }));
  if (mode === 'pickHost') return hostRows;
  const sessionRows: PaletteItem[] = sessions
    .filter((s) => matches(sessionHaystack(s), query))
    .map((session) => ({ kind: 'session', session }));
  return [...sessionRows, ...hostRows];
}

/** A stable key for the current result set — its rows' identity and order, but not
 *  volatile fields like a session's live status. The palette resets its highlight only
 *  when this changes, so a background status flip (which mints fresh item objects with
 *  the same ids) never snaps the selection back to the top mid-navigation. */
export function paletteSignature(items: PaletteItem[]): string {
  return items
    .map((it) => {
      switch (it.kind) {
        case 'session':
          return `s:${it.session.id}`;
        case 'host':
          return `h:${it.host.name}`;
        case 'snippet':
          return `a:${it.snippet.id}`;
        case 'newSnippet':
          return 'new-snippet';
        case 'uploadStep':
          return 'upload-step';
      }
    })
    .join('\u0000');
}

/** Move the selection by `delta`, wrapping at both ends; an empty list stays at 0. */
export function nextIndex(current: number, delta: number, length: number): number {
  if (length === 0) return 0;
  return (((current + delta) % length) + length) % length;
}

// A host reference shows its connection state as a dot (tech-gui.md §2, 1.3), mapped to
// the shared server-state palette. Connecting/not-yet-probed stay neutral; a failed
// host reads offline, matching the status-bar summary's offline bucket.
export function hostStatusDot(status: ConnectionStatusDto | undefined): Status {
  switch (status?.kind) {
    case 'connected':
      return 'ok';
    case 'failed':
      return 'off';
    default:
      return 'unknown';
  }
}

export interface PaletteState {
  open: boolean;
  mode: PaletteMode;
}

/** What `pickSnippet()` resolves with: an existing Snippet, `'upload'` (the pinned
 *  upload-step row), `'new'` (the pinned "new" row was chosen — the caller opens its own add-snippet form), or `null` (dismissed
 *  without choosing). */
export type SnippetPickResult = SnippetDto | 'new' | 'upload' | null;

function createPalette() {
  const { subscribe, set } = writable<PaletteState>({ open: false, mode: 'navigate' });
  // Pending resolvers for whichever picker is in flight — at most one of the two is
  // ever non-null, since only one mode can be open at a time, but both are settled on
  // every open/choose/close so a caller of either never hangs when the palette moves on
  // to something else out from under it (e.g. ⌘K opening the navigator mid-pick).
  let pendingHost: ((host: HostDto | null) => void) | null = null;
  let pendingSnippet: ((result: SnippetPickResult) => void) | null = null;

  function settleAll(): void {
    const host = pendingHost;
    const snippet = pendingSnippet;
    pendingHost = null;
    pendingSnippet = null;
    host?.(null);
    snippet?.(null);
  }

  return {
    subscribe,
    /** ⌘K navigator: jump to an open session or open a host. */
    open(): void {
      settleAll();
      set({ open: true, mode: 'navigate' });
    },
    /** Action-scoped host picker; resolves with the chosen host, or null if dismissed. */
    pickHost(): Promise<HostDto | null> {
      settleAll();
      set({ open: true, mode: 'pickHost' });
      return new Promise((resolve) => (pendingHost = resolve));
    },
    /** Action-scoped Snippet picker (AutomationEditor's "+"/drag-to-empty) — see
     *  `SnippetPickResult`'s doc comment for what it resolves with. */
    pickSnippet(): Promise<SnippetPickResult> {
      settleAll();
      set({ open: true, mode: 'pickSnippet' });
      return new Promise((resolve) => (pendingSnippet = resolve));
    },
    /** Host-picker mode: hand the chosen host back to its caller and close. Captures the
     *  resolver *before* settling the other (idle) one — `settleAll` would otherwise
     *  null this one out too, resolving it with `null` instead of `host`. */
    choose(host: HostDto): void {
      const resolve = pendingHost;
      pendingHost = null;
      pendingSnippet?.(null);
      pendingSnippet = null;
      resolve?.(host);
      set({ open: false, mode: 'navigate' });
    },
    /** Snippet-picker mode: hand the chosen result back to its caller and close. */
    chooseSnippet(result: SnippetDto | 'new' | 'upload'): void {
      const resolve = pendingSnippet;
      pendingSnippet = null;
      pendingHost?.(null);
      pendingHost = null;
      resolve?.(result);
      set({ open: false, mode: 'navigate' });
    },
    close(): void {
      settleAll();
      set({ open: false, mode: 'navigate' });
    }
  };
}

export const palette = createPalette();
