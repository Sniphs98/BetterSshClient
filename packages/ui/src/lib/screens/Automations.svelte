<script lang="ts">
  // Automations selector screen: two sections — the reusable Automation library, and
  // the Flows that wire them into a graph and run them. Mirrors `Snippets.svelte`'s
  // list+CRUD shape, doubled up (a tab switch between the two lists rather than one
  // flat list, since they're different entity types). CRUD orchestration refreshes
  // both stores from disk after every mutation so they never drift.
  import { onMount } from 'svelte';
  import type { AutomationDto, FlowDto } from '$lib/bindings';
  import { Surface, Chip, Icon, Button } from '$lib/theme';
  import {
    listAutomations,
    saveAutomation,
    deleteAutomation,
    listFlows,
    saveFlow,
    deleteFlow,
    runFlow
  } from '$lib/ipc/commands';
  import { automations, flows, flowRun, beginFlowRun } from '$lib/stores/automations';
  import { lastError } from '$lib/stores/notifications';
  import { palette } from '$lib/stores/palette';
  import { emptyForm, formFromAutomation } from './automationForm';
  import AutomationEditor from './AutomationEditor.svelte';
  import FlowEditor from './FlowEditor.svelte';
  import Modal from '$lib/components/Modal.svelte';

  type Dialog =
    | { kind: 'addAutomation'; id: string }
    | { kind: 'editAutomation'; automation: AutomationDto }
    | { kind: 'deleteAutomation'; automation: AutomationDto }
    | { kind: 'addFlow' }
    | { kind: 'editFlow'; flow: FlowDto }
    | { kind: 'deleteFlow'; flow: FlowDto }
    | { kind: 'runFlow'; flow: FlowDto; values: Record<string, string> };

  let tab = $state<'automations' | 'flows'>('automations');
  let dialog = $state<Dialog | null>(null);

  const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

  async function refresh(): Promise<void> {
    try {
      const [a, f] = await Promise.all([listAutomations(), listFlows()]);
      automations.set(a);
      flows.set(f);
    } catch (e) {
      lastError.set(message(e));
    }
  }

  onMount(refresh);

  async function submitAutomation(automation: AutomationDto): Promise<void> {
    await saveAutomation(automation);
    automations.set(await listAutomations());
    dialog = null;
  }

  async function confirmDeleteAutomation(id: string): Promise<void> {
    try {
      await deleteAutomation(id);
      automations.set(await listAutomations());
    } catch (e) {
      lastError.set(message(e));
    }
    dialog = null;
  }

  async function submitFlow(flow: FlowDto): Promise<void> {
    await saveFlow(flow);
    flows.set(await listFlows());
    dialog = null;
  }

  async function confirmDeleteFlow(name: string): Promise<void> {
    try {
      await deleteFlow(name);
      flows.set(await listFlows());
    } catch (e) {
      lastError.set(message(e));
    }
    dialog = null;
  }

  /** Runs `name` with `paramValues` (empty for a flow with no parameters). Called
   *  either directly (no parameters to collect) or after the "Run flow" dialog
   *  gathers them — see `openRunDialog`. */
  async function run(name: string, paramValues: Record<string, string>): Promise<void> {
    beginFlowRun(name);
    try {
      await runFlow(name, paramValues);
    } catch (e) {
      lastError.set(message(e));
    }
  }

  /** A flow with no parameters runs immediately; otherwise open a dialog to collect
   *  one value per parameter first (a host picker for a `'host'` param, a text input —
   *  prefilled from its `default` — for a `'text'` one) so the same flow can be run
   *  identically against different hosts / inputs each time. */
  function openRunDialog(flow: FlowDto): void {
    if (flow.params.length === 0) {
      void run(flow.name, {});
      return;
    }
    const values: Record<string, string> = {};
    for (const p of flow.params) values[p.name] = p.default ?? '';
    dialog = { kind: 'runFlow', flow, values };
  }

  async function pickRunHost(paramName: string): Promise<void> {
    if (dialog?.kind !== 'runFlow') return;
    const host = await palette.pickHost();
    if (host) dialog.values[paramName] = host.name;
  }

  function isRunning(name: string): boolean {
    const r = $flowRun;
    return r?.flowName === name && r.phase.kind === 'running';
  }

  const tabBtn = (active: boolean): string =>
    'rounded-full px-3.5 py-1.5 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ' +
    (active ? 'bg-accent text-accent-fg' : 'text-muted hover:bg-surface-inset hover:text-fg');
  const pill =
    'inline-flex items-center gap-1.5 rounded-full border border-default px-2.5 py-1 text-xs ' +
    'font-medium text-muted transition hover:border-strong hover:bg-accent hover:text-accent-fg ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';
  const iconBtn =
    'grid h-8 w-8 place-items-center rounded-lg text-muted transition hover:bg-surface-inset ' +
    'hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';
