<script lang="ts">
  // The flow's parameters, drawn as the graph's permanent starting node instead of a
  // toolbar above the canvas — "parameters flow in from here." No `Handle`s: a param
  // is visible to every node via `{{params.<name>}}` regardless of edges, so a real
  // connection into it would claim a dependency that doesn't exist (see
  // flowCanvasTypes.ts's note on `START_NODE_ID`). Reads/writes `params` through
  // `FLOW_PARAMS_CONTEXT` rather than `Node.data`, so typing into the add-parameter
  // fields never has to rebuild FlowEditor's node array.
  import { getContext } from 'svelte';
  import type { NodeProps } from '@xyflow/svelte';
  import { Icon } from '$lib/theme';
  import Select from '$lib/components/Select.svelte';
  import { FLOW_PARAMS_CONTEXT, type FlowParamsContext, type StartFlowNode } from './flowCanvasTypes';

  // svelte-flow's `nodeTypes` requires every registered component to accept
  // `NodeProps` — unused here since this node's state lives in `FLOW_PARAMS_CONTEXT`,
  // not `Node.data`.
  let {}: NodeProps<StartFlowNode> = $props();

  const ctx = getContext<FlowParamsContext>(FLOW_PARAMS_CONTEXT);

  let newName = $state('');
  let newKind = $state<'text' | 'host'>('text');

  const hasHostParam = $derived(ctx.params().some((p) => p.kind === 'host'));

  function add(): void {
    if (!newName.trim()) return;
    ctx.addParam(newName, newKind);
    newName = '';
    newKind = 'text';
  }

  const field =
    'nodrag min-w-0 rounded-lg bg-surface-inset px-2 py-1.5 text-xs text-fg outline-none ' +
    'focus-visible:ring-2 focus-visible:ring-focus placeholder:text-faint';
</script>

<div class="w-64 space-y-2.5 rounded-lg border border-accent/50 bg-surface p-3 text-left shadow-sm">
  <div class="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-[0.12em] text-accent">
    <Icon name="play" size={11} />
    Start
  </div>
  <p class="text-[11px] leading-snug text-muted">
    Collected before this flow runs. A host parameter targets every remote automation
    below; reference either kind in a command as {'{{params.<name>}}'}.
  </p>

  {#if ctx.params().length > 0}
    <div class="flex flex-wrap gap-1.5">
      {#each ctx.params() as param (param.name)}
        <span class="inline-flex items-center gap-1.5 rounded-full border border-default px-2 py-0.5 text-[11px] text-muted">
          <span class="font-mono">{param.name}</span>
          <span class="text-faint">({param.kind})</span>
          <button
            type="button"
            class="nodrag text-faint hover:text-fg"
            title="Remove parameter {param.name}"
            aria-label="Remove parameter {param.name}"
            onclick={() => ctx.removeParam(param.name)}
          >
            <Icon name="close" size={10} />
          </button>
        </span>
      {/each}
    </div>
  {/if}

  <div class="flex items-center gap-1.5">
    <input
      bind:value={newName}
      class="{field} flex-1"
      placeholder="name"
      aria-label="Parameter name"
      onkeydown={(e) => e.key === 'Enter' && (e.preventDefault(), add())}
    />
    <Select bind:value={newKind} class={field} aria-label="Parameter kind">
      <option value="text">text</option>
      <option value="host" disabled={hasHostParam}>host</option>
    </Select>
    <button
      type="button"
      class="nodrag grid h-7 w-7 shrink-0 place-items-center rounded text-muted transition hover:bg-surface-inset hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-40"
      title="Add parameter"
      aria-label="Add parameter"
      disabled={!newName.trim()}
      onclick={add}
    >
      <Icon name="plus" size={13} />
    </button>
  </div>
</div>
