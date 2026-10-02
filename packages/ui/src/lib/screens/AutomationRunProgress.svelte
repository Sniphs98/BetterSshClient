<script lang="ts">
  // Live automation-run progress panel: renders the active run from the `automationRun` store —
  // a per-node status list while running, then the same list frozen at its terminal
  // per-node outcomes, or an engine-level failure message. Mirrors
  // `KeySetupProgress.svelte`'s running -> terminal-panel structure. Mounted globally
  // (AppShell) so it survives navigating away from the Snippets screen mid-run.
  import { Button, Icon, StatusDot, type Status } from '$lib/theme';
  import Modal from '$lib/components/Modal.svelte';
  import {
    automationRun,
    dismissAutomationRun,
    formatDuration,
    stopAutomationRun,
    CANCELED,
    type AutomationRun,
    type NodeRunState
  } from '$lib/stores/automations';
  import type { NodeResultDto } from '$lib/bindings';
  import { openExternal } from '$lib/ipc/openExternal';

  // A progress line split into text and links (a GitHub run's, a release's), so a link
  // opens in the browser.
  const URL_RE = /(https:\/\/\S+)/;
  function parts(line: string): Array<{ text: string; url: boolean }> {
    return line.split(URL_RE).filter(Boolean).map((text) => ({ text, url: URL_RE.test(text) }));
  }

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

  // A clock for the times while a run is going — the whole run's, and the running
  // step's — ticking only then.
  let now = $state(Date.now());
  $effect(() => {
    if ($automationRun?.phase.kind !== 'running') return;
    now = Date.now();
    const timer = setInterval(() => (now = Date.now()), 250);
    return () => clearInterval(timer);
  });

  /** The whole run's time: live while it runs, fixed once it's done. */
  function totalTime(run: AutomationRun): string | undefined {
    if (run.startedAt === undefined) return undefined;
    if (run.phase.kind === 'running') return formatDuration(now - run.startedAt);
    if (run.finishedAt !== undefined) return formatDuration(run.finishedAt - run.startedAt);
    return undefined;
  }

  /** A finished step's own time; none for one that was skipped (it never ran). */
  function stepTime(result: NodeResultDto): string | undefined {
    return result.status === 'skipped' ? undefined : formatDuration(result.durationMs);
  }

  /** A step's time while the run goes: ticking while it runs, its own once done. */
  function nodeTime(state: NodeRunState): string | undefined {
    return state.status === 'running' ? formatDuration(now - state.startedAt) : stepTime(state.result);
  }

  /** What a finished step's row says: its status — or "canceled" for one Stop ended. */
  function statusText(result: NodeResultDto): string {
    return result.status === 'failed' && result.error === CANCELED ? 'canceled' : result.status;
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
      <div class="flex items-center gap-2.5 pr-8">
        <Icon name="automations" size={16} />
        <h2 class="min-w-0 truncate text-sm font-semibold">{run.automationName}</h2>
        {#if totalTime(run)}
          <span class="ml-auto flex shrink-0 items-center gap-1 font-mono text-xs tabular-nums text-muted" title="Total time">
            <Icon name="clock" size={12} />{totalTime(run)}
          </span>
        {/if}
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
                  {#if nodeTime(state)}
                    <span class="shrink-0 font-mono text-xs tabular-nums text-muted" title="Time of this step">{nodeTime(state)}</span>
                  {/if}
                  <span class="shrink-0 text-xs text-faint">
                    {state.status === 'running' ? 'running…' : statusText(state.result)}
                  </span>
                </div>
{#if run.progress?.[nodeId]?.length}
                  <ul class="space-y-0.5 text-[11px] text-muted">
                    {#each run.progress[nodeId].slice(-6) as line, i (i)}
                      <li class="break-words">
                        {#each parts(line) as part, j (j)}
                          {#if part.url}
                            <button type="button" class="underline decoration-dotted hover:text-fg" onclick={() => void openExternal(part.text)}>{part.text}</button>
                          {:else}{part.text}{/if}
                        {/each}
                      </li>
                    {/each}
                  </ul>
                {/if}
                {#if state.status === 'done' && state.result.output}
                  <pre class={outputBlock}>{state.result.output}</pre>
                {/if}
                {#if state.status === 'done' && state.result.error && state.result.error !== CANCELED}
                  <p class="text-xs text-status-crit">{state.result.error}</p>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
        <div class="flex justify-end pt-1">
          <Button variant="ghost" onclick={() => void stopAutomationRun(run.automationName)} disabled={run.stopping}>
            {run.stopping ? 'Stopping…' : 'Stop'}
          </Button>
        </div>
      {:else if phase.kind === 'completed'}
        <ul class="max-h-[50vh] space-y-1.5 overflow-y-auto">
          {#each phase.results as result (result.nodeId)}
            <li class={row}>
              <div class="flex items-center gap-2">
                <StatusDot status={dotStatus(result.status)} size={9} />
                <span class="min-w-0 flex-1 truncate">{result.label}</span>
                {#if stepTime(result)}
                  <span class="shrink-0 font-mono text-xs tabular-nums text-muted" title="Time of this step">{stepTime(result)}</span>
                {/if}
                <span class="shrink-0 text-xs text-faint">{statusText(result)}</span>
              </div>
{#if run.progress?.[result.nodeId]?.length}
                <ul class="space-y-0.5 text-[11px] text-muted">
                  {#each run.progress[result.nodeId].slice(-6) as line, i (i)}
                    <li class="break-words">
                      {#each parts(line) as part, j (j)}
                        {#if part.url}
                          <button type="button" class="underline decoration-dotted hover:text-fg" onclick={() => void openExternal(part.text)}>{part.text}</button>
                        {:else}{part.text}{/if}
                      {/each}
                    </li>
                  {/each}
                </ul>
              {/if}
              {#if result.output}
                <pre class={outputBlock}>{result.output}</pre>
              {/if}
              {#if result.error && result.error !== CANCELED}
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
