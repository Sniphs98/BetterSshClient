import { describe, expect, it } from 'vitest';

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
  thresholdLevel
} from './metrics.js';

// Ported from crates/omnyssh-core/src/ssh/metrics.rs's #[cfg(test)] module
// plus crates/omnyssh-core/tests/metrics_parser.rs's realistic-fixture and
// comma-decimal-locale battery.

function close(actual: number | undefined, expected: number, tolerance = 0.2): void {
  expect(actual, `expected ~${expected}, got ${actual}`).toBeDefined();
  expect(Math.abs((actual as number) - expected)).toBeLessThan(tolerance);
}

describe('CPU parsers', () => {
  it('Ubuntu procps-ng format', () => {
    close(parseCpuTop('%Cpu(s):  2.3 us,  0.7 sy,  0.0 ni, 96.7 id,  0.3 wa,  0.0 hi,  0.0 si,  0.0 st'), 3.3);
  });

  it('CentOS 7 legacy format', () => {
    close(parseCpuTop('Cpu(s):  2.3%us,  0.7%sy,  0.0%ni, 96.7%id,  0.3%wa,  0.0%hi,  0.0%si,  0.0%st'), 3.3);
  });

  it('Alpine BusyBox format', () => {
    close(parseCpuTop('CPU:   4% usr   1% sys   0% nic  94% idle   0% io   0% irq   1% sirq'), 6.0);
  });

  it('macOS top', () => {
    close(parseCpuTopMacos('CPU usage: 3.17% user, 1.56% sys, 95.26% idle'), 4.74);
  });

  it('macOS top, full multi-line output', () => {
    const out = [
      'Processes: 412 total, 2 running, 410 sleeping, 2178 threads',
      '2024/01/15 14:23:05',
      'Load Avg: 1.52, 1.74, 1.89',
      'CPU usage: 5.71% user, 2.57% sys, 91.71% idle',
      'SharedLibs: 438M resident, 108M data, 24M linkedit.'
    ].join('\n');
    close(parseCpuTopMacos(out), 8.29);
  });

  it('/proc/stat', () => {
    const pct = parseCpuProcStat('cpu  74608 2520 24433 1117073 6176 4054 0 0 0 0');
    expect(pct).toBeGreaterThan(0);
    expect(pct).toBeLessThan(20);
  });

  it('fully idle and fully loaded', () => {
    close(parseCpuTop('%Cpu(s): 100.0 us,  0.0 sy,  0.0 ni,  0.0 id,  0.0 wa,  0.0 hi,  0.0 si,  0.0 st'), 100.0, 0.5);
  });

  it('empty/unrecognised input returns undefined, never throws', () => {
    expect(parseCpuTop('')).toBeUndefined();
    expect(parseCpuTop('no cpu data here')).toBeUndefined();
    expect(parseCpuTopMacos('')).toBeUndefined();
    expect(parseCpuProcStat('')).toBeUndefined();
  });

  it('truncated output (missing idle field) returns undefined, not a crash', () => {
    expect(parseCpuTop('%Cpu(s):  2.3 us,  0.7 sy')).toBeUndefined();
  });

  // A server whose system language uses a comma decimal separator prints
  // "99,1 id"; naive comma-splitting would read the tenths digit as the idle
  // value and report ~91-100% on an idle machine.
  it('comma-decimal locale', () => {
    close(parseCpuTop('%CPU(s):  0,0 us,  0,9 sy,  0,0 ni, 99,1 id,  0,0 wa,  0,0 hi,  0,0 si,  0,0 st'), 0.9);
  });

  it('comma-decimal locale, several reported idle values', () => {
    for (const [idle, expected] of [
      ['99,9', 0.1],
      ['99,8', 0.2]
    ] as const) {
      close(parseCpuTop(`%Cpu(s):  0,1 us,  0,0 sy,  0,0 ni, ${idle} id,  0,0 wa`), expected);
    }
  });

  it('comma-decimal locale, fully idle', () => {
    close(parseCpuTop('%Cpu(s):  0,0 us,  0,0 sy,  0,0 ni,100,0 id,  0,0 wa,  0,0 hi,  0,0 si,  0,0 st'), 0.0);
  });

  it('comma-decimal locale, legacy format', () => {
    close(parseCpuTop('Cpu(s):  2,3%us,  0,7%sy,  0,0%ni, 96,7%id,  0,3%wa,  0,0%hi,  0,0%si,  0,0%st'), 3.3);
  });

  it('comma-decimal locale, macOS', () => {
    close(parseCpuTopMacos('CPU usage: 3,17% user, 1,56% sys, 95,26% idle'), 4.74);
  });
});

describe('RAM parsers', () => {
  it('modern free -b, 7-column with available', () => {
    const out = [
      '              total        used        free      shared  buff/cache   available',
      'Mem:    8192000000  3145728000   512000000   134217728  4534272000  4915200000',
      'Swap:   2147483648           0  2147483648'
    ].join('\n');
    close(parseRamFree(out), 40.0, 2.0);
  });

  it('BusyBox free, 4-column (no available)', () => {
    const out = ['              total        used        free', 'Mem:       1018736      524288      494448'].join('\n');
    close(parseRamFree(out), 51.5, 2.0);
  });

  it('empty/malformed input returns undefined', () => {
    expect(parseRamFree('')).toBeUndefined();
    expect(parseRamFree('only the header line\n')).toBeUndefined();
    expect(parseRamVmstat('', '')).toBeUndefined();
    expect(parseRamVmstat('', 'hw.memsize: 0')).toBeUndefined();
  });

  it('macOS vm_stat + sysctl', () => {
    const vmStat = [
      'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
      'Pages free:                               23456.',
      'Pages active:                           456789.',
      'Pages inactive:                         123456.',
      'Pages speculative:                        12345.',
      'Pages throttled:                              0.',
      'Pages wired down:                        98765.'
    ].join('\n');
    const pct = parseRamVmstat(vmStat, 'hw.memsize: 17179869184');
    expect(pct).toBeGreaterThan(0);
    expect(pct as number).toBeLessThanOrEqual(100);
  });
});

