import { describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import type { FileEntryDto } from '$lib/bindings';
import {
  sftp,
  newSession,
  applyListing,
  toggleMark,
  selectOnly,
  selectRange,
  clearMarks,
  markedEntries,
  mergeRefresh,
  applyProgress,
  applyOpDone,
  formatBytes,
  type Pane,
  type PendingOp,
  type SftpSession
} from './sftp';

const op = (id: number, kind: PendingOp['kind'], name?: string): PendingOp => ({
  id,
  kind,
  name,
  refresh: 'remote',
  batch: 1,
  key: `remote:/${name ?? id}`
});

// The dual-pane browser's navigation/marking/transfer logic lives as pure reducers so
// it is unit-testable without a Tauri runtime (tech-gui.md §3.2, §6.4).

function entry(name: string, isDir = false, size = 0): FileEntryDto {
  return { name, path: `/srv/${name}`, size, isDir };
}

function paneWith(entries: FileEntryDto[], marked: string[] = []): Pane {
  return { path: '/srv', entries, loading: false, marked: new Set(marked) };
}

describe('sftp reducers', () => {
  it('starts a session connecting with both panes empty and loading', () => {
    const s = newSession('web-1');
    expect(s.status).toBe('connecting');
    expect(s.local.loading).toBe(true);
    expect(s.remote.loading).toBe(true);
    expect(s.local.entries).toEqual([]);
    expect(s.pending).toEqual([]);
  });

  it('applyListing replaces entries at a path and clears marks + loading', () => {
    const pane = paneWith([entry('a')], ['/srv/a']);
    const next = applyListing(pane, '/etc', [entry('b'), entry('c')]);
    expect(next.path).toBe('/etc');
    expect(next.entries.map((e) => e.name)).toEqual(['b', 'c']);
    expect(next.loading).toBe(false);
    // Navigating clears the previous directory's marks.
    expect(next.marked.size).toBe(0);
  });

  it('toggleMark marks and unmarks, and markedEntries keeps listing order', () => {
    let pane = paneWith([entry('a'), entry('b'), entry('c')]);
    pane = toggleMark(pane, '/srv/c');
    pane = toggleMark(pane, '/srv/a');
    expect(markedEntries(pane).map((e) => e.name)).toEqual(['a', 'c']);
    // Toggling an already-marked path removes it.
    pane = toggleMark(pane, '/srv/a');
    expect(markedEntries(pane).map((e) => e.name)).toEqual(['c']);
  });

  it('toggleMark sets the anchor to the touched entry, for a later shift-click', () => {
    let pane = paneWith([entry('a'), entry('b'), entry('c')]);
    pane = toggleMark(pane, '/srv/b');
    expect(pane.anchor).toBe('/srv/b');
  });

  it('selectOnly replaces the whole selection with one entry and anchors there', () => {
    let pane = paneWith([entry('a'), entry('b'), entry('c')], ['/srv/a', '/srv/c']);
    pane = selectOnly(pane, '/srv/b');
    expect(markedEntries(pane).map((e) => e.name)).toEqual(['b']);
    expect(pane.anchor).toBe('/srv/b');
  });

  it('selectRange selects the contiguous run from the anchor to the clicked entry, forward', () => {
    let pane = paneWith([entry('a'), entry('b'), entry('c'), entry('d')]);
    pane = selectOnly(pane, '/srv/a');
    pane = selectRange(pane, '/srv/c');
    expect(markedEntries(pane).map((e) => e.name)).toEqual(['a', 'b', 'c']);
    // The anchor stays put, so a second shift-click re-ranges from the same origin.
    expect(pane.anchor).toBe('/srv/a');
  });

  it('selectRange works backward from the anchor too', () => {
    let pane = paneWith([entry('a'), entry('b'), entry('c'), entry('d')]);
    pane = selectOnly(pane, '/srv/d');
    pane = selectRange(pane, '/srv/b');
    expect(markedEntries(pane).map((e) => e.name)).toEqual(['b', 'c', 'd']);
  });

  it('selectRange replaces, not extends, a prior discontiguous selection', () => {
    let pane = paneWith([entry('a'), entry('b'), entry('c'), entry('d')]);
    pane = toggleMark(pane, '/srv/d'); // an unrelated prior mark, also sets anchor to d
    pane = selectOnly(pane, '/srv/a'); // fresh anchor
    pane = selectRange(pane, '/srv/b');
    expect(markedEntries(pane).map((e) => e.name)).toEqual(['a', 'b']);
  });

  it('selectRange with no prior anchor falls back to a plain select', () => {
    let pane = paneWith([entry('a'), entry('b'), entry('c')]);
    pane = selectRange(pane, '/srv/b');
    expect(markedEntries(pane).map((e) => e.name)).toEqual(['b']);
    expect(pane.anchor).toBe('/srv/b');
  });

  it('clearMarks empties the selection', () => {
    let pane = paneWith([entry('a'), entry('b')], ['/srv/a', '/srv/b']);
    pane = clearMarks(pane);
    expect(pane.marked.size).toBe(0);
  });

  it('applyListing resets the anchor along with the marks (a new directory)', () => {
    let pane = paneWith([entry('a')]);
    pane = selectOnly(pane, '/srv/a');
    const next = applyListing(pane, '/etc', [entry('b')]);
    expect(next.anchor).toBeUndefined();
  });

  it('mergeRefresh widens two different sides to both', () => {
    expect(mergeRefresh(undefined, 'remote')).toBe('remote');
    expect(mergeRefresh('remote', 'remote')).toBe('remote');
    expect(mergeRefresh('local', 'remote')).toBe('both');
    expect(mergeRefresh('both', 'local')).toBe('both');
  });

  it('applyProgress binds a tick to the op it names', () => {
    const s: SftpSession = {
      ...newSession('web-1'),
      pending: [op(1, 'upload', 'a.txt'), op(2, 'upload', 'b.txt')]
    };
    const next = applyProgress(s, { sessionId: 1, transferId: 9, opId: 2, done: 50, total: 100 });
    expect(next.transfers).toEqual([{ opId: 2, kind: 'upload', name: 'b.txt', done: 50, total: 100 }]);
  });

  it('applyProgress updates a running transfer in place and keeps the others', () => {
    let s: SftpSession = { ...newSession('web-1'), pending: [op(1, 'upload', 'a'), op(2, 'download', 'b')] };
    s = applyProgress(s, { sessionId: 1, transferId: 1, opId: 1, done: 1, total: 10 });
    s = applyProgress(s, { sessionId: 1, transferId: 2, opId: 2, done: 2, total: 20 });
    s = applyProgress(s, { sessionId: 1, transferId: 1, opId: 1, done: 5, total: 10 });
    expect(s.transfers.map((t) => [t.name, t.done])).toEqual([
      ['a', 5],
      ['b', 2]
    ]);
  });

  it('applyProgress drops a tick for a finished op or a non-transfer', () => {
    const s: SftpSession = { ...newSession('web-1'), pending: [op(1, 'mkdir')] };
    expect(applyProgress(s, { sessionId: 1, transferId: 9, opId: 1, done: 1, total: 2 }).transfers).toEqual([]);
    expect(applyProgress(s, { sessionId: 1, transferId: 9, opId: 7, done: 1, total: 2 }).transfers).toEqual([]);
  });

  it('applyOpDone removes the op it names, records its refresh, and clears its transfer', () => {
    const s: SftpSession = {
      ...newSession('web-1'),
      pending: [op(1, 'upload', 'a'), op(2, 'upload', 'b')],
      transfers: [
        { opId: 1, kind: 'upload', name: 'a', done: 1, total: 9 },
        { opId: 2, kind: 'upload', name: 'b', done: 9, total: 9 }
      ]
    };
    const next = applyOpDone(s, true, undefined, 2);
    expect(next.pending.map((p) => p.id)).toEqual([1]);
    expect(next.transfers.map((t) => t.opId)).toEqual([1]);
    expect(next.refresh).toBe('remote');
    expect(next.error).toBeUndefined();
  });

  it('applyOpDone ignores an op-done for an op it does not know', () => {
    const s: SftpSession = { ...newSession('web-1'), pending: [op(1, 'delete', 'x')] };
    expect(applyOpDone(s, true, undefined, 42)).toBe(s);
  });

  it('applyOpDone falls back to the oldest op for an event without an id', () => {
    const s: SftpSession = { ...newSession('web-1'), pending: [op(1, 'delete', 'x'), op(2, 'delete', 'y')] };
    expect(applyOpDone(s, true).pending.map((p) => p.id)).toEqual([2]);
  });

  it('applyOpDone surfaces the error message on failure', () => {
    const s: SftpSession = { ...newSession('web-1'), pending: [op(1, 'delete', 'x')] };
    const next = applyOpDone(s, false, 'permission denied', 1);
    expect(next.error).toBe('permission denied');
    expect(next.pending).toEqual([]);
  });

  it('applyOpDone keeps a prior op error on a later success (no mid-batch masking)', () => {
    // A batch of [delete non-empty folder (fails), delete sibling (ok)] must not let the
    // sibling's success hide the folder's failure — the error persists.
    let s: SftpSession = {
      ...newSession('web-1'),
      pending: [op(1, 'delete', 'logs'), op(2, 'delete', 'notes.txt')]
    };
    s = applyOpDone(s, false, 'directory not empty', 1);
    expect(s.error).toBe('directory not empty');
    s = applyOpDone(s, true, undefined, 2);
    expect(s.error).toBe('directory not empty');
    expect(s.pending).toEqual([]);
  });

  it('ties progress and op-done to the right file when they arrive out of order', () => {
    // A and B run side by side; B finishes first. Arrival order must not matter — each
    // event names its op, so B's completion never ends A's transfer or vice versa.
    let s: SftpSession = { ...newSession('web-1'), pending: [op(1, 'upload', 'A'), op(2, 'upload', 'B')] };
    s = applyProgress(s, { sessionId: 1, transferId: 2, opId: 2, done: 3, total: 3 });
    s = applyProgress(s, { sessionId: 1, transferId: 1, opId: 1, done: 5, total: 10 });
    s = applyOpDone(s, false, 'disk full', 2);
    expect(s.transfers.map((t) => t.name)).toEqual(['A']);
    expect(s.pending.map((p) => p.name)).toEqual(['A']);
    expect(s.error).toBe('disk full');
    s = applyOpDone(s, true, undefined, 1);
    expect(s.pending).toEqual([]);
    expect(s.transfers).toEqual([]);
    expect(s.error).toBe('disk full');
  });

  it('formatBytes is human readable', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

describe('sftp store', () => {
  it('keeps concurrent sessions isolated and prunes on close', () => {
    sftp.open(1, 'web-1');
    sftp.open(2, 'db-1');
    sftp.listing(1, 'remote', '/a', [entry('one')]);
    sftp.listing(2, 'remote', '/b', [entry('two'), entry('three')]);

    expect(get(sftp).get(1)?.remote.path).toBe('/a');
    expect(get(sftp).get(1)?.remote.entries).toHaveLength(1);
    // A listing for tab 1 never leaks into tab 2 — the store is keyed by session id.
    expect(get(sftp).get(2)?.remote.path).toBe('/b');
    expect(get(sftp).get(2)?.remote.entries).toHaveLength(2);

    sftp.remove(1);
    expect(get(sftp).has(1)).toBe(false);
    expect(get(sftp).has(2)).toBe(true);
    sftp.remove(2);
  });

  it('ignores mutations targeting an unknown (closed) session', () => {
    sftp.listing(999, 'remote', '/gone', [entry('x')]);
    expect(get(sftp).has(999)).toBe(false);
  });

  it('clearError drops a lingering batch error when a new batch is enqueued', () => {
    sftp.open(1, 'web-1');
    sftp.pushOp(1, op(1, 'delete', 'logs'));
    sftp.opDone(1, false, 'directory not empty', 1);
    expect(get(sftp).get(1)?.error).toBe('directory not empty');
    sftp.clearError(1);
    expect(get(sftp).get(1)?.error).toBeUndefined();
    sftp.remove(1);
  });

  it('sessionError clears the remote pane loading so a failed listing never sticks, but leaves a live local load', () => {
    sftp.open(1, 'web-1');
    sftp.beginLoading(1, 'remote');
    sftp.beginLoading(1, 'local');
    sftp.sessionError(1, 'ListDir failed: connection reset');
    const s = get(sftp).get(1);
    expect(s?.error).toBe('ListDir failed: connection reset');
    expect(s?.remote.loading).toBe(false);
    // A remote failure must not drop a legitimately in-flight local listing's spinner.
    expect(s?.local.loading).toBe(true);
    sftp.remove(1);
  });
});
