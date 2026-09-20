<script lang="ts">
  // The flow's parameters, drawn as the graph's permanent starting node instead of a
  // toolbar above the canvas — "parameters flow in from here." Reads/writes `params`
  // through `FLOW_PARAMS_CONTEXT` rather than `Node.data`, so typing into any field
  // here never has to rebuild FlowEditor's node array.
  //
  // One source `Handle` (right) lets the user drag a line from here to any node,
  // purely so the canvas *looks* connected — a param is visible to every node via
  // `{{params.<name>}}` regardless of edges, so this never becomes a real dependency
  // edge. FlowEditor.svelte renders it dashed/muted and keeps it out of the saved
  // `FlowDto.edges` entirely, routing it into `startLinks` instead (see
  // flowCanvasTypes.ts's note on `START_NODE_ID`). No target handle: nothing ever
  // depends on Start, so nothing should be able to connect into it.
  //
  // Every row — new or already-saved — is the same plain, unboxed-at-rest field, and
  // behaves the same way: edits (rename, re-kind) apply on every keystroke, no
  // separate "confirm" step. The dashed "+ Add parameter" button reflects that: it
  // doesn't open a draft form to fill in and submit, it immediately appends a param
  // (default text-kind, a placeholder name like "param") and focuses + selects that
  // new row's name field, so typing straight away just replaces the placeholder — one
  // action, not two. Rows are keyed by index, not name: keying by name would remount
  // (and defocus) a row's own `<input>` on every keystroke, since typing changes the
  // very key `{#each}` tracks it by, and would also defeat the focus-the-new-row step
  // right after clicking "+".
  import { getContext, tick } from 'svelte';
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import { Icon } from '$lib/theme';
  import Select from '$lib/components/Select.svelte';
  import type { FlowParamKindDto } from '$lib/bindings';
  import { FLOW_PARAMS_CONTEXT, type FlowParamsContext, type StartFlowNode } from './flowCanvasTypes';

  // svelte-flow's `nodeTypes` requires every registered component to accept
  // `NodeProps` — unused here since this node's state lives in `FLOW_PARAMS_CONTEXT`,
  // not `Node.data`.
  let {}: NodeProps<StartFlowNode> = $props();

  const ctx = getContext<FlowParamsContext>(FLOW_PARAMS_CONTEXT);

  let rowNameInputs: Array<HTMLInputElement | undefined> = [];

  function uniqueParamName(): string {
    const taken = new Set(ctx.params().map((p) => p.name));
    if (!taken.has('param')) return 'param';
    let i = 2;
    while (taken.has(`param-${i}`)) i += 1;
    return `param-${i}`;
  }

  function addParam(): void {
    const newIndex = ctx.params().length;
    ctx.addParam(uniqueParamName(), 'text');
    void tick().then(() => {
      const el = rowNameInputs[newIndex];
      el?.focus();
      el?.select();
    });
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
  <Handle type="source" position={Position.Right} />

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
          bind:this={rowNameInputs[i]}
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

    <button
      type="button"
      class="nodrag flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-default py-1.5 text-xs text-muted transition hover:border-strong hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      onclick={addParam}
    >
      <Icon name="plus" size={13} />
      Add parameter
    </button>
  </div>
</div>
