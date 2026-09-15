<script lang="ts">
  // Add/edit Flow form: nodes are placed and wired on an actual svelte-flow canvas —
  // drag from an Automation library entry onto the graph, drag between a node's right
  // (source) and another's left (target) handle to add a dependency edge. Structural
  // validation (unknown automation, a cycle, a template reference that isn't a direct
  // dependency, …) happens server-side in `validateFlow` (core/automation/engine.ts) —
  // this stays a plain UI package with no dependency on the electron package's code,
  // so a rejected save just surfaces that message inline, the same as any other form
  // here. `FlowNode.position` (already part of the DTO) is what makes a layout
  // persist across reopens instead of re-flowing every time.
  //
  // Parameters (`FlowParam`) are values collected right before the flow runs rather
  // than baked into any node — at most one `'host'`-kind, whose run-time value is the
  // target for every remote automation node in this flow, plus any number of
  // `'text'`-kind ones substituted via `{{params.<name>}}`. This is what lets one flow
  // definition run identically against different hosts.
  import { onMount } from 'svelte';
  import { SvelteFlow, Background, BackgroundVariant, Controls, type Connection } from '@xyflow/svelte';
  import '@xyflow/svelte/dist/style.css';
  import type { FlowDto, FlowParamDto } from '$lib/bindings';
  import { Button, Icon } from '$lib/theme';
  import Modal from '$lib/components/Modal.svelte';
  import Select from '$lib/components/Select.svelte';
  import { automations } from '$lib/stores/automations';
  import { theme } from '$lib/stores/theme';
  import FlowCanvasNode from './FlowCanvasNode.svelte';
  import type { AutomationFlowEdge, AutomationFlowNode } from './flowCanvasTypes';

  let {
    mode,
    initial,
    onSubmit,
    onCancel
  }: {
    mode: 'add' | 'edit';
    initial: FlowDto;
    onSubmit: (flow: FlowDto) => Promise<void>;
    onCancel: () => void;
  } = $props();

  const nodeTypes = { automation: FlowCanvasNode };

  /** A simple left-to-right, wrapping grid — used only for a node that has no saved
   *  `position` yet (freshly added, or a flow saved before positions existed). */
  function layoutPosition(index: number): { x: number; y: number } {
    return { x: 60 + (index % 4) * 230, y: 60 + Math.floor(index / 4) * 150 };
  }

  // Seeded once from `initial`; the editor is remounted per open, so the prop never
  // changes under a live instance.
  // svelte-ignore state_referenced_locally
  let name = $state(initial.name);
  // svelte-ignore state_referenced_locally
  let params = $state<FlowParamDto[]>(initial.params.map((p) => ({ ...p })));
  // svelte-ignore state_referenced_locally
  let canvasNodes = $state<AutomationFlowNode[]>(
    initial.nodes.map((n, i) => {
      const automation = $automations.find((a) => a.id === n.automationId);
      return {
        id: n.id,
        type: 'automation',
        position: n.position ?? layoutPosition(i),
        data: {
          automationId: n.automationId,
          label: n.label,
          continueOnError: n.continueOnError,
          automationName: automation?.name ?? 'unknown automation',
          automationKind: automation?.kind ?? 'local'
        }
      };
    })
  );
  // svelte-ignore state_referenced_locally
  let canvasEdges = $state<AutomationFlowEdge[]>(
    initial.edges.map((e) => ({ id: `${e.from}->${e.to}`, source: e.from, target: e.to }))
  );
  let addAutomationId = $state('');
  let newParamName = $state('');
  let newParamKind = $state<'text' | 'host'>('text');
  let error = $state<string | null>(null);
  let saving = $state(false);
  let nameEl = $state<HTMLInputElement>();

  onMount(() => nameEl?.focus());

  const hasHostParam = $derived(params.some((p) => p.kind === 'host'));

  function addParam(): void {
    const name = newParamName.trim();
    if (!name || params.some((p) => p.name === name)) return;
    if (newParamKind === 'host' && hasHostParam) return;
    params = [...params, { name, kind: newParamKind, default: undefined }];
    newParamName = '';
    newParamKind = 'text';
  }

  function removeParam(name: string): void {
    params = params.filter((p) => p.name !== name);
  }

  function uniqueLabel(base: string): string {
    const slug = base.trim() || 'node';
    const taken = new Set(canvasNodes.map((n) => n.data.label));
    if (!taken.has(slug)) return slug;
    let i = 2;
    while (taken.has(`${slug}-${i}`)) i += 1;
    return `${slug}-${i}`;
  }

  function addNode(): void {
    const automation = $automations.find((a) => a.id === addAutomationId);
    if (!automation) return;
    canvasNodes = [
      ...canvasNodes,
      {
        id: crypto.randomUUID(),
        type: 'automation',
        position: layoutPosition(canvasNodes.length),
        data: {
          automationId: automation.id,
          label: uniqueLabel(automation.name),
          continueOnError: false,
          automationName: automation.name,
          automationKind: automation.kind
        }
      }
    ];
    addAutomationId = '';
  }

  /** A dependency edge: dragging from a node's source (right) handle to another's
   *  target (left) handle means "the target depends on the source" — `to` waits for
   *  `from`, matching `FlowEdge`'s own `{ from, to }` shape exactly. */
  function onconnect(connection: Connection): void {
    if (!connection.source || !connection.target || connection.source === connection.target) return;
    const exists = canvasEdges.some((e) => e.source === connection.source && e.target === connection.target);
    if (exists) return;
    canvasEdges = [...canvasEdges, { id: `${connection.source}->${connection.target}`, source: connection.source, target: connection.target }];
  }

  async function save(): Promise<void> {
    const flowName = name.trim();
    if (!flowName) {
      error = 'Name cannot be empty';
      return;
    }
    if (canvasNodes.length === 0) {
      error = 'Add at least one node';
      return;
    }
    const labels = canvasNodes.map((n) => n.data.label.trim());
    if (labels.some((l) => !l)) {
      error = 'Every node needs a label';
      return;
    }
    if (new Set(labels).size !== labels.length) {
      error = 'Node labels must be unique within the flow';
      return;
    }
    const usesRemote = canvasNodes.some((n) => n.data.automationKind === 'remote');
    if (usesRemote && !hasHostParam) {
      error = 'This flow runs a remote automation — add a host parameter below';
      return;
    }

    const flow: FlowDto = {
      name: flowName,
      params: params.map((p) => ({ ...p })),
      nodes: canvasNodes.map((n) => ({
        id: n.id,
        automationId: n.data.automationId,
        label: n.data.label.trim(),
        continueOnError: n.data.continueOnError,
        position: n.position
      })),
      edges: canvasEdges.map((e) => ({ from: e.source, to: e.target }))
    };
    error = null;
    saving = true;
    try {
      await onSubmit(flow);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }

  const label = 'block space-y-1 text-xs font-medium text-muted';
  const field =
    'w-full rounded-lg bg-surface-inset px-3 py-2 text-sm text-fg outline-none ' +
    'focus-visible:ring-2 focus-visible:ring-focus placeholder:text-faint';
</script>

<Modal label={mode === 'add' ? 'New flow' : 'Edit flow'} size="large" onClose={onCancel}>
  <div class="flex min-h-0 flex-1 flex-col">
    <header class="border-b border-default px-5 py-3.5">
      <h2 class="text-sm font-semibold">{mode === 'add' ? 'New flow' : 'Edit flow'}</h2>
    </header>

    <div class="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
      <label class={label}>
        <span>Name</span>
        <input bind:this={nameEl} bind:value={name} class={field} placeholder="Deploy to prod" />
      </label>

      <div class="space-y-2">
        <h3 class="text-[11px] font-medium uppercase tracking-[0.18em] text-faint">Parameters</h3>
        <p class="text-xs text-muted">
          Collected right before the flow runs, not baked into any node — a host
          parameter is the target for every remote automation in this flow, so the
          same flow runs unchanged against a different host. Reference either kind in
          a command as {'{{params.<name>}}'}.
        </p>

        {#if params.length > 0}
          <div class="flex flex-wrap gap-1.5">
            {#each params as param (param.name)}
              <span class="inline-flex items-center gap-1.5 rounded-full border border-default px-2.5 py-1 text-xs text-muted">
                <span class="font-mono">{param.name}</span>
                <span class="text-faint">({param.kind})</span>
                <button
                  type="button"
                  class="text-faint hover:text-fg"
                  title="Remove parameter {param.name}"
                  aria-label="Remove parameter {param.name}"
                  onclick={() => removeParam(param.name)}
                >
                  <Icon name="close" size={11} />
                </button>
              </span>
            {/each}
          </div>
        {/if}

        <div class="flex items-center gap-2 pt-1">
          <input
            bind:value={newParamName}
            class="{field} flex-1"
            placeholder="parameter name, e.g. host"
            onkeydown={(e) => e.key === 'Enter' && (e.preventDefault(), addParam())}
          />
          <Select bind:value={newParamKind} class={field} aria-label="Parameter kind">
            <option value="text">text</option>
            <option value="host" disabled={hasHostParam}>host</option>
          </Select>
          <Button variant="secondary" title="Add parameter" onclick={addParam} disabled={!newParamName.trim()}>Add</Button>
        </div>
      </div>

      <div class="space-y-2">
        <div class="flex items-center justify-between gap-2">
          <h3 class="text-[11px] font-medium uppercase tracking-[0.18em] text-faint">Nodes</h3>
          <p class="text-xs text-muted">Drag between a node's dots to add a dependency; select an edge and press Delete to remove it.</p>
        </div>

        <div class="flex items-center gap-2">
          <Select bind:value={addAutomationId} class={field} aria-label="Add an automation">
            <option value="" disabled selected>Add an automation…</option>
            {#each $automations as a (a.id)}
              <option value={a.id}>{a.name} ({a.kind})</option>
            {/each}
          </Select>
          <Button variant="secondary" onclick={addNode} disabled={!addAutomationId}>Add</Button>
        </div>
        {#if $automations.length === 0}
          <p class="text-xs text-faint">No automations yet — create one first.</p>
        {/if}

        <div class="h-[420px] overflow-hidden rounded-lg border border-default">
          {#if canvasNodes.length === 0}
            <div class="flex h-full items-center justify-center text-sm text-muted">No nodes yet — add one above.</div>
          {:else}
            <SvelteFlow bind:nodes={canvasNodes} bind:edges={canvasEdges} {nodeTypes} {onconnect} colorMode={$theme} fitView minZoom={0.4}>
              <Background variant={BackgroundVariant.Dots} />
              <Controls showLock={false} />
            </SvelteFlow>
          {/if}
        </div>
      </div>

      {#if error}
        <p class="text-xs text-status-crit">{error}</p>
      {/if}
    </div>

    <footer class="flex justify-end gap-2 border-t border-default px-5 py-3">
      <Button variant="ghost" onclick={onCancel}>Cancel</Button>
      <Button variant="primary" onclick={save} disabled={saving}>
        {mode === 'add' ? 'Add flow' : 'Save'}
      </Button>
    </footer>
  </div>
</Modal>
