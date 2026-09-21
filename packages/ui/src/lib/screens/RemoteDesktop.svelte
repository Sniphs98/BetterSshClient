<script lang="ts">
  // Remote Desktop selector screen: list + add/edit/delete RDP connection profiles
  // (round-tripping through remote-desktop.toml), and "Connect" launches the OS's
  // native RDP client as its own external window — no in-app session/tab, unlike
  // Terminal/SFTP. Mirrors Snippets.svelte's list+CRUD shape. VNC is a later pass.
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
  import { lastError } from '$lib/stores/notifications';
  import { filterConnections, emptyForm, formFromConnection } from './remoteDesktopForm';
  import RemoteDesktopEditor from './RemoteDesktopEditor.svelte';
  import Modal from '$lib/components/Modal.svelte';

  type Dialog =
    | { kind: 'add' }
    | { kind: 'edit'; connection: RemoteDesktopConnectionDto }
    | { kind: 'delete'; connection: RemoteDesktopConnectionDto };

  let query = $state('');
  let dialog = $state<Dialog | null>(null);
  let connecting = $state<string | null>(null);
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

  async function connect(connection: RemoteDesktopConnectionDto): Promise<void> {
    connecting = connection.id;
    try {
      await rdpLaunch(connection.id);
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
    'grid h-8 w-8 place-items-center rounded-lg text-muted transition hover:bg-surface-inset ' +
    'hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';
</script>

<section class="flex h-full flex-col px-6 pb-6 pt-3">
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
    <ul class="min-h-0 flex-1 space-y-2 overflow-y-auto">
      {#each filtered as connection (connection.id)}
        <li>
          <Surface class="flex items-center gap-4 p-4">
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <span class="truncate font-medium" title={connection.name}>{connection.name}</span>
                <Chip>{connection.protocol}</Chip>
              </div>
              <div class="mt-1 truncate font-mono text-xs text-muted">
                {connection.username ? `${connection.username}@` : ''}{connection.hostname}:{connection.port}
              </div>
            </div>
            <div class="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                class={pill}
                title="Connect to {connection.name}"
                aria-label="Connect to {connection.name}"
                disabled={connecting === connection.id}
                onclick={() => connect(connection)}
              >
                <Icon name="play" size={12} />
                {connecting === connection.id ? 'Connecting…' : 'Connect'}
              </button>
              <button
                type="button"
                class={iconBtn}
                title="Edit {connection.name}"
                aria-label="Edit {connection.name}"
                onclick={() => (dialog = { kind: 'edit', connection })}
              >
                <Icon name="edit" size={15} />
              </button>
              <button
                type="button"
                class={iconBtn}
                title="Delete {connection.name}"
                aria-label="Delete {connection.name}"
                onclick={() => (dialog = { kind: 'delete', connection })}
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
