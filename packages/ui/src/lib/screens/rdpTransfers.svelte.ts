// File transfer for an embedded RDP session, over RDP's clipboard channel (IronRDP's
// RdpFileTransferProvider) — the way mstsc does it:
//   into the session: drop files on the tab (or pick them); they go on the remote
//     clipboard, and pasting in a remote folder (Ctrl+V) copies them there;
//   out of it: copying files on the remote desktop offers them here, to save into a
//     folder picked on this machine.

import type { DroppedFile, FileInfo, RdpFileTransferProvider } from '@devolutions/iron-remote-desktop-rdp';
import { rdpPickSaveFolder, rdpSaveFile, rdpShowSaved } from '$lib/ipc/commands';

type Entry = { size: number; isDirectory?: boolean };

/** Files (not folders) in a collection, and their total size. */
export function summarize(entries: Entry[]): { files: number; bytes: number } {
  const files = entries.filter((e) => !e.isDirectory);
  return { files: files.length, bytes: files.reduce((n, f) => n + (f.size || 0), 0) };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let n = bytes / 1024;
  let i = 0;
  for (; n >= 1024 && i < units.length - 1; i++) n /= 1024;
  return `${n >= 10 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

/** "3 files, 12 MB" / "report.pdf, 2.1 MB". */
export function describeCollection(entries: Array<Entry & { name: string }>): string {
  const { files, bytes } = summarize(entries);
  const single = entries.filter((e) => !e.isDirectory);
  const what = files === 1 ? single[0].name : `${files} files`;
  return `${what}, ${formatBytes(bytes)}`;
}

export interface UploadState {
  label: string;
  bytes: number;
  /** Waiting for the paste on the remote side, copying, or finished. */
  phase: 'waiting' | 'copying' | 'done' | 'failed';
  transferred: number;
  error?: string;
}

export interface RemoteFilesState {
  files: FileInfo[];
  label: string;
  phase: 'available' | 'saving' | 'saved' | 'failed';
  saved: number;
  total: number;
  firstSaved?: string;
  folder?: string;
  error?: string;
}

export class RdpTransfers {
  upload = $state<UploadState | null>(null);
  remote = $state<RemoteFilesState | null>(null);

  private uploadProgress = new Map<number, number>();
  /** When the download in flight last moved, for the stall check. */
  private lastDownloadActivity = 0;

  /**
   * `clipboardSync` pauses the web client's own clipboard sync while files are fetched:
   * it pushes this machine's clipboard to the remote one whenever that changes, which
   * would replace the file list being downloaded from (found against a real Windows).
   */
  constructor(
    private readonly provider: RdpFileTransferProvider,
    private readonly clipboardSync: { pause(): void; resume(): void } = { pause() {}, resume() {} }
  ) {
    provider.on('download-progress', () => {
      this.lastDownloadActivity = Date.now();
    });
    // Offering the files already starts a "batch"; only bytes flowing mean the remote
    // side has pasted them.
    provider.on('upload-progress', (p) => {
      this.uploadProgress.set(p.transferId, p.bytesTransferred);
      const transferred = [...this.uploadProgress.values()].reduce((a, b) => a + b, 0);
      if (this.upload && this.upload.phase !== 'done' && transferred > 0) {
        this.upload = { ...this.upload, phase: 'copying', transferred };
      }
    });
    provider.on('files-available', (files) => {
      if (this.remote?.phase === 'saving') return; // one save at a time
      const { files: count } = summarize(files);
      // Something other than files copied there: the offer stands until dismissed (a
      // save then says the files are gone), rather than vanishing under the pointer.
      if (count === 0) return;
      this.remote = { files, label: describeCollection(files), phase: 'available', saved: 0, total: count };
    });
    provider.on('error', (e) => {
      if (e.direction === 'download' && this.remote) this.remote = { ...this.remote, phase: 'failed', error: e.message };
      else if (this.upload) this.upload = { ...this.upload, phase: 'failed', error: e.message };
    });
  }

  /** Starts a drop: the entries must be read while the event is still live. */
  async drop(event: DragEvent): Promise<void> {
    const files = await this.provider.handleDrop(event);
    this.send(files);
  }

  async pick(): Promise<void> {
    const files = await this.provider.showFilePicker({ multiple: true });
    if (files.length) this.send(files);
  }

  private send(files: File[] | DroppedFile[]): void {
    if (files.length === 0) return;
    const entries = (files as Array<File | DroppedFile>).map((f) => ({
      name: f.name,
      size: f.size,
      isDirectory: 'isDirectory' in f ? f.isDirectory : false
    }));
    const { bytes } = summarize(entries);
    this.uploadProgress.clear();
    this.upload = { label: describeCollection(entries), bytes, phase: 'waiting', transferred: 0 };
    const handle = this.provider.uploadFiles(files);
    handle.completion.then(
      () => {
        if (this.upload) this.upload = { ...this.upload, phase: 'done', transferred: bytes };
      },
      (err: unknown) => {
        if (this.upload) this.upload = { ...this.upload, phase: 'failed', error: err instanceof Error ? err.message : String(err) };
      }
    );
  }

  /** Saves the files copied on the remote desktop into a folder picked here. */
  async save(): Promise<void> {
    const remote = this.remote;
    if (!remote || remote.phase === 'saving') return;
    let folder: string | null;
    try {
      folder = await rdpPickSaveFolder();
    } catch (err) {
      this.remote = { ...remote, phase: 'failed', error: err instanceof Error ? err.message : String(err) };
      return;
    }
    if (!folder) return;
    this.remote = { ...remote, phase: 'saving', saved: 0, folder, error: undefined };
    this.clipboardSync.pause();
    try {
      for (const [index, file] of remote.files.entries()) {
        if (file.isDirectory) continue;
        const blob = await this.withStallCheck(this.provider.downloadFile(file, index).completion, file.name);
        const path = await rdpSaveFile(folder, file.path, file.name, new Uint8Array(await blob.arrayBuffer()));
        this.remote = { ...this.remote!, saved: this.remote!.saved + 1, firstSaved: this.remote!.firstSaved ?? path };
      }
      this.remote = { ...this.remote!, phase: 'saved' };
    } catch (err) {
      this.remote = { ...(this.remote ?? remote), phase: 'failed', error: err instanceof Error ? err.message : String(err) };
    } finally {
      this.clipboardSync.resume();
    }
  }

  /** A download that stops moving for this long has lost its source (the remote
   *  clipboard changed, say) — the web client would otherwise wait forever. */
  static readonly STALL_MS = 30_000;

  private withStallCheck<T>(completion: Promise<T>, name: string): Promise<T> {
    this.lastDownloadActivity = Date.now();
    return new Promise<T>((resolve, reject) => {
      const timer = setInterval(() => {
        if (Date.now() - this.lastDownloadActivity > RdpTransfers.STALL_MS) {
          clearInterval(timer);
          reject(new Error(`${name} stopped arriving — copy the files on the remote desktop again`));
        }
      }, 1000);
      completion.then(
        (v) => (clearInterval(timer), resolve(v)),
        (e) => (clearInterval(timer), reject(e))
      );
    });
  }

  showSaved(): void {
    if (this.remote?.firstSaved) void rdpShowSaved(this.remote.firstSaved);
  }

  dismissUpload(): void {
    this.upload = null;
  }

  dismissRemote(): void {
    this.remote = null;
  }

  dispose(): void {
    this.provider.dispose();
  }
}
