<script lang="ts">
  // Server-card grid (tech-gui.md §2, 2.1): one card per host with live health and
  // detected services. Colour is reserved for semantic state — the header dot and
  // the metric fills read from `statusToken`; everything else is ink-on-paper. The
  // per-card `sh`/`files` buttons are the host-first spawn path (§2). Host management
  // (add/edit/delete, §4.1) lives here — there is no separate Hosts screen (§2).
  // Editing an SSH-config host adopts it into hosts.toml; the file itself is never
  // written, so only Delete stays manual-only.
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import type { HostDto, HostInputDto, TerminalProfileDto } from '$lib/bindings';
  import { Surface, Chip, StatusDot, Icon, Button, statusToken } from '$lib/theme';
  import { serverCards, filterHosts, QUICK_ACTIONS, type ServerCard } from './serverCard';
  import { groupCards, LOCAL_KEY } from './dashboardSections';
  import { collapsedSections } from '$lib/stores/dashboardLayout';
  import { spawnSession, spawnLocalTerminal } from '$lib/stores/navigation';
  import { streamerMode, displayHostname } from '$lib/stores/streamer';
  import { addressLine } from './onePasswordRef';
  import { hosts } from '$lib/stores/hosts';
  import { lastError } from '$lib/stores/notifications';
  import { saveHost, deleteHost, reloadHosts, startKeySetup, refreshMetrics, terminalProfiles } from '$lib/ipc/commands';
  import { isRefreshHotkey } from '$lib/stores/ui';
  import { beginKeySetup, dismissKeySetup } from '$lib/stores/keySetup';
  import { emptyForm, formFromHost, formToInput } from './hostForm';
  import HostEditor from './HostEditor.svelte';
  import Modal from '$lib/components/Modal.svelte';

  type Dialog =
    | { kind: 'add' }
    | { kind: 'edit'; host: HostDto }
    | { kind: 'delete'; host: HostDto }
    | { kind: 'keySetupConfirm'; host: HostDto };

  let dialog = $state<Dialog | null>(null);
  // Reset to the safer default (disable password login) each time the confirm dialog
  // opens, so a prior run's choice never silently carries over to a different host.
  let disablePasswordAuth = $state(true);

  // Host search (task 6): a round toggle slides a filter field out to its left and the
  // grid filters live. Frontend-only — the core stays untouched.
  let query = $state('');
  let searchOpen = $state(false);
  let searchInput = $state<HTMLInputElement>();
  const visibleCards = $derived(filterHosts($serverCards, query));
  // Accordion sections: a folder each, then the hosts in none (dashboardSections.ts).
  const sections = $derived(groupCards(visibleCards));

  // The local shells for the fixed "This computer" section, found once per visit.
  let localShells = $state<TerminalProfileDto[]>([]);
  onMount(() => {
    terminalProfiles().then(
      (list) => (localShells = Array.isArray(list) ? list : []),
      () => (localShells = [])
    );
  });
  const visibleLocal = $derived(
    query.trim() ? localShells.filter((s) => s.label.toLowerCase().includes(query.trim().toLowerCase())) : localShells
  );
  // The tile's second line: what kind of thing it opens (the label already names it).
  const shellKind = (kind: TerminalProfileDto['kind']): string => (kind === 'wsl' ? 'WSL distribution' : 'Local shell');

  // Every section is open while searching, so a match is never hidden in a closed one.
  function isCollapsed(key: string): boolean {
    return !query.trim() && $collapsedSections.has(key);
  }

  // Dragging a card onto another section moves the host into that folder (or out of
  // every folder, for the "no folder" one) — the same save its editor's Folder field does.
  const HOST_DRAG = 'application/x-better-ssh-client-host';
  let dropTarget = $state<string | null>(null);

  function onDragStart(e: DragEvent, hostName: string): void {
    e.dataTransfer?.setData(HOST_DRAG, hostName);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  }

  function onDragOver(e: DragEvent, key: string): void {
    if (!e.dataTransfer?.types.includes(HOST_DRAG)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    dropTarget = key;
  }

  async function onDrop(e: DragEvent, folder: string): Promise<void> {
    const hostName = e.dataTransfer?.getData(HOST_DRAG);
    dropTarget = null;
    if (!hostName) return;
    e.preventDefault();
    const host = get(hosts).find((h) => h.name === hostName);
    if (!host || (host.folder ?? '') === folder) return;
    const result = formToInput({ ...formFromHost(host), folder });
    if (!result.ok) {
      lastError.set(result.error);
      return;
    }
    try {
      await saveHost(result.input);
      await reloadHosts();
    } catch (err) {
      lastError.set(message(err));
    }
  }

  function toggleSearch(): void {
    searchOpen = !searchOpen;
    if (searchOpen) requestAnimationFrame(() => searchInput?.focus());
    else query = '';
  }

  const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

  // Force an immediate metric poll of every host (tech-gui.md §4.2), shared by the
  // refresh button and the `r` hotkey (mirrors the TUI). The command returns before the
  // fresh metrics arrive (they land via `metrics-updated` events), so a short minimum
  // spin gives the click/keypress visible feedback.
  let refreshing = $state(false);
  async function refresh(): Promise<void> {
    if (refreshing) return;
    refreshing = true;
    try {
      await refreshMetrics();
    } catch (e) {
      lastError.set(message(e));
    }
    setTimeout(() => (refreshing = false), 500);
  }

  // Dashboard hotkeys (tech-gui.md §2): `r` refreshes metrics. This listener only exists
  // while the dashboard is mounted (the selector unmounts when a session is active), so
  // it never reaches terminal input. Suppressed while a host dialog owns the keyboard.
  function onKeydown(e: KeyboardEvent): void {
    if (dialog) return;
    if (isRefreshHotkey(e)) {
      e.preventDefault();
      void refresh();
    }
  }

  // Persist an add/edit, then reload so the merged cache + pollers pick it up
  // (`reload_hosts` broadcasts `hosts-loaded`). Throws propagate to the editor so a
  // failed save surfaces inline and keeps the form open.
  async function submit(input: HostInputDto, previousName: string | undefined): Promise<void> {
    // Adding: refuse a name already taken (a save would silently overwrite it). An
    // edit keeps its name (the name field is immutable, §4.1), so it can't collide.
    if (!previousName && get(hosts).some((h) => h.name === input.name)) {
      throw new Error(`A host named "${input.name}" already exists`);
    }
    await saveHost(input);
    await reloadHosts();
    dialog = null;
  }

  // Host-first auto key-setup (tech-gui.md §4.2). The icon button opens a small confirm
  // dialog asking whether to also disable password login once the key is verified —
  // that choice travels through to the backend so it can skip the sshd_config steps
  // entirely when declined. Confirming opens the progress panel immediately, then kicks
  // the backend flow; its progress/outcome arrive as `key-setup-*` events. A synchronous
  // reject (unknown host) closes the panel and surfaces the error.
  async function confirmKeySetup(host: HostDto): Promise<void> {
    const disable = disablePasswordAuth;
    dialog = null;
    beginKeySetup(host.name);
    try {
      await startKeySetup(host.name, disable);
    } catch (e) {
      dismissKeySetup();
      lastError.set(message(e));
    }
  }

  async function confirmDelete(name: string): Promise<void> {
    try {
      await deleteHost(name);
      await reloadHosts();
    } catch (e) {
      lastError.set(message(e));
    }
    dialog = null;
  }

  // Shared pill used by the header/empty-state "Add host" and the per-card quick actions.
  const pill =
    'inline-flex items-center gap-1.5 rounded-full border border-default px-2.5 py-1 text-xs ' +
    'font-medium text-muted transition hover:border-strong hover:bg-accent hover:text-accent-fg ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';
  const iconBtn =
    'grid h-7 w-7 place-items-center rounded-lg text-muted transition hover:bg-surface-inset ' +
    'hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';
  const roundBtn =
    'grid h-8 w-8 shrink-0 place-items-center rounded-full border border-default text-muted transition ' +
    'hover:border-strong hover:bg-accent hover:text-accent-fg ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';
  const search =
    'min-w-0 rounded-full bg-surface-inset py-1.5 text-sm text-fg outline-none transition-all duration-200 ' +
    'placeholder:text-faint focus-visible:ring-2 focus-visible:ring-focus';
</script>

<svelte:window onkeydown={onKeydown} />

<section class="min-h-full px-6 pb-8 pt-3">
  <div class="mb-5 flex items-center gap-3">
    <h1 class="text-lg font-semibold tracking-tight">Dashboard</h1>
    <div class="ml-auto flex items-center gap-2">
      <!-- Host search: a round toggle that slides a live filter field out to its left. -->
      <div class="flex items-center">
        <input
          bind:this={searchInput}
          bind:value={query}
          type="text"
          placeholder="Search hosts…"
          aria-label="Search hosts"
          disabled={!searchOpen}
          class="{search} {searchOpen
            ? 'mr-2 w-52 px-3 opacity-100'
            : 'pointer-events-none w-0 px-0 opacity-0'}"
          onkeydown={(e) => {
            if (e.key === 'Escape') toggleSearch();
          }}
        />
        <button
          type="button"
          class={roundBtn}
          title={searchOpen ? 'Close search' : 'Search hosts'}
          aria-label={searchOpen ? 'Close search' : 'Search hosts'}
          aria-expanded={searchOpen}
          onclick={toggleSearch}
        >
          <Icon name={searchOpen ? 'close' : 'search'} size={15} />
        </button>
      </div>
      <!-- Force an immediate metric refresh of every host, like the TUI's `r` (also the
           `r` hotkey). Spins while in flight for feedback. -->
      <button
        type="button"
        class="{roundBtn} disabled:opacity-60"
        title="Refresh metrics (R)"
        aria-label="Refresh metrics"
        disabled={refreshing}
        onclick={() => refresh()}
      >
        <span class="inline-flex {refreshing ? 'animate-spin' : ''}">
          <Icon name="refresh" size={15} />
        </span>
      </button>
      <button type="button" class={pill} onclick={() => (dialog = { kind: 'add' })}>
        <Icon name="plus" size={13} />
        Add host
      </button>
    </div>
  </div>

  <!-- This computer: the local shells, always first (a fixed section, not a folder). -->
  {#if visibleLocal.length > 0}
    {@render sectionHeader(LOCAL_KEY, 'This computer', visibleLocal.length, null)}
    {#if !isCollapsed(LOCAL_KEY)}
      <div class="mb-6 grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(12rem,1fr))]">
        {#each visibleLocal as shell (shell.id)}
          <button
            type="button"
            class="flex items-center gap-3 rounded-xl border border-default bg-surface px-4 py-3 text-left transition hover:border-strong hover:bg-surface-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            title="Open {shell.label} in a tab"
            onclick={() => spawnLocalTerminal(shell)}
          >
            <span class="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface-inset text-muted">
              <Icon name="terminal" size={15} />
            </span>
            <span class="min-w-0">
              <span class="block truncate text-sm font-medium">{shell.label}</span>
              <span class="block truncate text-xs text-faint">{shellKind(shell.kind)}</span>
            </span>
          </button>
        {/each}
      </div>
    {/if}
  {/if}

  {#if $serverCards.length === 0}
    <div class="flex flex-col items-center justify-center gap-2 py-20 text-center">
      <p class="font-medium">No servers yet</p>
      <p class="text-sm text-muted">Add a host, or import one from your SSH config, to see it here.</p>
      <button type="button" class="{pill} mt-2" onclick={() => (dialog = { kind: 'add' })}>
        <Icon name="plus" size={13} />
        Add host
      </button>
    </div>
  {:else if visibleCards.length === 0}
    <div class="flex flex-col items-center justify-center gap-2 py-20 text-center">
      <p class="text-sm text-muted">No hosts match “{query}”.</p>
    </div>
  {:else}
    {#each sections as section (section.key)}
      <!-- svelte-ignore a11y_no_static_element_interactions -- a drop zone for dragged
           cards; moving a host is also possible from its editor's Folder field. -->
      <div
        class="mb-6 rounded-xl transition {dropTarget === section.key ? 'bg-surface-inset/60 ring-2 ring-focus' : ''}"
        ondragover={(e) => onDragOver(e, section.key)}
        ondragleave={() => (dropTarget = dropTarget === section.key ? null : dropTarget)}
        ondrop={(e) => onDrop(e, section.folder)}
      >
        {@render sectionHeader(section.key, section.title, section.cards.length, section.folder)}
        {#if !isCollapsed(section.key)}
          <div class="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(19rem,1fr))]">
            {#each section.cards as card (card.host.name)}
              <div draggable="true" ondragstart={(e) => onDragStart(e, card.host.name)} ondragend={() => (dropTarget = null)} role="listitem">
                {@render hostCard(card)}
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/each}
  {/if}
</section>

{#snippet sectionHeader(key: string, title: string, count: number, folder: string | null)}
  <button
    type="button"
    class="mb-3 flex w-full items-center gap-2 rounded-lg px-1 py-1 text-left text-sm font-semibold text-muted transition hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
    aria-expanded={!isCollapsed(key)}
    title={query ? 'Showing every section while searching' : isCollapsed(key) ? `Show ${title}` : `Hide ${title}`}
    onclick={() => collapsedSections.toggle(key)}
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
{/snippet}

{#snippet hostCard(card: ServerCard)}
      <Surface class="flex flex-col gap-4 p-5">
        <!-- Drag handle: the whole card; dropped on another section it moves there. -->
        <!-- Identity, then the actions on their own row so the name and address
             stay readable at any card width (a full row instead of sharing it). -->
        <div class="flex flex-col gap-3">
          <div class="flex min-w-0 items-start gap-2.5">
            <span class="mt-1 shrink-0">
              <StatusDot status={card.overall} size={9} label="{card.host.name} status" />
            </span>
            <div class="min-w-0">
              <div class="flex min-w-0 items-center gap-2">
                <span class="truncate font-medium" title={card.host.name}>{card.host.name}</span>
                {#if card.host.source === 'sshConfig'}
                  <span
                    class="shrink-0 rounded-full border border-default px-1.5 py-0.5 text-[10px] text-faint"
                    title="Imported from ~/.ssh/config — editing saves your own copy, which takes priority"
                  >
                    ssh config
                  </span>
                {/if}
                <!-- Auth-state reflection (tech-gui.md §4.2): key-only once password
                     auth is disabled, otherwise a plain key badge when a key exists. -->
                {#if card.host.passwordAuthDisabled}
                  <span
                    class="inline-flex shrink-0 items-center gap-1 rounded-full border border-default px-1.5 py-0.5 text-[10px] text-faint"
                    title="Password authentication disabled — key only"
                  >
                    <Icon name="shield" size={10} />
                    key-only
                  </span>
                {:else if card.host.hasKey}
                  <span
                    class="inline-flex shrink-0 items-center gap-1 rounded-full border border-default px-1.5 py-0.5 text-[10px] text-faint"
                    title="Key authentication configured"
                  >
                    <Icon name="key" size={10} />
                    key
                  </span>
                {/if}
              </div>
              <div class="truncate font-mono text-xs text-faint">
                {addressLine(card.host, displayHostname(card.host.hostname, $streamerMode))}
              </div>
            </div>
          </div>
          <div class="flex flex-wrap items-center gap-1.5">
            {#each QUICK_ACTIONS as action (action.id)}
              <button
                type="button"
                class={pill}
                title="{action.label} on {card.host.name}"
                onclick={() => spawnSession(action.kind, card.host.name)}
              >
                <Icon name={action.kind} size={13} />
                {action.label}
              </button>
            {/each}
            <!-- Key setup stays manual-only even though edit no longer is: it records
                 `key_setup_date`/`password_auth_disabled` through `save_hosts`, which
                 keeps manual entries only — on an import that outcome would be dropped.
                 Adopt the host first, then set up its key. -->
            {#if card.host.source === 'manual' && !card.host.hasKey}
              <button
                type="button"
                class={iconBtn}
                title="Set up an SSH key for {card.host.name}"
                aria-label="Set up an SSH key for {card.host.name}"
                onclick={() => {
                  disablePasswordAuth = true;
                  dialog = { kind: 'keySetupConfirm', host: card.host };
                }}
              >
                <Icon name="key" size={14} />
              </button>
            {/if}
            <!-- Editing an import adopts it into hosts.toml (§4.2); ~/.ssh/config is
                 never written, so the action is offered whatever the source. Delete
                 stays manual-only: there is nothing of an import to remove here. -->
            <button
              type="button"
              class={iconBtn}
              title="Edit {card.host.name}"
              aria-label="Edit {card.host.name}"
              onclick={() => (dialog = { kind: 'edit', host: card.host })}
            >
              <Icon name="edit" size={14} />
            </button>
            {#if card.host.source === 'manual'}
              <button
                type="button"
                class={iconBtn}
                title="Delete {card.host.name}"
                aria-label="Delete {card.host.name}"
                onclick={() => (dialog = { kind: 'delete', host: card.host })}
              >
                <Icon name="trash" size={14} />
              </button>
            {/if}
          </div>
        </div>

        <!-- Reachability, live metrics, or an offline state -->
        {#if card.reachability}
          <div
            class="rounded-lg bg-surface-inset px-3 py-3 text-center text-xs"
            style="color: {statusToken(card.overall)};"
          >
            {card.reachability}{card.host.monitorPort ? ` · port ${card.host.monitorPort}` : ''}
          </div>
        {:else if card.offline}
          <div class="rounded-lg bg-surface-inset px-3 py-3 text-center text-xs text-faint">offline</div>
        {:else}
          <div class="space-y-2">
            {#each card.metricRows as row (row.label)}
              <div class="flex items-center gap-3">
                <span class="w-9 shrink-0 text-[11px] uppercase tracking-wider text-faint">{row.label}</span>
                <div class="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-inset">
                  {#if row.percent != null}
                    <div
                      class="h-full rounded-full"
                      style="width: {Math.min(row.percent, 100)}%; background-color: {statusToken(row.status)};"
                    ></div>
                  {/if}
                </div>
                <span
                  class="w-10 shrink-0 text-right text-xs tabular-nums {row.percent == null
                    ? 'text-faint'
                    : 'text-muted'}"
                >
                  {row.percent != null ? `${Math.round(row.percent)}%` : '—'}
                </span>
              </div>
            {/each}
          </div>

          {#if card.uptime || card.osInfo}
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
              {#if card.uptime}<span>up {card.uptime}</span>{/if}
              {#if card.uptime && card.osInfo}<span class="text-faint">·</span>{/if}
              {#if card.osInfo}<span class="min-w-0 truncate">{card.osInfo}</span>{/if}
            </div>
          {/if}

          {#if card.topProcesses.length}
            <ul class="space-y-1">
              {#each card.topProcesses as proc, p (p)}
                <li class="flex items-center justify-between gap-3 text-xs">
                  <span class="min-w-0 truncate font-mono text-muted">{proc.name}</span>
                  <span class="shrink-0 tabular-nums text-faint">{Math.round(proc.cpuPercent)}%</span>
                </li>
              {/each}
            </ul>
          {/if}
        {/if}

        <!-- Detected services -->
        {#if card.detectedServices.length}
          <div class="flex flex-wrap gap-1.5">
            {#each card.detectedServices as service (service.kind)}
              <Chip>{service.detail ? `${service.name} · ${service.detail}` : service.name}</Chip>
            {/each}
          </div>
        {:else if card.servicesError}
          <div class="text-xs text-faint">Service scan unavailable</div>
        {/if}
      </Surface>
{/snippet}

{#if dialog?.kind === 'add'}
  <HostEditor mode="add" initial={emptyForm()} onSubmit={submit} onCancel={() => (dialog = null)} />
{:else if dialog?.kind === 'edit'}
  {@const host = dialog.host}
  <HostEditor
    mode="edit"
    initial={formFromHost(host)}
    previousName={host.name}
    imported={host.source === 'sshConfig'}
    onSubmit={submit}
    onCancel={() => (dialog = null)}
  />
{:else if dialog?.kind === 'delete'}
  {@const host = dialog.host}
  <Modal label="Delete host" onClose={() => (dialog = null)}>
    <div class="space-y-3 px-5 py-4">
      <h2 class="text-sm font-semibold">Delete host</h2>
      <p class="text-sm text-muted">
        Delete “{host.name}”? This removes it from <span class="font-mono">hosts.toml</span>. If
        your SSH config defines the same name, it comes back as an import.
      </p>
      <div class="flex justify-end gap-2 pt-1">
        <Button variant="ghost" onclick={() => (dialog = null)}>Cancel</Button>
        <Button variant="primary" onclick={() => confirmDelete(host.name)}>Delete</Button>
      </div>
    </div>
  </Modal>
{:else if dialog?.kind === 'keySetupConfirm'}
  {@const host = dialog.host}
  <Modal label="Set up SSH key" onClose={() => (dialog = null)}>
    <div class="space-y-3 px-5 py-4">
      <h2 class="text-sm font-semibold">Set up an SSH key for {host.name}</h2>
      <p class="text-sm text-muted">
        Generates an Ed25519 key, copies it to the server, and verifies it works — nothing
        else changes until that's confirmed.
      </p>
      <div class="flex items-center justify-between gap-4">
        <div class="min-w-0">
          <p class="text-sm">Disable password login</p>
          <p class="text-xs text-muted">
            Once the key is verified, turn password authentication off on the server too.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={disablePasswordAuth}
          aria-label="Disable password login after setup"
          onclick={() => (disablePasswordAuth = !disablePasswordAuth)}
          class="relative h-6 w-11 shrink-0 rounded-full transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus {disablePasswordAuth
            ? 'bg-accent'
            : 'bg-surface-inset'}"
        >
          <span
            class="absolute top-0.5 h-5 w-5 rounded-full bg-surface shadow-soft transition-[left] {disablePasswordAuth
              ? 'left-[1.375rem]'
              : 'left-0.5'}"
          ></span>
        </button>
      </div>
      <div class="flex justify-end gap-2 pt-1">
        <Button variant="ghost" onclick={() => (dialog = null)}>Cancel</Button>
        <Button variant="primary" onclick={() => confirmKeySetup(host)}>Set up key</Button>
      </div>
    </div>
  </Modal>
{/if}
