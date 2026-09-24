/**
 * Shares authenticated SSH connections between the features that talk to the
 * same host — the metrics poller, terminal tabs, SFTP sessions, automation
 * runs — the way OpenSSH's `ControlMaster` does. Opening a terminal on a host
 * the poller is already connected to then costs one channel open (a single
 * round trip) instead of a TCP connect, a key exchange and authentication.
 *
 * Each user holds a `Lease`; a connection closes once its last lease is
 * released. Generic over the connection type so the bookkeeping is testable
 * without a server (see `session.ts` for the real wiring).
 */

/** The part of a connection the pool needs. */
export interface PooledConnection {
  disconnect(): void;
  /** Registers `cb` for when the connection drops (either side). */
  onClose(cb: () => void): void;
}

/**
 * How many leases share one connection before the next one gets a connection
 * of its own. OpenSSH's default `MaxSessions` is 10 channels per connection;
 * a terminal or SFTP lease holds one for its whole life, while the poller's
 * lease briefly holds up to four (metrics, discovery, the macOS follow-ups).
 * Five leases stay under the limit even with the poller at its peak.
 */
export const MAX_LEASES_PER_CONNECTION = 5;

export interface Lease<C> {
  readonly connection: C;
  /** Gives the connection back. Idempotent. */
  release(): void;
  /** Stops handing this connection to new leases (it looks broken); existing
   *  leases keep it until they release. */
  invalidate(): void;
}

interface Entry<C> {
  connection: Promise<C>;
  leases: number;
  /** Still offered to new leases. */
  usable: boolean;
}

export class ConnectionPool<K, C extends PooledConnection> {
  private readonly entries = new Map<string, Entry<C>[]>();

  constructor(
    private readonly keyOf: (target: K) => string,
    private readonly dial: (target: K) => Promise<C>,
    private readonly maxLeases: number = MAX_LEASES_PER_CONNECTION
  ) {}

  /** A lease on a connection to `target` — an existing one with room to
   *  spare, or a freshly dialled one. Concurrent callers share a dial that is
   *  still in flight, and all see its failure if it fails. */
  async acquire(target: K): Promise<Lease<C>> {
    const key = this.keyOf(target);
    let list = this.entries.get(key);
    if (list === undefined) {
      list = [];
      this.entries.set(key, list);
    }

    let entry = list.find((e) => e.usable && e.leases < this.maxLeases);
    if (entry === undefined) {
      const fresh: Entry<C> = { connection: this.dial(target), leases: 0, usable: true };
      list.push(fresh);
      fresh.connection.then(
        (c) => c.onClose(() => this.retire(key, fresh)),
        () => this.retire(key, fresh)
      );
      entry = fresh;
    }

    entry.leases++;
    let connection: C;
    try {
      connection = await entry.connection;
    } catch (e) {
      entry.leases--;
      throw e;
    }
    return this.lease(key, entry, connection);
  }

  /** Stops offering every current connection to new leases — for when the
   *  host configuration changed, so later leases dial with the new settings.
   *  Connections in use stay up until released. */
  invalidateAll(): void {
    for (const [key, list] of [...this.entries]) for (const entry of [...list]) this.retire(key, entry);
  }

  private lease(key: string, entry: Entry<C>, connection: C): Lease<C> {
    let released = false;
    return {
      connection,
      release: () => {
        if (released) return;
        released = true;
        entry.leases--;
        if (entry.leases === 0) {
          this.retire(key, entry);
          connection.disconnect();
        }
      },
      invalidate: () => this.retire(key, entry)
    };
  }

  private retire(key: string, entry: Entry<C>): void {
    entry.usable = false;
    const list = this.entries.get(key);
    if (list === undefined) return;
    const i = list.indexOf(entry);
    if (i !== -1) list.splice(i, 1);
    if (list.length === 0) this.entries.delete(key);
  }
}
