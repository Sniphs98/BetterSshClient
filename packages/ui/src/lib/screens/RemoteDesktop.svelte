<script lang="ts">
  // Remote Desktop selector screen: list + add/edit/delete RDP connection profiles
  // (round-tripping through remote-desktop.toml), and "Connect" launches the OS's
  // native RDP client as its own external window — no in-app session/tab, unlike
  // Terminal/SFTP. VNC is a later pass. The tiles sit in folders like the dashboard's
  // host cards (dashboardSections.ts): collapsible sections, "New folder", drag a tile
  // onto a section to move it, export per folder.
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import type { ConnectionImportPreviewDto, RemoteDesktopConnectionDto, RemoteDesktopConnectionInputDto } from '$lib/bindings';
  import { Surface, Chip, Icon, Button } from '$lib/theme';
  import {
    listRemoteDesktopConnections,
    saveRemoteDesktopConnection,
    deleteRemoteDesktopConnection,
    exportRdpProfiles,
    previewRdpProfilesImport,
    rdpLaunch
  } from '$lib/ipc/commands';
  import { remoteDesktopConnections } from '$lib/stores/remoteDesktop';
  import { sessions } from '$lib/stores/sessions';
  import { activeEntity } from '$lib/stores/activeEntity';
  import { spawnRdpSession } from '$lib/stores/navigation';
  import { lastError } from '$lib/stores/notifications';
  import {
    describeSettings,
    filterConnections,
    emptyForm,
    formFromConnection,
    formToInput,
    fromOnePassword
  } from './remoteDesktopForm';
  import { folderNameProblem, folderNames, groupByFolder } from './dashboardSections';
  import { rdpCollapsedSections, rdpKeptFolders } from '$lib/stores/dashboardLayout';
  import { addressLine } from './onePasswordRef';
  import { streamerMode, displayHostname } from '$lib/stores/streamer';
  import RemoteDesktopEditor from './RemoteDesktopEditor.svelte';
  import ConnectionImportDialog from './ConnectionImportDialog.svelte';
  import { importSummary } from './connectionImport';
  import Modal from '$lib/components/Modal.svelte';

  type Dialog =
    | { kind: 'add' }
    | { kind: 'edit'; connection: RemoteDesktopConnectionDto }
    | { kind: 'delete'; connection: RemoteDesktopConnectionDto }
    | { kind: 'newFolder' }
    | { kind: 'import'; preview: ConnectionImportPreviewDto };

  // Search: a round toggle slides a filter field out to its left, as on the dashboard.
  let query = $state('');
  let searchOpen = $state(false);
  let searchInput = $state<HTMLInputElement>();
  let dialog = $state<Dialog | null>(null);
  let connecting = $state<string | null>(null);
  // Something to know about the last launch (e.g. Windows used its own saved password).
  let notice = $state<string | null>(null);
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  const filtered = $derived(filterConnections($remoteDesktopConnections, query));
  // A section per folder, then the connections in none. Kept folders show even when
  // empty — except while searching, where only matches count.
  const sections = $derived(
    groupByFolder(filtered, (c) => c, query.trim() ? [] : $rdpKeptFolders, 'Connections')
  );
  // Every folder a connection is in is kept, so it outlives its last tile (dragged out).
  $effect(() => rdpKeptFolders.keepAll(folderNames($remoteDesktopConnections)));

  const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

  async function refresh(): Promise<void> {
    try {
      remoteDesktopConnections.set(await listRemoteDesktopConnections());
    } catch (e) {
      lastError.set(message(e));
    }
  }

  onMount(() => {
    void rdpKeptFolders.load();
    void refresh();
  });

  function toggleSearch(): void {
    searchOpen = !searchOpen;
    if (searchOpen) requestAnimationFrame(() => searchInput?.focus());
    else query = '';
  }

  // Every section is open while searching, so a match is never hidden in a closed one.
  function isCollapsed(key: string): boolean {
    return !query.trim() && $rdpCollapsedSections.has(key);
  }

  // "New folder": an empty section to drag tiles into.
  let newFolderName = $state('');
  let newFolderError = $state<string | null>(null);

  function openNewFolder(): void {
    newFolderName = '';
    newFolderError = null;
    dialog = { kind: 'newFolder' };
  }

  function createFolder(): void {
    const problem = folderNameProblem(newFolderName, [...folderNames($remoteDesktopConnections), ...$rdpKeptFolders]);
    if (problem) {
      newFolderError = problem;
      return;
    }
    const name = newFolderName.trim();
    rdpKeptFolders.add(name);
    // Open, so the new section is visible straight away.
    if ($rdpCollapsedSections.has(`folder:${name}`)) rdpCollapsedSections.toggle(`folder:${name}`);
    dialog = null;
  }

  // Dragging a tile onto another section moves the connection into that folder (or out
  // of every folder, for the "no folder" one) — the same save its editor's Folder field does.
  const RDP_DRAG = 'application/x-remoty-rdp';
  let dropTarget = $state<string | null>(null);

  function onDragStart(e: DragEvent, id: string): void {
    e.dataTransfer?.setData(RDP_DRAG, id);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  }

  function onDragOver(e: DragEvent, key: string): void {
    if (!e.dataTransfer?.types.includes(RDP_DRAG)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    dropTarget = key;
  }

  async function onDrop(e: DragEvent, folder: string): Promise<void> {
    const id = e.dataTransfer?.getData(RDP_DRAG);
    dropTarget = null;
    if (!id) return;
    e.preventDefault();
    const connection = get(remoteDesktopConnections).find((c) => c.id === id);
    if (!connection || (connection.folder ?? '') === folder) return;
    // The form leaves the password blank, which keeps the stored one.
    const result = formToInput({ ...formFromConnection(connection), folder });
    if (!result.ok) {
      lastError.set(result.error);
      return;
    }
    try {
      await saveRemoteDesktopConnection(result.input);
      remoteDesktopConnections.set(await listRemoteDesktopConnections());
    } catch (err) {
      lastError.set(message(err));
    }
  }

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

  function showNotice(text: string): void {
    notice = text;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => (notice = null), 12_000);
  }

  /** Saves profiles to a file to share — without passwords; 1Password references stay. */
  async function exportProfiles(ids: string[], label?: string): Promise<void> {
    try {
      await exportRdpProfiles(ids, label);
    } catch (e) {
      lastError.set(message(e));
    }
  }

  /** Reads a profiles file; the dialog then settles name conflicts before importing. */
  async function startImport(): Promise<void> {
    try {
      const preview = await previewRdpProfilesImport();
      if (preview) dialog = { kind: 'import', preview };
    } catch (e) {
      lastError.set(message(e));
    }
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
      if (result?.notice) showNotice(result.notice);
    } catch (e) {
      lastError.set(message(e));
    } finally {
      connecting = null;
    }
  }

  const search =
    'min-w-0 rounded-full bg-surface-inset py-1.5 text-sm text-fg outline-none transition-all duration-200 ' +
    'placeholder:text-faint focus-visible:ring-2 focus-visible:ring-focus';
  const roundBtn =
    'grid h-8 w-8 shrink-0 place-items-center rounded-full border border-default text-muted transition ' +
    'hover:border-strong hover:bg-accent hover:text-accent-fg ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';
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
    <div class="ml-auto flex items-center gap-2">
    <div class="flex items-center">
      <input
        bind:this={searchInput}
        bind:value={query}
        type="text"
        placeholder="Search connections…"
        aria-label="Search connections"
        disabled={!searchOpen}
        class="{search} {searchOpen ? 'mr-2 w-52 px-3 opacity-100' : 'pointer-events-none w-0 px-0 opacity-0'}"
        onkeydown={(e) => {
          if (e.key === 'Escape') toggleSearch();
        }}
      />
      <button
        type="button"
        class={roundBtn}
        title={searchOpen ? 'Close search' : 'Search connections'}
        aria-label={searchOpen ? 'Close search' : 'Search connections'}
        aria-expanded={searchOpen}
        onclick={toggleSearch}
      >
        <Icon name={searchOpen ? 'close' : 'search'} size={15} />
      </button>
    </div>
    <button type="button" class={pill} title="Import remote desktop profiles from a file" onclick={startImport}>
      <Icon name="upload" size={13} />
      Import…
    </button>
    {#if $remoteDesktopConnections.length > 0}
      <button
        type="button"
        class={pill}
        title="Export every profile to a file, without passwords"
        onclick={() => exportProfiles($remoteDesktopConnections.map((c) => c.id), 'rdp-profiles')}
      >
        <Icon name="download" size={13} />
        Export all
      </button>
    {/if}
    <button type="button" class={pill} onclick={openNewFolder}>
      <Icon name="folder" size={13} />
      New folder
    </button>
    <button type="button" class={pill} onclick={() => (dialog = { kind: 'add' })}>
      <Icon name="plus" size={13} />
      New connection
    </button>
    </div>
  </div>

  {#if notice}
    <p class="mb-4 rounded-lg bg-surface-inset px-3 py-2 text-sm text-muted" role="status">{notice}</p>
  {/if}

  {#if $remoteDesktopConnections.length === 0 && sections.length === 0}
    <div class="flex flex-1 flex-col items-center justify-center gap-2 py-20 text-center">
      <p class="font-medium">No connections yet</p>
      <p class="text-sm text-muted">Save an RDP connection to launch it in one click.</p>
      <button type="button" class="{pill} mt-2" onclick={() => (dialog = { kind: 'add' })}>
        <Icon name="plus" size={13} />
        New connection
      </button>
    </div>
  {:else if query.trim() && filtered.length === 0}
    <div class="flex flex-1 flex-col items-center justify-center gap-2 py-20 text-center">
      <p class="text-sm text-muted">No connections match “{query}”.</p>
    </div>
  {:else}
    {#each sections as section (section.key)}
      <!-- svelte-ignore a11y_no_static_element_interactions -- a drop zone for dragged
           tiles; moving a connection is also possible from its editor's Folder field. -->
      <div
        class="mb-6 rounded-xl transition {dropTarget === section.key ? 'bg-surface-inset/60 ring-2 ring-focus' : ''}"
        ondragover={(e) => onDragOver(e, section.key)}
        ondragleave={() => (dropTarget = dropTarget === section.key ? null : dropTarget)}
        ondrop={(e) => onDrop(e, section.folder)}
      >
        {@render sectionHeader(section.key, section.title, section.cards.length, section.folder)}
        {#if !isCollapsed(section.key) && section.cards.length === 0}
          <div class="rounded-xl border border-dashed border-default px-4 py-6 text-center text-xs text-faint">
            Drag connections here to put them in {section.title}.
          </div>
        {:else if !isCollapsed(section.key)}
          <!-- Tiles like the dashboard's server cards: identity, actions on their own row,
               then what connecting will do. -->
          <div class="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(19rem,1fr))]">
            {#each section.cards as connection (connection.id)}
              <div
                draggable="true"
                ondragstart={(e) => onDragStart(e, connection.id)}
                ondragend={() => (dropTarget = null)}
                role="listitem"
                class="h-full"
              >
                {@render connectionTile(connection)}
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/each}
  {/if}
</section>

{#snippet sectionHeader(key: string, title: string, count: number, folder: string)}
  <div class="mb-3 flex items-center gap-1">
    <button
      type="button"
      class="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-1 py-1 text-left text-sm font-semibold text-muted transition hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      aria-expanded={!isCollapsed(key)}
      title={query ? 'Showing every section while searching' : isCollapsed(key) ? `Show ${title}` : `Hide ${title}`}
      onclick={() => rdpCollapsedSections.toggle(key)}
    >
      <svg
        class="h-3 w-3 shrink-0 transition-transform {isCollapsed(key) ? '-rotate-90' : ''}"
        viewBox="0 0 12 12"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M3 4.5 6 7.5 9 4.5" />
      </svg>
      {#if folder}<Icon name="folder" size={14} />{/if}
      <span class="truncate">{title}</span>
      <span class="rounded-full bg-surface-inset px-1.5 text-[11px] font-medium text-faint">{count}</span>
    </button>
    {#if folder && count > 0}
      <button
        type="button"
        class={iconBtn}
        title="Export the connections in {title} to a file, without passwords"
        aria-label="Export folder {title}"
        onclick={() =>
          exportProfiles(
            $remoteDesktopConnections.filter((c) => c.folder === folder).map((c) => c.id),
            folder
          )}
      >
        <Icon name="download" size={13} />
      </button>
    {/if}
    <!-- Only an empty folder can go: one with connections in it would just come back. -->
    {#if folder && count === 0}
      <button
        type="button"
        class={iconBtn}
        title="Remove the empty folder {title}"
        aria-label="Remove folder {title}"
        onclick={() => rdpKeptFolders.remove(folder)}
      >
        <Icon name="close" size={13} />
      </button>
    {/if}
  </div>
{/snippet}

{#snippet connectionTile(connection: RemoteDesktopConnectionDto)}
        <Surface class="flex h-full flex-col gap-4 p-5">
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
                  {addressLine(
                    { ...connection, user: connection.username },
                    displayHostname(connection.hostname, $streamerMode)
                  )}
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
                title="Export {connection.name} to a file, without its password"
                aria-label="Export {connection.name}"
                onclick={() => exportProfiles([connection.id])}
              >
                <Icon name="download" size={14} />
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
{/snippet}

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
{:else if dialog?.kind === 'import'}
  <ConnectionImportDialog
    title="Import remote desktop profiles"
    preview={dialog.preview}
    onCancel={() => (dialog = null)}
    onDone={(result) => {
      dialog = null;
      showNotice(importSummary(result));
      void refresh();
    }}
  />
{:else if dialog?.kind === 'newFolder'}
  <Modal label="New folder" onClose={() => (dialog = null)}>
    <form
      class="space-y-3 px-5 py-4"
      onsubmit={(e) => {
        e.preventDefault();
        createFolder();
      }}
    >
      <h2 class="text-sm font-semibold">New folder</h2>
      <label class="block space-y-1 text-xs font-medium text-muted">
        <span>Name</span>
        <!-- svelte-ignore a11y_autofocus -- the one field of a dialog just opened for it -->
        <input
          bind:value={newFolderName}
          autofocus
          class="w-full rounded-lg bg-surface-inset px-3 py-2 text-sm text-fg outline-none placeholder:text-faint focus-visible:ring-2 focus-visible:ring-focus"
          placeholder="Office"
        />
      </label>
      <p class="text-xs text-faint">Then drag connections onto it, or pick it in a connection's Folder field.</p>
      {#if newFolderError}<p class="text-xs text-status-crit">{newFolderError}</p>{/if}
      <div class="flex justify-end gap-2 pt-1">
        <Button variant="ghost" onclick={() => (dialog = null)}>Cancel</Button>
        <Button variant="primary" type="submit">Create folder</Button>
      </div>
    </form>
  </Modal>
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
