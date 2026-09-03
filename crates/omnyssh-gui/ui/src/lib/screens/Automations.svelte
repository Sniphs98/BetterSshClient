<script lang="ts">
  // Automations selector screen: list + search saved local automations, add/edit/
  // delete (round-tripping through `automations.toml`), and run them with a
  // per-step results panel. Mirrors `Snippets.svelte` in structure. An automation
  // is a sequence of local-command / remote-command / SFTP upload / SFTP download
  // steps run against one optional target host — see `automationForm.ts` for the
  // steps DSL, shared line-for-line with the TUI's editor.
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import type { AutomationDto } from '$lib/bindings';
  import { Surface, Chip, Icon, Button } from '$lib/theme';
  import { listAutomations, saveAutomation, deleteAutomation, executeAutomation } from '$lib/ipc/commands';
  import { automations, beginAutomationRun, failPendingAutomationRun } from '$lib/stores/automations';
  import { lastError } from '$lib/stores/notifications';
  import { filterAutomations, emptyForm, formFromAutomation, describeStep } from './automationForm';
  import AutomationEditor from './AutomationEditor.svelte';
  import AutomationRunner from './AutomationRunner.svelte';
  import AutomationResults from './AutomationResults.svelte';
  import Modal from '$lib/components/Modal.svelte';

  type Dialog =
    | { kind: 'add' }
    | { kind: 'edit'; automation: AutomationDto }
    | { kind: 'run'; automation: AutomationDto }
    | { kind: 'delete'; automation: AutomationDto };

  let query = $state('');
  let dialog = $state<Dialog | null>(null);
  const filtered = $derived(filterAutomations($automations, query));

  const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

  async function refresh(): Promise<void> {
    try {
      automations.set(await listAutomations());
    } catch (e) {
      lastError.set(message(e));
    }
  }

  onMount(refresh);

  // Persist add/edit, then re-read from disk. Throws propagate to the editor so a
  // failed save surfaces inline and keeps the form open.
  async function submit(automation: AutomationDto, previousName: string | undefined): Promise<void> {
    if (get(automations).some((a) => a.name === automation.name && a.name !== previousName)) {
      throw new Error(`An automation named "${automation.name}" already exists`);
    }
    await saveAutomation(automation);
    if (previousName && previousName !== automation.name) await deleteAutomation(previousName);
    automations.set(await listAutomations());
    dialog = null;
  }

  async function confirmDelete(name: string): Promise<void> {
    try {
      await deleteAutomation(name);
      automations.set(await listAutomations());
    } catch (e) {
      lastError.set(message(e));
    }
    dialog = null;
  }

  async function execute(automation: AutomationDto, params: Record<string, string>): Promise<void> {
    dialog = null;
    beginAutomationRun(automation.name, automation.steps.map(describeStep));
    try {
      await executeAutomation(automation.name, params);
    } catch (e) {
      const msg = message(e);
      lastError.set(msg);
      failPendingAutomationRun(msg);
    }
  }

  const search =
    'w-full rounded-lg bg-surface-inset px-3 py-2 text-sm text-fg outline-none ' +
    'focus-visible:ring-2 focus-visible:ring-focus placeholder:text-faint';
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
    <div class="ml-auto w-full max-w-xs">
      <input
        bind:value={query}
        class={search}
        placeholder="Search automations…"
        aria-label="Search automations"
      />
    </div>
    <button type="button" class={pill} onclick={() => (dialog = { kind: 'add' })}>
      <Icon name="plus" size={13} />
      New automation
    </button>
  </div>

  {#if filtered.length === 0}
    <div class="flex flex-1 flex-col items-center justify-center gap-2 text-center">
      {#if $automations.length === 0}
        <p class="font-medium">No automations yet</p>
        <p class="text-sm text-muted">
          Chain local commands, remote commands, and SFTP transfers into one repeatable run.
        </p>
        <button type="button" class="{pill} mt-2" onclick={() => (dialog = { kind: 'add' })}>
          <Icon name="plus" size={13} />
          New automation
        </button>
      {:else}
        <p class="text-sm text-muted">No automations match “{query}”.</p>
      {/if}
    </div>
  {:else}
    <!-- Keyed by position: the core never dedups automation names, so a name key
         could throw each_key_duplicate and blank the whole screen. -->
    <ul class="min-h-0 flex-1 space-y-2 overflow-y-auto">
      {#each filtered as automation, i (i)}
        <li>
          <Surface class="flex items-center gap-4 p-4">
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <span class="truncate font-medium" title={automation.name}>{automation.name}</span>
                <Chip>{automation.host ? `host · ${automation.host}` : 'local-only'}</Chip>
                <Chip variant="outline">{automation.steps.length} step{automation.steps.length === 1 ? '' : 's'}</Chip>
              </div>
              {#if automation.steps.length}
                <div class="mt-1 truncate font-mono text-xs text-muted" title={describeStep(automation.steps[0])}>
                  {describeStep(automation.steps[0])}{automation.steps.length > 1 ? ' …' : ''}
                </div>
              {/if}
            </div>
            <div class="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                class={pill}
                title="Run {automation.name}"
                aria-label="Run {automation.name}"
                onclick={() => (dialog = { kind: 'run', automation })}
              >
                <Icon name="play" size={12} />
                Run
              </button>
              <button
                type="button"
                class={iconBtn}
                title="Edit {automation.name}"
                aria-label="Edit {automation.name}"
                onclick={() => (dialog = { kind: 'edit', automation })}
              >
                <Icon name="edit" size={15} />
              </button>
              <button
                type="button"
                class={iconBtn}
                title="Delete {automation.name}"
                aria-label="Delete {automation.name}"
                onclick={() => (dialog = { kind: 'delete', automation })}
              >
                <Icon name="trash" size={15} />
              </button>
            </div>
          </Surface>
        </li>
      {/each}
    </ul>
  {/if}
</section>

{#if dialog?.kind === 'add'}
  <AutomationEditor mode="add" initial={emptyForm()} onSubmit={submit} onCancel={() => (dialog = null)} />
{:else if dialog?.kind === 'edit'}
  {@const automation = dialog.automation}
  <AutomationEditor
    mode="edit"
    initial={formFromAutomation(automation)}
    previousName={automation.name}
    onSubmit={submit}
    onCancel={() => (dialog = null)}
  />
{:else if dialog?.kind === 'run'}
  {@const automation = dialog.automation}
  <AutomationRunner
    {automation}
    onExecute={(params) => execute(automation, params)}
    onCancel={() => (dialog = null)}
  />
{:else if dialog?.kind === 'delete'}
  {@const automation = dialog.automation}
  <Modal label="Delete automation" onClose={() => (dialog = null)}>
    <div class="space-y-3 px-5 py-4">
      <h2 class="text-sm font-semibold">Delete automation</h2>
      <p class="text-sm text-muted">
        Delete “{automation.name}”? This removes it from <span class="font-mono">automations.toml</span>.
      </p>
      <div class="flex justify-end gap-2 pt-1">
        <Button variant="ghost" onclick={() => (dialog = null)}>Cancel</Button>
        <Button variant="primary" onclick={() => confirmDelete(automation.name)}>Delete</Button>
      </div>
    </div>
  </Modal>
{/if}

<AutomationResults />
