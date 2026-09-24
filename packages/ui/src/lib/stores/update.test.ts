import { beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import type { UpdateInfoDto } from '$lib/bindings';
import {
  availableUpdate,
  beginUpdateDownload,
  dismissUpdate,
  offerUpdate,
  updateDownload,
  updateDownloaded,
  updateDownloadFailed
} from './update';
import { applyUpdateAvailable, applyUpdateDownloaded, applyUpdateDownloadProgress } from '$lib/ipc/router';

const info: UpdateInfoDto = {
  version: '1.2.0',
  url: 'https://github.com/timhartmann7/better-ssh-client/releases/tag/v1.2.0',
  tag: 'v1.2.0',
  canSelfUpdate: true
};

describe('update banner store', () => {
  beforeEach(() => dismissUpdate());

  it('starts hidden', () => {
    expect(get(availableUpdate)).toBeNull();
  });

  it('offerUpdate shows the update; dismiss hides it', () => {
    offerUpdate(info);
    expect(get(availableUpdate)).toEqual(info);
    dismissUpdate();
    expect(get(availableUpdate)).toBeNull();
  });

  it('applyUpdateAvailable routes an update-available event into the banner', () => {
    applyUpdateAvailable({ info });
    expect(get(availableUpdate)).toEqual(info);
  });
});

describe('update download state', () => {
  beforeEach(() => updateDownload.set({ phase: 'idle' }));

  it('runs idle → downloading → ready', () => {
    beginUpdateDownload();
    expect(get(updateDownload)).toEqual({ phase: 'downloading', percent: 0 });
    applyUpdateDownloadProgress({ percent: 57.5, transferred: 575, total: 1000 });
    expect(get(updateDownload)).toEqual({ phase: 'downloading', percent: 57.5 });
    applyUpdateDownloaded({ version: '1.2.0' });
    expect(get(updateDownload)).toEqual({ phase: 'ready', version: '1.2.0' });
  });

  it('ignores a progress tick that arrives after the download finished or failed', () => {
    updateDownloaded('1.2.0');
    applyUpdateDownloadProgress({ percent: 99, transferred: 99, total: 100 });
    expect(get(updateDownload)).toEqual({ phase: 'ready', version: '1.2.0' });
    updateDownloadFailed('boom');
    applyUpdateDownloadProgress({ percent: 10, transferred: 1, total: 10 });
    expect(get(updateDownload)).toEqual({ phase: 'failed', error: 'boom' });
  });

  it('clamps progress to 0–100', () => {
    beginUpdateDownload();
    applyUpdateDownloadProgress({ percent: 140, transferred: 0, total: 0 });
    expect(get(updateDownload)).toEqual({ phase: 'downloading', percent: 100 });
  });
});
