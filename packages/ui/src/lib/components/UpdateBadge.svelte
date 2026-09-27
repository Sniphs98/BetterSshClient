<script lang="ts">
  // The sidebar's version badge while an update is on offer and its banner has tucked
  // itself away (UpdateBanner flies into it): highlighted, saying what's next, and one
  // click does it — download, then restart to install; the release page where this copy
  // can't update itself. Collapsed sidebar: a round button in its place.
  import { scale } from 'svelte/transition';
  import { backOut } from 'svelte/easing';
  import { Icon } from '$lib/theme';
  import { availableUpdate, updateDownload } from '$lib/stores/update';
  import { updateFromBadge } from '$lib/stores/updateActions';
  import { UPDATE_BADGE_ID } from './flyToBadge';

  let { collapsed = false }: { collapsed?: boolean } = $props();

  // Short: the badge shares the footer with three icons. The tooltip says the rest.
  const label = $derived.by(() => {
    const info = $availableUpdate;
    const dl = $updateDownload;
    if (!info) return '';
    if (!info.canSelfUpdate) return 'Update';
    if (dl.phase === 'downloading') return `Updating ${Math.round(dl.percent)}%`;
    if (dl.phase === 'ready') return 'Restart';
    if (dl.phase === 'failed') return 'Retry update';
    return 'Update';
  });

  const title = $derived.by(() => {
    const info = $availableUpdate;
    const dl = $updateDownload;
    if (!info) return '';
    if (!info.canSelfUpdate) return `BetterSshClient v${info.version} is out — open the release page`;
    if (dl.phase === 'downloading') return `Downloading v${info.version}…`;
    if (dl.phase === 'ready') return `v${info.version} is downloaded — restart to install it`;
    if (dl.phase === 'failed') return `The download failed: ${dl.error}`;
    return `BetterSshClient v${info.version} is out — click to update`;
  });

  const busy = $derived($updateDownload.phase === 'downloading');
</script>

{#if collapsed}
  <button
    id={UPDATE_BADGE_ID}
    type="button"
    class="relative grid h-9 w-9 place-items-center rounded-full bg-accent text-accent-fg transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
    {title}
    aria-label={label}
    disabled={busy}
    onclick={updateFromBadge}
    in:scale={{ start: 0.4, duration: 350, delay: 380, easing: backOut }}
  >
    <Icon name="download" size={16} />
  </button>
{:else}
  <button
    id={UPDATE_BADGE_ID}
    type="button"
    class="ml-1 inline-flex min-w-0 items-center gap-1.5 overflow-hidden rounded-full bg-accent px-2.5 py-0.5 text-[11px] font-medium text-accent-fg transition hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-default"
    {title}
    disabled={busy}
    onclick={updateFromBadge}
    in:scale={{ start: 0.4, duration: 350, delay: 380, easing: backOut }}
  >
    {#if busy}
      <span class="inline-flex animate-spin"><Icon name="refresh" size={11} /></span>
    {:else}
      <span class="relative flex h-1.5 w-1.5 shrink-0">
        <!-- Green, the app's "all good" colour: something new is ready. -->
        <span class="absolute inline-flex h-full w-full animate-ping rounded-full bg-status-ok opacity-75"></span>
        <span class="relative inline-flex h-1.5 w-1.5 rounded-full bg-status-ok"></span>
      </span>
    {/if}
    <span class="truncate">{label}</span>
  </button>
{/if}
