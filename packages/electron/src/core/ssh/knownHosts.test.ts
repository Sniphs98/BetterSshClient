import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkKnownHosts, learnKnownHost } from './knownHosts.js';

// Not ported from a Rust test file directly (russh's `check_known_hosts` is a
// third-party dependency, not something the Rust source itself unit-tests) —
// this exercises the TOFU policy this module re-implements: known+match →
// accept, unknown → accept, changed → reject.

function fakeKey(algo: string, marker: string): Buffer {
  const algoBuf = Buffer.from(algo, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(algoBuf.length);
  return Buffer.concat([len, algoBuf, Buffer.from(marker, 'utf8')]);
}

describe('known_hosts TOFU', () => {
  let tmp: string;
  let prevHome: string | undefined;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'omnyssh-knownhosts-'));
    prevHome = process.env.HOME;
    process.env.HOME = tmp;
    process.env.USERPROFILE = tmp;
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    await rm(tmp, { recursive: true, force: true });
  });

  it('a host with no known_hosts file at all is unknown', async () => {
    expect(await checkKnownHosts('example.com', 22, fakeKey('ssh-ed25519', 'key-a'))).toBe('unknown');
  });

  it('learning a host, then checking it again, matches', async () => {
    const key = fakeKey('ssh-ed25519', 'key-a');
    expect(await learnKnownHost('example.com', 22, key)).toBe(true);
    expect(await checkKnownHosts('example.com', 22, key)).toBe('known-match');
  });

  it('a different key for the same host is a key-changed rejection', async () => {
    await learnKnownHost('example.com', 22, fakeKey('ssh-ed25519', 'key-a'));
    const changed = fakeKey('ssh-ed25519', 'key-b');
    expect(await checkKnownHosts('example.com', 22, changed)).toBe('key-changed');
  });

  it('a non-default port is bracketed in the recorded pattern, and only matches that port', async () => {
    const key = fakeKey('ssh-ed25519', 'key-a');
    await learnKnownHost('example.com', 2222, key);
    expect(await checkKnownHosts('example.com', 2222, key)).toBe('known-match');
    // The default-port pattern is a different host entry entirely.
    expect(await checkKnownHosts('example.com', 22, key)).toBe('unknown');
  });

  it('a hashed known_hosts entry is invisible to this check (treated as unknown)', async () => {
    const path = join(tmp, '.ssh', 'known_hosts');
    await import('node:fs/promises').then((fs) => fs.mkdir(join(tmp, '.ssh'), { recursive: true }));
    await import('node:fs/promises').then((fs) =>
      fs.writeFile(path, '|1|abcdEFGH1234567890AB=|abcdEFGH1234567890ABCDEFGHabcdefghAB= ssh-ed25519 AAAAfake\n')
    );
    expect(await checkKnownHosts('example.com', 22, fakeKey('ssh-ed25519', 'key-a'))).toBe('unknown');
  });
});
