<script lang="ts">
  // Keyboard on the Automation canvas: Ctrl/⌘+A selects every step, Ctrl/⌘+C copies the
  // selected ones, Ctrl/⌘+V pastes where the mouse is (in flow coordinates — which only
  // code inside <SvelteFlow> can work out, hence this component). Keys typed into a
  // field, or while a dialog is open, are left alone.
  import { useSvelteFlow } from '@xyflow/svelte';

  let {
    onSelectAll,
    onCopy,
    onPaste
  }: {
    onSelectAll: () => void;
    onCopy: () => void;
    /** `at`: where the mouse is on the canvas, or null when it isn't over it. */
    onPaste: (at: { x: number; y: number } | null) => void;
  } = $props();

  const { screenToFlowPosition } = useSvelteFlow();
  let pointer: { x: number; y: number } | null = null;

  function overCanvas(e: PointerEvent): void {
    const pane = (e.target as HTMLElement | null)?.closest('.svelte-flow');
    pointer = pane ? { x: e.clientX, y: e.clientY } : null;
  }

  function typing(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null;
    return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
  }

  function onKeydown(e: KeyboardEvent): void {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    if (typing(e.target) || document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
    const key = e.key.toLowerCase();
    if (key === 'a') {
      e.preventDefault();
      onSelectAll();
    } else if (key === 'c') {
      // Text selected on the page (an output, say): the browser copies that instead.
      if (window.getSelection()?.toString()) return;
      e.preventDefault();
      onCopy();
    } else if (key === 'v') {
      e.preventDefault();
      onPaste(pointer ? screenToFlowPosition(pointer) : null);
    }
  }
</script>

<svelte:window onkeydown={onKeydown} onpointermove={overCanvas} />
