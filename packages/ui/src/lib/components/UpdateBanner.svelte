<script lang="ts">
  // Update banner (tech-gui.md §4.3). Floats above the status bar whenever an update is
  // available — from the startup `update-available` event or a manual check.
  //
  // Where this copy of the app can update itself (`info.canSelfUpdate`: the Windows
  // installer build, a Linux AppImage), "Update now" downloads the release in the
  // background with a progress bar, then "Restart to update" installs it. Everywhere
  // else (macOS until builds are signed, the portable/zip builds, .deb/.rpm) it links to
  // the release page instead. Skip persists the version to the shared config so it is
  // never offered again; Dismiss hides it for this session only.
  import { Icon } from '$lib/theme';
  import {
    availableUpdate,
    beginUpdateDownload,
    dismissUpdate,
    updateDownload,
    updateDownloadFailed
  } from '$lib/stores/update';
  import { installUpdate, loadUpdateConfig, restartToUpdate, saveUpdateConfig } from '$lib/ipc/commands';
  import { openExternal } from '$lib/ipc/openExternal';
  import { lastError } from '$lib/stores/notifications';

  const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
  let busy = $state(false);

  async function openReleasePage(url: string): Promise<void> {
    try {
      await openExternal(url);
    } catch (e) {
      lastError.set(message(e));
    }
  }

  function updateNow(): void {
    beginUpdateDownload();
    // Progress and completion arrive as events; only a failure comes back here.
    installUpdate().catch((e) => updateDownloadFailed(message(e)));
  }

  async function restart(): Promise<void> {
    busy = true;
    try {
      await restartToUpdate();
    } catch (e) {
      lastError.set(message(e));
      busy = false;
    }
  }

  // Persist the skip against the current config so `check_on_startup` is preserved.
  async function skip(version: string): Promise<void> {
    busy = true;
    try {
      const config = await loadUpdateConfig();
      await saveUpdateConfig({ ...config, skipVersion: version });
      dismissUpdate();
    } catch (e) {
      lastError.set(message(e));
    } finally {
      busy = false;
    }
  }

  const action =
    'rounded-full px-3 py-1.5 text-sm transition disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';
  const primary = `${action} bg-accent text-accent-fg hover:opacity-90`;
  const secondary = `${action} text-muted hover:bg-surface-inset hover:text-fg`;
</script>

{#if $availableUpdate}
  {@const info = $availableUpdate}
  {@const dl = $updateDownload}
  <div class="pointer-events-none fixed inset-x-0 bottom-14 z-40 flex justify-center px-4">
    <div
      class="pointer-events-auto w-full max-w-xl rounded-2xl border border-default bg-surface-raised px-4 py-3 shadow-soft"
      role="status"
      aria-label="Update"
    >
      <div class="flex items-center gap-3">
        <span class="shrink-0 text-muted"><Icon name="download" size={18} /></span>
        <div class="min-w-0">
          {#if dl.phase === 'downloading'}
            <p class="text-sm font-medium">Downloading v{info.version}… {Math.round(dl.percent)}%</p>
            <p class="truncate text-xs text-muted">You can keep working in the meantime.</p>
          {:else if dl.phase === 'ready'}
            <p class="text-sm font-medium">v{dl.version} is ready to install</p>
            <p class="truncate text-xs text-muted">Restart now, or it installs the next time you quit.</p>
          {:else if dl.phase === 'failed'}
            <p class="text-sm font-medium">The update couldn't be downloaded</p>
            <p class="truncate text-xs text-muted" title={dl.error}>{dl.error}</p>
          {:else}
            <p class="text-sm font-medium">Update available — v{info.version}</p>
            <p class="truncate text-xs text-muted">A newer BetterSshClient release is ready.</p>
          {/if}
        </div>
        <div class="ml-auto flex shrink-0 items-center gap-1.5">
          {#if !info.canSelfUpdate}
            <button type="button" class={primary} disabled={busy} onclick={() => openReleasePage(info.url)}>
              Download
            </button>
          {:else if dl.phase === 'idle'}
            <button type="button" class={primary} disabled={busy} onclick={updateNow}>Update now</button>
          {:else if dl.phase === 'ready'}
            <button type="button" class={primary} disabled={busy} onclick={restart}>Restart to update</button>
          {:else if dl.phase === 'failed'}
            <button type="button" class={primary} onclick={updateNow}>Try again</button>
            <button type="button" class={secondary} onclick={() => openReleasePage(info.url)}>Download</button>
          {/if}
          {#if dl.phase === 'idle' || !info.canSelfUpdate}
            <button type="button" class={secondary} disabled={busy} onclick={() => skip(info.version)}>Skip</button>
          {/if}
          <button
            type="button"
            class="grid h-8 w-8 place-items-center rounded-full text-muted transition hover:bg-surface-inset hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            title="Dismiss"
            aria-label="Dismiss update notice"
            onclick={dismissUpdate}
          >
            <Icon name="close" size={15} />
          </button>
        </div>
      </div>
      {#if dl.phase === 'downloading'}
        <div class="mt-2.5 h-1.5 overflow-hidden rounded-full bg-surface-inset" aria-hidden="true">
          <div class="h-full rounded-full bg-accent transition-[width]" style="width: {dl.percent}%"></div>
        </div>
      {/if}
    </div>
  </div>
{/if}
