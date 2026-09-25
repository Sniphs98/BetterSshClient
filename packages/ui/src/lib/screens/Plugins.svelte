<script lang="ts">
  // The Plugins page: a card per plugin found in the plugins folder, laid out like the
  // Dashboard. A card shows what the plugin asks for and a switch — switching it on is
  // the consent, granting exactly the permissions listed (a later version asking for
  // more stays off until switched on again). A running plugin's commands sit on its
  // card, runnable from here as well as from the command palette. A broken plugin shows
  // why instead of disappearing.
  import { onMount } from 'svelte';
  import type { PluginCommandDto, PluginDto } from '$lib/bindings';
  import { Surface, Icon, StatusDot, type Status } from '$lib/theme';
  import { lastError } from '$lib/stores/notifications';
  import { pluginCommands } from '$lib/stores/plugins';
  import { palette } from '$lib/stores/palette';
  import {
    listPlugins,
    openPluginsFolder,
    readPluginDocs,
    reloadPlugins,
    runPluginCommand,
    setPluginEnabled
  } from '$lib/ipc/commands';
  import { openExternal } from '$lib/ipc/openExternal';
  import { renderUntrustedMarkdown } from '$lib/markdown';
  import Modal from '$lib/components/Modal.svelte';

  let plugins = $state<PluginDto[] | null>(null);
  let busy = $state<string | null>(null);
  // The README of the plugin whose docs are open, already sanitised (see markdown.ts).
  let docs = $state<{ name: string; html: string } | null>(null);

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

  // Same flow as running it from the command palette: pick a host first if it wants one.
  async function run(command: PluginCommandDto): Promise<void> {
    let host: string | undefined;
    if (command.needsHost) {
      const picked = await palette.pickHost();
      if (!picked) return;
      host = picked.name;
    }
    try {
      await runPluginCommand(command.pluginId, command.commandId, host);
    } catch (e) {
      lastError.set(`${command.pluginName}: ${message(e)}`);
    }
  }

  async function showDocs(p: PluginDto): Promise<void> {
    try {
      docs = { name: p.name, html: renderUntrustedMarkdown(await readPluginDocs(p.id)) };
    } catch (e) {
      lastError.set(message(e));
    }
  }

  // A link in plugin docs never navigates the app window: it goes to the system browser.
  function onDocsClick(event: MouseEvent): void {
    const link = (event.target as HTMLElement).closest('a');
    if (!link) return;
    event.preventDefault();
    const href = link.getAttribute('href') ?? '';
    if (href.startsWith('#')) {
      document.getElementById(href.slice(1))?.scrollIntoView();
    } else if (/^(https:|mailto:)/i.test(href)) {
      void openExternal(href).catch((e) => lastError.set(message(e)));
    }
  }

  function status(p: PluginDto): { dot: Status; label: string } {
    if (p.error) return { dot: 'crit', label: 'Error' };
    if (p.running) return { dot: 'ok', label: 'Running' };
    if (p.enabled) return { dot: 'warn', label: 'Not running' };
    return { dot: 'off', label: 'Off' };
  }

  const roundBtn =
    'grid h-8 w-8 shrink-0 place-items-center rounded-full border border-default text-muted transition ' +
    'hover:border-strong hover:bg-accent hover:text-accent-fg disabled:opacity-60 ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';
  const pill =
    'inline-flex items-center gap-1.5 rounded-full border border-default px-2.5 py-1 text-xs ' +
    'font-medium text-muted transition hover:border-strong hover:bg-accent hover:text-accent-fg ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';
</script>

