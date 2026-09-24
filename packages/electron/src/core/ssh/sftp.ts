import { open, readdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SFTPWrapper } from 'ssh2';

import type { Host } from './client.js';
import { SshSession } from './session.js';

/**
 * SFTP file manager operations. Ported from
 * crates/omnyssh-core/src/ssh/sftp.rs. Each `SftpManager` owns a persistent
 * SSH+SFTP session; unlike the Rust source's background-task + `mpsc`
 * design, operations here are plain `async` methods — there's no separate
 * process boundary to bridge, so the caller (`ipc/sftp.ts`) can just
 * `await` them directly and emit the resulting IPC event itself.
 */

export interface FileEntry {
  name: string;
  path: string;
  size: number;
  isDir: boolean;
}

/** Sorts entries `".."` first, then directories before files, both
 *  alphabetically case-insensitive within their group — mutates in place,
 *  mirroring the Rust `sort_by`. */
export function sortEntries(entries: FileEntry[]): void {
  entries.sort((a, b) => {
    if (a.name === '..') return -1;
    if (b.name === '..') return 1;
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
}

export function posixParent(path: string): string | undefined {
  if (path === '/') return undefined;
  const trimmed = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  const idx = trimmed.lastIndexOf('/');
  if (idx === -1) return '';
  if (idx === 0) return '/';
  return trimmed.slice(0, idx);
}

/** Guards against path traversal (a literal `..` path component — not
 *  merely a substring) and embedded null bytes, mirroring the Rust
 *  transfer guards. Throws when either path is unsafe. `localRole` names
 *  which side of the transfer `local` is, for the error message
 *  (download's local path is the destination; upload's is the source). */
export function guardTransferPaths(local: string, remote: string, localRole: 'destination' | 'source'): void {
  const segments = local.split(/[/\\]/);
  if (segments.includes('..')) {
    throw new Error(`transfer ${localRole} path contains '..': ${local}`);
  }
  if (local.includes('\0') || remote.includes('\0')) {
    throw new Error('Path contains null bytes');
  }
}

/** How often a running transfer reports progress, at most. */
export const PROGRESS_INTERVAL_MS = 100;

/**
 * Rate-limits a transfer's progress callback. `fastGet`/`fastPut` report
 * every 32 KiB block — some 30 000 calls for a 1 GiB file, each otherwise an
 * IPC event and a store update in the renderer — while a progress bar needs
 * a handful a second. The first report and the completing one always pass.
 */
export function throttleProgress(
  onProgress: (done: number, total: number) => void,
  intervalMs: number = PROGRESS_INTERVAL_MS,
  now: () => number = Date.now
): (done: number, total: number) => void {
  let last: number | undefined;
  return (done, total) => {
    const t = now();
    if (last !== undefined && done < total && t - last < intervalMs) return;
    last = t;
    onProgress(done, total);
  };
}

export class SftpManager {
  private constructor(
    private readonly sftp: SFTPWrapper,
    private readonly sshSession: SshSession
  ) {}

  static async connect(host: Host): Promise<SftpManager> {
    const sshSession = await SshSession.connect(host);
    let sftp: SFTPWrapper;
    try {
      sftp = await sshSession.openSftp();
    } catch (e) {
      sshSession.disconnect();
      throw e;
    }
    return new SftpManager(sftp, sshSession);
  }

  /** Lists a remote directory, prepending a `".."` parent entry (omitted at
   *  `/`) and sorted `..`-first, dirs-before-files, case-insensitive. */
  async listDir(path: string): Promise<FileEntry[]> {
    const list = await new Promise<import('ssh2').FileEntryWithStats[]>((resolve, reject) => {
      this.sftp.readdir(path, (err, entries) => (err ? reject(err) : resolve(entries)));
    });

    const entries: FileEntry[] = [];
    const parent = posixParent(path);
    if (parent !== undefined) {
      entries.push({ name: '..', path: parent === '' ? '/' : parent, size: 0, isDir: true });
    }

    for (const entry of list) {
      const fullPath = path.endsWith('/') ? `${path}${entry.filename}` : `${path}/${entry.filename}`;
      entries.push({ name: entry.filename, path: fullPath, size: entry.attrs.size, isDir: entry.attrs.isDirectory() });
    }

    sortEntries(entries);
    return entries;
  }

  /** Downloads a remote file to `local`, reporting progress via `onProgress`. */
  async download(remote: string, local: string, onProgress: (done: number, total: number) => void): Promise<void> {
    guardTransferPaths(local, remote, 'destination');
    await new Promise<void>((resolve, reject) => {
      const report = throttleProgress(onProgress);
      this.sftp.fastGet(remote, local, { step: (total, _nb, fsize) => report(total, fsize) }, (err) => (err ? reject(err) : resolve()));
    });
  }

  /** Uploads a local file to `remote`, reporting progress via `onProgress`. */
  async upload(local: string, remote: string, onProgress: (done: number, total: number) => void): Promise<void> {
    guardTransferPaths(local, remote, 'source');
    await new Promise<void>((resolve, reject) => {
      const report = throttleProgress(onProgress);
      this.sftp.fastPut(local, remote, { step: (total, _nb, fsize) => report(total, fsize) }, (err) => (err ? reject(err) : resolve()));
    });
  }

  /** Deletes a remote file; falls back to removing an empty directory. */
  async delete(path: string): Promise<void> {
    try {
      await new Promise<void>((resolve, reject) => this.sftp.unlink(path, (err) => (err ? reject(err) : resolve())));
    } catch {
      await new Promise<void>((resolve, reject) => this.sftp.rmdir(path, (err) => (err ? reject(err) : resolve())));
    }
  }

  async mkdir(path: string): Promise<void> {
    await new Promise<void>((resolve, reject) => this.sftp.mkdir(path, (err) => (err ? reject(err) : resolve())));
  }

  async rename(from: string, to: string): Promise<void> {
    await new Promise<void>((resolve, reject) => this.sftp.rename(from, to, (err) => (err ? reject(err) : resolve())));
  }

  /** Reads the first 4096 bytes of a remote file, lossily decoded as UTF-8. */
  async readPreview(path: string): Promise<string> {
    const handle = await new Promise<Buffer>((resolve, reject) => this.sftp.open(path, 'r', (err, h) => (err ? reject(err) : resolve(h))));
    try {
      const buf = Buffer.alloc(4096);
      const n = await new Promise<number>((resolve, reject) =>
        this.sftp.read(handle, buf, 0, buf.length, 0, (err, bytesRead) => (err ? reject(err) : resolve(bytesRead)))
      );
      return buf.subarray(0, n).toString('utf-8');
    } finally {
      this.sftp.close(handle, () => {});
    }
  }

  /** Reads a remote file in full, decoded as UTF-8 — for the file editor
   *  (unlike `readPreview`, which is deliberately truncated). The editor
   *  gates this behind an extension allowlist + size cap (`fileEdit.ts`), so
   *  by the time this runs the caller has already decided the file is worth
   *  loading whole. */
  async readFile(path: string): Promise<string> {
    const buf = await new Promise<Buffer>((resolve, reject) =>
      this.sftp.readFile(path, (err, data) => (err ? reject(err) : resolve(data)))
    );
    return buf.toString('utf-8');
  }

  /** Overwrites a remote file's full content. */
  async writeFile(path: string, content: string): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.sftp.writeFile(path, Buffer.from(content, 'utf-8'), (err) => (err ? reject(err) : resolve()))
    );
  }

  disconnect(): void {
    this.sshSession.disconnect();
  }
}

