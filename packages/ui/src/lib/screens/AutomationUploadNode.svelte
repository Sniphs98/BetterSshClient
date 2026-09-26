<script lang="ts">
  // A built-in upload step on the Automation canvas (AutomationEditor.svelte): copies a
  // file from this machine to the automation's host over the app's own SFTP connection.
  // Laid out like AutomationCanvasNode.svelte — label, then its own fields — and edited
  // in place the same way, via `updateNodeData`. No "runs local / on host" switch: an
  // upload always needs the host. Its output is the path the file landed at, so the next
  // node can say `docker load < {{nodes.<label>.output}}`.
  import { Handle, Position, useSvelteFlow, type NodeProps } from '@xyflow/svelte';
  import { Icon } from '$lib/theme';
  import type { UploadNode } from './automationCanvasTypes';

  let { id, data, selected }: NodeProps<UploadNode> = $props();

  const { updateNodeData, deleteElements } = useSvelteFlow();

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

  <label class="block space-y-0.5 text-[11px] text-muted">
    <span>From this computer</span>
    <input
      value={data.from}
      oninput={(e) => updateNodeData(id, { from: e.currentTarget.value })}
      class={input}
      placeholder="image.tar.gz"
      spellcheck="false"
      title="A file on this computer — relative paths start in your home folder, where local nodes run"
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
