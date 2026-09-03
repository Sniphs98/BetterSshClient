<script lang="ts">
  // Run dialog: collect any declared param values, then execute. Unlike snippets,
  // an automation targets at most one host — the one set on the automation itself
  // (resolved backend-side) — so there is no broadcast picker here, only a summary
  // of what will run and where.
  import type { AutomationDto } from '$lib/bindings';
  import { Button, StatusDot } from '$lib/theme';
  import Modal from '$lib/components/Modal.svelte';
  import { hosts } from '$lib/stores/hosts';
  import { statuses } from '$lib/stores/statuses';
  import { hostStatusDot } from '$lib/stores/palette';
  import { declaredParams } from './automationForm';

  let {
    automation,
    onExecute,
    onCancel
  }: {
    automation: AutomationDto;
    onExecute: (params: Record<string, string>) => void;
    onCancel: () => void;
  } = $props();

  // Seeded once from `automation`; the runner is remounted per open, so the prop
  // never changes under a live instance.
  // svelte-ignore state_referenced_locally
  const params = declaredParams(automation);
  let values = $state<Record<string, string>>(Object.fromEntries(params.map((p) => [p, ''])));

  const targetHost = $derived(automation.host ? $hosts.find((h) => h.name === automation.host) : undefined);

  /** Focus the first param input on open for a keyboard-first run. */
  function autofocus(node: HTMLInputElement, active: boolean): void {
    if (active) node.focus();
  }

  function run(): void {
    onExecute({ ...values });
  }

  const field =
    'w-full rounded-lg bg-surface-inset px-3 py-2 text-sm text-fg outline-none ' +
    'focus-visible:ring-2 focus-visible:ring-focus placeholder:text-faint';
</script>

<Modal label="Run automation" onClose={onCancel}>
  <header class="border-b border-default px-5 py-3.5">
    <h2 class="truncate text-sm font-semibold">Run “{automation.name}”</h2>
    <p class="mt-0.5 text-xs text-faint">
      {automation.steps.length} step{automation.steps.length === 1 ? '' : 's'}
    </p>
  </header>

  <div class="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
    {#if params.length}
      <div class="space-y-3">
        <h3 class="text-[11px] font-medium uppercase tracking-[0.18em] text-faint">Parameters</h3>
        <!-- Keyed by position: params come from automations.toml unchanged and the
             core never dedups them, so a name key could throw each_key_duplicate. -->
        {#each params as name, i (i)}
          <label class="block space-y-1 text-xs font-medium text-muted">
            <span class="font-mono">{'{{'}{name}{'}}'}</span>
            <input use:autofocus={i === 0} bind:value={values[name]} class={field} placeholder={name} />
          </label>
        {/each}
      </div>
    {/if}

    <div class="space-y-2">
      <h3 class="text-[11px] font-medium uppercase tracking-[0.18em] text-faint">Target</h3>
      {#if automation.host}
        <div class="flex items-center gap-2.5 rounded-lg bg-surface-inset px-3 py-2 text-sm">
          <StatusDot status={hostStatusDot($statuses.get(automation.host))} />
          <span class="min-w-0 flex-1 truncate font-medium">{automation.host}</span>
          {#if !targetHost}
            <span class="shrink-0 text-xs text-status-crit">not found</span>
          {/if}
        </div>
      {:else}
        <p class="text-sm text-muted">Local-only — every step runs on this machine.</p>
      {/if}
    </div>
  </div>

  <footer class="flex justify-end gap-2 border-t border-default px-5 py-3">
    <Button variant="ghost" onclick={onCancel}>Cancel</Button>
    <Button variant="primary" onclick={run} disabled={!!automation.host && !targetHost}>Run</Button>
  </footer>
</Modal>
