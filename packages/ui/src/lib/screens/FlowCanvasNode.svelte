<script lang="ts">
  // One Automation placed into a Flow, rendered on the svelte-flow canvas
  // (FlowEditor.svelte). Editing happens right on the node — label text and the
  // continueOnError toggle — via `useSvelteFlow().updateNodeData`, which mutates the
  // `nodes` array `bind:nodes` in FlowEditor, so the parent needs no event plumbing.
  // Interactive elements carry `nodrag`/`nopan` (svelte-flow's escape hatch) so typing
  // or clicking them doesn't start a node drag or a canvas pan.
  import { Handle, Position, useSvelteFlow, type NodeProps } from '@xyflow/svelte';
  import { Icon } from '$lib/theme';
  import type { AutomationFlowNode } from './flowCanvasTypes';

  let { id, data, selected }: NodeProps<AutomationFlowNode> = $props();

  const { updateNodeData, deleteElements } = useSvelteFlow();

  function remove(): void {
    void deleteElements({ nodes: [{ id }] });
  }
</script>

<div
  class="w-56 space-y-2 rounded-lg border bg-surface p-3 text-left shadow-sm {selected
    ? 'border-accent'
    : 'border-default'}"
>
  <Handle type="target" position={Position.Left} />

  <div class="flex items-center gap-1.5">
    <input
      value={data.label}
      oninput={(e) => updateNodeData(id, { label: e.currentTarget.value })}
      class="nodrag min-w-0 flex-1 rounded bg-surface-inset px-2 py-1 font-mono text-xs text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus"
      placeholder="label"
      aria-label="Label"
    />
    <button
      type="button"
      class="nodrag nopan grid h-6 w-6 shrink-0 place-items-center rounded text-muted transition hover:bg-surface-inset hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      title="Remove node"
      aria-label="Remove {data.label || 'node'}"
      onclick={remove}
    >
      <Icon name="trash" size={13} />
    </button>
  </div>

  <div class="truncate text-[11px] text-muted" title={data.automationName}>
    {data.automationName} · {data.automationKind}
  </div>

  <label class="nodrag flex items-center gap-1.5 text-[11px] text-muted">
    <input
      type="checkbox"
      checked={data.continueOnError}
      onchange={(e) => updateNodeData(id, { continueOnError: e.currentTarget.checked })}
      class="accent-current"
    />
    Continue on error
  </label>

  <Handle type="source" position={Position.Right} />
</div>
