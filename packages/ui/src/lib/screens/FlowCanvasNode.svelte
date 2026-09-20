<script lang="ts">
  // One Automation placed into a Flow, rendered on the svelte-flow canvas
  // (FlowEditor.svelte). Editing happens right on the node — label text and the
  // continueOnError toggle — via `useSvelteFlow().updateNodeData`, which mutates the
  // `nodes` array `bind:nodes` in FlowEditor, so the parent needs no event plumbing.
  // Interactive elements carry `nodrag`/`nopan` (svelte-flow's escape hatch) so typing
  // or clicking them doesn't start a node drag or a canvas pan. Editing the underlying
  // *Automation* (its command, kind, timeout — not just this node's label/wiring) opens
  // the same AutomationEditor form the library screen uses, via double-click or the
  // edit button — see FLOW_NODE_ACTIONS_CONTEXT.
  import { getContext } from 'svelte';
  import { Handle, Position, useSvelteFlow, type NodeProps } from '@xyflow/svelte';
  import { Icon } from '$lib/theme';
  import { FLOW_NODE_ACTIONS_CONTEXT, type AutomationFlowNode, type FlowNodeActionsContext } from './flowCanvasTypes';

  let { id, data, selected }: NodeProps<AutomationFlowNode> = $props();

  const { updateNodeData, deleteElements } = useSvelteFlow();
  const actions = getContext<FlowNodeActionsContext>(FLOW_NODE_ACTIONS_CONTEXT);

  function remove(): void {
    void deleteElements({ nodes: [{ id }] });
  }

  function edit(): void {
    actions.editAutomation(data.automationId);
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
      title="Edit {data.automationName}"
      aria-label="Edit {data.automationName}"
      onclick={edit}
    >
      <Icon name="edit" size={13} />
    </button>
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

  <div
    role="button"
    tabindex="0"
    class="nodrag truncate rounded text-[11px] text-muted outline-none focus-visible:ring-2 focus-visible:ring-focus"
    title="Double-click to edit {data.automationName}"
    ondblclick={edit}
    onkeydown={(e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        edit();
      }
    }}
  >
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
