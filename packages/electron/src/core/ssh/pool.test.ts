import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BackoffState,
  CPU_CMD,
  CPU_MACOS_CMD,
  DISK_CMD,
  MEM_CMD,
  PS_LOCALE,
  RefreshChannel,
  UPTIME_CMD,
  topProcessesCommand,
  waitBackoff,
  waitOrRefresh
} from './pool.js';

// Ported from crates/omnyssh-core/src/ssh/pool.rs's #[cfg(test)] module.

describe('BackoffState', () => {
  it('escalates and only a reset returns it to the first step', () => {
    const backoff = new BackoffState();
    const steps = Array.from({ length: 5 }, () => backoff.nextDelayMs() / 1000);
    expect(steps).toEqual([30, 60, 120, 300, 300]);

    backoff.reset();
    expect(backoff.nextDelayMs() / 1000).toBe(30);
  });
});

describe('metric commands pin the locale', () => {
  it('every command is LC_ALL=C pinned', () => {
    for (const cmd of [CPU_CMD, MEM_CMD, DISK_CMD, UPTIME_CMD, CPU_MACOS_CMD]) {
      expect(cmd.startsWith('env LC_ALL=C '), `unpinned command: ${cmd}`).toBe(true);
    }
    // The `||` fallback needs the prefix on both sides.
    expect(MEM_CMD.split('env LC_ALL=C ').length - 1).toBe(2);
  });
});

describe('topProcessesCommand', () => {
  it('pins numbers but keeps the host CTYPE', () => {
    const cmd = topProcessesCommand('-eo pcpu=');
    // Both `ps` invocations are pinned, so a comma-decimal host still parses.
    expect(cmd.split(PS_LOCALE).length - 1).toBe(2);
    // LC_ALL is cleared rather than set: it outranks LC_NUMERIC, so leaving a
    // host's own LC_ALL in place would defeat the pin. LC_CTYPE still falls
    // through to the host, so process names reach the user verbatim.
    expect(cmd).toContain('LC_ALL=');
    expect(cmd).not.toContain('LC_ALL=C');
    expect(cmd).not.toContain('LC_CTYPE');
  });

  it('excludes the monitoring connection\'s own PID chain', () => {
    const cmd = topProcessesCommand('-eo pid=,ppid=,pcpu=,pmem=,comm= --sort=-pcpu');

    // The grandparent PID is resolved in a substitution that runs before the
    // pipeline does.
    expect(cmd.startsWith('g=$(')).toBe(true);
    expect(cmd).toContain("ps -o ppid= -p $PPID 2>/dev/null | tr -d ' ')");
    // The awk filter binds the shell, its parent sshd and the grandparent.
    expect(cmd).toContain('-v s=$$');
    expect(cmd).toContain('-v p=$PPID');
    expect(cmd).toContain('-v g="$g"');
    expect(cmd).toContain('$1!=s && $1!=p && $1!=g && $2!=s && $2!=p');
    // Filtering is by PID only — never by process name.
    expect(cmd).not.toContain('sshd');
    // Output is capped server-side.
    expect(cmd.trimEnd().endsWith('head -n 3')).toBe(true);
  });

  it('splices the ps args in verbatim', () => {
    const linux = topProcessesCommand('-eo pid=,ppid=,pcpu=,pmem=,comm= --sort=-pcpu');
    expect(linux).toContain('ps -eo pid=,ppid=,pcpu=,pmem=,comm= --sort=-pcpu 2>/dev/null');

    const macos = topProcessesCommand('-Aceo pid=,ppid=,pcpu=,pmem=,comm= -r');
    expect(macos).toContain('ps -Aceo pid=,ppid=,pcpu=,pmem=,comm= -r 2>/dev/null');
  });
});

describe('waitBackoff / waitOrRefresh', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('waitBackoff ignores refresh signals and serves out the full delay', async () => {
    const controller = new AbortController();
    const promise = waitBackoff(300_000, controller.signal);
    await vi.advanceTimersByTimeAsync(299_999);
    let resolved = false;
    void promise.then(() => (resolved = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await promise;
    expect(true).toBe(true);
  });

  it('waitBackoff resolves early when aborted (task shutdown)', async () => {
    const controller = new AbortController();
    const promise = waitBackoff(300_000, controller.signal);
    controller.abort();
    await promise; // must resolve without waiting out the delay
  });

  it('waitOrRefresh serves out its delay with no refresh signal', async () => {
    const controller = new AbortController();
    let resolved = false;
    const promise = waitOrRefresh(300_000, new RefreshChannel(), controller.signal).then(() => (resolved = true));
    await vi.advanceTimersByTimeAsync(299_999);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await promise;
    expect(resolved).toBe(true);
  });

  it('waitOrRefresh still returns early on a refresh signal', async () => {
    const controller = new AbortController();
    const refresh = new RefreshChannel();
    let resolved = false;
    const promise = waitOrRefresh(300_000, refresh, controller.signal).then(() => (resolved = true));
    refresh.fire();
    await vi.advanceTimersByTimeAsync(0);
    expect(resolved).toBe(true);
    await promise;
  });
});