<section class="min-h-full px-6 pb-8 pt-3">
  <div class="mb-2 flex items-center gap-3">
    <h1 class="text-lg font-semibold tracking-tight">Plugins</h1>
    <span class="rounded-full border border-default px-2 py-0.5 text-[11px] text-faint">experimental</span>
    <div class="ml-auto flex items-center gap-2">
      <button type="button" class={roundBtn} title="Open plugins folder" aria-label="Open plugins folder" onclick={openFolder}>
        <Icon name="folder" size={15} />
      </button>
      <button
        type="button"
        class={roundBtn}
        title="Reload plugins"
        aria-label="Reload plugins"
        disabled={busy !== null}
        onclick={reload}
      >
        <span class="inline-flex {busy === '*' ? 'animate-spin' : ''}"><Icon name="refresh" size={15} /></span>
      </button>
    </div>
  </div>
  <p class="mb-5 max-w-3xl text-xs text-muted">
    Plugins run sandboxed and can only do what their card lists. Only switch on plugins you trust — one
    allowed to run commands can run any command on your servers.
  </p>

  {#if plugins === null}
    <p class="text-sm text-faint">Loading…</p>
  {:else if plugins.length === 0}
    <div class="flex flex-col items-center justify-center gap-2 py-20 text-center">
      <p class="font-medium">No plugins installed</p>
      <p class="max-w-md text-sm text-muted">
        Put a plugin folder into the plugins folder, then reload. The repository has an example in
        <span class="font-mono">examples/plugins</span>.
      </p>
      <div class="mt-2 flex gap-2">
        <button type="button" class={pill} onclick={openFolder}><Icon name="folder" size={13} /> Open folder</button>
        <button type="button" class={pill} onclick={reload}><Icon name="refresh" size={13} /> Reload</button>
      </div>
    </div>
  {:else}
    <div class="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(19rem,1fr))]">
      {#each plugins as p (p.id)}
        {@const st = status(p)}
        {@const commands = $pluginCommands.filter((c) => c.pluginId === p.id)}
        <Surface class="flex flex-col gap-3 p-5">
          <div class="flex items-start justify-between gap-3" aria-label="Plugin {p.name}" role="group">
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <StatusDot status={st.dot} />
                <h2 class="truncate font-medium">{p.name}</h2>
              </div>
              <p class="mt-0.5 font-mono text-xs text-faint">
                {p.version ? `v${p.version}` : p.id} · {st.label}
              </p>
            </div>
            {#if !p.error || p.enabled}
              <button
                type="button"
                role="switch"
                aria-checked={p.enabled}
                aria-label="Enable {p.name}"
                disabled={busy !== null}
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

          {#if p.description}<p class="text-sm text-muted">{p.description}</p>{/if}
          {#if p.error}<p class="text-xs text-status-crit">{p.error}</p>{/if}

          {#if p.permissions.length > 0}
            <div>
              <p class="text-xs text-faint">{p.enabled ? 'Allowed to' : 'Asks to'}</p>
              <ul class="mt-1 space-y-0.5 text-xs text-muted">
                {#each p.permissions as perm (perm.id)}
                  <li class="flex gap-1.5"><Icon name="shield" size={12} />{perm.description}</li>
                {/each}
              </ul>
            </div>
          {:else if !p.error}
            <p class="text-xs text-faint">Needs no permissions.</p>
          {/if}

          {#if commands.length > 0 || p.hasDocs}
            <div class="mt-auto flex flex-wrap gap-1.5 border-t border-default pt-3">
              {#each commands as c (c.commandId)}
                <button type="button" class={pill} onclick={() => run(c)}>
                  <Icon name="play" size={12} />
                  {c.title}
                </button>
              {/each}
              {#if p.hasDocs}
                <button type="button" class="{pill} ml-auto" aria-label="Docs for {p.name}" onclick={() => showDocs(p)}>
                  <Icon name="file" size={12} />
                  Docs
                </button>
              {/if}
            </div>
          {/if}
        </Surface>
      {/each}
    </div>
  {/if}
</section>

{#if docs}
  <Modal label="{docs.name} documentation" size="large" onClose={() => (docs = null)}>
    <p class="shrink-0 border-b border-default px-8 py-3 text-xs text-faint">
      Documentation from the plugin “{docs.name}”
    </p>
    <!-- Sanitised by renderUntrustedMarkdown: no scripts, handlers, frames or images. -->
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="plugin-docs min-h-0 flex-1 overflow-auto px-8 pb-8 pt-6 select-text" onclick={onDocsClick}>
      {@html docs.html}
    </div>
  </Modal>
{/if}

<style>
  .plugin-docs {
    font-size: 0.875rem;
    line-height: 1.6;
    color: var(--text);
  }
  .plugin-docs :global(h1) {
    font-size: 1.25rem;
    font-weight: 600;
    margin: 0 0 0.75rem;
  }
  .plugin-docs :global(h2) {
    font-size: 1.05rem;
    font-weight: 600;
    margin: 1.25rem 0 0.5rem;
  }
  .plugin-docs :global(h3) {
    font-weight: 600;
    margin: 1rem 0 0.4rem;
  }
  .plugin-docs :global(p),
  .plugin-docs :global(ul),
  .plugin-docs :global(ol),
  .plugin-docs :global(pre),
  .plugin-docs :global(table),
  .plugin-docs :global(blockquote) {
    margin: 0 0 0.75rem;
  }
  .plugin-docs :global(ul) {
    list-style: disc;
    padding-left: 1.25rem;
  }
  .plugin-docs :global(ol) {
    list-style: decimal;
    padding-left: 1.25rem;
  }
  .plugin-docs :global(code) {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 0.8em;
    background: var(--surface-inset);
    border-radius: 0.3rem;
    padding: 0.1rem 0.3rem;
  }
  .plugin-docs :global(pre) {
    background: var(--surface-inset);
    border-radius: 0.5rem;
    padding: 0.75rem;
    overflow: auto;
  }
  .plugin-docs :global(pre code) {
    background: none;
    padding: 0;
  }
  .plugin-docs :global(a) {
    color: var(--accent);
    text-decoration: underline;
  }
  .plugin-docs :global(blockquote) {
    border-left: 3px solid var(--border-strong, currentColor);
    padding-left: 0.75rem;
    color: var(--text-muted, inherit);
  }
  .plugin-docs :global(table) {
    border-collapse: collapse;
  }
  .plugin-docs :global(th),
  .plugin-docs :global(td) {
    border: 1px solid var(--border, currentColor);
    padding: 0.25rem 0.5rem;
    text-align: left;
  }
</style>
