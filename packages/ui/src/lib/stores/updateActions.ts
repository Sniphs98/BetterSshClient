import { get } from 'svelte/store';
import { installUpdate, restartToUpdate } from '$lib/ipc/commands';
import { openExternal } from '$lib/ipc/openExternal';
import { lastError } from './notifications';
import { availableUpdate, beginUpdateDownload, updateDownload, updateDownloadFailed } from './update';

// What installing the offered update does, shared by the banner and the sidebar's
// version badge (which the banner tucks into), so both act alike.

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Start downloading the update in the background; progress and completion arrive as events. */
export function startUpdate(): void {
  beginUpdateDownload();
  installUpdate().catch((e) => updateDownloadFailed(message(e)));
}

/** Quit and install the downloaded update. */
export async function restartNow(): Promise<void> {
  try {
    await restartToUpdate();
  } catch (e) {
    lastError.set(message(e));
  }
}

export async function openReleasePage(url: string): Promise<void> {
  try {
    await openExternal(url);
  } catch (e) {
    lastError.set(message(e));
  }
}

/** The badge's one action, whatever stage the update is at: this copy can't update
 *  itself → the release page; not downloaded yet (or failed) → download; downloaded →
 *  restart. While downloading, nothing. */
export function updateFromBadge(): void {
  const info = get(availableUpdate);
  if (!info) return;
  if (!info.canSelfUpdate) {
    void openReleasePage(info.url);
    return;
  }
  const dl = get(updateDownload);
  if (dl.phase === 'idle' || dl.phase === 'failed') startUpdate();
  else if (dl.phase === 'ready') void restartNow();
}
