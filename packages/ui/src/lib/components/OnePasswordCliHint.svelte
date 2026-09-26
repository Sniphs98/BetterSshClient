<script lang="ts">
  // Under a "1Password reference" field: whether the 1Password CLI the reference needs
  // is installed — and if not, the command that installs it (to copy) and the docs,
  // so the first connection doesn't fail over it. Checked once per app run and when
  // asked to check again.
  import { onMount } from 'svelte';
  import type { OnePasswordStatusDto } from '$lib/bindings';
  import { onePasswordStatus } from '$lib/ipc/commands';
  import { openExternal } from '$lib/ipc/openExternal';
  import { Icon } from '$lib/theme';
  import { cachedOnePasswordStatus, rememberOnePasswordStatus } from '$lib/stores/onePassword';

  let status = $state<OnePasswordStatusDto | null>(cachedOnePasswordStatus());
  let checking = $state(false);
  let copied = $state(false);
  let box = $state<HTMLDivElement>();

  // Appearing under the field near the bottom of a form, it would start cut off.
  $effect(() => {
    if (box) requestAnimationFrame(() => box?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  });

  async function check(): Promise<void> {
    checking = true;
    try {
      status = await onePasswordStatus();
      rememberOnePasswordStatus(status);
    } catch {
      status = null;
    } finally {
      checking = false;
    }
  }

  async function copyCommand(): Promise<void> {
    if (!status?.command) return;
    try {
      await navigator.clipboard.writeText(status.command);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      // Clipboard unavailable: the command is shown to select by hand.
    }
  }

  onMount(() => {
    if (!status) void check();
  });

  const small =
    'inline-flex items-center gap-1 rounded-full border border-default px-2 py-0.5 text-[11px] font-medium text-muted ' +
    'transition hover:border-strong hover:bg-accent hover:text-accent-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';
</script>

{#if status && !status.installed}
  <div bind:this={box} class="-mt-1 space-y-2 rounded-lg border border-strong bg-surface-inset px-3 py-2.5 text-xs" role="status">
    <p class="font-medium text-fg">The 1Password CLI isn't installed</p>
    <p class="text-muted">
      The app reads the password through it.{#if status.command}{' '}Install it with:{/if}
    </p>
    {#if status.command}
      <div class="flex items-center gap-2">
        <code class="min-w-0 flex-1 select-text truncate rounded-md bg-surface px-2 py-1 font-mono text-fg">{status.command}</code>
        <button type="button" class={small} onclick={copyCommand}>
          <Icon name={copied ? 'check' : 'file'} size={11} />
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    {/if}
    <p class="text-muted">
      Then turn on <span class="text-fg">Settings → Developer → Integrate with 1Password CLI</span> in the 1Password
      app and check again.
    </p>
    <div class="flex flex-wrap gap-1.5">
      <button type="button" class={small} disabled={checking} onclick={check}>
        <Icon name="refresh" size={11} />
        {checking ? 'Checking…' : 'Check again'}
      </button>
      <button type="button" class={small} onclick={() => void openExternal(status!.docsUrl)}>Setup guide</button>
    </div>
  </div>
{:else if status?.installed}
  <p class="-mt-1 flex items-center gap-1.5 text-xs text-faint">
    <Icon name="check" size={11} />
    1Password CLI {status.version ?? ''} found
  </p>
{/if}
