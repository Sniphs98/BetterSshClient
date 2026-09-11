import type { Host } from './client.js';
import { defaultHost } from './client.js';

/**
 * `ProxyJump` chain resolution. Ported from crates/omnyssh-core/src/ssh/jump.rs.
 *
 * Turns the `proxyJump` value of a `Host` (`bastion`, `ops@jump:2222`,
 * `first,second`, …) into the ordered list of hosts that must be connected
 * before the target, nearest to the local machine first.
 *
 * Each hop is looked up in the known host list — the merged hosts.toml +
 * ~/.ssh/config entries — so a jump alias inherits that entry's hostname,
 * user, port and identityFile, exactly like an `ssh -J` hop resolves through
 * ssh_config. A hop that matches no known entry is used literally as a
 * hostname.
 *
 * Pure and I/O-free: `resolveChain` takes the known hosts as an argument so
 * it can be unit-tested without touching the filesystem.
 */

/** Upper bound on the hops in a resolved chain, and on the depth of the
 *  expansion recursion. Longer chains are almost certainly a configuration
 *  mistake. */
const MAX_HOPS = 10;

interface JumpSpec {
  user?: string;
  host: string;
  port?: number;
}

class JumpChainError extends Error {}

/** The effective `proxyJump` value of `host`, or `undefined` when it connects
 *  directly. Blank values and the OpenSSH `none` opt-out both mean "direct". */
export function jumpValue(host: Host): string | undefined {
  const value = host.proxyJump?.trim();
  if (value === undefined || value === '' || value.toLowerCase() === 'none') return undefined;
  return value;
}

/**
 * Resolves the full jump chain for `target` against the `known` host list.
 *
 * The returned hosts are in connection order: the first entry is reached
 * directly from this machine, each subsequent one through its predecessor,
 * and `target` itself through the last. An empty array means "connect
 * directly" — no ProxyJump, or the OpenSSH `ProxyJump none` opt-out.
 *
 * Every returned host has its own `proxyJump` cleared: the chain is already
 * flattened, so a caller connecting hop by hop must not expand it again.
 *
 * Throws when a hop is unusable, when the chain references itself (a cycle),
 * or when it exceeds `MAX_HOPS` hops. A host that names a bastion never
 * resolves to an empty chain: failing is the only alternative to connecting
 * straight to the target, past the bastion that is its only route.
 */
export function resolveChain(target: Host, known: Host[]): Host[] {
  const spec = jumpValue(target);
  if (spec === undefined) return [];

  const walk = new Walk();
  // Seed with the target so `A -> B -> A` is caught as the cycle it is.
  walk.active = [target];
  walk.expand(spec, known);
  return walk.chain;
}

class Walk {
  /** Hops resolved so far, in connection order. */
  chain: Host[] = [];
  /** Hops whose own ProxyJump is being expanded right now, plus the target
   *  that started the walk. Re-entering one of these is a cycle; the length
   *  is the recursion depth. */
  active: Host[] = [];

  /**
   * Appends the hops of `spec` to the chain, nearest hop first.
   *
   * Only the *first* hop of a list carries bastions of its own. That is what
   * `ssh` does: for `ProxyJump a,b` it reaches `b` with `-J a` on the command
   * line, and a command-line jump list makes it ignore `b`'s own configured
   * ProxyJump. `a` is then reached by a plain `ssh`, which does read its
   * ProxyJump — so nested bastions still work, one level in from each list.
   */
  expand(spec: string, known: Host[]): void {
    const hops = parseJumpSpec(spec);

    hops.forEach((hop, index) => {
      const host = resolveHop(hop, known);

      if (this.active.some((h) => sameHop(h, host))) {
        throw new JumpChainError(`ProxyJump cycle detected at '${host.name}'`);
      }
      const nested = index === 0 ? jumpValue(host) : undefined;
      if (nested !== undefined) {
        if (this.active.length > MAX_HOPS) {
          throw new JumpChainError(`ProxyJump chain nested deeper than ${MAX_HOPS} hops`);
        }
        this.active.push(host);
        try {
          this.expand(nested, known);
        } finally {
          this.active.pop();
        }
      }

      if (this.chain.length >= MAX_HOPS) {
        throw new JumpChainError(`ProxyJump chain longer than ${MAX_HOPS} hops`);
      }
      host.proxyJump = undefined;
      this.chain.push(host);
    });
  }
}

