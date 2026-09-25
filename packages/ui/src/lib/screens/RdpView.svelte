<script lang="ts">
  // A remote desktop inside the app, as a tab (like Terminal/SFTP): IronRDP's web client
  // (`<iron-remote-desktop>`, Rust compiled to WebAssembly) talking to the RDP server
  // through the main process's local gateway (core/rdp/gateway.ts). Kept mounted while
  // other tabs are shown, so the session keeps running. The external client
  // (mstsc/FreeRDP) stays one click away.
  import { onDestroy, onMount } from 'svelte';
  import { sessions, type Session } from '$lib/stores/sessions';
  import { closeSession } from '$lib/stores/navigation';
  import { remoteDesktopConnections } from '$lib/stores/remoteDesktop';
  import { lastError } from '$lib/stores/notifications';
  import { rdpEmbeddedClose, rdpEmbeddedOpen, rdpEmbeddedStatus, rdpForgetCertificate, rdpLaunch } from '$lib/ipc/commands';
  import { Icon } from '$lib/theme';
  import { explainRdpError, loadIronRdp, type IronUserInteraction } from './rdpEmbedded';

  let { session, active }: { session: Session; active: boolean } = $props();

  let viewport = $state<HTMLDivElement>();
  let phase = $state<'connecting' | 'credentials' | 'connected' | 'ended' | 'failed'>('connecting');
  // Asked for in the tab when the profile doesn't store them; kept only for reconnects
  // of this tab, never saved.
  let credentials = $state<{ username: string; password: string; domain: string } | null>(null);
  let form = $state({ username: '', password: '', domain: '' });
  let passwordEl = $state<HTMLInputElement>();
  let problem = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let certificateChanged = $state(false);

  let ui: IronUserInteraction | undefined;
  let token: string | undefined;
  let element: HTMLElement | undefined;
  let destroyed = false;
  let resizeObserver: ResizeObserver | undefined;
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;

  const connection = $derived($remoteDesktopConnections.find((c) => c.id === session.rdpConnectionId));

  /** The viewport in device pixels, even (RDP wants an even width), within RDP's limits. */
  function viewportSize(): { width: number; height: number } {
    const rect = viewport?.getBoundingClientRect();
    const clamp = (n: number): number => Math.max(200, Math.min(8192, Math.floor(n / 2) * 2));
    return { width: clamp(rect?.width ?? 1280), height: clamp(rect?.height ?? 720) };
  }

  async function connect(): Promise<void> {
    if (!viewport || !session.rdpConnectionId) return;
    phase = 'connecting';
    problem = null;
    certificateChanged = false;
    sessions.setStatus(session.id, 'connecting');
    try {
      const { Backend, displayControl } = await loadIronRdp();
      if (destroyed) return;

      element?.remove();
      element = document.createElement('iron-remote-desktop');
      const props = element as unknown as Record<string, unknown>;
      props.module = Backend;
      props.scale = 'fit';
      props.flexcenter = 'true';
      props.verbose = 'false';
      const ready = new Promise<IronUserInteraction>((resolve) =>
        element!.addEventListener('ready', (e) => resolve((e as CustomEvent).detail.irgUserInteraction), { once: true })
      );
      viewport.appendChild(element);
      ui = await ready;
      if (destroyed) return;

      // A plain copy: a reactive proxy can't be sent over IPC.
      const opened = await rdpEmbeddedOpen(session.rdpConnectionId, credentials ? $state.snapshot(credentials) : undefined);
      if (destroyed) return;
      if (opened.kind === 'credentials') {
        form = { username: opened.username ?? '', password: '', domain: opened.domain ?? '' };
        phase = 'credentials';
        sessions.setStatus(session.id, 'unknown');
        requestAnimationFrame(() => passwordEl?.focus());
        return;
      }
      const dto = opened;
      token = dto.token;
      ui.setEnableClipboard(connection?.clipboard !== false);
      ui.setEnableAutoClipboard(connection?.clipboard !== false);
      const config = ui
        .configBuilder()
        .withUsername(dto.username)
        .withPassword(dto.password)
        .withDestination(dto.destination)
        .withProxyAddress(dto.proxyUrl)
        .withAuthToken(dto.token)
        .withServerDomain(dto.domain ?? '')
        .withDesktopSize(viewportSize())
        // Lets the window resize the remote desktop instead of scaling it.
        .withExtension(displayControl(true))
        .build();

      const info = await ui.connect(config);
      if (destroyed) return;
      phase = 'connected';
      sessions.setStatus(session.id, 'connected');
      ui.setVisibility(true);
      const status = await rdpEmbeddedStatus(dto.token).catch(() => undefined);
      notice = status?.notice ?? null;
      focus();

      const end = await info.run();
      if (destroyed) return;
      phase = 'ended';
      problem = end.reason() || null;
      sessions.setStatus(session.id, 'unknown');
    } catch (err) {
      if (destroyed) return;
      const status = token ? await rdpEmbeddedStatus(token).catch(() => undefined) : undefined;
      problem = explainRdpError(err, status?.failure ?? undefined);
      // Wrong typed credentials: ask again rather than keep failing with them.
      if (credentials && /username or password/.test(problem)) credentials = null;
      certificateChanged = /certificate has changed/.test(problem);
      phase = 'failed';
      sessions.setStatus(session.id, 'failed');
    } finally {
      if (token && phase !== 'connected') {
        void rdpEmbeddedClose(token).catch(() => {});
        token = undefined;
      }
    }
  }

  function focus(): void {
    requestAnimationFrame(() => (element?.shadowRoot?.querySelector('canvas') as HTMLElement | null)?.focus());
  }

  // Following the tab's size: the server changes its resolution (display control).
  function scheduleResize(): void {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (phase !== 'connected' || !ui || !active) return;
      const { width, height } = viewportSize();
      ui.resize(width, height);
    }, 250);
  }

  function signIn(event: SubmitEvent): void {
    event.preventDefault();
    if (!form.username.trim() || !form.password) return;
    credentials = { username: form.username.trim(), password: form.password, domain: form.domain.trim() };
    void connect();
  }

  async function openExternally(): Promise<void> {
    if (!session.rdpConnectionId) return;
    try {
      await rdpLaunch(session.rdpConnectionId);
    } catch (e) {
      lastError.set(e instanceof Error ? e.message : String(e));
    }
  }

  async function trustNewCertificate(): Promise<void> {
    if (!session.rdpConnectionId) return;
    await rdpForgetCertificate(session.rdpConnectionId);
    void connect();
  }

  onMount(() => {
    resizeObserver = new ResizeObserver(scheduleResize);
    if (viewport) resizeObserver.observe(viewport);
    void connect();
  });

  onDestroy(() => {
    destroyed = true;
    clearTimeout(resizeTimer);
    resizeObserver?.disconnect();
    try {
      ui?.shutdown();
    } catch {
      // already gone
    }
    if (token) void rdpEmbeddedClose(token).catch(() => {});
    element?.remove();
  });

  $effect(() => {
    if (active && phase === 'connected') {
      scheduleResize();
      focus();
    }
  });

  const field =
    'w-full rounded-lg bg-surface-inset px-3 py-2 text-sm text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus placeholder:text-faint';
  const btn =
    'inline-flex items-center gap-1.5 rounded-full border border-default px-2.5 py-1 text-xs font-medium text-muted ' +
    'transition hover:border-strong hover:bg-accent hover:text-accent-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';
