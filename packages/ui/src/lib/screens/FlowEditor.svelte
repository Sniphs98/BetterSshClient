<script lang="ts">
  // A single Flow, full-page: the canvas needs the room a modal can't give it. Reached
  // via `activeEntity.selectFlow(name | null)` and rendered by +page.svelte as another
  // selector (tech-gui.md §2) — it occupies the whole content area, sidebar and status
  // bar excluded, same chrome every other selector gets for free. Nodes are placed and
  // wired directly on an actual svelte-flow canvas: click a node's source (right) dot
  // then another's target (left) dot to add a dependency edge (or drag between them).
  // Structural validation (unknown automation, a cycle, a template reference that
  // isn't a direct dependency, …) happens server-side in `validateFlow`
  // (core/automation/engine.ts) — this stays a plain UI package with no dependency on
  // the electron package's code, so a rejected save just surfaces that message inline.
  // `FlowNode.position` (already part of the DTO) is what makes a layout persist
  // across reopens instead of re-flowing every time.
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
  import Select from '$lib/components/Select.svelte';
  import ContextMenu, { type ContextMenuItem } from '$lib/components/ContextMenu.svelte';
  import { automations, flows } from '$lib/stores/automations';
  import { listFlows, saveFlow } from '$lib/ipc/commands';
  import { activeEntity } from '$lib/stores/activeEntity';
  import { theme } from '$lib/stores/theme';
  import FlowCanvasNode from './FlowCanvasNode.svelte';
  import type { AutomationFlowEdge, AutomationFlowNode } from './flowCanvasTypes';

  /** `null` opens a fresh, unsaved flow; a name loads that existing Flow from the
   *  `flows` store (already loaded by Automations.svelte before navigation ever gets
   *  here). +page.svelte keys this component on `flowName`, so a switch between two
   *  flows (or from an existing one to a new draft) always gets a fresh instance —
   *  the "seeded once" state below never has to react to a changed prop. */
  let { flowName }: { flowName: string | null } = $props();

  // svelte-ignore state_referenced_locally
  const existing = flowName ? $flows.find((f) => f.name === flowName) : undefined;
  const mode: 'add' | 'edit' = existing ? 'edit' : 'add';
  const initial: FlowDto = existing ?? { name: '', params: [], nodes: [], edges: [] };
  // A name was passed but no longer matches anything in the store (deleted from
  // elsewhere between listing and opening) — surface that instead of silently
  // presenting an empty "new flow" draft under the old name.
  // svelte-ignore state_referenced_locally
  const notFound = flowName !== null && existing === undefined;

  const nodeTypes = { automation: FlowCanvasNode };

  /** A simple left-to-right, wrapping grid — used only for a node that has no saved
   *  `position` yet (freshly added, or a flow saved before positions existed). */
  function layoutPosition(index: number): { x: number; y: number } {
    return { x: 60 + (index % 4) * 230, y: 60 + Math.floor(index / 4) * 150 };
  }

  let name = $state(initial.name);
  let params = $state<FlowParamDto[]>(initial.params.map((p) => ({ ...p })));
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
  let canvasEdges = $state<AutomationFlowEdge[]>(
    initial.edges.map((e) => ({ id: `${e.from}->${e.to}`, source: e.from, target: e.to }))
  );
  let addMenuAnchor = $state<{ x: number; y: number } | null>(null);
  let newParamName = $state('');
  let newParamKind = $state<'text' | 'host'>('text');
  let error = $state<string | null>(null);
  let saving = $state(false);
  let nameEl = $state<HTMLInputElement>();

  onMount(() => {
    if (!notFound) nameEl?.focus();
  });

  const hasHostParam = $derived(params.some((p) => p.kind === 'host'));

  function back(): void {
    activeEntity.selectAutomations();
  }

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

  function openAddMenu(e: MouseEvent): void {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    addMenuAnchor = { x: rect.left, y: rect.bottom + 6 };
  }

  const addMenuItems: ContextMenuItem[] = $derived(
    $automations.length === 0
      ? [{ label: 'No automations yet — create one first', onSelect: () => {}, disabled: true }]
      : $automations.map((a) => ({
          label: `${a.name} (${a.kind})`,
          onSelect: () => {
            canvasNodes = [
              ...canvasNodes,
              {
                id: crypto.randomUUID(),
                type: 'automation',
                position: layoutPosition(canvasNodes.length),
                data: {
                  automationId: a.id,
                  label: uniqueLabel(a.name),
                  continueOnError: false,
                  automationName: a.name,
                  automationKind: a.kind
                }
              }
            ];
          }
        }))
  );

  /** A dependency edge: connecting from a node's source (right) handle to another's
   *  target (left) handle means "the target depends on the source" — `to` waits for
   *  `from`, matching `FlowEdge`'s own `{ from, to }` shape exactly. */
  function onconnect(connection: Connection): void {
    if (!connection.source || !connection.target || connection.source === connection.target) return;
    const exists = canvasEdges.some((e) => e.source === connection.source && e.target === connection.target);
    if (exists) return;
    canvasEdges = [...canvasEdges, { id: `${connection.source}->${connection.target}`, source: connection.source, target: connection.target }];
  }

  async function save(): Promise<void> {
    const flowNameTrimmed = name.trim();
    if (!flowNameTrimmed) {
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
      name: flowNameTrimmed,
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
      await saveFlow(flow);
      flows.set(await listFlows());
      back();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }

  const field =
    'rounded-lg bg-surface-inset px-3 py-2 text-sm text-fg outline-none ' +
    'focus-visible:ring-2 focus-visible:ring-focus placeholder:text-faint';
  const iconBtn =
    'grid h-9 w-9 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-surface-inset ' +
    'hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';
</script>

<section class="flex h-full flex-col">
  <header class="flex items-center gap-3 border-b border-default px-6 py-3">
    <button type="button" class={iconBtn} title="Back to Flows" aria-label="Back to Flows" onclick={back}>
      <Icon name="arrow-left" size={18} />
    </button>
    {#if notFound}
      <h1 class="text-lg font-semibold tracking-tight">Flow not found</h1>
    {:else}
      <input
        bind:this={nameEl}
        bind:value={name}
        class="{field} min-w-0 flex-1 max-w-sm text-base font-semibold"
        placeholder="Flow name"
        aria-label="Flow name"
      />
      <div class="ml-auto flex items-center gap-2">
        <Button variant="ghost" onclick={back}>Cancel</Button>
        <Button variant="primary" onclick={save} disabled={saving}>
          {mode === 'add' ? 'Create flow' : 'Save'}
        </Button>
      </div>
    {/if}
  </header>

  {#if notFound}
    <div class="flex flex-1 items-center justify-center">
      <p class="text-sm text-muted">“{flowName}” no longer exists — it may have been deleted.</p>
    </div>
  {:else}
    <div class="flex flex-wrap items-center gap-3 border-b border-default px-6 py-2.5">
      <span class="text-[11px] font-medium uppercase tracking-[0.14em] text-faint" title="Collected right before the flow runs, not baked into any node — a host parameter is the target for every remote automation in this flow. Reference either kind in a command as {'{{params.<name>}}'}.">
        Parameters
      </span>
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
      <div class="flex items-center gap-1.5">
        <input
          bind:value={newParamName}
          class="{field} w-40"
          placeholder="parameter name"
          onkeydown={(e) => e.key === 'Enter' && (e.preventDefault(), addParam())}
        />
        <Select bind:value={newParamKind} class={field} aria-label="Parameter kind">
          <option value="text">text</option>
          <option value="host" disabled={hasHostParam}>host</option>
        </Select>
        <Button variant="secondary" title="Add parameter" onclick={addParam} disabled={!newParamName.trim()}>Add</Button>
      </div>
    </div>

    {#if error}
      <p class="border-b border-default px-6 py-2 text-xs text-status-crit">{error}</p>
    {/if}

    <div class="relative min-h-0 flex-1">
      <button
        type="button"
        class="absolute left-4 top-4 z-10 grid h-10 w-10 place-items-center rounded-full border border-default bg-surface text-fg shadow-soft transition hover:bg-surface-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        title="Add an automation to this flow"
        aria-label="Add an automation to this flow"
        onclick={openAddMenu}
      >
        <Icon name="plus" size={18} />
      </button>
      {#if addMenuAnchor}
        <ContextMenu x={addMenuAnchor.x} y={addMenuAnchor.y} items={addMenuItems} onClose={() => (addMenuAnchor = null)} />
      {/if}

      {#if canvasNodes.length === 0}
        <div class="flex h-full items-center justify-center text-sm text-muted">
          No nodes yet — use the + button to add an automation.
        </div>
      {:else}
        <SvelteFlow bind:nodes={canvasNodes} bind:edges={canvasEdges} {nodeTypes} {onconnect} colorMode={$theme} class="h-full w-full" fitView minZoom={0.3}>
          <Background variant={BackgroundVariant.Dots} />
          <Controls showLock={false} />
        </SvelteFlow>
      {/if}
    </div>
  {/if}
</section>
