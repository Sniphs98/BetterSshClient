import { connect as netConnect } from 'node:net';

import type { Host } from './client.js';
import {
  parseCpuProcStat,
  parseCpuTop,
  parseCpuTopMacos,
  parseDiskDf,
  parseLoadavg,
  parseRamFree,
  parseRamVmstat,
  parseTopProcesses,
  parseUptime,
  type ProcessInfo
} from './metrics.js';
import { SshSession } from './session.js';
import { quickScan } from './discovery.js';
import type { CoreEvent, Metrics } from '../../event.js';

/**
 * Background metrics polling pool. Ported from
 * crates/omnyssh-core/src/ssh/pool.rs. Each host gets its own long-lived
 * async loop that manages its SSH connection and collects metrics at a
 * configurable interval, with exponential backoff on failure.
 */

// ---------------------------------------------------------------------------
// Backoff schedule
// ---------------------------------------------------------------------------

const BACKOFF_SECS = [30, 60, 120, 300] as const;

export class BackoffState {
  private step = 0;

  nextDelayMs(): number {
    const secs = BACKOFF_SECS[this.step];
    this.step = Math.min(this.step + 1, BACKOFF_SECS.length - 1);
    return secs * 1000;
  }

  reset(): void {
    this.step = 0;
  }
}

// ---------------------------------------------------------------------------
// Metric commands
// ---------------------------------------------------------------------------

// Metric output is machine-parsed, so the locale has to be pinned: a server set
// to a comma-decimal language prints "99,1 id" and "Speicher:", which the parsers
// read as garbage or not at all.
export const CPU_CMD = 'env LC_ALL=C top -bn1 2>/dev/null | head -5';
export const MEM_CMD = 'env LC_ALL=C free -b 2>/dev/null || env LC_ALL=C vm_stat 2>/dev/null';
export const DISK_CMD = 'env LC_ALL=C df -k / 2>/dev/null';
export const UPTIME_CMD = 'env LC_ALL=C uptime 2>/dev/null';
export const CPU_MACOS_CMD = "env LC_ALL=C top -l 1 -n 0 2>/dev/null | grep 'CPU usage'";
// `ps` output reaches the user, so keep the host's LC_CTYPE: under a full
// `LC_ALL=C` GNU ps replaces every non-ASCII byte of a process name with '?'.
export const PS_LOCALE = 'env LC_ALL= LC_NUMERIC=C LC_MESSAGES=C';

/**
 * Builds the remote shell command that lists the top processes by CPU with
 * the monitoring connection's own process chain removed. `psArgs` selects
 * the OS-specific `ps` columns and sort order.
 *
 * The pipeline runs inside an SSH-spawned shell whose own processes — and
 * the `sshd` hosting the connection — would otherwise dominate the snapshot
 * on an idle server. The `awk` filter drops them strictly by PID:
 * - `s` (`$$`) — the shell, and everything it forked (`ps`, `awk`, `head`);
 * - `p` (`$PPID`) — the connection's `sshd`, and its children;
 * - `g` — the privileged `sshd` one level up (parent of `$PPID`).
 *
 * Filtering is by PID only, never by process name. POSIX-sh syntax — a
 * non-Bourne login shell simply yields no output.
 */
export function topProcessesCommand(psArgs: string): string {
  return (
    `g=$(${PS_LOCALE} ps -o ppid= -p $PPID 2>/dev/null | tr -d ' '); ` +
    `${PS_LOCALE} ps ${psArgs} 2>/dev/null | ` +
    `awk -v s=$$ -v p=$PPID -v g="$g" ` +
    `'$1!=s && $1!=p && $1!=g && $2!=s && $2!=p ` +
    `{$1="";$2="";sub(/^[ \\t]+/,"");print}' | ` +
    `head -n 3`
  );
}

// ---------------------------------------------------------------------------
// Cooperative sleep / refresh signalling
// ---------------------------------------------------------------------------

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    // `{ once: true }` only unregisters `onAbort` once the 'abort' event actually
    // fires — the far more common case (the timer just elapsing) leaves it attached
    // forever. Since `signal` is a long-lived per-host poll signal reused on every
    // cycle (waitOrRefresh/waitBackoff -> sleep), that leaked one listener per
    // cycle, eventually tripping Node's MaxListenersExceededWarning.
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** A fire-and-forget wake-up channel — the manual-refresh equivalent of the
 *  Rust `mpsc::Sender<()>`. */
export class RefreshChannel {
  private listeners = new Set<() => void>();

  fire(): void {
    for (const l of [...this.listeners]) l();
  }

