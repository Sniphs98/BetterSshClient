/**
 * Metric collection and parsing for remote servers. Ported from
 * crates/omnyssh-core/src/ssh/metrics.rs.
 *
 * All parsers return `undefined` on unrecognised/truncated input — they
 * never throw. The UI renders `undefined` as "N/A".
 *
 * Severity thresholds: Ok < 60%, Warn 60-85%, Crit > 85%.
 */

export interface ProcessInfo {
  name: string;
  cpuPercent: number;
  memPercent: number;
}

export type ThresholdLevel = 'ok' | 'warn' | 'crit';

export function thresholdLevel(percent: number): ThresholdLevel {
  if (percent < 60) return 'ok';
  if (percent <= 85) return 'warn';
  return 'crit';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Rust's `str::parse::<f64>()` requires the *entire* string to be numeric —
 *  unlike `parseFloat`, which stops at the first non-numeric character and
 *  silently accepts trailing garbage. `Number()` matches that strictness,
 *  except for blank/whitespace-only input, which it reads as `0`. */
function strictFloat(s: string): number {
  return s.trim() === '' ? NaN : Number(s);
}

// ---------------------------------------------------------------------------
// CPU parsers
// ---------------------------------------------------------------------------

/**
 * Rewrites a decimal comma as a decimal point.
 *
 * The commands are run under a pinned locale, but that is best-effort: a
 * host without `env`, or a wrapper that re-exports a locale, still reaches
 * the parsers with `99,1 id`. Only a comma between two digits is a radix
 * point — every other comma separates fields and must survive.
 */
function normalizeDecimalCommas(line: string): string {
  const chars = Array.from(line);
  return chars
    .map((c, i) => {
      const isRadix = c === ',' && i > 0 && /\d/.test(chars[i - 1]) && chars[i + 1] !== undefined && /\d/.test(chars[i + 1]);
      return isRadix ? '.' : c;
    })
    .join('');
}

function parseCpuBusybox(line: string): number | undefined {
  const words = line.split(/\s+/).filter((w) => w !== '');
  for (let i = 0; i < words.length - 1; i++) {
    if (words[i + 1] === 'idle') {
      const idle = strictFloat(words[i].replace(/%$/, ''));
      if (!Number.isNaN(idle)) return clamp(100 - idle, 0, 100);
    }
  }
  return undefined;
}

function parseCpuLinuxTopLine(rawLine: string): number | undefined {
  const line = normalizeDecimalCommas(rawLine);
  const colonIdx = line.indexOf(':');
  if (colonIdx === -1) return undefined;
  const afterColon = line.slice(colonIdx + 1);

  for (const rawField of afterColon.split(',')) {
    // Field looks like "96.7 id" or "96.7%id" — split at the *first* space or
    // '%', mirroring Rust's `splitn(2, [' ', '%'])`.
    const field = rawField.trim();
    const sepIdxCandidates = [field.indexOf(' '), field.indexOf('%')].filter((i) => i !== -1);
    if (sepIdxCandidates.length === 0) continue;
    const sepIdx = Math.min(...sepIdxCandidates);
    const value = field.slice(0, sepIdx);
    const label = field.slice(sepIdx + 1).trim().toLowerCase();
    if (label === 'id' || label === 'idle' || label.startsWith('id,')) {
      const idle = strictFloat(value.replace(/%$/, ''));
      if (!Number.isNaN(idle)) return clamp(100 - idle, 0, 100);
    }
  }
  return undefined;
}

/** Parses CPU idle percentage from Linux `top -bn1` output (modern
 *  procps-ng, legacy, and Alpine BusyBox formats). Returns `100 - idle`. */
export function parseCpuTop(output: string): number | undefined {
  for (const rawLine of output.split('\n')) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith('CPU:')) return parseCpuBusybox(trimmed);

    const lower = trimmed.toLowerCase();
    if (lower.startsWith('%cpu') || lower.startsWith('cpu(s)')) return parseCpuLinuxTopLine(trimmed);
  }
  return undefined;
}

