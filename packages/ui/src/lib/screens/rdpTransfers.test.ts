import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/ipc/commands', () => ({
  rdpPickSaveFolder: vi.fn(),
  rdpSaveFile: vi.fn(),
  rdpShowSaved: vi.fn()
}));

const { rdpPickSaveFolder, rdpSaveFile } = await import('$lib/ipc/commands');
const { RdpTransfers, describeCollection, formatBytes, summarize } = await import('./rdpTransfers.svelte');

type Handler = (...args: unknown[]) => void;

/** A stand-in for IronRDP's provider: records listeners, lets tests fire events. */
function fakeProvider() {
  const handlers: Record<string, Handler[]> = {};
  let finishUpload!: () => void;
  const provider = {
    on: (event: string, h: Handler) => void (handlers[event] ??= []).push(h),
    emit: (event: string, ...args: unknown[]) => handlers[event]?.forEach((h) => h(...args)),
    uploadFiles: vi.fn(() => ({ transferIds: new Map(), completion: new Promise<void>((r) => (finishUpload = r)) })),
    downloadFile: vi.fn((file: { name: string }) => ({ transferId: 1, completion: Promise.resolve(new Blob([`bytes of ${file.name}`])) })),
    handleDrop: vi.fn(),
    showFilePicker: vi.fn(),
    dispose: vi.fn()
  };
  return { provider, finish: () => finishUpload() };
}

describe('collection summaries', () => {
  it('count files, not folders, and add up their size', () => {
    expect(summarize([{ size: 10 }, { size: 0, isDirectory: true }, { size: 5 }])).toEqual({ files: 2, bytes: 15 });
  });

  it('read naturally', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(20 * 1024 * 1024)).toBe('20 MB');
    expect(describeCollection([{ name: 'a.pdf', size: 2048 }])).toBe('a.pdf, 2.0 KB');
    expect(describeCollection([{ name: 'a', size: 1 }, { name: 'b', size: 1 }])).toBe('2 files, 2 B');
  });
});

describe('RdpTransfers', () => {
  it('offers files, waits for the paste, then counts bytes until done', async () => {
    const { provider, finish } = fakeProvider();
    const t = new RdpTransfers(provider as never);
    provider.showFilePicker.mockResolvedValue([new File(['hello'], 'a.txt')]);

    await t.pick();
    expect(t.upload).toMatchObject({ label: 'a.txt, 5 B', phase: 'waiting' });

    // Offering starts a "batch" already — still waiting until bytes flow.
    provider.emit('upload-batch-started', new Map(), []);
    expect(t.upload?.phase).toBe('waiting');
    provider.emit('upload-progress', { transferId: 1, bytesTransferred: 3 });
    expect(t.upload).toMatchObject({ phase: 'copying', transferred: 3 });

    finish();
    await Promise.resolve();
    expect(t.upload).toMatchObject({ phase: 'done', transferred: 5 });
  });

  it('offers files copied on the remote side and keeps the offer when the clipboard changes to text', () => {
    const { provider } = fakeProvider();
    const t = new RdpTransfers(provider as never);
    provider.emit('files-available', [{ name: 'r.txt', size: 4, lastModified: 0 }]);
    expect(t.remote).toMatchObject({ label: 'r.txt, 4 B', phase: 'available', total: 1 });
    provider.emit('files-available', []);
    expect(t.remote?.label).toBe('r.txt, 4 B');
  });

  it('saves into the picked folder, keeping folders, pausing the clipboard sync meanwhile', async () => {
    const { provider } = fakeProvider();
    const sync = { pause: vi.fn(), resume: vi.fn() };
    const t = new RdpTransfers(provider as never, sync);
    vi.mocked(rdpPickSaveFolder).mockResolvedValue('/dl');
    vi.mocked(rdpSaveFile).mockImplementation(async (folder, rel, name) => `${folder}/${rel ?? ''}/${name}`);
    provider.emit('files-available', [
      { name: 'docs', size: 0, lastModified: 0, isDirectory: true },
      { name: 'a.txt', path: 'docs', size: 1, lastModified: 0 }
    ]);

    await t.save();

    expect(sync.pause).toHaveBeenCalledTimes(1);
    expect(sync.resume).toHaveBeenCalledTimes(1);
    expect(provider.downloadFile).toHaveBeenCalledTimes(1);
    expect(vi.mocked(rdpSaveFile).mock.calls[0].slice(0, 3)).toEqual(['/dl', 'docs', 'a.txt']);
    expect(t.remote).toMatchObject({ phase: 'saved', saved: 1, firstSaved: '/dl/docs/a.txt' });
  });

  it('says why when saving fails — including a folder dialog that fails', async () => {
    const { provider } = fakeProvider();
    const t = new RdpTransfers(provider as never);
    provider.emit('files-available', [{ name: 'a.txt', size: 1, lastModified: 0 }]);
    vi.mocked(rdpPickSaveFolder).mockRejectedValue(new Error('no dialog'));
    await t.save();
    expect(t.remote).toMatchObject({ phase: 'failed', error: 'no dialog' });
  });

  it('does nothing when the folder dialog is cancelled', async () => {
    const { provider } = fakeProvider();
    const t = new RdpTransfers(provider as never);
    provider.emit('files-available', [{ name: 'a.txt', size: 1, lastModified: 0 }]);
    vi.mocked(rdpPickSaveFolder).mockResolvedValue(null);
    await t.save();
    expect(t.remote?.phase).toBe('available');
  });
});
