<script lang="ts">
  // The flow's parameters, drawn as the graph's permanent starting node instead of a
  // toolbar above the canvas — "parameters flow in from here." No `Handle`s: a param
  // is visible to every node via `{{params.<name>}}` regardless of edges, so a real
  // connection into it would claim a dependency that doesn't exist (see
  // flowCanvasTypes.ts's note on `START_NODE_ID`). Reads/writes `params` through
  // `FLOW_PARAMS_CONTEXT` rather than `Node.data`, so typing into any field here never
  // has to rebuild FlowEditor's node array.
  //
  // Existing params are edited in place (rename/re-kind), not just add-or-delete —
  // each row uses the same plain, unboxed look the "add a new one" row does, so the
  // whole list reads as one stack of fields rather than a form above a separate
  // read-only chip list. A row only shows its input-field chrome (background, ring) on
  // hover/focus; at rest it's just text, so a flow with several params doesn't turn
  // into a wall of boxes. Rows are keyed by index, not name: keying by name would
  // remount (and defocus) the row's own `<input>` on every keystroke, since typing
  // changes the very key `{#each}` tracks it by.
  import { getContext } from 'svelte';
  import type { NodeProps } from '@xyflow/svelte';
  import { Icon } from '$lib/theme';
  import Select from '$lib/components/Select.svelte';
  import type { FlowParamKindDto } from '$lib/bindings';
  import { FLOW_PARAMS_CONTEXT, type FlowParamsContext, type StartFlowNode } from './flowCanvasTypes';

  // svelte-flow's `nodeTypes` requires every registered component to accept
  // `NodeProps` — unused here since this node's state lives in `FLOW_PARAMS_CONTEXT`,
  // not `Node.data`.
  let {}: NodeProps<StartFlowNode> = $props();

  const ctx = getContext<FlowParamsContext>(FLOW_PARAMS_CONTEXT);

  let newName = $state('');
  let newKind = $state<FlowParamKindDto>('text');

  const hasHostParam = $derived(ctx.params().some((p) => p.kind === 'host'));

  function add(): void {
    if (!newName.trim()) return;
    ctx.addParam(newName, newKind);
    newName = '';
    newKind = 'text';
  }

  // A row's own "host" option is only disabled by *another* row already being one —
  // never by itself, or switching it back to text (or right back to host) would be
  // impossible once it's the current host param.
  function hostTakenElsewhere(index: number): boolean {
    return ctx.params().some((p, i) => i !== index && p.kind === 'host');
  }

  const rowField =
    'nodrag min-w-0 rounded-lg bg-transparent px-2 py-1.5 text-xs text-fg outline-none transition ' +
    'hover:bg-surface-inset focus-visible:bg-surface-inset focus-visible:ring-2 focus-visible:ring-focus placeholder:text-faint';
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

  <div class="space-y-1">
    {#each ctx.params() as param, i (i)}
      <div class="flex items-center gap-1.5">
        <input
          value={param.name}
          oninput={(e) => ctx.updateParam(param.name, { name: e.currentTarget.value })}
          class="{rowField} flex-1 font-mono"
          placeholder="name"
          aria-label="Parameter {i + 1} name"
        />
        <Select
          value={param.kind}
          onchange={(e: Event & { currentTarget: HTMLSelectElement }) =>
            ctx.updateParam(param.name, { kind: e.currentTarget.value as FlowParamKindDto })}
          class={rowField}
          aria-label="Parameter {i + 1} kind"
        >
          <option value="text">text</option>
          <option value="host" disabled={hostTakenElsewhere(i)}>host</option>
        </Select>
        <button
          type="button"
          class="nodrag grid h-7 w-7 shrink-0 place-items-center rounded text-faint transition hover:bg-surface-inset hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          title="Remove parameter {param.name}"
          aria-label="Remove parameter {param.name}"
          onclick={() => ctx.removeParam(param.name)}
        >
          <Icon name="close" size={12} />
        </button>
      </div>
    {/each}

    <div class="flex items-center gap-1.5">
      <input
        bind:value={newName}
        class="{rowField} flex-1 font-mono"
        placeholder="name"
        aria-label="New parameter name"
        onkeydown={(e) => e.key === 'Enter' && (e.preventDefault(), add())}
      />
      <Select bind:value={newKind} class={rowField} aria-label="New parameter kind">
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
</div>