/** Parses CPU usage from macOS `top -l 1 -n 0` output
 *  (`CPU usage: 3.17% user, 1.56% sys, 95.26% idle`). */
export function parseCpuTopMacos(output: string): number | undefined {
  for (const rawLine of output.split('\n')) {
    const lower = rawLine.trim().toLowerCase();
    if (!lower.startsWith('cpu usage:')) continue;
    const line = normalizeDecimalCommas(rawLine);
    for (const rawPart of line.split(',')) {
      const part = rawPart.trim();
      if (part.toLowerCase().endsWith('idle')) {
        const token = part.split(/\s+/)[0];
        if (token === undefined) return undefined;
        const idle = strictFloat(token.replace(/%$/, ''));
        if (Number.isNaN(idle)) return undefined;
        return clamp(100 - idle, 0, 100);
      }
    }
  }
  return undefined;
}

/** Parses CPU usage from Linux `/proc/stat`'s first line. */
export function parseCpuProcStat(output: string): number | undefined {
  const line = output.split('\n')[0];
  if (line === undefined) return undefined;
  const parts = line.split(/\s+/).filter((p) => p !== '');
  const label = parts[0];
  if (label === undefined || !label.startsWith('cpu')) return undefined;

  const values = parts.slice(1).map(Number).filter((n) => !Number.isNaN(n));
  if (values.length < 4) return undefined;
  const idle = values[3] + (values[4] ?? 0); // idle + iowait
  const total = values.reduce((a, b) => a + b, 0);
  if (total === 0) return undefined;
  return clamp(((total - idle) / total) * 100, 0, 100);
}

// ---------------------------------------------------------------------------
// RAM parsers
// ---------------------------------------------------------------------------

/** Parses RAM usage from Linux `free -b` output. Uses the `available`
 *  column when present (modern `free`), else `free` (BusyBox/older). */
export function parseRamFree(output: string): number | undefined {
  const memLine = output.split('\n').find((l) => l.trimStart().startsWith('Mem:'));
  if (memLine === undefined) return undefined;
  const fields = memLine.split(/\s+/).filter((f) => f !== '');

  const total = strictFloat(fields[1] ?? '');
  if (Number.isNaN(total) || total === 0) return undefined;

  if (fields[6] !== undefined) {
    const available = strictFloat(fields[6]);
    if (Number.isNaN(available)) return undefined;
    return clamp(((total - available) / total) * 100, 0, 100);
  }
  if (fields[3] !== undefined) {
    const free = strictFloat(fields[3]);
    if (Number.isNaN(free)) return undefined;
    return clamp(((total - free) / total) * 100, 0, 100);
  }
  return undefined;
}

function parseVmstatLine(line: string, prefix: string): number | undefined {
  if (!line.trimStart().startsWith(prefix)) return undefined;
  const rest = line.split(':')[1];
  if (rest === undefined) return undefined;
  const value = strictFloat(rest.trim().replace(/\.$/, ''));
  return Number.isNaN(value) ? undefined : value;
}

/** Parses RAM usage from macOS `vm_stat` + `sysctl hw.memsize` output. */
export function parseRamVmstat(vmStatOutput: string, memsizeOutput: string): number | undefined {
  const totalBytes = strictFloat(memsizeOutput.split(':')[1]?.trim() ?? '');
  if (Number.isNaN(totalBytes) || totalBytes === 0) return undefined;

  const firstLine = vmStatOutput.split('\n')[0] ?? '';
  const idx = firstLine.indexOf('page size of');
  let pageSize = 4096;
  if (idx !== -1) {
    const rest = firstLine.slice(idx + 'page size of'.length);
    const token = rest.trim().split(/\s+/)[0];
    const parsed = token !== undefined ? strictFloat(token) : NaN;
    if (!Number.isNaN(parsed)) pageSize = parsed;
  }

  let freePages = 0;
  let speculativePages = 0;
  for (const line of vmStatOutput.split('\n')) {
    const free = parseVmstatLine(line, 'Pages free:');
    if (free !== undefined) freePages = free;
    const spec = parseVmstatLine(line, 'Pages speculative:');
    if (spec !== undefined) speculativePages = spec;
  }
  const availableBytes = (freePages + speculativePages) * pageSize;
  return clamp(((totalBytes - availableBytes) / totalBytes) * 100, 0, 100);
}

