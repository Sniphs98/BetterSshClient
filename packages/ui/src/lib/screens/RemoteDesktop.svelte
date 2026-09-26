<script lang="ts">
  // Remote Desktop selector screen: list + add/edit/delete RDP connection profiles
  // (round-tripping through remote-desktop.toml), and "Connect" launches the OS's
  // native RDP client as its own external window — no in-app session/tab, unlike
  // Terminal/SFTP. Mirrors the Snippets screen's list+CRUD shape. VNC is a later pass.
  import { onMount } from 'svelte';
  import type { RemoteDesktopConnectionDto, RemoteDesktopConnectionInputDto } from '$lib/bindings';
  import { Surface, Chip, Icon, Button } from '$lib/theme';
  import {
    listRemoteDesktopConnections,
    saveRemoteDesktopConnection,
    deleteRemoteDesktopConnection,
    rdpLaunch
  } from '$lib/ipc/commands';
  import { remoteDesktopConnections } from '$lib/stores/remoteDesktop';
  import { sessions } from '$lib/stores/sessions';
  import { activeEntity } from '$lib/stores/activeEntity';
  import { spawnRdpSession } from '$lib/stores/navigation';
  import { lastError } from '$lib/stores/notifications';
  import { describeSettings, filterConnections, emptyForm, formFromConnection, fromOnePassword } from './remoteDesktopForm';
  import { displayReference } from './onePasswordRef';
  import { streamerMode, displayHostname } from '$lib/stores/streamer';
  import RemoteDesktopEditor from './RemoteDesktopEditor.svelte';
  import Modal from '$lib/components/Modal.svelte';

  type Dialog =
    | { kind: 'add' }
    | { kind: 'edit'; connection: RemoteDesktopConnectionDto }
    | { kind: 'delete'; connection: RemoteDesktopConnectionDto };

  let query = $state('');
  let dialog = $state<Dialog | null>(null);
  let connecting = $state<string | null>(null);
  // Something to know about the last launch (e.g. Windows used its own saved password).
  let notice = $state<string | null>(null);
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  const filtered = $derived(filterConnections($remoteDesktopConnections, query));

  const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

  async function refresh(): Promise<void> {
    try {
      remoteDesktopConnections.set(await listRemoteDesktopConnections());
    } catch (e) {
      lastError.set(message(e));
    }
  }

  onMount(refresh);

  async function submit(input: RemoteDesktopConnectionInputDto): Promise<void> {
    await saveRemoteDesktopConnection(input);
    remoteDesktopConnections.set(await listRemoteDesktopConnections());
    dialog = null;
  }

  async function confirmDelete(id: string): Promise<void> {
    try {
      await deleteRemoteDesktopConnection(id);
      remoteDesktopConnections.set(await listRemoteDesktopConnections());
    } catch (e) {
      lastError.set(message(e));
    }
    dialog = null;
  }

  /** Opens the connection in a tab inside the app — or goes to its tab if it has one. */
  function connect(connection: RemoteDesktopConnectionDto): void {
    const open = $sessions.find((s) => s.kind === 'rdp' && s.rdpConnectionId === connection.id);
    if (open) activeEntity.activateSession(open.id);
    else spawnRdpSession(connection.id, connection.name);
  }

  /** Opens the connection in the system's Remote Desktop app (mstsc / FreeRDP). */
  async function openExternally(connection: RemoteDesktopConnectionDto): Promise<void> {
    connecting = connection.id;
    notice = null;
    try {
      const result = await rdpLaunch(connection.id);
      if (result?.notice) {
        notice = result.notice;
        clearTimeout(noticeTimer);
        noticeTimer = setTimeout(() => (notice = null), 12_000);
      }
    } catch (e) {
      lastError.set(message(e));
    } finally {
      connecting = null;
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
    'grid h-7 w-7 place-items-center rounded-lg text-muted transition hover:bg-surface-inset ' +
    'hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';
</script>

<section class="min-h-full px-6 pb-8 pt-3">
  <div class="mb-5 flex items-center gap-3">
    <h1 class="text-lg font-semibold tracking-tight">Remote Desktop</h1>
    <div class="ml-auto w-full max-w-xs">
      <input bind:value={query} class={search} placeholder="Search connections…" aria-label="Search connections" />
    </div>
    <button type="button" class={pill} onclick={() => (dialog = { kind: 'add' })}>
      <Icon name="plus" size={13} />
      New connection
    </button>
  </div>

  {#if notice}
    <p class="mb-4 rounded-lg bg-surface-inset px-3 py-2 text-sm text-muted" role="status">{notice}</p>
  {/if}

  {#if filtered.length === 0}
    <div class="flex flex-1 flex-col items-center justify-center gap-2 text-center">
      {#if $remoteDesktopConnections.length === 0}
        <p class="font-medium">No connections yet</p>
        <p class="text-sm text-muted">Save an RDP connection to launch it in one click.</p>
        <button type="button" class="{pill} mt-2" onclick={() => (dialog = { kind: 'add' })}>
          <Icon name="plus" size={13} />
          New connection
        </button>
      {:else}
        <p class="text-sm text-muted">No connections match “{query}”.</p>
      {/if}
    </div>
  {:else}
    <!-- Tiles like the dashboard's server cards: identity, actions on their own row,
         then what connecting will do. -->
    <div class="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(19rem,1fr))]">
      {#each filtered as connection (connection.id)}
        <Surface class="flex flex-col gap-4 p-5">
          <div class="flex flex-col gap-3">
            <div class="flex min-w-0 items-start gap-3">
              <span class="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-surface-inset text-muted">
                <Icon name="monitor" size={16} />
              </span>
              <div class="min-w-0">
                <div class="flex min-w-0 items-center gap-2">
                  <span class="truncate font-medium" title={connection.name}>{connection.name}</span>
                  <span
                    class="shrink-0 rounded-full border border-default px-1.5 py-0.5 text-[10px] uppercase text-faint"
                    >{connection.protocol}</span
                  >
                  {#if fromOnePassword(connection)}
                    <span
                      class="inline-flex shrink-0 items-center gap-1 rounded-full border border-default px-1.5 py-0.5 text-[10px] text-faint"
                      title="{fromOnePassword(connection)} read from 1Password when connecting"
                    >
                      <Icon name="key" size={10} />
                      1Password
                    </span>
                  {:else if connection.hasPassword}
                    <span
                      class="inline-flex shrink-0 items-center gap-1 rounded-full border border-default px-1.5 py-0.5 text-[10px] text-faint"
                      title="Password saved — signs in by itself"
                    >
                      <Icon name="key" size={10} />
                      saved
                    </span>
                  {/if}
                </div>
                <div class="truncate font-mono text-xs text-faint">
                  {connection.username ? `${connection.domain ? `${connection.domain}\\` : ''}${displayReference(connection.username)}@` : ''}{displayHostname(
                    connection.hostname,
                    $streamerMode
                  )}:{connection.port}
                </div>
              </div>
            </div>
            <div class="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                class={pill}
                title="Connect to {connection.name}"
                aria-label="Connect to {connection.name}"
                onclick={() => connect(connection)}
              >
                <Icon name="play" size={12} />
                Connect
              </button>
              <button
                type="button"
                class={pill}
                title="Open {connection.name} in the Remote Desktop app"
                aria-label="Open {connection.name} in the Remote Desktop app"
                disabled={connecting === connection.id}
                onclick={() => openExternally(connection)}
              >
                <Icon name="upload" size={12} />
                {connecting === connection.id ? 'Opening…' : 'External'}
              </button>
              <button
                type="button"
                class={iconBtn}
                title="Edit {connection.name}"
                aria-label="Edit {connection.name}"
                onclick={() => (dialog = { kind: 'edit', connection })}
              >
                <Icon name="edit" size={14} />
              </button>
              <button
                type="button"
                class={iconBtn}
                title="Delete {connection.name}"
                aria-label="Delete {connection.name}"
                onclick={() => (dialog = { kind: 'delete', connection })}
              >
                <Icon name="trash" size={14} />
              </button>
            </div>
          </div>

          <div class="rounded-lg bg-surface-inset px-3 py-2.5 text-xs">
            <div class="flex items-center justify-between gap-3">
              <span class="text-[11px] uppercase tracking-wider text-faint">Route</span>
              <span class="min-w-0 truncate text-muted">
                {#if connection.viaHost}
                  via {connection.viaHost} <span class="text-faint">(SSH tunnel)</span>
                {:else}
                  direct
                {/if}
              </span>
            </div>
          </div>

          <div class="flex flex-wrap gap-1.5">
            {#each describeSettings(connection) as setting (setting)}
              <Chip>{setting}</Chip>
            {/each}
          </div>
        </Surface>
      {/each}
    </div>
  {/if}
</section>

{#if dialog?.kind === 'add'}
  <RemoteDesktopEditor mode="add" initial={emptyForm()} onSubmit={submit} onCancel={() => (dialog = null)} />
{:else if dialog?.kind === 'edit'}
  {@const connection = dialog.connection}
  <RemoteDesktopEditor
    mode="edit"
    initial={formFromConnection(connection)}
    onSubmit={submit}
    onCancel={() => (dialog = null)}
  />
{:else if dialog?.kind === 'delete'}
  {@const connection = dialog.connection}
  <Modal label="Delete connection" onClose={() => (dialog = null)}>
    <div class="space-y-3 px-5 py-4">
      <h2 class="text-sm font-semibold">Delete connection</h2>
      <p class="text-sm text-muted">
        Delete “{connection.name}”? This removes it from <span class="font-mono">remote-desktop.toml</span>.
      </p>
      <div class="flex justify-end gap-2 pt-1">
        <Button variant="ghost" onclick={() => (dialog = null)}>Cancel</Button>
        <Button variant="primary" onclick={() => confirmDelete(connection.id)}>Delete</Button>
      </div>
    </div>
  </Modal>
{/if}
