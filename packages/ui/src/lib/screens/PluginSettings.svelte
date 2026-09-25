<script lang="ts">
  // The Plugins section of Settings: every plugin found in the plugins folder, what it
  // asks for, and a switch. Switching one on is the consent — it grants exactly the
  // permissions listed next to it, and nothing a later version adds (that version stays
  // off until switched on again). A broken plugin shows why instead of disappearing.
  import { onMount } from 'svelte';
  import type { PluginDto } from '$lib/bindings';
  import { Surface, Icon } from '$lib/theme';
  import { lastError } from '$lib/stores/notifications';
  import { listPlugins, openPluginsFolder, reloadPlugins, setPluginEnabled } from '$lib/ipc/commands';

  let plugins = $state<PluginDto[] | null>(null);
  let busy = $state<string | null>(null);

  const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

  onMount(async () => {
    try {
      plugins = (await listPlugins()) ?? [];
    } catch {
      plugins = []; // Not under Electron (tests, vite preview).
    }
  });

  async function toggle(p: PluginDto): Promise<void> {
    busy = p.id;
    try {
      plugins = await setPluginEnabled(p.id, !p.enabled);
    } catch (e) {
      lastError.set(message(e));
    } finally {
      busy = null;
    }
  }

  async function reload(): Promise<void> {
    busy = '*';
    try {
      plugins = await reloadPlugins();
    } catch (e) {
      lastError.set(message(e));
    } finally {
      busy = null;
    }
  }

  async function openFolder(): Promise<void> {
    try {
      await openPluginsFolder();
    } catch (e) {
      lastError.set(message(e));
    }
  }

  const pill =
    'inline-flex shrink-0 items-center gap-1.5 rounded-full border border-strong px-3 py-1 text-xs text-fg transition hover:bg-accent hover:text-accent-fg disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';
</script>

<Surface class="p-5">
  <div class="mb-3 flex items-center justify-between gap-4">
    <h2 class="text-sm font-semibold">Plugins <span class="ml-1 text-xs font-normal text-faint">experimental</span></h2>
    <div class="flex gap-1.5">
      <button type="button" class={pill} onclick={openFolder}>
        <Icon name="folder" size={13} /> Open folder
      </button>
      <button type="button" class={pill} disabled={busy !== null} onclick={reload}>
        <Icon name="refresh" size={13} /> Reload
      </button>
    </div>
  </div>
  <p class="mb-4 text-xs text-muted">
    Plugins run sandboxed and can only do what they list below. Only switch on plugins you trust —
    one allowed to run commands can run any command on your servers.
  </p>

  {#if plugins === null}
    <p class="text-xs text-faint">Loading…</p>
  {:else if plugins.length === 0}
    <p class="text-xs text-faint">No plugins installed. Put a plugin folder into the plugins folder, then Reload.</p>
  {:else}
    <ul class="space-y-3">
      {#each plugins as p (p.id)}
        <li class="rounded-xl border border-default p-3" aria-label="Plugin {p.name}">
          <div class="flex items-start justify-between gap-4">
            <div class="min-w-0">
              <p class="text-sm font-medium">
                {p.name}
                {#if p.version}<span class="ml-1 font-mono text-xs text-faint">v{p.version}</span>{/if}
              </p>
              {#if p.description}<p class="text-xs text-muted">{p.description}</p>{/if}
            </div>
            {#if !p.error || p.enabled}
              <button
                type="button"
                role="switch"
                aria-checked={p.enabled}
                aria-label="Enable {p.name}"
                disabled={busy !== null || (!!p.error && !p.enabled)}
                onclick={() => toggle(p)}
                class="relative h-6 w-11 shrink-0 rounded-full transition disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus {p.enabled
                  ? 'bg-accent'
                  : 'bg-surface-inset'}"
              >
                <span
                  class="absolute top-0.5 h-5 w-5 rounded-full bg-surface shadow-soft transition-[left] {p.enabled
                    ? 'left-[1.375rem]'
                    : 'left-0.5'}"
                ></span>
              </button>
            {/if}
          </div>
          {#if p.error}
            <p class="mt-2 text-xs text-status-crit">{p.error}</p>
          {/if}
          {#if p.permissions.length > 0}
            <p class="mt-2 text-xs text-faint">{p.enabled ? 'Allowed to:' : 'Asks to:'}</p>
            <ul class="mt-1 space-y-0.5 text-xs text-muted">
              {#each p.permissions as perm (perm.id)}
                <li class="flex gap-1.5"><span aria-hidden="true">•</span>{perm.description}</li>
              {/each}
            </ul>
          {:else if !p.error}
            <p class="mt-2 text-xs text-faint">Needs no permissions.</p>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</Surface>
