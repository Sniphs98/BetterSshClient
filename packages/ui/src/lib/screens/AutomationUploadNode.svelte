<script lang="ts">
  // A built-in upload step on the Automation canvas (AutomationEditor.svelte): copies a
  // file from this machine to the automation's host over the app's own SFTP connection.
  // Laid out like AutomationCanvasNode.svelte — label, then its own fields — and edited
  // in place the same way, via `updateNodeData`. No "runs local / on host" switch: an
  // upload always needs the host. Its output is the path the file landed at, so the next
  // node can say `docker load < {{nodes.<label>.output}}`.
  //
  // Where the file comes *from* is a switch, though: this computer's own file system, or
  // a WSL distribution — a file a WSL node wrote to `/tmp` exists only there, and looking
  // it up by name on Windows would find nothing, or an old file of the same name.
  import { getContext } from 'svelte';
  import { Handle, Position, useSvelteFlow, type NodeProps } from '@xyflow/svelte';
  import { Icon } from '$lib/theme';
  import Select from '$lib/components/Select.svelte';
  import { AUTOMATION_NODE_ACTIONS_CONTEXT, type AutomationNodeActionsContext, type UploadNode } from './automationCanvasTypes';

  let { id, data, selected }: NodeProps<UploadNode> = $props();

  const { updateNodeData, deleteElements } = useSvelteFlow();
  const actions = getContext<AutomationNodeActionsContext>(AUTOMATION_NODE_ACTIONS_CONTEXT);

  // WSL is offered where this machine has it — and kept on a node that already reads
  // from it, as AutomationCanvasNode.svelte does for its target.
  const sources = $derived([
    { value: 'local' as const, label: 'this computer', title: 'A file in Windows — relative paths start in your home folder' },
    ...(actions.wslDistros().length > 0 || data.source === 'wsl'
      ? [{ value: 'wsl' as const, label: 'WSL', title: 'A file inside WSL, such as /tmp/image.tar.gz — what a WSL node wrote' }]
      : [])
  ]);
  const distroChoices = $derived.by(() => {
    const list = actions.wslDistros();
    return data.wslDistro && !list.includes(data.wslDistro) ? [data.wslDistro, ...list] : list;
  });

  const input =
    'nodrag w-full rounded bg-surface-inset px-2 py-1 font-mono text-xs text-fg outline-none ' +
    'focus-visible:ring-2 focus-visible:ring-focus placeholder:text-faint';
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
      onclick={() => void deleteElements({ nodes: [{ id }] })}
    >
      <Icon name="trash" size={13} />
    </button>
  </div>

  <div class="flex items-center gap-1.5 text-[11px] text-muted">
    <Icon name="upload" size={12} />
    Upload a file to the host
  </div>

  {#if sources.length > 1}
    <div class="nodrag nopan flex items-center gap-1.5 text-[11px] text-muted">
      <span class="shrink-0">From</span>
      <div class="ml-auto flex gap-0.5 rounded bg-surface-inset p-0.5">
        {#each sources as option (option.value)}
          <button
            type="button"
            class="rounded px-1.5 py-0.5 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus {data.source ===
            option.value
              ? 'bg-accent text-accent-fg'
              : 'hover:text-fg'}"
            title={option.title}
            aria-pressed={data.source === option.value}
            onclick={() => updateNodeData(id, { source: option.value })}
          >
            {option.label}
          </button>
        {/each}
      </div>
    </div>
  {/if}

  {#if data.source === 'wsl'}
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

  <label class="block space-y-0.5 text-[11px] text-muted">
    <span>{data.source === 'wsl' ? 'From WSL' : 'From this computer'}</span>
    <input
      value={data.from}
      oninput={(e) => updateNodeData(id, { from: e.currentTarget.value })}
      class={input}
      placeholder={data.source === 'wsl' ? '/tmp/image.tar.gz' : 'image.tar.gz'}
      spellcheck="false"
      title={data.source === 'wsl'
        ? 'A path inside WSL — ~ is your Linux home, relative paths start where WSL nodes run (your Windows home folder)'
        : 'A file on this computer — relative paths start in your home folder, where local nodes run'}
    />
  </label>

  <label class="block space-y-0.5 text-[11px] text-muted">
    <span>To on the host</span>
    <input
      value={data.to}
      oninput={(e) => updateNodeData(id, { to: e.currentTarget.value })}
      class={input}
      placeholder="/tmp/"
      spellcheck="false"
      title="A path on the host — end it with / to keep the file's name. The node's output is where the file landed."
    />
  </label>

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