</script>

<div class="absolute inset-0 flex flex-col bg-surface {active ? '' : 'hidden'}" style="padding-top: var(--titlebar-h);">
  <div class="flex shrink-0 items-center gap-2 border-b border-default px-4 py-2 text-xs">
    <Icon name="monitor" size={14} />
    <span class="font-medium">{session.hostName}</span>
    <span class="text-faint">
      {phase === 'connecting'
        ? 'Connecting…'
        : phase === 'credentials'
          ? 'Sign in'
          : phase === 'connected'
            ? 'Connected'
            : phase === 'ended'
              ? 'Session ended'
              : 'Failed'}
    </span>
    <div class="ml-auto flex items-center gap-1.5">
      {#if phase === 'connected'}
        <button type="button" class={btn} title="Send Ctrl+Alt+Del" onclick={() => ui?.ctrlAltDel()}>Ctrl+Alt+Del</button>
      {:else if phase !== 'connecting' && phase !== 'credentials'}
        <button type="button" class={btn} onclick={() => connect()}>
          <Icon name="refresh" size={12} />
          Reconnect
        </button>
      {/if}
      <button type="button" class={btn} title="Open in the Remote Desktop app instead" onclick={openExternally}>
        <Icon name="upload" size={12} />
        Open externally
      </button>
      <button type="button" class={btn} title="Close this tab" onclick={() => closeSession(session.id)}>
        <Icon name="close" size={12} />
      </button>
    </div>
  </div>

  {#if notice && phase === 'connected'}
    <div class="flex shrink-0 items-center gap-2 bg-surface-inset px-4 py-1.5 text-xs text-muted" role="status">
      <span class="min-w-0 flex-1 truncate">{notice}</span>
      <button type="button" class="text-faint hover:text-fg" aria-label="Dismiss" onclick={() => (notice = null)}>
        <Icon name="close" size={12} />
      </button>
    </div>
  {/if}

  <div class="relative min-h-0 flex-1 overflow-hidden bg-black">
    <div bind:this={viewport} class="rdp-viewport absolute inset-0"></div>
    {#if phase !== 'connected'}
      <div class="absolute inset-0 grid place-items-center bg-surface p-6">
        <div class="max-w-md space-y-3 text-center">
          {#if phase === 'connecting'}
            <p class="text-sm text-muted">Connecting to {session.hostName}…</p>
          {:else if phase === 'credentials'}
            <form class="w-80 space-y-3 text-left" onsubmit={signIn}>
              <p class="text-center font-medium">Sign in to {session.hostName}</p>
              <label class="block space-y-1 text-xs font-medium text-muted">
                <span>Username</span>
                <input bind:value={form.username} class={field} autocomplete="off" />
              </label>
              <label class="block space-y-1 text-xs font-medium text-muted">
                <span>Password</span>
                <input bind:this={passwordEl} bind:value={form.password} type="password" class={field} autocomplete="off" />
              </label>
              <label class="block space-y-1 text-xs font-medium text-muted">
                <span>Domain</span>
                <input bind:value={form.domain} class={field} placeholder="Optional" autocomplete="off" />
              </label>
              <p class="text-xs text-faint">Used for this connection only, not saved.</p>
              <div class="flex justify-center gap-2 pt-1">
                <button type="submit" class={btn} disabled={!form.username.trim() || !form.password}>Connect</button>
                <button type="button" class={btn} onclick={openExternally}>Open in the Remote Desktop app</button>
              </div>
            </form>
          {:else}
            <p class="font-medium">{phase === 'ended' ? 'The session has ended' : 'Could not connect'}</p>
            {#if problem}<p class="text-sm text-muted">{problem}</p>{/if}
            <div class="flex flex-wrap justify-center gap-2 pt-1">
              {#if certificateChanged}
                <button type="button" class={btn} onclick={trustNewCertificate}>Trust new certificate</button>
              {/if}
              <button type="button" class={btn} onclick={() => connect()}>
                <Icon name="refresh" size={12} />
                Reconnect
              </button>
              <button type="button" class={btn} onclick={openExternally}>Open in the Remote Desktop app</button>
            </div>
          {/if}
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .rdp-viewport :global(iron-remote-desktop) {
    display: block;
    width: 100%;
    height: 100%;
  }
</style>
