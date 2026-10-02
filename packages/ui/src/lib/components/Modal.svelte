<script lang="ts">
  // A centered dialog over a scrim (tech-gui.md §2.2 forms/results). Same overlay
  // language as the command palette — role="dialog", Escape to dismiss, backdrop
  // click to close — but a solid raised surface for readable forms. Content is
  // passed in; the chrome (scrim, box, × button, key handling) is fixed here so the
  // dialogs don't each re-implement it.
  //
  // A dialog with unsaved changes (`dirty`) isn't lost to a stray click: the scrim,
  // Escape and × first ask whether to keep editing, discard, or save (`onSave`).
  import type { Snippet } from 'svelte';
  import { Button, Icon } from '$lib/theme';

  let {
    label,
    onClose,
    size = 'default',
    dirty = false,
    onSave,
    children
  }: {
    label: string;
    onClose: () => void;
    size?: 'default' | 'large' | 'wide';
    /** There are changes that closing would lose. */
    dirty?: boolean;
    /** Saves the changes (and closes, as the dialog's own Save does); offered in the
     *  "unsaved changes" question. Should throw — or leave the dialog open — when it
     *  can't save, so the reason shows. */
    onSave?: () => void | Promise<void>;
    children: Snippet;
  } = $props();

  let confirming = $state(false);
  let saving = $state(false);

  /** Closing by the scrim, Escape or ×: asks first when there are unsaved changes. */
  function requestClose(): void {
    if (dirty) confirming = true;
    else onClose();
  }

  async function saveFromPrompt(): Promise<void> {
    if (!onSave) return;
    saving = true;
    try {
      await onSave();
    } catch {
      // The dialog shows why; it stays open.
    } finally {
      saving = false;
      confirming = false;
    }
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    if (confirming) confirming = false;
    else requestClose();
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
    onclick={requestClose}
  ></button>

  <div
    class="relative flex w-full flex-col overflow-hidden rounded-2xl border border-default bg-surface-raised shadow-soft
      {size === 'wide' ? 'max-h-[88vh] max-w-6xl' : size === 'large' ? 'max-h-[85vh] max-w-4xl' : 'max-h-[76vh] max-w-lg'}"
  >
    {@render children()}

    <button
      type="button"
      class="absolute right-3 top-2.5 grid h-7 w-7 place-items-center rounded-lg text-faint transition hover:bg-surface-inset hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      title="Close (Esc)"
      aria-label="Close"
      onclick={requestClose}
    >
      <Icon name="close" size={14} />
    </button>

    {#if confirming}
      <div class="absolute inset-0 z-10 grid place-items-center bg-overlay p-4">
        <div
          class="w-full max-w-sm space-y-3 rounded-xl border border-default bg-surface-raised p-4 shadow-soft"
          role="alertdialog"
          aria-label="Unsaved changes"
        >
          <h2 class="text-sm font-semibold">Unsaved changes</h2>
          <p class="text-sm text-muted">You have changes that aren't saved yet. Save them before closing?</p>
          <div class="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onclick={() => (confirming = false)}>Keep editing</Button>
            <Button variant="ghost" onclick={onClose}>Discard</Button>
            {#if onSave}
              <Button variant="primary" onclick={saveFromPrompt} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
            {/if}
          </div>
        </div>
      </div>
    {/if}
  </div>
</div>