</script>

<section class="flex h-full flex-col px-6 pb-6 pt-3">
  <div class="mb-5 flex items-center gap-3">
    <h1 class="text-lg font-semibold tracking-tight">Automations</h1>
    <div class="ml-auto flex items-center gap-1 rounded-full bg-surface-inset p-1">
      <button type="button" class={tabBtn(tab === 'automations')} onclick={() => (tab = 'automations')}>
        Automations
      </button>
      <button type="button" class={tabBtn(tab === 'flows')} onclick={() => (tab = 'flows')}>Flows</button>
    </div>
    {#if tab === 'automations'}
      <button type="button" class={pill} onclick={() => (dialog = { kind: 'addAutomation', id: crypto.randomUUID() })}>
        <Icon name="plus" size={13} />
        New automation
      </button>
    {:else}
      <button type="button" class={pill} onclick={() => (dialog = { kind: 'addFlow' })}>
        <Icon name="plus" size={13} />
        New flow
      </button>
    {/if}
  </div>

  {#if tab === 'automations'}
    {#if $automations.length === 0}
      <div class="flex flex-1 flex-col items-center justify-center gap-2 text-center">
        <p class="font-medium">No automations yet</p>
        <p class="text-sm text-muted">
          A shell command, local or on one host — the building block a flow wires together.
        </p>
        <button type="button" class="{pill} mt-2" onclick={() => (dialog = { kind: 'addAutomation', id: crypto.randomUUID() })}>
          <Icon name="plus" size={13} />
          New automation
        </button>
      </div>
    {:else}
      <div class="min-h-0 flex-1 overflow-y-auto">
        <div class="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(19rem,1fr))]">
          {#each $automations as automation (automation.id)}
            <Surface class="flex flex-col gap-3 p-5">
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="truncate font-medium" title={automation.name}>{automation.name}</span>
                  <Chip>{automation.kind === 'remote' ? 'remote' : 'local'}</Chip>
                </div>
                <div class="mt-1 truncate font-mono text-xs text-muted" title={automation.command}>
                  {automation.command}
                </div>
              </div>
              <div class="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  class={iconBtn}
                  title="Edit {automation.name}"
                  aria-label="Edit {automation.name}"
                  onclick={() => (dialog = { kind: 'editAutomation', automation })}
                >
                  <Icon name="edit" size={15} />
                </button>
                <button
                  type="button"
                  class={iconBtn}
                  title="Delete {automation.name}"
                  aria-label="Delete {automation.name}"
                  onclick={() => (dialog = { kind: 'deleteAutomation', automation })}
                >
                  <Icon name="trash" size={15} />
                </button>
              </div>
            </Surface>
          {/each}
        </div>
      </div>
    {/if}
  {:else if $flows.length === 0}
    <div class="flex flex-1 flex-col items-center justify-center gap-2 text-center">
      <p class="font-medium">No flows yet</p>
      <p class="text-sm text-muted">Wire automations together with dependencies, then run the whole graph.</p>
      <button type="button" class="{pill} mt-2" onclick={() => (dialog = { kind: 'addFlow' })}>
        <Icon name="plus" size={13} />
        New flow
      </button>
    </div>
  {:else}
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(19rem,1fr))]">
        {#each $flows as flow (flow.name)}
          <Surface class="flex flex-col gap-3 p-5">
            <div class="min-w-0">
              <span class="truncate font-medium" title={flow.name}>{flow.name}</span>
              <div class="mt-1 text-xs text-muted">
                {flow.nodes.length} {flow.nodes.length === 1 ? 'node' : 'nodes'} · {flow.edges.length}
                {flow.edges.length === 1 ? 'dependency' : 'dependencies'}
              </div>
            </div>
            <div class="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                class={pill}
                title="Run {flow.name}"
                aria-label="Run {flow.name}"
                disabled={isRunning(flow.name)}
                onclick={() => openRunDialog(flow)}
              >
                <Icon name="play" size={12} />
                {isRunning(flow.name) ? 'Running…' : 'Run'}
              </button>
              <button
                type="button"
                class={iconBtn}
                title="Edit {flow.name}"
                aria-label="Edit {flow.name}"
                onclick={() => (dialog = { kind: 'editFlow', flow })}
              >
                <Icon name="edit" size={15} />
              </button>
              <button
                type="button"
                class={iconBtn}
                title="Delete {flow.name}"
                aria-label="Delete {flow.name}"
                onclick={() => (dialog = { kind: 'deleteFlow', flow })}
              >
                <Icon name="trash" size={15} />
              </button>
            </div>
          </Surface>
        {/each}
      </div>
    </div>
  {/if}
</section>

{#if dialog?.kind === 'addAutomation'}
  <AutomationEditor mode="add" id={dialog.id} initial={emptyForm()} onSubmit={submitAutomation} onCancel={() => (dialog = null)} />
{:else if dialog?.kind === 'editAutomation'}
  {@const automation = dialog.automation}
  <AutomationEditor
    mode="edit"
    id={automation.id}
    initial={formFromAutomation(automation)}
    onSubmit={submitAutomation}
    onCancel={() => (dialog = null)}
  />
{:else if dialog?.kind === 'deleteAutomation'}
  {@const automation = dialog.automation}
  <Modal label="Delete automation" onClose={() => (dialog = null)}>
    <div class="space-y-3 px-5 py-4">
      <h2 class="text-sm font-semibold">Delete automation</h2>
      <p class="text-sm text-muted">
        Delete “{automation.name}”? Any flow still using it will fail to save until you remove it there
        first.
      </p>
      <div class="flex justify-end gap-2 pt-1">
        <Button variant="ghost" onclick={() => (dialog = null)}>Cancel</Button>
        <Button variant="primary" onclick={() => confirmDeleteAutomation(automation.id)}>Delete</Button>
      </div>
    </div>
  </Modal>
{:else if dialog?.kind === 'addFlow'}
  <FlowEditor mode="add" initial={{ name: '', params: [], nodes: [], edges: [] }} onSubmit={submitFlow} onCancel={() => (dialog = null)} />
{:else if dialog?.kind === 'editFlow'}
  <FlowEditor mode="edit" initial={dialog.flow} onSubmit={submitFlow} onCancel={() => (dialog = null)} />
{:else if dialog?.kind === 'deleteFlow'}
  {@const flow = dialog.flow}
  <Modal label="Delete flow" onClose={() => (dialog = null)}>
    <div class="space-y-3 px-5 py-4">
      <h2 class="text-sm font-semibold">Delete flow</h2>
      <p class="text-sm text-muted">
        Delete “{flow.name}”? The automations it uses stay in your library.
      </p>
      <div class="flex justify-end gap-2 pt-1">
        <Button variant="ghost" onclick={() => (dialog = null)}>Cancel</Button>
        <Button variant="primary" onclick={() => confirmDeleteFlow(flow.name)}>Delete</Button>
      </div>
    </div>
  </Modal>
{:else if dialog?.kind === 'runFlow'}
  {@const d = dialog}
  <Modal label="Run flow" onClose={() => (dialog = null)}>
    <div class="space-y-3 px-5 py-4">
      <h2 class="text-sm font-semibold">Run “{d.flow.name}”</h2>
      <p class="text-sm text-muted">This flow needs a few values before it runs.</p>
      <div class="space-y-3">
        {#each d.flow.params as param (param.name)}
          {#if param.kind === 'host'}
            <!-- Not a <label>: wrapping a <button> in one lets the label text win the
                 accessible-name computation over the button's own "Choose a host…"
                 text in some engines, so the two are kept as siblings instead. -->
            <div class="space-y-1 text-xs font-medium text-muted">
              <span>{param.label || param.name}</span>
              <button
                type="button"
                class="w-full truncate rounded-lg bg-surface-inset px-3 py-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-focus {d
                  .values[param.name]
                  ? 'text-fg'
                  : 'text-faint'}"
                onclick={() => pickRunHost(param.name)}
              >
                {d.values[param.name] || 'Choose a host…'}
              </button>
            </div>
          {:else}
            <label class="block space-y-1 text-xs font-medium text-muted">
              <span>{param.label || param.name}</span>
              <input
                bind:value={d.values[param.name]}
                class="w-full rounded-lg bg-surface-inset px-3 py-2 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus"
              />
            </label>
          {/if}
        {/each}
      </div>
      <div class="flex justify-end gap-2 pt-1">
        <Button variant="ghost" onclick={() => (dialog = null)}>Cancel</Button>
        <Button
          variant="primary"
          disabled={d.flow.params.some((p) => !d.values[p.name]?.trim())}
          onclick={() => {
            const { flow, values } = d;
            dialog = null;
            void run(flow.name, values);
          }}
        >
          Run
        </Button>
      </div>
    </div>
  </Modal>
{/if}
