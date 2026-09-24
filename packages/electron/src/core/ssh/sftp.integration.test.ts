import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SftpManager } from './sftp.js';
import { testTargetHost } from '../../testSupport/sshTestTarget.js';

// Runs against the disposable local SSH test container (`docker compose up -d --build`
// at the repo root — see docker/ssh-test-target/README.md). Opt-in only —
// `npm run test:integration`.

describe('SftpManager against the test target', () => {
  let manager: SftpManager | undefined;

  afterEach(() => {
    manager?.disconnect();
    manager = undefined;
  });

  it('lists the seeded home directory', async () => {
    manager = await SftpManager.connect(testTargetHost());
    const entries = await manager.listDir('/home/better-ssh-client');
    expect(entries.map((e) => e.name)).toEqual(expect.arrayContaining(['config.yml', 'www']));
  });

  it('round-trips write, read, rename, and delete on a fresh directory', async () => {
    manager = await SftpManager.connect(testTargetHost());
    const dir = `/home/better-ssh-client/it-${Date.now()}`;
    await manager.mkdir(dir);

    const original = `${dir}/note.txt`;
    const content = 'hello from the integration test\n';
    await manager.writeFile(original, content);
    expect(await manager.readFile(original)).toBe(content);

    const renamed = `${dir}/renamed.txt`;
    await manager.rename(original, renamed);
    expect(await manager.readFile(renamed)).toBe(content);

    const listed = await manager.listDir(dir);
    expect(listed.map((e) => e.name)).toContain('renamed.txt');

    await manager.delete(renamed);
    await manager.delete(dir); // empty now — delete() falls back to rmdir
    const remaining = await manager.listDir('/home/better-ssh-client');
    expect(remaining.map((e) => e.name)).not.toContain(dir.split('/').pop());
  });

  it('readPreview truncates; readFile does not', async () => {
    manager = await SftpManager.connect(testTargetHost());
    const dir = `/home/better-ssh-client/it-${Date.now()}`;
    await manager.mkdir(dir);
    const path = `${dir}/big.txt`;
    const content = 'x'.repeat(5000); // over readPreview's 4096-byte cap
    await manager.writeFile(path, content);

    expect((await manager.readPreview(path)).length).toBe(4096);
    expect(await manager.readFile(path)).toBe(content);

    await manager.delete(path);
    await manager.delete(dir);
  });
  it('runs uploads, downloads and deletes side by side on one session, each intact', async () => {
    // What the renderer's parallel batches do (stores/sftpQueue.ts): several ops in
    // flight on the one SFTP channel at once, distinct paths, every byte in the right file.
    manager = await SftpManager.connect(testTargetHost());
    const m = manager;
    const local = await mkdtemp(join(tmpdir(), 'bssh-par-'));
    const dir = `/home/better-ssh-client/it-par-${Date.now()}`;
    await m.mkdir(dir);
    try {
      const names = Array.from({ length: 8 }, (_, i) => `f${i}.bin`);
      const content = (i: number): Buffer => Buffer.alloc(200_000 + i * 1000, i + 1);
      await Promise.all(names.map((n, i) => writeFile(join(local, n), content(i))));

      await Promise.all(names.map((n) => m.upload(join(local, n), `${dir}/${n}`, () => {})));
      await Promise.all(names.map((n) => m.download(`${dir}/${n}`, join(local, `back-${n}`), () => {})));
      for (const [i, n] of names.entries()) expect((await readFile(join(local, `back-${n}`))).equals(content(i))).toBe(true);

      await Promise.all(names.map((n) => m.delete(`${dir}/${n}`)));
      expect(await m.listDir(dir)).toEqual([expect.objectContaining({ name: '..' })]);
    } finally {
      await m.delete(dir).catch(() => {});
      await rm(local, { recursive: true, force: true });
    }
  });
});
