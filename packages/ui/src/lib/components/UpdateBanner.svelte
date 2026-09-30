<script lang="ts">
  // Update banner (tech-gui.md §4.3). Floats above the status bar whenever an update is
  // available — from the startup `update-available` event or a manual check.
  //
  // Where this copy of the app can update itself (`info.canSelfUpdate`: the Windows
  // installer build, a Linux AppImage), "Update now" downloads the release in the
  // background with a progress bar, then "Restart to update" installs it. Everywhere
  // else (macOS until builds are signed, the portable/zip builds, .deb/.rpm) it links to
  // the release page instead. Skip persists the version to the shared config so it is
  // never offered again. After a few seconds — or when closed — the banner flies into
  // the sidebar's version badge, which then offers the update itself (UpdateBadge).
  import { fly } from 'svelte/transition';
  import { Icon } from '$lib/theme';
  import { availableUpdate, dismissUpdate, minimizeUpdate, updateDownload, updateMinimized } from '$lib/stores/update';
  import { openReleasePage, restartNow, restarting, startUpdate } from '$lib/stores/updateActions';
  import { loadUpdateConfig, saveUpdateConfig } from '$lib/ipc/commands';
  import { lastError } from '$lib/stores/notifications';
  import { flyToBadge } from './flyToBadge';

  const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
  let busy = $state(false);

  function updateNow(): void {
    startUpdate();
  }

  async function restart(): Promise<void> {
    busy = true;
    await restartNow();
    busy = false;
  }

  // How long the banner stays before tucking itself away. Not while the pointer or the
  // keyboard is on it, and not while it has news to show (downloading, failed).
  const AUTO_HIDE_MS = 8000;
  let hovered = $state(false);
  let focused = $state(false);
  $effect(() => {
    const phase = $updateDownload.phase;
    if (!$availableUpdate || $updateMinimized || hovered || focused) return;
    if (phase === 'downloading' || phase === 'failed') return;
    const timer = setTimeout(minimizeUpdate, AUTO_HIDE_MS);
    return () => clearTimeout(timer);
  });

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

{#if $availableUpdate && !$updateMinimized}
  {@const info = $availableUpdate}
  {@const dl = $updateDownload}
  <div
    class="pointer-events-none fixed inset-x-0 bottom-14 z-40 flex justify-center px-4"
    in:fly={{ y: 16, duration: 250 }}
    out:flyToBadge
  >
    <!-- svelte-ignore a11y_no_static_element_interactions -- hover only pauses the auto-hide -->
    <div
      class="pointer-events-auto w-full max-w-xl rounded-2xl border border-default bg-surface-raised px-4 py-3 shadow-soft"
      role="status"
      aria-label="Update"
      onmouseenter={() => (hovered = true)}
      onmouseleave={() => (hovered = false)}
      onfocusin={() => (focused = true)}
      onfocusout={() => (focused = false)}
    >
      <div class="flex items-center gap-3">
        <span class="shrink-0 text-muted"><Icon name="download" size={18} /></span>
        <div class="min-w-0">
          {#if dl.phase === 'downloading'}
            <p class="text-sm font-medium">Downloading v{info.version}… {Math.round(dl.percent)}%</p>
            <p class="truncate text-xs text-muted">You can keep working in the meantime.</p>
          {:else if dl.phase === 'ready' && $restarting}
            <p class="text-sm font-medium">Restarting to install v{dl.version}…</p>
            <p class="truncate text-xs text-muted">The app closes and opens again by itself.</p>
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
            <button type="button" class={primary} disabled={busy || $restarting} onclick={restart}>Restart to update</button>
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
            title="Hide — it stays in the version badge"
            aria-label="Dismiss update notice"
            onclick={minimizeUpdate}
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
