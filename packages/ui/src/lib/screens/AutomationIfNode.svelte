<script lang="ts">
  // A built-in If on the Automation canvas (AutomationEditor.svelte): asks a question when
  // the run reaches it, and only the nodes connected to its "yes" handle — or to its
  // "no" one — run; the others are skipped, and so is what only they lead to. Laid out
  // like the upload and GitHub nodes, edited in place via `updateNodeData`.
  //   - Compare: a text (usually {{params.…}} or {{nodes.….output}}) against another.
  //   - Command succeeds: runs a command where the node says; exit code 0 is "yes".
  // Its output is `yes` or `no`, so a later node can use it too.
  import { getContext } from 'svelte';
  import { Handle, Position, useSvelteFlow, type NodeProps } from '@xyflow/svelte';
  import type { IfConditionDto, IfOperatorDto, NodeTargetDto } from '$lib/bindings';
  import { Icon } from '$lib/theme';
  import Select from '$lib/components/Select.svelte';
  import { AUTOMATION_NODE_ACTIONS_CONTEXT, type AutomationNodeActionsContext, type IfNode } from './automationCanvasTypes';

  let { id, data, selected }: NodeProps<IfNode> = $props();
  const { updateNodeData, deleteElements } = useSvelteFlow();
  const actions = getContext<AutomationNodeActionsContext>(AUTOMATION_NODE_ACTIONS_CONTEXT);

  const condition = $derived(data.condition);

  const OPERATORS: Array<{ value: IfOperatorDto; label: string; takesRight: boolean }> = [
    { value: 'equals', label: 'equals', takesRight: true },
    { value: 'notEquals', label: 'does not equal', takesRight: true },
    { value: 'contains', label: 'contains', takesRight: true },
    { value: 'notContains', label: 'does not contain', takesRight: true },
    { value: 'isEmpty', label: 'is empty', takesRight: false },
    { value: 'notEmpty', label: 'is not empty', takesRight: false }
  ];

  function setCondition(next: IfConditionDto): void {
    updateNodeData(id, { condition: next });
  }

  /** Switching kind keeps what the other kind had typed only where it fits. */
  function setKind(kind: IfConditionDto['kind']): void {
    if (kind === condition.kind) return;
    setCondition(kind === 'compare' ? { kind, left: '', op: 'equals', right: '' } : { kind, command: '', timeoutSecs: 30 });
    if (kind === 'compare') updateNodeData(id, { target: 'local' });
  }

  // Where a command runs: as a snippet node offers it — WSL only where this machine has it.
  const targets = $derived([
    { value: 'local' as const, label: 'local', title: 'Runs on this machine' },
    ...(actions.wslDistros().length > 0 || data.target === 'wsl'
      ? [{ value: 'wsl' as const, label: 'WSL', title: 'Runs in WSL on this machine' }]
      : []),
    { value: 'remote' as const, label: 'on host', title: 'Runs on the host chosen when the automation runs' }
  ]);
  const distroChoices = $derived.by(() => {
    const list = actions.wslDistros();
    return data.wslDistro && !list.includes(data.wslDistro) ? [data.wslDistro, ...list] : list;
  });

  const input =
    'nodrag w-full rounded bg-surface-inset px-2 py-1 font-mono text-xs text-fg outline-none ' +
    'focus-visible:ring-2 focus-visible:ring-focus placeholder:text-faint';
  const toggle = (on: boolean) =>
    'rounded px-1.5 py-0.5 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ' +
    (on ? 'bg-accent text-accent-fg' : 'hover:text-fg');
</script>

<div
  class="relative w-60 space-y-2 rounded-lg border bg-surface p-3 text-left shadow-sm {selected ? 'border-accent' : 'border-default'}"
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
    <Icon name="branch" size={12} />
    If — then one way or the other
  </div>

  <div class="nodrag nopan flex items-center gap-1.5 text-[11px] text-muted">
    <span class="shrink-0">Check</span>
    <div class="ml-auto flex gap-0.5 rounded bg-surface-inset p-0.5">
      <button
        type="button"
        class={toggle(condition.kind === 'compare')}
        aria-pressed={condition.kind === 'compare'}
        title="Compare a text — a parameter, an earlier node's output — with another"
        onclick={() => setKind('compare')}>compare</button
      >
      <button
        type="button"
        class={toggle(condition.kind === 'command')}
        aria-pressed={condition.kind === 'command'}
        title="Run a command: if it succeeds (exit code 0), the answer is yes"
        onclick={() => setKind('command')}>command</button
      >
    </div>
  </div>

  {#if condition.kind === 'compare'}
    {@const op = OPERATORS.find((o) => o.value === condition.op) ?? OPERATORS[0]}
    <input
      value={condition.left}
      oninput={(e) => setCondition({ ...condition, left: e.currentTarget.value })}
      class={input}
      placeholder={'{{params.env}}'}
      spellcheck="false"
      aria-label="Value to check"
      title="What to check — a parameter, an earlier node's output, or plain text"
    />
    <Select
      value={condition.op}
      onchange={(e: Event) => setCondition({ ...condition, op: (e.currentTarget as HTMLSelectElement).value as IfOperatorDto })}
      class="nodrag w-full rounded bg-surface-inset px-1.5 py-1 text-xs text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus"
      aria-label="Comparison"
    >
      {#each OPERATORS as o (o.value)}
        <option value={o.value}>{o.label}</option>
      {/each}
    </Select>
    {#if op.takesRight}
      <input
        value={condition.right}
        oninput={(e) => setCondition({ ...condition, right: e.currentTarget.value })}
        class={input}
        placeholder="prod"
        spellcheck="false"
        aria-label="Compare with"
      />
    {/if}
  {:else}
    <input
      value={condition.command}
      oninput={(e) => setCondition({ ...condition, command: e.currentTarget.value })}
      class={input}
      placeholder="test -f image.tar.gz"
      spellcheck="false"
      aria-label="Command"
      title="Succeeds (exit code 0) → yes; fails or times out → no"
    />
    <div class="nodrag nopan flex items-center gap-1.5 text-[11px] text-muted">
      <span class="shrink-0">Runs</span>
      <div class="ml-auto flex gap-0.5 rounded bg-surface-inset p-0.5">
        {#each targets as option (option.value)}
          <button
            type="button"
            class={toggle(data.target === option.value)}
            title={option.title}
            aria-pressed={data.target === option.value}
            onclick={() => updateNodeData(id, { target: option.value as NodeTargetDto })}
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

  <!-- The two ways out, labelled where they leave the node. -->
  <div class="pointer-events-none absolute left-full top-[35%] ml-2 -translate-y-1/2 text-[10px] font-semibold text-status-ok">yes</div>
  <div class="pointer-events-none absolute left-full top-[65%] ml-2 -translate-y-1/2 text-[10px] font-semibold text-status-crit">no</div>
  <Handle type="source" id="yes" position={Position.Right} style="top: 35%;" />
  <Handle type="source" id="no" position={Position.Right} style="top: 65%;" />
</div>
