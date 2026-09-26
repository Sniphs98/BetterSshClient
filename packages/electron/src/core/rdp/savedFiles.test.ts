import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { freePath, safeSegment, saveReceivedFile, targetPath } from './savedFiles.js';

describe('safeSegment', () => {
  it('keeps ordinary names', () => {
    expect(safeSegment('report 2026.pdf')).toBe('report 2026.pdf');
  });

  it('replaces characters no file system here would take', () => {
    expect(safeSegment('a<b>c:d"e|f?g*h')).toBe('a_b_c_d_e_f_g_h');
    expect(safeSegment('tab\there')).toBe('tab_here');
  });

  it('never yields an empty name, a dot entry or a Windows device name', () => {
    expect(safeSegment('')).toBe('_');
    expect(safeSegment('..')).toBe('_');
    expect(safeSegment('name. ')).toBe('name');
    expect(safeSegment('CON')).toBe('_CON');
    expect(safeSegment('nul.txt')).toBe('_nul.txt');
  });
});

describe('targetPath', () => {
  const folder = resolve('/downloads');

  it('keeps the folder structure of the copied collection', () => {
    expect(targetPath(folder, 'docs\\images', 'a.png')).toBe(join(folder, 'docs', 'images', 'a.png'));
    expect(targetPath(folder, undefined, 'a.png')).toBe(join(folder, 'a.png'));
  });

  it('refuses paths that would leave the folder', () => {
    expect(() => targetPath(folder, '..\\..\\Windows', 'evil.dll')).toThrow('leaves the target folder');
    expect(() => targetPath(folder, 'C:\\Windows', 'evil.dll')).toThrow('leaves the target folder');
    // A name can't smuggle a path either.
    expect(targetPath(folder, undefined, '..\\evil.txt')).toBe(join(folder, '.._evil.txt'));
  });
});

describe('freePath', () => {
  it('numbers a name that is taken instead of overwriting', () => {
    const taken = new Set(['/d/a.txt', '/d/a (1).txt']);
    expect(freePath('/d/a.txt', (p) => taken.has(p))).toBe('/d/a (2).txt');
    expect(freePath('/d/b.txt', (p) => taken.has(p))).toBe('/d/b.txt');
  });
});

describe('saveReceivedFile', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bssh-save-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes into subfolders and never over an existing file', async () => {
    const first = await saveReceivedFile(dir, 'docs', 'a.txt', new TextEncoder().encode('one'));
    const second = await saveReceivedFile(dir, 'docs', 'a.txt', new TextEncoder().encode('two'));
    expect(first).toBe(join(dir, 'docs', 'a.txt'));
    expect(second).toBe(join(dir, 'docs', 'a (1).txt'));
    expect(await readFile(first, 'utf8')).toBe('one');
    expect(await readFile(second, 'utf8')).toBe('two');
  });
});
