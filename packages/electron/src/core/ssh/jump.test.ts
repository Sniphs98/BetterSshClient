import { describe, expect, it } from 'vitest';

import { defaultHost, type Host } from './client.js';
import { resolveChain } from './jump.js';

// Ported from crates/omnyssh-core/src/ssh/jump.rs's #[cfg(test)] module.
// (parse_jump_spec/parse_hop are private in the Rust source and only tested
// indirectly there via resolve_chain's error cases — same here.)

function host(name: string, hostname: string): Host {
  return { ...defaultHost(), name, hostname, user: 'ops' };
}

function jumping(name: string, hostname: string, via: string): Host {
  return { ...host(name, hostname), proxyJump: via };
}

function names(chain: Host[]): string[] {
  return chain.map((h) => h.name);
}

describe('resolveChain', () => {
  it('no ProxyJump means no chain', () => {
    expect(resolveChain(host('web', '10.0.0.1'), [])).toEqual([]);
  });

  it('ProxyJump none opts out', () => {
    expect(resolveChain(jumping('web', '10.0.0.1', 'none'), [])).toEqual([]);
  });

  it('a blank ProxyJump value also means direct', () => {
    expect(resolveChain(jumping('web', '10.0.0.1', '   '), [])).toEqual([]);
  });

  it('a malformed value fails instead of connecting direct', () => {
    const target = jumping('internal', '192.168.100.50', 'public-proxy:22x');
    expect(() => resolveChain(target, [])).toThrow();
  });

  it('resolves an alias against the known hosts', () => {
    const known = [{ ...host('public-proxy', 'proxy.example.com'), port: 2222, identityFile: '/keys/proxy' }];
    const target = jumping('internal', '192.168.100.50', 'public-proxy');

    const chain = resolveChain(target, known);
    expect(chain).toHaveLength(1);
    expect(chain[0].hostname).toBe('proxy.example.com');
    expect(chain[0].user).toBe('ops');
    expect(chain[0].port).toBe(2222);
    expect(chain[0].identityFile).toBe('/keys/proxy');
  });

  it('a renamed bastion is still found under its original alias', () => {
    let known: Host[] = [{ ...host('Prod Bastion', 'proxy.example.com'), originalSshHost: 'public-proxy' }];
    const target = jumping('internal', '10.0.0.2', 'public-proxy');
    expect(resolveChain(target, known)[0].hostname).toBe('proxy.example.com');

    // An entry that owns the alias outright wins over one that used to.
    known = [
      { ...host('Prod Bastion', 'renamed.example.com'), originalSshHost: 'public-proxy' },
      host('public-proxy', 'proxy.example.com')
    ];
    expect(resolveChain(target, known)[0].hostname).toBe('proxy.example.com');
  });

  it('unknown alias falls back to a literal host', () => {
    const target = jumping('internal', '10.0.0.2', 'jump.example.com');
    const chain = resolveChain(target, []);
    expect(chain).toHaveLength(1);
    expect(chain[0].hostname).toBe('jump.example.com');
    expect(chain[0].port).toBe(22);
  });

  it('explicit user and port override the known entry', () => {
    const known = [{ ...host('public-proxy', 'proxy.example.com'), port: 2222 }];
    const target = jumping('internal', '10.0.0.2', 'admin@public-proxy:2022');

    const chain = resolveChain(target, known);
    expect(chain[0].hostname).toBe('proxy.example.com'); // still inherited
    expect(chain[0].user).toBe('admin');
    expect(chain[0].port).toBe(2022);
  });

  it('a hostname-less entry uses its alias as the address', () => {
    const known = [{ ...host('public-proxy', ''), hostname: '' }];
    const target = jumping('internal', '10.0.0.2', 'public-proxy');
    expect(resolveChain(target, known)[0].hostname).toBe('public-proxy');
  });

  it('multi-hop chains keep connection order', () => {
    const known = [host('first', '10.0.0.1'), host('second', '10.0.0.2')];
    const target = jumping('internal', '10.0.0.3', 'first,second');
    expect(names(resolveChain(target, known))).toEqual(['first', 'second']);
  });

  it('a nested jump host is connected first', () => {
    const known = [host('outer', '10.0.0.1'), jumping('inner', '10.0.0.2', 'outer')];
    const target = jumping('internal', '10.0.0.3', 'inner');

    const chain = resolveChain(target, known);
    expect(names(chain)).toEqual(['outer', 'inner']);
    // Flattened: the caller connects hop by hop and must not re-expand.
    expect(chain.every((h) => h.proxyJump === undefined)).toBe(true);
  });

  it('only the first hop of a list expands its own bastion', () => {
    const known = [host('edge', '10.0.0.1'), host('first', '10.0.0.2'), jumping('second', '10.0.0.3', 'edge')];
    let target = jumping('internal', '10.0.0.4', 'first,second');
    expect(names(resolveChain(target, known))).toEqual(['first', 'second']);

    // …but the first hop's own bastion still applies.
    target = jumping('internal', '10.0.0.4', 'second,first');
    expect(names(resolveChain(target, known))).toEqual(['edge', 'second', 'first']);
  });

  it('a bastion named twice is not a cycle', () => {
    const known = [host('edge', '10.0.0.1'), jumping('inner', '10.0.0.2', 'edge')];

    let target = jumping('internal', '10.0.0.3', 'inner,edge');
    expect(names(resolveChain(target, known))).toEqual(['edge', 'inner', 'edge']);

    target = jumping('internal', '10.0.0.3', 'edge,inner');
    expect(names(resolveChain(target, known))).toEqual(['edge', 'inner']);
  });

  it('a self-referencing jump is rejected', () => {
    const known = [jumping('loop', '10.0.0.1', 'loop')];
    const target = jumping('internal', '10.0.0.2', 'loop');
    expect(() => resolveChain(target, known)).toThrow(/cycle/);
  });

  it('two aliases for one bastion are rejected', () => {
    const known = [jumping('proxy-a', '10.0.0.1', 'proxy-b'), host('proxy-b', '10.0.0.1')];
    const target = jumping('internal', '10.0.0.2', 'proxy-a');
    expect(() => resolveChain(target, known)).toThrow();
  });

  it('a jump back to the target is rejected', () => {
    const known = [jumping('bastion', '10.0.0.1', 'internal')];
    const target = jumping('internal', '10.0.0.2', 'bastion');
    expect(() => resolveChain(target, known)).toThrow();
  });

  it('the hop limit is the boundary it claims', () => {
    const MAX_HOPS = 10;
    const chainOf = (count: number): Host[] => {
      const hopNames = Array.from({ length: count }, (_, i) => `h${i}`);
      const known = hopNames.map((name, i) => host(name, `10.0.0.${i}`));
      const target = jumping('internal', '10.1.0.1', hopNames.join(','));
      return resolveChain(target, known);
    };

    expect(chainOf(MAX_HOPS)).toHaveLength(MAX_HOPS);
    expect(() => chainOf(MAX_HOPS + 1)).toThrow();
  });

  it('a deeply nested chain is rejected before it recurses away', () => {
    const MAX_HOPS = 10;
    const known: Host[] = Array.from({ length: MAX_HOPS * 4 }, (_, i) => jumping(`h${i}`, `10.0.0.${i}`, `h${i + 1}`));
    const target = jumping('internal', '10.1.0.1', 'h0');
    expect(() => resolveChain(target, known)).toThrow(/nested deeper/);
  });

  it('rejects unusable ProxyJump hop specs', () => {
    // Dropping any of these would silently shorten the route. Note: a lone ''
    // hop isn't reachable here — an all-blank value is intercepted earlier by
    // jumpValue's "blank means direct" rule (see the test above) before it
    // would ever reach the hop parser.
    for (const value of [' , ', 'host:not-a-port', 'host:', 'host:70000', 'host:0', 'gw: 2222', 'ops@', '[2001:db8::1]junk:22', 'first,bad:port']) {
      const target = jumping('internal', '10.0.0.1', value);
      expect(() => resolveChain(target, []), `expected '${value}' to be rejected`).toThrow();
    }
  });

  it('parses multi-hop, user/port, and IPv6 specs', () => {
    const known = [host('a', '10.0.0.1'), host('b', '10.0.0.2')];

    const bracketed = resolveChain(jumping('t', '10.0.0.9', 'ops@[2001:db8::1]:2222'), []);
    expect(bracketed[0].hostname).toBe('2001:db8::1');
    expect(bracketed[0].port).toBe(2222);
    expect(bracketed[0].user).toBe('ops');

    const bare = resolveChain(jumping('t', '10.0.0.9', '2001:db8::1'), []);
    expect(bare[0].hostname).toBe('2001:db8::1');
    expect(bare[0].port).toBe(22); // default — no port parsed out of a bare IPv6 literal

    const multi = resolveChain(jumping('t', '10.0.0.9', 'a, ops@b:2222'), known);
    expect(names(multi)).toEqual(['a', 'b']);
    expect(multi[1].port).toBe(2222);
  });
});