// ---------------------------------------------------------------------------
// Local filesystem helpers
// ---------------------------------------------------------------------------

function localParent(path: string): string | undefined {
  const parent = dirname(path);
  return parent === path ? undefined : parent;
}

/** Lists a local directory, sorted the same way as `listDir` (dirs-first,
 *  case-insensitive), with a `".."` parent entry (omitted at the filesystem root). */
export async function listLocalDir(path: string): Promise<FileEntry[]> {
  const dirents = await readdir(path, { withFileTypes: true });

  const entries: FileEntry[] = [];
  const parent = localParent(path);
  if (parent !== undefined) {
    entries.push({ name: '..', path: parent, size: 0, isDir: true });
  }

  for (const dirent of dirents) {
    const entryPath = joinNative(path, dirent.name);
    let size = 0;
    let isDir = dirent.isDirectory();
    if (!isDir) {
      try {
        size = (await stat(entryPath)).size;
      } catch {
        // Unreadable entry (permission, broken symlink target, race) — 0 is
        // the same "unknown" the Rust source falls back to.
      }
    }
    entries.push({ name: dirent.name, path: entryPath, size, isDir });
  }

  sortEntries(entries);
  return entries;
}

function joinNative(dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
}

/** Reads up to 4096 bytes from a local file as UTF-8 (lossy). */
export async function previewLocalFile(path: string): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).toString('utf-8');
  } finally {
    await handle.close();
  }
}

/** Reads a local file in full, decoded as UTF-8 — for the file editor. */
export async function readLocalFile(path: string): Promise<string> {
  const handle = await open(path, 'r');
  try {
    return await handle.readFile({ encoding: 'utf-8' });
  } finally {
    await handle.close();
  }
}

/** Overwrites a local file's full content. */
export async function writeLocalFile(path: string, content: string): Promise<void> {
  const handle = await open(path, 'w');
  try {
    await handle.writeFile(content, 'utf-8');
  } finally {
    await handle.close();
  }
}