/** Whether two hops are the same machine — the same alias, or the same
 *  endpoint reached under a second name. Only ever asked of hops still being
 *  expanded, so a match is a back-edge, not a repetition. */
function sameHop(a: Host, b: Host): boolean {
  return a.name === b.name || (a.user === b.user && a.hostname === b.hostname && a.port === b.port);
}

/**
 * Turns one parsed hop into a connectable `Host`.
 *
 * A hop naming a known entry inherits all of its connection settings;
 * anything else becomes a bare host with default user and port. An explicit
 * `user@` or `:port` in the spec always wins over the inherited value.
 */
function resolveHop(spec: JumpSpec, known: Host[]): Host {
  // A host imported from ~/.ssh/config and then renamed keeps its original
  // alias, which is still what every other entry's ProxyJump names — but an
  // entry that carries the alias as its own name comes first.
  const entry = known.find((h) => h.name === spec.host) ?? known.find((h) => h.originalSshHost === spec.host);

  const host: Host = entry ? { ...entry } : { ...defaultHost(), name: spec.host, hostname: spec.host };

  if (spec.user !== undefined) host.user = spec.user;
  if (spec.port !== undefined) host.port = spec.port;
  // A known entry may omit hostname; the alias is then the address (the same
  // fallback the ssh_config parser applies).
  if (host.hostname === '') host.hostname = host.name;
  return host;
}

/** Splits a ProxyJump value into its comma-separated hops, nearest first.
 *  An unusable hop fails the whole value: dropping it would shorten the
 *  route, and dropping the only hop would connect straight to the target —
 *  past the bastion the value exists to name. */
function parseJumpSpec(value: string): JumpSpec[] {
  return value.split(',').map(parseHop);
}

/** Parses a single `[user@]host[:port]` hop. Bracketed IPv6 literals
 *  (`[2001:db8::1]:2222`) are supported, matching `ssh -J`. */
function parseHop(rawHop: string): JumpSpec {
  const hop = rawHop.trim();
  if (hop === '') throw new JumpChainError('empty ProxyJump hop');

  // Split on the last '@': a username cannot contain one, a host never does.
  const at = hop.lastIndexOf('@');
  const user = at > 0 ? hop.slice(0, at) : undefined;
  const rest = at > 0 ? hop.slice(at + 1) : hop;

  let hostPort: [string, number | undefined];
  try {
    hostPort = splitHostPort(rest);
  } catch (e) {
    throw new JumpChainError(`unusable ProxyJump hop '${hop}': ${(e as Error).message}`);
  }
  const [host, port] = hostPort;
  if (host === '') throw new JumpChainError(`ProxyJump hop '${hop}' has no host`);
  return { user, host, port };
}

/** Splits `host`, `host:port`, `[v6]` or `[v6]:port` into its two parts. */
function splitHostPort(rest: string): [string, number | undefined] {
  if (rest.startsWith('[')) {
    const end = rest.indexOf(']');
    if (end !== -1) {
      const host = rest.slice(1, end);
      const trailer = rest.slice(end + 1);
      if (trailer === '') return [host, undefined];
      if (!trailer.startsWith(':')) throw new Error(`trailing '${trailer}' after ']'`);
      return [host, parsePort(trailer.slice(1))];
    }
  }
  // An unbracketed colon separates the port only when it is the sole one; a
  // bare IPv6 literal has several and carries no port.
  const firstColon = rest.indexOf(':');
  if (firstColon !== -1 && rest.indexOf(':', firstColon + 1) === -1) {
    return [rest.slice(0, firstColon), parsePort(rest.slice(firstColon + 1))];
  }
  return [rest, undefined];
}

/** Parses a hop's port. Zero is rejected the way `ssh` rejects it — it can
 *  never name a listening service. */
function parsePort(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`'${value}' is not a valid port`);
  const port = Number.parseInt(value, 10);
  if (port === 0 || port > 65535) throw new Error(`'${value}' is not a valid port`);
  return port;
}
