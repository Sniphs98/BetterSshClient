<script lang="ts">
  // Snippets selector screen: Automations (what actually gets run) is the primary,
  // default view; the reusable Snippet library is secondary — a building-block
  // list reached via a small "Manage snippets" link, not an equal-weight tab,
  // since an automation is the thing someone actually cares about day to day. CRUD
  // orchestration refreshes both stores from disk after every mutation so they never
  // drift.
  import { onMount } from 'svelte';
  import type { SnippetDto, AutomationDto } from '$lib/bindings';
  import { Surface, Chip, Icon, Button } from '$lib/theme';
  import {
    listSnippets,
    saveSnippet,
    deleteSnippet,
    listAutomations,
    deleteAutomation,
    exportSnippet,
    exportAutomation,
    importBundle
  } from '$lib/ipc/commands';
  import { snippets, automations, automationsTab, automationRun, runAutomationNow } from '$lib/stores/automations';
  import { lastError } from '$lib/stores/notifications';
  import { activeEntity } from '$lib/stores/activeEntity';
  import { emptyForm, formFromSnippet } from './snippetForm';
  import SnippetEditor from './SnippetEditor.svelte';
  import AutomationRunDialog from './AutomationRunDialog.svelte';
  import Modal from '$lib/components/Modal.svelte';

  type Dialog =
    | { kind: 'addSnippet'; id: string }
    | { kind: 'editSnippet'; snippet: SnippetDto }
    | { kind: 'deleteSnippet'; snippet: SnippetDto }
    | { kind: 'deleteAutomation'; automation: AutomationDto }
    | { kind: 'runAutomation'; automation: AutomationDto };

  let dialog = $state<Dialog | null>(null);

  const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

  async function refresh(): Promise<void> {
    try {
      const [a, f] = await Promise.all([listSnippets(), listAutomations()]);
      snippets.set(a);
      automations.set(f);
    } catch (e) {
      lastError.set(message(e));
    }
  }

  onMount(refresh);

  async function submitSnippet(snippet: SnippetDto): Promise<void> {
    await saveSnippet(snippet);
    snippets.set(await listSnippets());
    dialog = null;
  }

  async function confirmDeleteSnippet(id: string): Promise<void> {
    try {
      await deleteSnippet(id);
      snippets.set(await listSnippets());
    } catch (e) {
      lastError.set(message(e));
    }
    dialog = null;
  }

  async function confirmDeleteAutomation(name: string): Promise<void> {
    try {
      await deleteAutomation(name);
      automations.set(await listAutomations());
    } catch (e) {
      lastError.set(message(e));
    }
    dialog = null;
  }

  // Export/import — sharing a Snippet or Automation as a portable JSON file (with an Automation
  // also bundling the Snippets its nodes reference, so it's self-contained). Each
  // export just prompts a save dialog; a canceled dialog resolves `null`, not an error,
  // so there's nothing to catch beyond a genuine failure. Import is a single entry
  // point for either kind — the file itself says which one it is.
  async function exportSnippetAction(id: string): Promise<void> {
    try {
      await exportSnippet(id);
    } catch (e) {
      lastError.set(message(e));
    }
  }

  async function exportAutomationAction(name: string): Promise<void> {
    try {
      await exportAutomation(name);
    } catch (e) {
      lastError.set(message(e));
    }
  }

  async function importAction(): Promise<void> {
    try {
      const result = await importBundle();
      if (!result) return; // the file picker was canceled
      await refresh();
    } catch (e) {
      lastError.set(message(e));
    }
  }

  /** An automation with no parameters runs immediately; otherwise AutomationRunDialog collects one
   *  value per parameter first (a host picker for a `'host'` param, a text input for a
   *  `'text'` one) so the same automation can be run identically against different hosts /
   *  inputs each time. */
  function openRunDialog(automation: AutomationDto): void {
    if (automation.params.length === 0) {
      void runAutomationNow(automation.name, {});
      return;
    }
    dialog = { kind: 'runAutomation', automation };
  }

  function isRunning(name: string): boolean {
    const r = $automationRun;
    return r?.automationName === name && r.phase.kind === 'running';
  }

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
    {#if $automationsTab === 'snippets'}
      <button type="button" class={iconBtn} title="Back to Automations" aria-label="Back to Automations" onclick={() => automationsTab.set('automations')}>
        <Icon name="arrow-left" size={18} />
      </button>
      <h1 class="text-lg font-semibold tracking-tight">Snippet library</h1>
      <button type="button" class="{pill} ml-auto" title="Import a snippet or automation from a file" onclick={importAction}>
        <Icon name="upload" size={13} />
        Import…
      </button>
      <button type="button" class={pill} onclick={() => (dialog = { kind: 'addSnippet', id: crypto.randomUUID() })}>
        <Icon name="plus" size={13} />
        New snippet
      </button>
    {:else}
      <h1 class="text-lg font-semibold tracking-tight">Automations</h1>
      <button
        type="button"
        class="ml-auto rounded text-xs font-medium text-muted transition hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        onclick={() => automationsTab.set('snippets')}
      >
        Manage snippets
      </button>
      <button type="button" class={pill} title="Import a snippet or automation from a file" onclick={importAction}>
        <Icon name="upload" size={13} />
        Import…
      </button>
      <button type="button" class={pill} onclick={() => activeEntity.selectAutomation(null)}>
        <Icon name="plus" size={13} />
        New automation
      </button>
    {/if}
  </div>

  {#if $automationsTab === 'snippets'}
    {#if $snippets.length === 0}
      <div class="flex flex-1 flex-col items-center justify-center gap-2 text-center">
        <p class="font-medium">No snippets yet</p>
        <p class="text-sm text-muted">
          A shell command, local or on one host — the building block an automation wires together.
        </p>
        <button type="button" class="{pill} mt-2" onclick={() => (dialog = { kind: 'addSnippet', id: crypto.randomUUID() })}>
          <Icon name="plus" size={13} />
          New snippet
        </button>
      </div>
    {:else}
      <div class="min-h-0 flex-1 overflow-y-auto">
        <div class="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(19rem,1fr))]">
          {#each $snippets as snippet (snippet.id)}
            <Surface class="flex flex-col gap-3 p-5">
              <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="truncate font-medium" title={snippet.name}>{snippet.name}</span>
                </div>
                <div class="mt-1 truncate font-mono text-xs text-muted" title={snippet.command}>
                  {snippet.command}
                </div>
              </div>
              <div class="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  class={iconBtn}
                  title="Edit {snippet.name}"
                  aria-label="Edit {snippet.name}"
                  onclick={() => (dialog = { kind: 'editSnippet', snippet })}
                >
                  <Icon name="edit" size={15} />
                </button>
                <button
                  type="button"
                  class={iconBtn}
                  title="Export {snippet.name} to a file"
                  aria-label="Export {snippet.name}"
                  onclick={() => exportSnippetAction(snippet.id)}
                >
                  <Icon name="download" size={15} />
                </button>
                <button
                  type="button"
                  class={iconBtn}
                  title="Delete {snippet.name}"
                  aria-label="Delete {snippet.name}"
                  onclick={() => (dialog = { kind: 'deleteSnippet', snippet })}
                >
                  <Icon name="trash" size={15} />
                </button>
              </div>
            </Surface>
          {/each}
        </div>
      </div>
    {/if}
  {:else if $automations.length === 0}
    <div class="flex flex-1 flex-col items-center justify-center gap-2 text-center">
      <p class="font-medium">No automations yet</p>
      <p class="text-sm text-muted">Wire snippets together with dependencies, then run the whole graph.</p>
      <button type="button" class="{pill} mt-2" onclick={() => activeEntity.selectAutomation(null)}>
        <Icon name="plus" size={13} />
        New automation
      </button>
    </div>
  {:else}
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(19rem,1fr))]">
        {#each $automations as automation (automation.name)}
          <Surface class="flex flex-col gap-3 p-5">
            <button
              type="button"
              class="min-w-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              title="Open {automation.name}"
              onclick={() => activeEntity.selectAutomation(automation.name)}
            >
              <span class="truncate font-medium" title={automation.name}>{automation.name}</span>
              <div class="mt-1 text-xs text-muted">
                {automation.nodes.length} {automation.nodes.length === 1 ? 'node' : 'nodes'} · {automation.edges.length}
                {automation.edges.length === 1 ? 'dependency' : 'dependencies'}
              </div>
            </button>
            <div class="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                class={pill}
                title="Run {automation.name}"
                aria-label="Run {automation.name}"
                disabled={isRunning(automation.name)}
                onclick={() => openRunDialog(automation)}
              >
                <Icon name="play" size={12} />
                {isRunning(automation.name) ? 'Running…' : 'Run'}
              </button>
              <button
                type="button"
                class={iconBtn}
                title="Export {automation.name} to a file"
                aria-label="Export {automation.name}"
                onclick={() => exportAutomationAction(automation.name)}
              >
                <Icon name="download" size={15} />
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
</section>

{#if dialog?.kind === 'addSnippet'}
  <SnippetEditor mode="add" id={dialog.id} initial={emptyForm()} onSubmit={submitSnippet} onCancel={() => (dialog = null)} />
{:else if dialog?.kind === 'editSnippet'}
  {@const snippet = dialog.snippet}
  <SnippetEditor
    mode="edit"
    id={snippet.id}
    initial={formFromSnippet(snippet)}
    onSubmit={submitSnippet}
    onCancel={() => (dialog = null)}
  />
{:else if dialog?.kind === 'deleteSnippet'}
  {@const snippet = dialog.snippet}
  <Modal label="Delete snippet" onClose={() => (dialog = null)}>
    <div class="space-y-3 px-5 py-4">
      <h2 class="text-sm font-semibold">Delete snippet</h2>
      <p class="text-sm text-muted">
        Delete “{snippet.name}”? Any automation still using it will fail to save until you remove it there
        first.
      </p>
      <div class="flex justify-end gap-2 pt-1">
        <Button variant="ghost" onclick={() => (dialog = null)}>Cancel</Button>
        <Button variant="primary" onclick={() => confirmDeleteSnippet(snippet.id)}>Delete</Button>
      </div>
    </div>
  </Modal>
{:else if dialog?.kind === 'deleteAutomation'}
  {@const automation = dialog.automation}
  <Modal label="Delete automation" onClose={() => (dialog = null)}>
    <div class="space-y-3 px-5 py-4">
      <h2 class="text-sm font-semibold">Delete automation</h2>
      <p class="text-sm text-muted">
        Delete “{automation.name}”? The snippets it uses stay in your library.
      </p>
      <div class="flex justify-end gap-2 pt-1">
        <Button variant="ghost" onclick={() => (dialog = null)}>Cancel</Button>
        <Button variant="primary" onclick={() => confirmDeleteAutomation(automation.name)}>Delete</Button>
      </div>
    </div>
  </Modal>
{:else if dialog?.kind === 'runAutomation'}
  {@const automation = dialog.automation}
  <AutomationRunDialog
    {automation}
    onRun={(values) => {
      // `{@const}` isn't a one-time snapshot — `automation` re-reads `dialog.automation` on every
      // access, live, for as long as this block is mounted. Reading `automation.name` here
      // into a plain local *before* nulling `dialog` is what makes it a real snapshot;
      // reading it after (or inlining `automation.name` into the runAutomationNow call below) would
      // throw "Cannot read properties of null (reading 'automation')", since by then `automation`
      // itself evaluates to `dialog.automation` on an already-null `dialog`.
      const name = automation.name;
      dialog = null;
      void runAutomationNow(name, values);
    }}
    onCancel={() => (dialog = null)}
  />
{/if}
