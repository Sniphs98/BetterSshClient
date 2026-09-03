<script lang="ts">
  // Per-step automation results, driven by the `automationRun` store: each step
  // shows queued → running → ok/failed with its output, in execution order.
  // Mirrors `SnippetResults.svelte`. Colour lives only in the status dot.
  import { StatusDot, Button, type Status } from '$lib/theme';
  import Modal from '$lib/components/Modal.svelte';
  import { automationRun, clearAutomationRun, type AutomationResultEntry } from '$lib/stores/automations';

  function dot(entry: AutomationResultEntry): Status {
    if (!entry.started) return 'unknown';
    if (entry.pending) return 'unknown';
    return entry.ok ? 'ok' : 'crit';
  }

  function state(entry: AutomationResultEntry): string {
    if (!entry.started) return 'queued';
    if (entry.pending) return 'running';
    return entry.ok ? 'ok' : 'failed';
  }
</script>

{#if $automationRun}
  {@const run = $automationRun}
  <Modal label="Automation results" onClose={clearAutomationRun}>
    <header class="border-b border-default px-5 py-3.5">
      <h2 class="truncate text-sm font-semibold">Results — “{run.automationName}”</h2>
    </header>

    <div class="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
      {#each run.entries as entry, i (i)}
        <div class="rounded-lg border border-default">
          <div class="flex items-center gap-2.5 border-b border-default px-3 py-2">
            <StatusDot status={dot(entry)} label="step {i + 1} {state(entry)}" />
            <span class="min-w-0 flex-1 truncate font-mono text-sm font-medium">{entry.description}</span>
            <span class="shrink-0 text-[11px] uppercase tracking-wider text-faint">{state(entry)}</span>
          </div>
          {#if !entry.started}
            <p class="px-3 py-2 text-xs text-faint">Queued…</p>
          {:else if entry.pending}
            <p class="px-3 py-2 text-xs text-faint">Running…</p>
          {:else if entry.output.trim()}
            <pre
              class="max-h-52 select-text overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-xs {entry.ok
                ? 'text-muted'
                : 'text-status-crit'}">{entry.output}</pre>
          {:else}
            <p class="px-3 py-2 text-xs text-faint">(no output)</p>
          {/if}
        </div>
      {/each}
    </div>

    <footer class="flex justify-end border-t border-default px-5 py-3">
      <Button variant="secondary" onclick={clearAutomationRun}>Close</Button>
    </footer>
  </Modal>
{/if}
