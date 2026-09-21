<script lang="ts">
  // The "collect an Automation's parameter values, then run it" dialog — shared by the
  // Snippets screen's own Run button (openRunDialog in Snippets.svelte, always a
  // fresh run) and any other entry point that already knows some of the values (e.g.
  // SFTP's "Run automation with this file" context menu item, which prefills a text param
  // with the clicked file's path and the host param with the SFTP session's host). A
  // automation with no parameters never reaches this — callers run it directly instead.
  import type { AutomationDto } from '$lib/bindings';
  import { Button } from '$lib/theme';
  import Modal from '$lib/components/Modal.svelte';
  import { palette } from '$lib/stores/palette';

  let {
    automation,
    initialValues = {},
    onRun,
    onCancel
  }: {
    automation: AutomationDto;
    /** Pre-filled values, keyed by param name — anything not present here falls back
     *  to that param's own `default`. Still editable before running. */
    initialValues?: Record<string, string>;
    onRun: (values: Record<string, string>) => void;
    onCancel: () => void;
  } = $props();

  // Seeded once from `initialValues`/each param's own default; every caller remounts
  // this dialog per open (a fresh `{#if}`/component instance), so the props never
  // change under a live one.
  // svelte-ignore state_referenced_locally
  let values = $state<Record<string, string>>(
    Object.fromEntries(automation.params.map((p) => [p.name, initialValues[p.name] ?? p.default ?? '']))
  );

  async function pickHost(paramName: string): Promise<void> {
    const host = await palette.pickHost();
    if (host) values[paramName] = host.name;
  }
</script>

<Modal label="Run automation" onClose={onCancel}>
  <div class="space-y-3 px-5 py-4">
    <h2 class="text-sm font-semibold">Run "{automation.name}"</h2>
    <p class="text-sm text-muted">This automation needs a few values before it runs.</p>
    <div class="space-y-3">
      {#each automation.params as param (param.name)}
        {#if param.kind === 'host'}
          <!-- Not a <label>: wrapping a <button> in one lets the label text win the
               accessible-name computation over the button's own "Choose a host…" text
               in some engines, so the two are kept as siblings instead. -->
          <div class="space-y-1 text-xs font-medium text-muted">
            <span>{param.label || param.name}</span>
            <button
              type="button"
              class="w-full truncate rounded-lg bg-surface-inset px-3 py-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-focus {values[
                param.name
              ]
                ? 'text-fg'
                : 'text-faint'}"
              onclick={() => pickHost(param.name)}
            >
              {values[param.name] || 'Choose a host…'}
            </button>
          </div>
        {:else}
          <label class="block space-y-1 text-xs font-medium text-muted">
            <span>{param.label || param.name}</span>
            <input
              bind:value={values[param.name]}
              class="w-full rounded-lg bg-surface-inset px-3 py-2 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus"
            />
          </label>
        {/if}
      {/each}
    </div>
    <div class="flex justify-end gap-2 pt-1">
      <Button variant="ghost" onclick={onCancel}>Cancel</Button>
      <Button
        variant="primary"
        disabled={automation.params.some((p) => !values[p.name]?.trim())}
        onclick={() => onRun({ ...values })}
      >
        Run
      </Button>
    </div>
  </div>
</Modal>
