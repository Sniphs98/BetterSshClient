import { describe, expect, it } from 'vitest';

import { OutputBatcher, localeEnv } from './pty.js';

// Ported from crates/omnyssh-core/src/ssh/pty.rs's #[cfg(test)] module
// (the locale_env / is_utf8_locale battery — the vt100/session parts have
// no port, see pty.ts's module comment).

function env(pairs: [string, string][]): Map<string, string> {
  return new Map(pairs);
}

function result(pairs: [string, string][]): [string, string][] {
  return pairs;
}

describe('localeEnv', () => {
  it('defaults CTYPE to UTF-8 when there is no locale env at all', () => {
    // A process with no locale env (e.g. a GUI launched from a dock icon)
    // still gets a UTF-8 character type forwarded.
    const got = localeEnv(env([['PATH', '/bin'], ['HOME', '/root']]));
    expect(got).toEqual(result([['LC_CTYPE', 'C.UTF-8']]));
  });

  it('forces UTF-8 when LANG is not UTF-8', () => {
    const got = localeEnv(env([['LANG', 'C']]));
    expect(got).toContainEqual(['LANG', 'C']);
    expect(got).toContainEqual(['LC_CTYPE', 'C.UTF-8']);
  });

  it('keeps a UTF-8 LANG and adds no fallback', () => {
    // Regression guard: a working UTF-8 LANG must not be overridden by a
    // C.UTF-8 the server might not have.
    const got = localeEnv(env([['LANG', 'ru_RU.UTF-8'], ['LC_MESSAGES', 'ru_RU.UTF-8']]));
    expect(got).toContainEqual(['LANG', 'ru_RU.UTF-8']);
    expect(got.every(([k]) => k !== 'LC_CTYPE')).toBe(true);
  });

  it('replaces a non-UTF-8 CTYPE without duplicating it', () => {
    const got = localeEnv(env([['LC_CTYPE', 'C']]));
    expect(got).toEqual(result([['LC_CTYPE', 'C.UTF-8']]));
  });

  it('respects an explicit UTF-8 CTYPE', () => {
    const got = localeEnv(env([['LC_CTYPE', 'ru_RU.UTF-8']]));
    expect(got).toEqual(result([['LC_CTYPE', 'ru_RU.UTF-8']]));
  });

  it('respects LC_ALL, which overrides every category', () => {
    const got = localeEnv(env([['LC_ALL', 'C']]));
    expect(got).toEqual(result([['LC_ALL', 'C']]));
  });

  it('ignores non-locale variables entirely', () => {
    const got = localeEnv(env([['EDITOR', 'vim'], ['LANG', 'en_US.UTF-8']]));
    expect(got).toEqual(result([['LANG', 'en_US.UTF-8']]));
  });
});

describe('OutputBatcher', () => {
  const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  it('merges the chunks of one event-loop turn into a single delivery', async () => {
    const out: string[] = [];
    const batcher = new OutputBatcher((data) => out.push(data.toString()));
    batcher.push(Buffer.from('ab'));
    batcher.push(Buffer.from('cd'));
    expect(out).toEqual([]);
    await nextTurn();
    expect(out).toEqual(['abcd']);
  });

  it('delivers a lone chunk as-is, without waiting past the turn', async () => {
    const out: Buffer[] = [];
    const batcher = new OutputBatcher((data) => out.push(data));
    const chunk = Buffer.from('x');
    batcher.push(chunk);
    await nextTurn();
    expect(out).toEqual([chunk]);
  });

  it('sends a large burst at once instead of holding it', () => {
    const out: number[] = [];
    const batcher = new OutputBatcher((data) => out.push(data.length));
    batcher.push(Buffer.alloc(200 * 1024));
    batcher.push(Buffer.alloc(100 * 1024));
    expect(out).toEqual([300 * 1024]);
  });

  it('flush delivers immediately; discard drops the buffer', async () => {
    const out: string[] = [];
    const batcher = new OutputBatcher((data) => out.push(data.toString()));
    batcher.push(Buffer.from('kept'));
    batcher.flush();
    batcher.push(Buffer.from('dropped'));
    batcher.discard();
    await nextTurn();
    expect(out).toEqual(['kept']);
  });
});
