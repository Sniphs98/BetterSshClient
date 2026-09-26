<script lang="ts">
  // One Snippet placed into an Automation, rendered on the svelte-flow canvas
  // (AutomationEditor.svelte). Editing happens right on the node — label text, where it
  // runs, and the continueOnError toggle — via `useSvelteFlow().updateNodeData`, which mutates the
  // `nodes` array `bind:nodes` in AutomationEditor, so the parent needs no event plumbing.
  // Interactive elements carry `nodrag`/`nopan` (svelte-flow's escape hatch) so typing
  // or clicking them doesn't start a node drag or a canvas pan. Editing the underlying
  // *Snippet* (its command and timeout — not just this node's label/target/wiring) opens
  // the same SnippetEditor form the library screen uses, via double-click or the
  // edit button — see AUTOMATION_NODE_ACTIONS_CONTEXT.
  import { getContext } from 'svelte';
  import { Handle, Position, useSvelteFlow, type NodeProps } from '@xyflow/svelte';
  import { Icon } from '$lib/theme';
  import Select from '$lib/components/Select.svelte';
  import { AUTOMATION_NODE_ACTIONS_CONTEXT, type SnippetNode, type AutomationNodeActionsContext } from './automationCanvasTypes';

  let { id, data, selected }: NodeProps<SnippetNode> = $props();

  const { updateNodeData, deleteElements } = useSvelteFlow();
  const actions = getContext<AutomationNodeActionsContext>(AUTOMATION_NODE_ACTIONS_CONTEXT);

  function remove(): void {
    void deleteElements({ nodes: [{ id }] });
  }

  function edit(): void {
    actions.editSnippet(data.snippetId);
  }

  // WSL is offered where this machine has it — and kept on a node that already runs
  // there (an automation opened elsewhere), so opening it never silently changes it.
  const targets = $derived([
    { value: 'local' as const, label: 'local', title: 'Runs on this machine' },
    ...(actions.wslDistros().length > 0 || data.target === 'wsl'
      ? [{ value: 'wsl' as const, label: 'WSL', title: 'Runs in WSL on this machine (bash), in your Windows home folder' }]
      : []),
    { value: 'remote' as const, label: 'on host', title: 'Runs on the host chosen when the automation runs (its host parameter)' }
  ]);
  // The saved distribution stays choosable even if it isn't installed here.
  const distroChoices = $derived.by(() => {
    const list = actions.wslDistros();
    return data.wslDistro && !list.includes(data.wslDistro) ? [data.wslDistro, ...list] : list;
  });
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
      title="Edit {data.snippetName}"
      aria-label="Edit {data.snippetName}"
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
    title="Double-click to edit {data.snippetName}"
    ondblclick={edit}
    onkeydown={(e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        edit();
      }
    }}
  >
    {data.snippetName}
  </div>

  <!-- Where this placement runs. On the node rather than on the Snippet, so the same
       snippet can be a local step in one automation and a remote one in another. -->
  <div class="nodrag nopan flex items-center gap-1.5 text-[11px] text-muted">
    <span class="shrink-0">Runs</span>
    <div class="ml-auto flex gap-0.5 rounded bg-surface-inset p-0.5">
      {#each targets as option (option.value)}
        <button
          type="button"
          class="rounded px-1.5 py-0.5 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus {data.target ===
          option.value
            ? 'bg-accent text-accent-fg'
            : 'hover:text-fg'}"
          title={option.title}
          aria-pressed={data.target === option.value}
          onclick={() => updateNodeData(id, { target: option.value })}
        >
          {option.label}
        </button>
      {/each}
    </div>
  </div>

  {#if data.target === 'wsl'}
    <label class="nodrag nopan flex items-center gap-1.5 text-[11px] text-muted">
      <span class="shrink-0">Distribution</span>
      <div class="ml-auto min-w-0 flex-1">
        <Select
          value={data.wslDistro}
          onchange={(e: Event) => updateNodeData(id, { wslDistro: (e.currentTarget as HTMLSelectElement).value })}
          class="w-full rounded bg-surface-inset px-1.5 py-0.5 text-[11px] text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus"
          aria-label="WSL distribution"
        >
          <option value="">Default</option>
          {#each distroChoices as distro (distro)}
            <option value={distro}>{distro}</option>
          {/each}
        </Select>
      </div>
    </label>
  {/if}

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
