import { writable } from 'svelte/store';
import type { UpdateDownloadProgress, UpdateInfoDto } from '$lib/bindings';

// The update the banner offers, or null (up to date / dismissed / skipped). Set by the
// `update-available` startup event and by a manual `check_update` from Settings
// (tech-gui.md §4.3). The banner (AppShell) renders whenever this is non-null.
export const availableUpdate = writable<UpdateInfoDto | null>(null);

/** Show an available update (from the event or a manual check). */
export function offerUpdate(info: UpdateInfoDto): void {
  availableUpdate.set(info);
}

/** Dismiss the banner for this session (no persistence — it returns next launch). */
export function dismissUpdate(): void {
  availableUpdate.set(null);
}

/** Where installing the offered update in place stands. */
export type UpdateDownload =
  | { phase: 'idle' }
  | { phase: 'downloading'; percent: number }
  | { phase: 'ready'; version: string }
  | { phase: 'failed'; error: string };

export const updateDownload = writable<UpdateDownload>({ phase: 'idle' });

/** The user asked to update in place: the download is starting. */
export function beginUpdateDownload(): void {
  updateDownload.set({ phase: 'downloading', percent: 0 });
}

/** A progress tick. Ignored unless a download is running — a late tick must not undo "ready". */
export function updateDownloadProgress(p: UpdateDownloadProgress): void {
  updateDownload.update((s) =>
    s.phase === 'downloading' ? { phase: 'downloading', percent: Math.max(0, Math.min(100, p.percent)) } : s
  );
}

export function updateDownloaded(version: string): void {
  updateDownload.set({ phase: 'ready', version });
}

export function updateDownloadFailed(error: string): void {
  updateDownload.set({ phase: 'failed', error });
}
