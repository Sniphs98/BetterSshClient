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
    const entries = await manager.listDir('/home/omnyssh');
    expect(entries.map((e) => e.name)).toEqual(expect.arrayContaining(['config.yml', 'www']));
  });

  it('round-trips write, read, rename, and delete on a fresh directory', async () => {
    manager = await SftpManager.connect(testTargetHost());
    const dir = `/home/omnyssh/it-${Date.now()}`;
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
    const remaining = await manager.listDir('/home/omnyssh');
    expect(remaining.map((e) => e.name)).not.toContain(dir.split('/').pop());
  });

  it('readPreview truncates; readFile does not', async () => {
    manager = await SftpManager.connect(testTargetHost());
    const dir = `/home/omnyssh/it-${Date.now()}`;
    await manager.mkdir(dir);
    const path = `${dir}/big.txt`;
    const content = 'x'.repeat(5000); // over readPreview's 4096-byte cap
    await manager.writeFile(path, content);

    expect((await manager.readPreview(path)).length).toBe(4096);
    expect(await manager.readFile(path)).toBe(content);

    await manager.delete(path);
    await manager.delete(dir);
  });
});
