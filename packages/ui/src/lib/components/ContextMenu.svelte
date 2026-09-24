<script lang="ts">
  // A small right-click menu positioned at the cursor (SFTP panes, tech-gui.md §3.2).
  // Same dismiss language as Modal (scrim click, Escape) but no backdrop dimming and no
  // centering — it opens exactly where the click happened, clamped to stay on-screen.
  import type { IconName } from '$lib/theme';
  import { Icon } from '$lib/theme';

  export interface ContextMenuItem {
    label: string;
    icon?: IconName;
    onSelect: () => void;
    disabled?: boolean;
    /** Destructive actions (Delete) render in the critical-status colour. */
    danger?: boolean;
  }

  let { x, y, items, onClose }: { x: number; y: number; items: ContextMenuItem[]; onClose: () => void } =
    $props();

  let menuEl = $state<HTMLDivElement | undefined>();
  // Clamped so the menu never opens off the edge of the window, especially in a narrow
  // pane near the right side of the app. Undefined until the first measurement — the
  // template falls back to the raw click position for that first paint.
  let pos = $state<{ left: number; top: number } | undefined>(undefined);

  $effect(() => {
    const el = menuEl;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const left = Math.min(x, Math.max(8, window.innerWidth - rect.width - 8));
    const top = Math.min(y, Math.max(8, window.innerHeight - rect.height - 8));
    pos = { left, top };
  });

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }

  function activate(item: ContextMenuItem): void {
    if (item.disabled) return;
    onClose();
    item.onSelect();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<!-- Full-screen scrim, invisible: any click or a second right-click outside the menu
     dismisses it, matching how a native context menu behaves. -->
<button
  type="button"
  tabindex="-1"
  aria-label="Dismiss menu"
  class="fixed inset-0 z-40 cursor-default"
  onclick={onClose}
  oncontextmenu={(e) => {
    e.preventDefault();
    onClose();
  }}
></button>

<div
  bind:this={menuEl}
  role="menu"
  class="fixed z-50 min-w-[11rem] overflow-hidden rounded-lg border border-default bg-surface-raised py-1 shadow-soft"
  style="left: {pos?.left ?? x}px; top: {pos?.top ?? y}px;"
>
  {#each items as item, i (i)}
    <button
      type="button"
      role="menuitem"
      disabled={item.disabled}
      class="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm transition
        disabled:cursor-not-allowed disabled:opacity-40
        {item.danger ? 'text-status-crit hover:bg-status-crit/10' : 'text-fg hover:bg-surface-inset'}"
      onclick={() => activate(item)}
    >
      {#if item.icon}<Icon name={item.icon} size={14} />{/if}
      <span class="min-w-0 flex-1 truncate">{item.label}</span>
    </button>
  {/each}
</div>