describe('Disk parser', () => {
  it('Linux df, Use% column', () => {
    const out = ['Filesystem     1K-blocks    Used Available Use% Mounted on', '/dev/sda1       51475068 9000000  39841436  19% /'].join('\n');
    close(parseDiskDf(out), 19.0, 0.5);
  });

  it('macOS df, Capacity column', () => {
    const out = [
      'Filesystem   1024-blocks      Used Available Capacity iused ifree %iused  Mounted on',
      '/dev/disk3s5   994662584 516879368 400765064    57% 5488234 4293478045    0%   /'
    ].join('\n');
    close(parseDiskDf(out), 57.0, 0.5);
  });

  it('100% full', () => {
    const out = ['Filesystem     1K-blocks    Used Available Use% Mounted on', '/dev/sda1       51475068 51475068          0 100% /'].join('\n');
    close(parseDiskDf(out), 100.0, 0.5);
  });

  it('empty/header-only input returns undefined', () => {
    expect(parseDiskDf('')).toBeUndefined();
    expect(parseDiskDf('only header\n')).toBeUndefined();
    expect(parseDiskDf('Filesystem 1K-blocks Used Available Use% Mounted on\n')).toBeUndefined();
  });
});

describe('Uptime / load average', () => {
  it('Linux, days present — trims the trailing time', () => {
    expect(parseUptime(' 14:23:45 up 2 days,  3:45,  2 users,  load average: 0.15, 0.10, 0.08')).toBe('2 days');
  });

  it('Linux, hours only — keeps the time', () => {
    const result = parseUptime(' 10:00:00 up  3:45,  1 user,  load average: 0.00, 0.01, 0.05');
    expect(result).toContain('3:45');
  });

  it('empty input returns undefined', () => {
    expect(parseUptime('')).toBeUndefined();
  });

  it('parses the first three loadavg fields', () => {
    expect(parseLoadavg('0.15 0.10 0.08 1/423 12345\n')).toBe('0.15 0.10 0.08');
  });

  it('empty loadavg input returns undefined', () => {
    expect(parseLoadavg('')).toBeUndefined();
  });
});

describe('parseTopProcesses', () => {
  it('Linux ps, %CPU %MEM COMMAND', () => {
    const out = ['%CPU %MEM COMMAND', '12.3  4.5 firefox', ' 8.1  2.0 node', ' 3.0  1.1 sshd'].join('\n');
    const procs = parseTopProcesses(out);
    expect(procs).toHaveLength(3);
    expect(procs?.[0].name).toBe('firefox');
    expect(procs?.[0].cpuPercent).toBeCloseTo(12.3);
    expect(procs?.[0].memPercent).toBeCloseTo(4.5);
    expect(procs?.[2].name).toBe('sshd');
  });

  it('macOS ps header is skipped as non-numeric', () => {
    const out = '%CPU %MEM COMM\n  5.0  3.2 WindowServer';
    const procs = parseTopProcesses(out);
    expect(procs).toHaveLength(1);
    expect(procs?.[0].name).toBe('WindowServer');
  });

  it('a command containing spaces is preserved', () => {
    const out = '%CPU %MEM COMMAND\n 2.5  9.0 postgres: writer process';
    expect(parseTopProcesses(out)?.[0].name).toBe('postgres: writer process');
  });

  it('malformed lines are skipped without breaking the rest', () => {
    const out = ['%CPU %MEM COMMAND', 'garbage line', '10.0  1.0 redis', '', 'only-one-field'].join('\n');
    const procs = parseTopProcesses(out);
    expect(procs).toHaveLength(1);
    expect(procs?.[0].name).toBe('redis');
  });

  it('caps at three entries, in input order', () => {
    const out = ['%CPU %MEM COMMAND', '5.0 1.0 a', '4.0 1.0 b', '3.0 1.0 c', '2.0 1.0 d', '1.0 1.0 e'].join('\n');
    const procs = parseTopProcesses(out);
    expect(procs).toHaveLength(3);
    expect(procs?.[2].name).toBe('c');
  });

  it('no header line — every line is data', () => {
    const out = '12.3  4.5 firefox\n 3.0  1.1 sshd';
    const procs = parseTopProcesses(out);
    expect(procs).toHaveLength(2);
    expect(procs?.[0].name).toBe('firefox');
    expect(procs?.[1].name).toBe('sshd');
  });

  it('empty/header-only input returns undefined', () => {
    expect(parseTopProcesses('')).toBeUndefined();
    expect(parseTopProcesses('%CPU %MEM COMMAND\n')).toBeUndefined();
  });
});

describe('thresholdLevel', () => {
  it('ok below 60', () => {
    expect(thresholdLevel(0)).toBe('ok');
    expect(thresholdLevel(59.9)).toBe('ok');
  });

  it('warn 60 to 85 inclusive', () => {
    expect(thresholdLevel(60)).toBe('warn');
    expect(thresholdLevel(75)).toBe('warn');
    expect(thresholdLevel(85)).toBe('warn');
  });

  it('crit above 85', () => {
    expect(thresholdLevel(85.1)).toBe('crit');
    expect(thresholdLevel(100)).toBe('crit');
  });
});
