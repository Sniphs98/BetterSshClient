import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

/**
 * Saving files copied on a remote desktop (clipboard file transfer) into a folder
 * here. The names and folder paths come from the remote machine, so they are treated
 * as untrusted: nothing may land outside the chosen folder, and nothing already there
 * is overwritten.
 */

/** One path segment, made safe as a file or folder name on every OS. */
export function safeSegment(name: string): string {
  const cleaned = name
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/, '') // Windows drops trailing dots and spaces
    .trim();
  if (cleaned === '' || cleaned === '.' || cleaned === '..') return '_';
  // Reserved device names on Windows (CON, NUL, COM1…), with or without extension.
  return /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(cleaned) ? `_${cleaned}` : cleaned;
}

/**
 * Where a file `name` inside the remote collection's folder `relativePath` (backslash-
 * separated, as the RDP clipboard sends it) goes under `folder`. `..` and absolute
 * paths are refused rather than cleaned up, since a legitimate copy never has them.
 */
export function targetPath(folder: string, relativePath: string | undefined, name: string): string {
  const parts = (relativePath ?? '').split(/[\\/]+/).filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..') || /^[a-z]:$/i.test(parts[0] ?? '')) {
    throw new Error(`refusing a file path that leaves the target folder: ${relativePath}`);
  }
  const root = resolve(folder);
  const path = resolve(root, ...parts.map(safeSegment), safeSegment(name));
  if (!path.startsWith(root + sep)) throw new Error(`refusing a file path that leaves the target folder: ${name}`);
  return path;
}

/** `path`, or `name (1).ext`, `name (2).ext`… if it is taken. */
export function freePath(path: string, exists: (p: string) => boolean = existsSync): string {
  if (!exists(path)) return path;
  const ext = extname(path);
  const base = path.slice(0, path.length - ext.length);
  for (let n = 1; ; n++) {
    const candidate = `${base} (${n})${ext}`;
    if (!exists(candidate)) return candidate;
  }
}

/** Writes one received file; returns where it went. */
export async function saveReceivedFile(folder: string, relativePath: string | undefined, name: string, bytes: Uint8Array): Promise<string> {
  const wanted = targetPath(folder, relativePath, name);
  await mkdir(join(wanted, '..'), { recursive: true });
  const path = freePath(wanted);
  await writeFile(path, bytes, { flag: 'wx' });
  return path;
}
