<script lang="ts">
  // Left region (tech-gui.md §2): header (logo + collapse), the SSH/Remote Desktop
  // switch, that mode's entry points (selectors that hold a highlight, spawners that
  // open sessions), the sessions list, and the footer (palette + theme toggle, §5.1). The active
  // highlight is the brand's accent inversion, so exactly one filled row — a
  // selector or a session — is visible at any moment (the §2 invariant, made legible).
  import { onMount } from 'svelte';
  import { get } from 'svelte/store';
  import Logo from './Logo.svelte';
  import ThemeToggle from './ThemeToggle.svelte';
  import { Button, Icon, StatusDot, type IconName } from '$lib/theme';
  import { activeEntity } from '$lib/stores/activeEntity';
  import {
    sessions,
    sessionLabel,
    sessionTitle,
    sessionStatusDot,
    sessionIcon,
    type SessionKind
  } from '$lib/stores/sessions';
  import { sidebarCollapsed } from '$lib/stores/ui';
  import { sidebarMode, type SidebarMode } from '$lib/stores/sidebarMode';
  import { automationsTab } from '$lib/stores/automations';
  import { spawnSession, spawnLocalTerminal, closeSession } from '$lib/stores/navigation';
  import { terminalProfiles } from '$lib/ipc/commands';
  import { lastError } from '$lib/stores/notifications';
  import ContextMenu, { type ContextMenuItem } from './ContextMenu.svelte';
  import { palette } from '$lib/stores/palette';

  // The running version, shown beside the Settings gear (or in its tooltip when the
  // sidebar is collapsed). Absent outside Electron (tests, `vite preview`).
  let appVersion = $state<string | null>(null);
  onMount(() => {
    window.bsshClient
      ?.appVersion?.()
      .then((v) => (appVersion = v))
      .catch(() => {});
  });

  // Flipping the top switch swaps which selector/spawner rows show below it; an open
  // session (terminal/sftp) is never affected — only a currently-active selector
  // screen that doesn't exist in the new mode gets redirected to that mode's default.
  function setMode(mode: SidebarMode): void {
    sidebarMode.set(mode);
    const active = get(activeEntity);
    if (active.kind === 'session') return;
    if (mode === 'ssh') activeEntity.selectDashboard();
    else activeEntity.selectRemoteDesktop();
  }

  // Action-first spawn (tech-gui.md §2): a spawner opens the host-picker, then creates
  // a session of its kind for the chosen host. A dismissed picker spawns nothing.
  async function pickAndSpawn(kind: SessionKind): Promise<void> {
    const host = await palette.pickHost();
    if (host) spawnSession(kind, host.name);
  }

  // Local terminal: a shell on this machine rather than a host — PowerShell, Command
  // Prompt, a WSL distribution, zsh … (whatever core/local/profiles.ts finds here),
  // picked from a small menu beside the row, the way VS Code's terminal "+" offers them.
  let localMenu = $state<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);

  async function openLocalMenu(event: MouseEvent): Promise<void> {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    let items: ContextMenuItem[];
    try {
      const profiles = await terminalProfiles();
      items =
        profiles.length > 0
          ? profiles.map((p) => ({ label: p.label, icon: 'terminal' as const, onSelect: () => spawnLocalTerminal(p) }))
          : [{ label: 'No shells found on this computer', onSelect: () => {}, disabled: true }];
    } catch (err) {
      lastError.set(err instanceof Error ? err.message : String(err));
      return;
    }
    localMenu = { x: rect.right + 4, y: rect.top, items };
  }

  // Automations and Snippets are two entry points into the same screen — it already
  // switches between the automation list and the snippet library via `automationsTab`,
  // so the sidebar just picks which one opens, and the highlight follows that tab.
  type Selector = { kind: 'dashboard' | 'automations' | 'snippets' | 'remoteDesktop'; label: string; icon: IconName };
  type Spawner = { kind: SessionKind; label: string; icon: IconName };

  const sshSelectors: Selector[] = [
    { kind: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
    { kind: 'automations', label: 'Automations', icon: 'automations' },
    { kind: 'snippets', label: 'Snippets', icon: 'snippets' }
  ];

  function selectorActive(kind: Selector['kind']): boolean {
    if (kind === 'automations' || kind === 'snippets') {
      return $activeEntity.kind === 'automations' && $automationsTab === kind;
    }
    return $activeEntity.kind === kind;
  }

  function openSelector(kind: Selector['kind']): void {
    if (kind === 'dashboard') activeEntity.selectDashboard();
    else if (kind === 'remoteDesktop') activeEntity.selectRemoteDesktop();
    else {
      automationsTab.set(kind);
      activeEntity.selectAutomations();
    }
  }

  const remoteDesktopSelectors: Selector[] = [{ kind: 'remoteDesktop', label: 'Remote Desktop', icon: 'monitor' }];
  const selectors = $derived($sidebarMode === 'ssh' ? sshSelectors : remoteDesktopSelectors);
  const spawners: Spawner[] = [
    { kind: 'sftp', label: 'SFTP', icon: 'sftp' },
    { kind: 'terminal', label: 'Terminal', icon: 'terminal' }
  ];

  const rowBase = 'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition';
  // The ring belongs on the focusable element, so it is applied to buttons only —
  // never the session-row wrapper div, where :focus-visible can never match.
  const focusRing = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';
  const rowState = (active: boolean): string =>
    active ? 'bg-accent text-accent-fg' : 'text-muted hover:bg-surface-inset hover:text-fg';
</script>

<aside
  class="col-start-1 row-start-1 flex h-full flex-col overflow-hidden border-r border-default bg-surface pt-[var(--titlebar-h)]"
>
  <header
    class="flex items-center gap-2.5 px-3 py-4 {$sidebarCollapsed ? 'justify-center' : ''}"
  >
    {#if !$sidebarCollapsed}
      <Logo size={22} />
      <span class="flex-1 truncate text-sm font-bold tracking-wide">BetterSshClient</span>
    {/if}
    <Button
      variant="icon"
      title={$sidebarCollapsed ? 'Expand sidebar (⌘B)' : 'Collapse sidebar (⌘B)'}
      onclick={() => sidebarCollapsed.toggle()}
    >
      <Icon name={$sidebarCollapsed ? 'expand' : 'collapse'} />
    </Button>
  </header>

  <!-- Entry points stay pinned; only the sessions list scrolls (tech-gui.md §2). -->
  <nav class="flex min-h-0 flex-1 flex-col px-2 py-2">
    <!-- Top switch: swaps the SSH-centric app for the Remote Desktop area below.
         The open-sessions list further down is unaffected either way. -->
    <div class="shrink-0 pb-2">
      {#if $sidebarCollapsed}
        <button
          type="button"
          class="{rowBase} {focusRing} justify-center text-muted hover:bg-surface-inset hover:text-fg"
          title={$sidebarMode === 'ssh' ? 'Switch to Remote Desktop' : 'Switch to SSH'}
          onclick={() => setMode($sidebarMode === 'ssh' ? 'remoteDesktop' : 'ssh')}
        >
          <Icon name={$sidebarMode === 'ssh' ? 'monitor' : 'terminal'} />
        </button>
      {:else}
        <!-- Each segment is aria-labelled "Switch to …" rather than taking its name
             from the visible text: the Remote Desktop segment would otherwise share an
             accessible name with the selector row of the same label below it, leaving a
             screen reader with two identically-announced buttons that do different
             things. -->
        <div class="grid grid-cols-2 gap-1 rounded-lg bg-surface-inset p-1 text-xs font-medium">
          <button
            type="button"
            class="rounded-md px-2 py-1.5 transition {focusRing} {$sidebarMode === 'ssh'
              ? 'bg-accent text-accent-fg'
              : 'text-muted hover:text-fg'}"
            aria-label="Switch to SSH"
            aria-current={$sidebarMode === 'ssh' ? 'true' : undefined}
            onclick={() => setMode('ssh')}
          >
            SSH
          </button>
          <button
            type="button"
            class="rounded-md px-2 py-1.5 transition {focusRing} {$sidebarMode === 'remoteDesktop'
              ? 'bg-accent text-accent-fg'
              : 'text-muted hover:text-fg'}"
            aria-label="Switch to Remote Desktop"
            aria-current={$sidebarMode === 'remoteDesktop' ? 'true' : undefined}
            onclick={() => setMode('remoteDesktop')}
          >
            Remote Desktop
          </button>
        </div>
      {/if}
    </div>

    <ul class="shrink-0 space-y-1">
      {#each selectors as sel (sel.kind)}
        <li>
          <button
            type="button"
            class="{rowBase} {focusRing} {rowState(selectorActive(sel.kind))} {$sidebarCollapsed
              ? 'justify-center'
              : ''}"
            title={sel.label}
            aria-current={selectorActive(sel.kind) ? 'page' : undefined}
            onclick={() => openSelector(sel.kind)}
          >
            <Icon name={sel.icon} />
            {#if !$sidebarCollapsed}<span class="truncate">{sel.label}</span>{/if}
          </button>
        </li>
      {/each}
      {#if $sidebarMode === 'ssh'}
        {#each spawners as sp (sp.kind)}
          <li>
            <button
              type="button"
              class="{rowBase} {focusRing} {rowState(false)} {$sidebarCollapsed ? 'justify-center' : ''}"
              title={sp.label}
              onclick={() => pickAndSpawn(sp.kind)}
            >
              <Icon name={sp.icon} />
              {#if !$sidebarCollapsed}<span class="truncate">{sp.label}</span>{/if}
            </button>
          </li>
        {/each}
        <li>
          <button
            type="button"
            class="{rowBase} {focusRing} {rowState(false)} {$sidebarCollapsed ? 'justify-center' : ''}"
            title="Local terminal — a shell on this computer (PowerShell, cmd, WSL, …)"
            aria-haspopup="menu"
            onclick={openLocalMenu}
          >
            <Icon name="terminal" />
            {#if !$sidebarCollapsed}<span class="truncate">Local terminal</span>{/if}
          </button>
        </li>
      {/if}
    </ul>

    {#if $sessions.length > 0}
      <ul class="mt-2 min-h-0 flex-1 space-y-1 overflow-y-auto border-t border-default pt-2">
        {#each $sessions as s (s.id)}
          {@const active = $activeEntity.kind === 'session' && $activeEntity.id === s.id}
          <li>
            <div
              class="{rowBase} {rowState(active)} {$sidebarCollapsed ? 'justify-center' : 'pr-1'}"
            >
              <button
                type="button"
                class="flex min-w-0 items-center gap-2.5 rounded text-left {focusRing} {$sidebarCollapsed
                  ? ''
                  : 'flex-1'}"
                title={sessionTitle(s)}
                aria-label={sessionTitle(s)}
                aria-current={active ? 'true' : undefined}
                onclick={() => activeEntity.activateSession(s.id)}
              >
                {#if $sidebarCollapsed}
                  <span class="relative inline-flex shrink-0">
                    <Icon name={sessionIcon(s.kind)} />
                    <span class="absolute -right-1 -top-1">
                      <StatusDot status={sessionStatusDot[s.status]} size={7} />
                    </span>
                  </span>
                {:else}
                  <StatusDot status={sessionStatusDot[s.status]} />
                  <Icon name={sessionIcon(s.kind)} size={16} />
                  <span class="min-w-0 flex-1 truncate">{sessionLabel(s)}</span>
                {/if}
              </button>
              {#if !$sidebarCollapsed}
                <button
                  type="button"
                  class="shrink-0 rounded p-1 opacity-60 transition hover:opacity-100 {focusRing}"
                  title="Close {sessionLabel(s)}"
                  aria-label="Close {sessionLabel(s)}"
                  onclick={() => closeSession(s.id)}
                >
                  <Icon name="close" size={14} />
                </button>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </nav>

  <footer
    class="border-t border-default px-2 py-3 {$sidebarCollapsed
      ? 'flex flex-col items-center gap-1'
      : 'flex items-center gap-1'}"
  >
    <Button variant="icon" title="Command palette (⌘K)" onclick={() => palette.open()}>
      <Icon name="command" />
    </Button>
    <ThemeToggle />
    <!-- Settings is a selector-like screen; the gear holds the active highlight like
         Dashboard/Snippets do, and stays icon-only so it survives collapse (§5.1). -->
    <button
      type="button"
      class="grid h-9 w-9 place-items-center rounded-full transition {focusRing} {$activeEntity.kind ===
      'settings'
        ? 'bg-accent text-accent-fg'
        : 'text-muted hover:bg-surface-inset hover:text-fg'}"
      title={$sidebarCollapsed && appVersion ? `Settings · v${appVersion}` : 'Settings'}
      aria-label="Settings"
      aria-current={$activeEntity.kind === 'settings' ? 'page' : undefined}
      onclick={() => activeEntity.selectSettings()}
    >
      <Icon name="settings" />
    </button>
    {#if appVersion && !$sidebarCollapsed}
      <span
        class="ml-1 rounded-full border border-default px-2 py-0.5 font-mono text-[11px] text-faint"
        title="BetterSshClient v{appVersion}"
      >
        v{appVersion}
      </span>
    {/if}
  </footer>
</aside>

{#if localMenu}
  <ContextMenu x={localMenu.x} y={localMenu.y} items={localMenu.items} onClose={() => (localMenu = null)} />
{/if}
