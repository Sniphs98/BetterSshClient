<script lang="ts">
  // A "run automation" step on the Automation canvas (AutomationEditor.svelte), laid out
  // like the GitHub node: label, which automation, then a field per value that one asks
  // for when it runs — filled in from this automation where it can be (the host, a
  // parameter of the same name; see automationCall.ts). Every value also takes
  // {{params.…}} and {{nodes.….output}}. Output: the output of its last step.
  import { getContext } from 'svelte';
  import { Handle, Position, useSvelteFlow, type NodeProps } from '@xyflow/svelte';
  import { Icon } from '$lib/theme';
  import { automations } from '$lib/stores/automations';
  import Select from '$lib/components/Select.svelte';
  import { AUTOMATION_NODE_ACTIONS_CONTEXT, AUTOMATION_PARAMS_CONTEXT, type AutomationNodeActionsContext, type AutomationParamsContext, type CallNode } from './automationCanvasTypes';
  import { askedParams, callableAutomations, callParamValues } from './automationCall';

  let { id, data, selected }: NodeProps<CallNode> = $props();
  const { updateNodeData, deleteElements } = useSvelteFlow();
  const actions = getContext<AutomationNodeActionsContext>(AUTOMATION_NODE_ACTIONS_CONTEXT);
  const ownParams = getContext<AutomationParamsContext>(AUTOMATION_PARAMS_CONTEXT);

  const call = $derived(data.call);
  const choices = $derived(callableAutomations($automations, actions.automationName()));
  const called = $derived($automations.find((a) => a.name === call.automation));
  const asked = $derived(called ? askedParams(called) : []);

  function choose(name: string): void {
    const target = $automations.find((a) => a.name === name);
    updateNodeData(id, {
      call: { automation: name, params: target ? callParamValues(target, ownParams.params(), call.params) : {} }
    });
  }

  function setValue(name: string, value: string): void {
    updateNodeData(id, { call: { ...call, params: { ...call.params, [name]: value } } });
  }

  const input =
    'nodrag w-full rounded bg-surface-inset px-2 py-1 font-mono text-xs text-fg outline-none ' +
    'focus-visible:ring-2 focus-visible:ring-focus placeholder:text-faint';
</script>

<div class="w-60 space-y-2 rounded-lg border bg-surface p-3 text-left shadow-sm {selected ? 'border-accent' : 'border-default'}">
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
    <Icon name="automations" size={12} />
    Run another automation
  </div>

  <label class="block space-y-0.5 text-[11px] text-muted">
    <span>Automation</span>
    <Select value={call.automation} onchange={(e: Event) => choose((e.currentTarget as HTMLSelectElement).value)} class="nodrag {input} font-sans" aria-label="Automation to run">
      <option value="" disabled>Choose…</option>
      {#if call.automation && !choices.includes(call.automation)}
        <option value={call.automation}>{call.automation} (missing)</option>
      {/if}
      {#each choices as name (name)}
        <option value={name}>{name}</option>
      {/each}
    </Select>
  </label>

  {#if call.automation && !called}
    <p class="text-[10px] text-status-crit">No automation called "{call.automation}" any more.</p>
  {:else if called && asked.length === 0}
    <p class="text-[10px] text-faint">It asks for nothing when it runs.</p>
  {/if}

  {#each asked as p (p.name)}
    <label class="block space-y-0.5 text-[11px] text-muted">
      <span>{p.label || p.name}{p.kind === 'host' ? ' (host)' : ''}</span>
      <input
        value={call.params[p.name] ?? ''}
        oninput={(e) => setValue(p.name, e.currentTarget.value)}
        class={input}
        placeholder={p.kind === 'host' ? 'host name or {{params.…}}' : (p.default ?? '')}
        spellcheck="false"
        aria-label="Value for {p.label || p.name}"
      />
    </label>
  {/each}

  <p class="text-[10px] text-faint">Its output: the output of its last step.</p>

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
