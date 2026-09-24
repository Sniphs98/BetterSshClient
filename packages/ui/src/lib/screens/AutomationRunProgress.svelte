<script lang="ts">
  // Live automation-run progress panel: renders the active run from the `automationRun` store —
  // a per-node status list while running, then the same list frozen at its terminal
  // per-node outcomes, or an engine-level failure message. Mirrors
  // `KeySetupProgress.svelte`'s running -> terminal-panel structure. Mounted globally
  // (AppShell) so it survives navigating away from the Snippets screen mid-run.
  import { Button, Icon, StatusDot, type Status } from '$lib/theme';
  import Modal from '$lib/components/Modal.svelte';
  import { automationRun, dismissAutomationRun } from '$lib/stores/automations';
  import type { NodeResultDto } from '$lib/bindings';

  function dotStatus(status: NodeResultDto['status'] | 'running'): Status {
    switch (status) {
      case 'success':
        return 'ok';
      case 'failed':
        return 'crit';
      case 'skipped':
        return 'warn';
      case 'running':
        return 'unknown';
    }
  }

  const row =
    'space-y-1.5 rounded-lg bg-surface-inset px-3 py-2 text-sm';
  const outputBlock =
    'mt-1.5 max-h-28 overflow-auto whitespace-pre-wrap break-words rounded bg-surface px-2 py-1.5 font-mono text-[11px] text-muted';
</script>

{#if $automationRun}
  {@const run = $automationRun}
  {@const phase = run.phase}
  <Modal label="Automation run" onClose={dismissAutomationRun}>
    <div class="space-y-3 px-5 py-4">
      <div class="flex items-center gap-2.5">
        <Icon name="automations" size={16} />
        <h2 class="min-w-0 truncate text-sm font-semibold">{run.automationName}</h2>
      </div>

      {#if phase.kind === 'running'}
        {#if phase.nodes.size === 0}
          <p class="text-sm text-muted">Starting…</p>
        {:else}
          <ul class="max-h-[50vh] space-y-1.5 overflow-y-auto">
            {#each [...phase.nodes] as [nodeId, state] (nodeId)}
              <li class={row}>
                <div class="flex items-center gap-2">
                  <StatusDot status={dotStatus(state.status === 'running' ? 'running' : state.result.status)} size={9} />
                  <span class="min-w-0 flex-1 truncate">{state.status === 'running' ? state.label : state.result.label}</span>
                  <span class="shrink-0 text-xs text-faint">
                    {state.status === 'running' ? 'running…' : state.result.status}
                  </span>
                </div>
                {#if state.status === 'done' && state.result.output}
                  <pre class={outputBlock}>{state.result.output}</pre>
                {/if}
                {#if state.status === 'done' && state.result.error}
                  <p class="text-xs text-status-crit">{state.result.error}</p>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      {:else if phase.kind === 'completed'}
        <ul class="max-h-[50vh] space-y-1.5 overflow-y-auto">
          {#each phase.results as result (result.nodeId)}
            <li class={row}>
              <div class="flex items-center gap-2">
                <StatusDot status={dotStatus(result.status)} size={9} />
                <span class="min-w-0 flex-1 truncate">{result.label}</span>
                <span class="shrink-0 text-xs text-faint">{result.status}</span>
              </div>
              {#if result.output}
                <pre class={outputBlock}>{result.output}</pre>
              {/if}
              {#if result.error}
                <p class="text-xs text-status-crit">{result.error}</p>
              {/if}
            </li>
          {/each}
        </ul>
        <div class="flex justify-end pt-1">
          <Button variant="primary" onclick={dismissAutomationRun}>Done</Button>
        </div>
      {:else}
        <div class="flex items-start gap-2.5">
          <span class="mt-0.5 shrink-0"><StatusDot status="crit" size={9} /></span>
          <div class="min-w-0 space-y-1">
            <p class="text-sm font-medium">Automation run failed</p>
            <p class="break-words text-xs text-muted">{phase.error}</p>
          </div>
        </div>
        <div class="flex justify-end pt-1">
          <Button variant="ghost" onclick={dismissAutomationRun}>Close</Button>
        </div>
      {/if}
    </div>
  </Modal>
{/if}
