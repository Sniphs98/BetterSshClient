import { describe, expect, it } from 'vitest';

import { ConnectionPool, type PooledConnection } from './connectionPool.js';

class FakeConnection implements PooledConnection {
  disconnected = false;
  private closeListeners: (() => void)[] = [];

  constructor(readonly id: number) {}

  disconnect(): void {
    this.disconnected = true;
  }

  onClose(cb: () => void): void {
    this.closeListeners.push(cb);
  }

  /** The remote end hung up. */
  drop(): void {
    for (const cb of this.closeListeners) cb();
  }
}

function harness(maxLeases = 3) {
  const dialled: FakeConnection[] = [];
  let failNext = false;
  const pool = new ConnectionPool<string, FakeConnection>(
    (host) => host,
    async () => {
      if (failNext) {
        failNext = false;
        throw new Error('auth failed');
      }
      const c = new FakeConnection(dialled.length);
      dialled.push(c);
      return c;
    },
    maxLeases
  );
  return { pool, dialled, failNextDial: () => (failNext = true) };
}

describe('ConnectionPool', () => {
  it('hands the same connection to every lease for a host', async () => {
    const { pool, dialled } = harness();
    const a = await pool.acquire('web');
    const b = await pool.acquire('web');
    expect(a.connection).toBe(b.connection);
    expect(dialled).toHaveLength(1);
  });

  it('keeps hosts apart', async () => {
    const { pool, dialled } = harness();
    const a = await pool.acquire('web');
    const b = await pool.acquire('db');
    expect(a.connection).not.toBe(b.connection);
    expect(dialled).toHaveLength(2);
  });

  it('shares a dial that is still in flight', async () => {
    const { pool, dialled } = harness();
    const [a, b] = await Promise.all([pool.acquire('web'), pool.acquire('web')]);
    expect(a.connection).toBe(b.connection);
    expect(dialled).toHaveLength(1);
  });

  it('closes the connection only when its last lease is released', async () => {
    const { pool } = harness();
    const a = await pool.acquire('web');
    const b = await pool.acquire('web');
    a.release();
    expect(a.connection.disconnected).toBe(false);
    b.release();
    expect(a.connection.disconnected).toBe(true);
  });

  it('treats a double release as one', async () => {
    const { pool } = harness();
    const a = await pool.acquire('web');
    const b = await pool.acquire('web');
    a.release();
    a.release();
    expect(b.connection.disconnected).toBe(false);
  });

  it('dials afresh once the last lease is gone', async () => {
    const { pool, dialled } = harness();
    (await pool.acquire('web')).release();
    await pool.acquire('web');
    expect(dialled).toHaveLength(2);
  });

  it('opens a second connection once the first is full', async () => {
    const { pool, dialled } = harness(2);
    const a = await pool.acquire('web');
    await pool.acquire('web');
    const c = await pool.acquire('web');
    expect(c.connection).not.toBe(a.connection);
    expect(dialled).toHaveLength(2);
  });

  it('never reuses a connection that dropped', async () => {
    const { pool, dialled } = harness();
    const a = await pool.acquire('web');
    a.connection.drop();
    const b = await pool.acquire('web');
    expect(b.connection).not.toBe(a.connection);
    expect(dialled).toHaveLength(2);
  });

  it('invalidate retires the connection for new leases but not for its holders', async () => {
    const { pool } = harness();
    const a = await pool.acquire('web');
    const b = await pool.acquire('web');
    a.invalidate();
    const c = await pool.acquire('web');
    expect(c.connection).not.toBe(a.connection);
    expect(b.connection.disconnected).toBe(false);
    a.release();
    b.release();
    expect(a.connection.disconnected).toBe(true);
  });

  it('invalidateAll retires every connection', async () => {
    const { pool } = harness();
    const web = await pool.acquire('web');
    const db = await pool.acquire('db');
    pool.invalidateAll();
    expect((await pool.acquire('web')).connection).not.toBe(web.connection);
    expect((await pool.acquire('db')).connection).not.toBe(db.connection);
  });

  it('passes a failed dial to its callers and retries on the next acquire', async () => {
    const { pool, dialled, failNextDial } = harness();
    failNextDial();
    await expect(pool.acquire('web')).rejects.toThrow('auth failed');
    const a = await pool.acquire('web');
    expect(a.connection).toBe(dialled[0]);
  });
});
