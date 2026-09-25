<script lang="ts">
  // Text a plugin asked to show (`bssh.ui.showText`). Always labelled with the plugin's
  // name, so it is never mistaken for a message from the app itself.
  import Modal from './Modal.svelte';
  import { pluginText } from '$lib/stores/plugins';
</script>

{#if $pluginText}
  {@const shown = $pluginText}
  <Modal label="{shown.pluginName}: {shown.title}" size="large" onClose={() => pluginText.set(null)}>
    <h2 class="text-sm font-semibold">{shown.title}</h2>
    <p class="mb-3 text-xs text-faint">From the plugin “{shown.pluginName}”</p>
    <pre
      class="max-h-[60vh] overflow-auto whitespace-pre rounded-lg bg-surface-inset p-3 font-mono text-xs text-fg select-text">{shown.text}</pre>
  </Modal>
{/if}
