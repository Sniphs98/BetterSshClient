<script lang="ts">
  // A centered dialog over a scrim (tech-gui.md §2.2 forms/results). Same overlay
  // language as the command palette — role="dialog", Escape to dismiss, backdrop
  // click to close — but a solid raised surface for readable forms. Content is
  // passed in; the chrome (scrim, box, key handling) is fixed here so the snippet
  // dialogs don't each re-implement it.
  import type { Snippet } from 'svelte';

  let {
    label,
    onClose,
    size = 'default',
    children
  }: { label: string; onClose: () => void; size?: 'default' | 'large'; children: Snippet } = $props();

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div
  class="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]"
  role="dialog"
  aria-modal="true"
  aria-label={label}
>
  <button
    type="button"
    tabindex="-1"
    aria-label="Dismiss"
    class="absolute inset-0 bg-overlay"
    onclick={onClose}
  ></button>

  <div
    class="relative flex w-full flex-col overflow-hidden rounded-2xl border border-default bg-surface-raised shadow-soft
      {size === 'large' ? 'max-h-[85vh] max-w-4xl' : 'max-h-[76vh] max-w-lg'}"
  >
    {@render children()}
  </div>
</div>
