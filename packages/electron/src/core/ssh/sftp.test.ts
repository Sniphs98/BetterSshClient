import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { guardTransferPaths, listLocalDir, posixParent, previewLocalFile, sortEntries, throttleProgress, type FileEntry } from './sftp.js';

// sftp.rs is almost entirely I/O against a live SFTP session (untestable
// without a real server); this ports what's pure or exercisable against the
// real local filesystem: the sort order, the ".." parent computation, the
// transfer path guards, and the local-fs helpers.

function entry(name: string, isDir: boolean): FileEntry {
  return { name, path: `/x/${name}`, size: 0, isDir };
}

describe('sortEntries', () => {
  it('puts ".." first, then dirs before files, case-insensitively', () => {
    const entries = [entry('zeta.txt', false), entry('Alpha', true), entry('beta.txt', false), entry('..', true), entry('bravo', true)];
    sortEntries(entries);
    expect(entries.map((e) => e.name)).toEqual(['..', 'Alpha', 'bravo', 'beta.txt', 'zeta.txt']);
  });
});

describe('posixParent', () => {
  it('root has no parent', () => {
    expect(posixParent('/')).toBeUndefined();
  });

  it('a top-level directory\'s parent is root', () => {
    expect(posixParent('/home')).toBe('/');
  });

  it('a nested directory\'s parent is its container', () => {
    expect(posixParent('/home/user')).toBe('/home');
  });

  it('a trailing slash is ignored', () => {
    expect(posixParent('/home/user/')).toBe('/home');
  });

  it('a relative single-component path has an empty parent', () => {
    expect(posixParent('home')).toBe('');
  });
});

describe('guardTransferPaths', () => {
  it('rejects a literal ".." path component in the local path', () => {
    expect(() => guardTransferPaths('../etc/passwd', '/remote/file', 'destination')).toThrow(/\.\./);
    expect(() => guardTransferPaths('foo/../bar', '/remote/file', 'source')).toThrow(/\.\./);
  });

  it('does not reject a filename that merely contains ".." as a substring', () => {
    expect(() => guardTransferPaths('my..file.txt', '/remote/file', 'destination')).not.toThrow();
  });

  it('rejects a null byte in either path', () => {
    expect(() => guardTransferPaths('/tmp/f\0ile', '/remote/file', 'destination')).toThrow(/null/);
    expect(() => guardTransferPaths('/tmp/file', '/remote/f\0ile', 'source')).toThrow(/null/);
  });

  it('accepts an ordinary local/remote pair', () => {
    expect(() => guardTransferPaths('/tmp/file.txt', '/remote/file.txt', 'destination')).not.toThrow();
  });
});

describe('local filesystem helpers', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'better-ssh-client-sftp-local-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('listLocalDir sorts dirs-first, case-insensitively, with a ".." entry', async () => {
    await mkdir(join(tmp, 'Zdir'));
    await mkdir(join(tmp, 'adir'));
    await writeFile(join(tmp, 'file.txt'), 'hello');
    await writeFile(join(tmp, 'Afile.txt'), 'hello');

    const entries = await listLocalDir(tmp);
    const names = entries.map((e) => e.name);
    expect(names[0]).toBe('..');
    // dirs (adir, Zdir) before files (Afile.txt, file.txt), each group alpha
    // case-insensitive.
    expect(names).toEqual(['..', 'adir', 'Zdir', 'Afile.txt', 'file.txt']);
  });

  it('listLocalDir reports file sizes', async () => {
    await writeFile(join(tmp, 'data.bin'), Buffer.alloc(1234));
    const entries = await listLocalDir(tmp);
    const file = entries.find((e) => e.name === 'data.bin');
    expect(file?.size).toBe(1234);
    expect(file?.isDir).toBe(false);
  });

  it('previewLocalFile reads up to 4096 bytes as UTF-8', async () => {
    await writeFile(join(tmp, 'small.txt'), 'hello world');
    expect(await previewLocalFile(join(tmp, 'small.txt'))).toBe('hello world');

    const big = 'x'.repeat(5000);
    await writeFile(join(tmp, 'big.txt'), big);
    const preview = await previewLocalFile(join(tmp, 'big.txt'));
    expect(preview.length).toBe(4096);
  });
});

describe('throttleProgress', () => {
  function harness(): { calls: [number, number][]; report: (done: number, total: number) => void; advance: (ms: number) => void } {
    let clock = 0;
    const calls: [number, number][] = [];
    const report = throttleProgress((done, total) => calls.push([done, total]), 100, () => clock);
    return { calls, report, advance: (ms) => (clock += ms) };
  }

  it('passes the first report, then at most one per interval', () => {
    const { calls, report, advance } = harness();
    report(1, 10);
    report(2, 10);
    advance(50);
    report(3, 10);
    advance(50);
    report(4, 10);
    expect(calls).toEqual([
      [1, 10],
      [4, 10]
    ]);
  });

  it('always passes the completing report, however soon it follows', () => {
    const { calls, report } = harness();
    report(5, 10);
    report(10, 10);
    expect(calls).toEqual([
      [5, 10],
      [10, 10]
    ]);
  });
});