  /** Resolves on the next `fire()`, or immediately if `signal` is already aborted. */
  wait(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const onFire = (): void => {
        cleanup();
        resolve();
      };
      const onAbort = (): void => {
        cleanup();
        resolve();
      };
      const cleanup = (): void => {
        this.listeners.delete(onFire);
        signal.removeEventListener('abort', onAbort);
      };
      this.listeners.add(onFire);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

/** Waits for `delayMs`, but returns early on a refresh signal. */
export async function waitOrRefresh(delayMs: number, refresh: RefreshChannel, signal: AbortSignal): Promise<void> {
  await Promise.race([sleep(delayMs, signal), refresh.wait(signal)]);
}

/**
 * Sleeps the whole `delayMs`, discarding refresh signals.
 *
 * A reconnect must never dial faster than the backoff schedule: the GUI
 * drives a refresh on its own timer, indistinguishable from a manual
 * refresh here, which would otherwise retry a failing host every few seconds.
 */
export async function waitBackoff(delayMs: number, signal: AbortSignal): Promise<void> {
  await sleep(delayMs, signal);
}

// ---------------------------------------------------------------------------
// PollManager
// ---------------------------------------------------------------------------

export class PollManager {
  private readonly controllers = new Map<string, AbortController>();
  private readonly refreshChannels = new Map<string, RefreshChannel>();
  private readonly tasks: Promise<void>[] = [];

  /** Spawns one poller loop per host. */
  start(hosts: Host[], emit: (event: CoreEvent) => void, pollIntervalMs: number): void {
    for (const host of hosts) {
      const controller = new AbortController();
      const refresh = new RefreshChannel();
      this.controllers.set(host.name, controller);
      this.refreshChannels.set(host.name, refresh);
      this.tasks.push(runHostPoller(host, emit, pollIntervalMs, refresh, controller.signal));
    }
  }

  /** Triggers an immediate poll for every host. */
  refreshAll(): void {
    for (const refresh of this.refreshChannels.values()) refresh.fire();
  }

  /** Aborts every poller loop. SSH sessions are closed inside the loops. */
  shutdown(): void {
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    this.refreshChannels.clear();
  }
}

// ---------------------------------------------------------------------------
// Per-host poller loop
// ---------------------------------------------------------------------------

async function runHostPoller(
  host: Host,
  emit: (event: CoreEvent) => void,
  pollIntervalMs: number,
  refresh: RefreshChannel,
  signal: AbortSignal
): Promise<void> {
  if (host.monitoring === 'tcp_port') await runTcpPoller(host, emit, pollIntervalMs, refresh, signal);
  else await runSshPoller(host, emit, pollIntervalMs, refresh, signal);
}

/** How long a reachability probe waits for the port to answer. */
const TCP_PROBE_TIMEOUT_MS = 5000;

function tcpProbe(host: string, port: number): Promise<ConnectionStatusResult> {
  return new Promise((resolve) => {
    const socket = netConnect({ host, port, timeout: TCP_PROBE_TIMEOUT_MS });
    const finish = (status: { kind: 'connected' } | { kind: 'failed'; message: string }): void => {
      socket.destroy();
      resolve(status);
    };
    socket.once('connect', () => finish({ kind: 'connected' }));
    socket.once('timeout', () => finish({ kind: 'failed', message: `no answer from ${host}:${port}` }));
    socket.once('error', (err) => finish({ kind: 'failed', message: err.message }));
  });
}

type ConnectionStatusResult = { kind: 'connected' } | { kind: 'failed'; message: string };

/** Reachability-only poller: one TCP connect per cycle, no SSH session and
 *  no authentication, so a device that cannot serve metrics is never
 *  logged in to. Emits status only. */
async function runTcpPoller(
  host: Host,
  emit: (event: CoreEvent) => void,
  pollIntervalMs: number,
  refresh: RefreshChannel,
  signal: AbortSignal
): Promise<void> {
  // A bare TCP dial cannot traverse a bastion, and probing the target
  // address direct would silently report on whatever else answers it.
  if (host.proxyJump !== undefined) {
    emit({ type: 'hostStatusChanged', hostName: host.name, status: { kind: 'failed', message: 'a port check cannot reach a host behind ProxyJump - use SSH monitoring' } });
    return;
  }

  const port = host.monitorPort !== undefined && host.monitorPort !== 0 ? host.monitorPort : host.port;
  const backoff = new BackoffState();
  let last: ConnectionStatusResult | undefined;

  while (!signal.aborted) {
    if (last === undefined) {
      emit({ type: 'hostStatusChanged', hostName: host.name, status: { kind: 'connecting' } });
    }

    const status = await tcpProbe(host.hostname, port);
    const reachable = status.kind === 'connected';

    // Only on a change: re-announcing every cycle flickers the card between
    // reachable and checking.
    if (last === undefined || last.kind !== status.kind || (status.kind === 'failed' && last.kind === 'failed' && last.message !== status.message)) {
      emit({ type: 'hostStatusChanged', hostName: host.name, status });
      last = status;
    }

    if (reachable) {
      backoff.reset();
      await waitOrRefresh(pollIntervalMs, refresh, signal);
    } else {
      // A device that is down should not be re-dialled on every refresh tick.
      const delay = Math.max(backoff.nextDelayMs(), pollIntervalMs);
      await waitBackoff(delay, signal);
    }
  }
}

async function runSshPoller(
  host: Host,
  emit: (event: CoreEvent) => void,
  pollIntervalMs: number,
  refresh: RefreshChannel,
  signal: AbortSignal
): Promise<void> {
  const backoff = new BackoffState();
  let session: SshSession | undefined;
  let discoveryDone = false;

  while (!signal.aborted) {
    if (session === undefined) {
      emit({ type: 'hostStatusChanged', hostName: host.name, status: { kind: 'connecting' } });
      try {
        session = await SshSession.connect(host);
        emit({ type: 'hostStatusChanged', hostName: host.name, status: { kind: 'connected' } });
        discoveryDone = false;
      } catch (e) {
        emit({ type: 'hostStatusChanged', hostName: host.name, status: { kind: 'failed', message: (e as Error).message } });
        await waitBackoff(backoff.nextDelayMs(), signal);
        continue;
      }
    }

    // Run Quick Scan once per connection, without blocking the metrics loop.
    if (!discoveryDone) {
      discoveryDone = true;
      void quickScan(session, host.name, emit).catch((e: Error) => {
        emit({ type: 'discoveryFailed', hostName: host.name, message: e.message });
      });
    }

    try {
      const metrics = await collectMetrics(session);
      // A cycle that produced data proves the host is pollable. Resetting on
      // connect instead pins a host that authenticates but cannot run
      // commands (a network appliance) to the first backoff step forever.
      backoff.reset();
      emit({ type: 'metricsUpdate', hostName: host.name, metrics });
    } catch (e) {
      session.disconnect();
      session = undefined;
      emit({ type: 'hostStatusChanged', hostName: host.name, status: { kind: 'failed', message: (e as Error).message } });
      await waitBackoff(backoff.nextDelayMs(), signal);
      continue;
    }

    await waitOrRefresh(pollIntervalMs, refresh, signal);
  }

  session?.disconnect();
}

// ---------------------------------------------------------------------------
// Metric collection
// ---------------------------------------------------------------------------

/** Runs all metric commands and returns a `Metrics` snapshot. Throws when
 *  every command fails simultaneously — that indicates a dead session and
 *  should prompt the caller to reconnect. */
async function collectMetrics(session: SshSession): Promise<Metrics> {
  const results = await Promise.allSettled([
    session.runCommand(CPU_CMD),
    session.runCommand(MEM_CMD),
    session.runCommand(DISK_CMD),
    session.runCommand(UPTIME_CMD),
    session.runCommand('cat /proc/loadavg 2>/dev/null')
  ]);

  if (results.every((r) => r.status === 'rejected')) {
    const first = results[0] as PromiseRejectedResult;
    throw new Error(`all metric commands failed (session may be dead): ${String(first.reason)}`);
  }

  const value = (r: PromiseSettledResult<string>): string => (r.status === 'fulfilled' ? r.value : '');
  const [cpuStr, memStr, diskStr, uptimeStr, loadavgStr] = results.map(value);

  const cpuPercent = await parseCpuCombined(cpuStr, session);
  const ramPercent = await parseRamCombined(memStr, session);
  const diskPercent = parseDiskDf(diskStr);
  const uptime = parseUptime(uptimeStr);
  const loadAvg = parseLoadavg(loadavgStr);
  const topProcesses = await collectTopProcesses(session);

  return { cpuPercent, ramPercent, diskPercent, uptime, loadAvg, topProcesses, lastUpdated: Date.now() };
}

/** Collects the top 3 processes by CPU usage. Tries GNU `ps` (Linux) with a
 *  server-side sort first, then falls back to BSD `ps` (macOS). */
async function collectTopProcesses(session: SshSession): Promise<ProcessInfo[] | undefined> {
  const linuxOut = await session.runCommand(topProcessesCommand('-eo pid=,ppid=,pcpu=,pmem=,comm= --sort=-pcpu')).catch(() => '');
  const linux = parseTopProcesses(linuxOut);
  if (linux !== undefined) return linux;

  const macosOut = await session.runCommand(topProcessesCommand('-Aceo pid=,ppid=,pcpu=,pmem=,comm= -r')).catch(() => '');
  return parseTopProcesses(macosOut);
}

async function parseCpuCombined(topOut: string, session: SshSession): Promise<number | undefined> {
  const linux = parseCpuTop(topOut);
  if (linux !== undefined) return linux;

  const macosOut = await session.runCommand(CPU_MACOS_CMD).catch(() => '');
  const macos = parseCpuTopMacos(macosOut);
  if (macos !== undefined) return macos;

  const statOut = await session.runCommand('head -1 /proc/stat 2>/dev/null').catch(() => '');
  return parseCpuProcStat(statOut);
}

async function parseRamCombined(memOut: string, session: SshSession): Promise<number | undefined> {
  const linux = parseRamFree(memOut);
  if (linux !== undefined) return linux;

  if (memOut.includes('Mach Virtual Memory')) {
    const memsizeOut = await session.runCommand('sysctl hw.memsize 2>/dev/null').catch(() => '');
    return parseRamVmstat(memOut, memsizeOut);
  }
  return undefined;
}
