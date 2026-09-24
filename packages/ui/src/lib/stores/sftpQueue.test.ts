import { describe, expect, it } from 'vitest';
import { opKey, readyOps } from './sftpQueue';

const op = (id: string, batch: number, key = id) => ({ id, batch, key });
const ids = (ops: { id: string }[]) => ops.map((o) => o.id);

describe('readyOps', () => {
  it('starts independent ops of one batch side by side, up to the limit', () => {
    const queued = [op('a', 1), op('b', 1), op('c', 1), op('d', 1), op('e', 1)];
    expect(ids(readyOps(queued, [], 4))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('counts running ops against the limit', () => {
    const queued = [op('c', 1), op('d', 1)];
    expect(ids(readyOps(queued, [op('a', 1), op('b', 1), op('x', 1)], 4))).toEqual(['c']);
    expect(readyOps(queued, [op('a', 1), op('b', 1), op('x', 1), op('y', 1)], 4)).toEqual([]);
  });

  it('holds a later batch until the earlier one has fully finished', () => {
    // "delete x" then "upload x": the upload waits even though a slot is free.
    const queued = [op('upload-x', 2, 'remote:/x')];
    expect(readyOps(queued, [op('delete-x', 1, 'remote:/x')])).toEqual([]);
    expect(readyOps(queued, [op('delete-y', 1, 'remote:/y')])).toEqual([]);
    expect(ids(readyOps(queued, []))).toEqual(['upload-x']);
  });

  it('never starts a later batch in the same call as an earlier one', () => {
    const queued = [op('a', 1), op('b', 2)];
    expect(ids(readyOps(queued, []))).toEqual(['a']);
  });

  it('serializes ops on the same path within a batch, in queue order', () => {
    const queued = [op('first', 1, 'remote:/a'), op('other', 1, 'remote:/b'), op('second', 1, 'remote:/a')];
    expect(ids(readyOps(queued, []))).toEqual(['first', 'other']);
    // Once `first` is running, `second` still waits for it.
    expect(readyOps([op('second', 1, 'remote:/a')], [op('first', 1, 'remote:/a')])).toEqual([]);
  });

  it('keeps a same-path op from overtaking an earlier one still in the queue', () => {
    // `a1` can't start (its path is busy), so `a2` behind it on the same path waits too.
    const queued = [op('a1', 1, 'k'), op('a2', 1, 'k')];
    expect(readyOps(queued, [op('running', 1, 'k')])).toEqual([]);
  });

  it('starts nothing for an empty queue', () => {
    expect(readyOps([], [op('a', 1)])).toEqual([]);
  });
});

describe('opKey', () => {
  it('separates the two sides and ignores case', () => {
    expect(opKey('remote', '/A.txt')).toBe(opKey('remote', '/a.txt'));
    expect(opKey('remote', '/a.txt')).not.toBe(opKey('local', '/a.txt'));
  });
});
