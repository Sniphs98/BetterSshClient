// Which queued SFTP mutations may start now. Ops run side by side only where that can't
// change the outcome:
//
// - Batches run one after another. A batch is what one user action enqueued (upload the
//   marked files, delete the selection, a mkdir, a rename); nothing of a later batch
//   starts while an earlier one still has an op queued or in flight. "Delete x" followed
//   by "upload x" therefore always deletes first.
// - Within a batch, two ops on the same `key` (the path they write) never overlap: the
//   later one waits for the earlier one, in queue order — dropping the same file twice
//   can't race to decide which copy lands.
// - At most `MAX_PARALLEL_OPS` run at once, so a thousand-file batch doesn't open a
//   thousand SFTP file handles on the server.
//
// What this buys is round trips: a batch of small files no longer waits out one full
// request/response per file. A single large file gains nothing — `fastGet`/`fastPut`
// already pipeline its blocks.

import type { PaneSide } from './sftp';

export const MAX_PARALLEL_OPS = 4;

/** The scheduling facts about an op, queued or running. */
export interface Scheduled {
  batch: number;
  key: string;
}

/** The key two ops conflict on: the path an op writes, on its side. Lowercased, because
 *  a case-insensitive filesystem (Windows, macOS) treats `A.txt` and `a.txt` as one file —
 *  over-serializing on a case-sensitive one costs only a little parallelism. */
export function opKey(side: PaneSide, path: string): string {
  return `${side}:${path.toLowerCase()}`;
}

/**
 * The ops in `queued` (in queue order) that may start now, given the ops already
 * `running`. Starting all of them keeps every rule above; call again whenever an op
 * finishes or a batch is enqueued.
 */
export function readyOps<T extends Scheduled>(
  queued: readonly T[],
  running: readonly Scheduled[],
  max: number = MAX_PARALLEL_OPS
): T[] {
  if (queued.length === 0) return [];
  // The oldest unfinished batch is the only one allowed to make progress.
  const batch = Math.min(queued[0].batch, ...running.map((op) => op.batch));
  const taken = new Set(running.map((op) => op.key));
  let slots = max - running.length;
  const ready: T[] = [];
  for (const op of queued) {
    if (slots <= 0 || op.batch !== batch) break;
    // Whether or not this op starts, its key is spoken for: a later op on the same path
    // must not overtake it.
    const busy = taken.has(op.key);
    taken.add(op.key);
    if (busy) continue;
    ready.push(op);
    slots--;
  }
  return ready;
}
