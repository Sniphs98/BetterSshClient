<script lang="ts">
  // "Auto-arrange" in the canvas's control bar (under zoom and fit): the editor moves the
  // nodes (automationLayout.ts), then this fits the view to where they went. Lives inside
  // <SvelteFlow>, the only place `useSvelteFlow()` can be called.
  import { tick } from 'svelte';
  import { ControlButton, useSvelteFlow } from '@xyflow/svelte';

  let { onArrange }: { onArrange: () => void } = $props();
  const { fitView } = useSvelteFlow();

  async function arrange(): Promise<void> {
    onArrange();
    await tick();
    // After svelte-flow has taken the new positions.
    requestAnimationFrame(() => void fitView({ duration: 300 }));
  }
</script>

<ControlButton onclick={() => void arrange()} title="Auto-arrange" aria-label="Auto-arrange">
  <!-- Three boxes in a left-to-right flow. -->
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <rect x="2" y="9" width="6" height="6" rx="1" />
    <rect x="16" y="3" width="6" height="6" rx="1" />
    <rect x="16" y="15" width="6" height="6" rx="1" />
    <path d="M8 12h4M12 6v12M12 6h4M12 18h4" />
  </svg>
</ControlButton>
