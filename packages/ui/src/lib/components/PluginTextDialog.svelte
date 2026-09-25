<script lang="ts">
  // Text a plugin asked to show (`bssh.ui.showText`). Always labelled with the plugin's
  // name, so it is never mistaken for a message from the app itself.
  import Modal from './Modal.svelte';
  import { pluginText } from '$lib/stores/plugins';
</script>

{#if $pluginText}
  {@const shown = $pluginText}
  <Modal label="{shown.pluginName}: {shown.title}" size="large" onClose={() => pluginText.set(null)}>
    <div class="flex min-h-0 flex-col p-6">
      <h2 class="text-sm font-semibold">{shown.title}</h2>
      <p class="mb-4 text-xs text-faint">From the plugin “{shown.pluginName}”</p>
      <pre
        class="min-h-0 overflow-auto whitespace-pre rounded-lg bg-surface-inset p-4 font-mono text-xs text-fg select-text">{shown.text}</pre>
    </div>
  </Modal>
{/if}