// ---------------------------------------------------------------------------
// Disk parser
// ---------------------------------------------------------------------------

/** Parses disk usage of `/` from `df -k /` output (Linux `Use%` / macOS
 *  `Capacity` column). */
export function parseDiskDf(output: string): number | undefined {
  const lines = output.split('\n');
  const header = lines[0];
  const dataLine = lines[1];
  if (header === undefined || dataLine === undefined || header === '' || dataLine === '') return undefined;

  const headerFields = header.split(/\s+/).filter((f) => f !== '');
  const dataFields = dataLine.split(/\s+/).filter((f) => f !== '');

  const pctCol = headerFields.findIndex((h) => h === 'Use%' || h === 'Capacity' || h.endsWith('Use%') || h.endsWith('Capacity'));
  if (pctCol === -1) return undefined;

  const pctStr = dataFields[pctCol];
  if (pctStr === undefined) return undefined;
  const pct = strictFloat(pctStr.replace(/%$/, ''));
  return Number.isNaN(pct) ? undefined : clamp(pct, 0, 100);
}

// ---------------------------------------------------------------------------
// Uptime / load average
// ---------------------------------------------------------------------------

/** Extracts the human-readable uptime string from `uptime` output (Linux
 *  and macOS). Trims to just "N days" when the uptime spans days. */
export function parseUptime(output: string): string | undefined {
  const line = output.split('\n')[0];
  if (line === undefined) return undefined;
  const upIdx = line.toLowerCase().indexOf(' up ');
  if (upIdx === -1) return undefined;
  const afterUp = line.slice(upIdx + 4).trim();

  const parts: string[] = [];
  for (const part of afterUp.split(', ')) {
    if (part.trim().includes('user')) break;
    parts.push(part.trim());
  }
  const uptimeStr = parts.length === 0 ? afterUp : parts.join(', ');

  const daysIdx = uptimeStr.indexOf(' days');
  if (daysIdx !== -1) return uptimeStr.slice(0, daysIdx + 5);
  const dayIdx = uptimeStr.indexOf(' day,');
  if (dayIdx !== -1) return uptimeStr.slice(0, dayIdx + 4);
  return uptimeStr;
}

/** Extracts load averages from `cat /proc/loadavg` output as `"a b c"`. */
export function parseLoadavg(output: string): string | undefined {
  const line = output.split('\n')[0];
  if (line === undefined) return undefined;
  const parts = line.split(/\s+/).filter((p) => p !== '');
  if (parts.length < 3) return undefined;
  return `${parts[0]} ${parts[1]} ${parts[2]}`;
}

// ---------------------------------------------------------------------------
// Process list parser
// ---------------------------------------------------------------------------

/** Parses the top processes by CPU usage from `ps` output — lines of
 *  `%CPU %MEM COMMAND`. Skips a header/malformed line (non-numeric first two
 *  columns). At most 3 entries, in input order; `undefined` if none. */
export function parseTopProcesses(output: string): ProcessInfo[] | undefined {
  const procs: ProcessInfo[] = [];
  for (const line of output.split('\n')) {
    if (procs.length === 3) break;
    const fields = line.split(/\s+/).filter((f) => f !== '');
    const [cpuStr, memStr, ...rest] = fields;
    if (cpuStr === undefined || memStr === undefined) continue;

    const cpu = strictFloat(normalizeDecimalCommas(cpuStr));
    const mem = strictFloat(normalizeDecimalCommas(memStr));
    if (Number.isNaN(cpu) || Number.isNaN(mem)) continue;

    const name = rest.join(' ');
    if (name === '') continue;
    procs.push({ name, cpuPercent: cpu, memPercent: mem });
  }
  return procs.length === 0 ? undefined : procs;
}
