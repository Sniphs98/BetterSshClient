<script lang="ts">
  // A live terminal tab (tech-gui.md §3.1). One instance per terminal session, kept
  // mounted for the session's whole life — hidden, not destroyed, when another entity
  // is active — so scrollback and the byte stream survive tab switches. Raw output
  // arrives on a per-session channel (§3.3/§3.6); keystrokes/resizes go back over the
  // terminal commands. Subscribes to the theme store and re-themes live (§5.1).
  import '@xterm/xterm/css/xterm.css';
  import { onMount, onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import type { Terminal } from '@xterm/xterm';
  import type { FitAddon } from '@xterm/addon-fit';
  import { theme } from '$lib/stores/theme';
  import { xtermTheme } from '$lib/theme/terminalTheme';
  import { sessions, type Session } from '$lib/stores/sessions';
  import { hosts } from '$lib/stores/hosts';
  import { isOnePasswordReference } from './onePasswordRef';
  import { closeSession, spawnSession } from '$lib/stores/navigation';
  import { events, type SshConnectStageDto } from '$lib/bindings';
  import { streamerMode, displayHostname } from '$lib/stores/streamer';
  import { Icon } from '$lib/theme';
  import { displayReference } from './onePasswordRef';
  import { advance, sshConnectSteps, stageOfError, stepStatus, suggestedCommand } from './sshConnectSteps';
  import { terminalDidExit } from '$lib/ipc/router';
  import { lastError } from '$lib/stores/notifications';
  import { terminalOpen, terminalOpenLocal, terminalWrite, terminalResize, terminalClose } from '$lib/ipc/commands';
  import { shouldFadeTop } from './terminalFade';
  import { chunkBytes } from './terminalInput';
  import { shellQuote } from './shellQuote';
  import { copySelection, isCopyChord, isMacPlatform, isPasteChord, pasteFromClipboard } from './terminalClipboard';
  import { terminalCopyOnSelect, terminalGpu, terminalRightClick } from '$lib/stores/terminalPrefs';
  import { followGpuPref } from './terminalRenderer';
  import ContextMenu, { type ContextMenuItem } from '$lib/components/ContextMenu.svelte';
  import { Channel, type TerminalBytes } from '$lib/bindings';

  let { session, active }: { session: Session; active: boolean } = $props();

  const btn =
    'inline-flex items-center gap-1.5 rounded-full border border-default px-2.5 py-1 text-xs font-medium text-muted ' +
    'transition hover:border-strong hover:bg-accent hover:text-accent-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';

  // Connecting an SSH tab, step by step (the main process reports each as it's reached),
  // and where it stopped if it failed — shown over the terminal until the shell is open.
  // Shown only once connecting takes a moment, so a quick connection doesn't flash it.
  let connectPhase = $state<'connecting' | 'failed' | 'open'>('connecting');
  let connectStage = $state<SshConnectStageDto | null>(null);
  let connectError = $state('');
  let showConnecting = $state(false);
  let copied = $state(false);
  // A tab keeps its session for its whole life.
  // svelte-ignore state_referenced_locally
  const progressKey = `terminal-${session.id}`;
  const connectHost = $derived(session.localProfileId ? undefined : $hosts.find((h) => h.name === session.hostName));
  const connectSteps = $derived(
    connectHost
      ? sshConnectSteps(
          connectHost,
          `${displayHostname(connectHost.hostname, $streamerMode)}:${connectHost.portRef ? '…' : connectHost.port}`,
          displayReference(connectHost.user)
        )
      : []
  );
  const keygen = $derived(suggestedCommand(connectError));

  function tryAgain(): void {
    closeSession(session.id);
    spawnSession('terminal', session.hostName);
  }

  async function copyCommand(): Promise<void> {
    if (!keygen) return;
    await navigator.clipboard.writeText(keygen);
    copied = true;
    setTimeout(() => (copied = false), 1500);
  }

  // The Nerd Font families come after the generic `monospace`, not merely after the
  // named system ones: the named list is macOS/Windows-only, so on a Linux desktop a
  // patched font ahead of the generic would become the terminal's Latin face and size
  // its cell from itself. Per-character fallback continues past a generic family, so the
  // Private Use Area glyphs (starship, powerlevel10k, eza --icons) still reach the tail.
  // Within the tail, the single-width variants come first — Nerd Fonts v3 ships icons at
  // double width in the bare family and one cell wide in its `Mono` twin.
  const MONO =
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace, ' +
    '"Symbols Nerd Font Mono", "Symbols Nerd Font", "MesloLGS NF", ' +
    '"JetBrainsMono Nerd Font Mono", "JetBrainsMono Nerd Font", ' +
    '"Hack Nerd Font Mono", "Hack Nerd Font", ' +
    '"FiraCode Nerd Font Mono", "FiraCode Nerd Font"';
  // One encoder for the keystroke hot path instead of one per input event.
  const ENCODER = new TextEncoder();

  // A large paste arrives as one onData; sending it as a single number[] would freeze
  // the UI thread (§9). Split into bounded chunks and await each so paint yields between
  // them; a serialization chain keeps all input strictly in order across events.
  // Copy/paste: the chord depends on the platform, and copy has to read xterm's own
  // selection (see terminalClipboard.ts). Returning false from the custom handler keeps
  // the keystroke away from the shell; anything we don't claim falls through untouched,
  // so Ctrl+C still interrupts and Ctrl+V still reaches readline.
  const mac = isMacPlatform();
  function handleClipboardKey(event: KeyboardEvent): boolean {
    if (event.type !== 'keydown' || term === undefined) return true;
    if (isCopyChord(event, mac)) {
      if (!term.hasSelection()) return true;
      void copySelection(term).catch(() => {});
      return false;
    }
    if (isPasteChord(event, mac)) {
      void pasteFromClipboard(term).catch((err) => lastError.set(err instanceof Error ? err.message : String(err)));
      return false;
    }
    return true;
  }

  // Marking text copies it straight away, the way PuTTY and most X11 terminals behave
  // — off via Settings for anyone who'd rather keep their clipboard.
  function handleSelectionChange(): void {
    if (!$terminalCopyOnSelect || term === undefined || !term.hasSelection()) return;
    void copySelection(term).catch(() => {});
  }

  // Right-click either pastes outright (PuTTY) or opens a small menu — a setting,
  // since which one feels right is a matter of which terminal you grew up with.
  let terminalMenu = $state<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);

  function pasteIntoTerm(): void {
    if (term === undefined) return;
    void pasteFromClipboard(term).catch((err) =>
      lastError.set(err instanceof Error ? err.message : String(err))
    );
  }

  function handleContextMenu(event: MouseEvent): void {
    if (term === undefined) return;
    event.preventDefault();
    if ($terminalRightClick === 'paste') {
      pasteIntoTerm();
      return;
    }
    const hasSelection = term.hasSelection();
    terminalMenu = {
      x: event.clientX,
      y: event.clientY,
      items: [
        {
          label: 'Copy',
          icon: 'file',
          disabled: !hasSelection,
          onSelect: () => {
            if (term) void copySelection(term).catch(() => {});
          }
        },
        { label: 'Paste', icon: 'upload', onSelect: pasteIntoTerm }
      ]
    };
  }

  let writeChain: Promise<void> = Promise.resolve();
  function sendInput(bytes: Uint8Array): void {
    if (termId == null || bytes.length === 0) return;
    writeChain = writeChain.then(async () => {
      for (const chunk of chunkBytes(bytes)) {
        if (destroyed || termId == null) return;
        try {
          await terminalWrite(termId, chunk);
        } catch {
          // Stop this input on a write failure rather than sending a gapped stream.
          return;
        }
      }
    });
  }

  let container: HTMLDivElement;
  let term: Terminal | undefined;
  let fitAddon: FitAddon | undefined;
  let termId: number | undefined;
  let destroyed = false;
  let connected = false;
  let ready = $state(false);
  let themeUnsub: (() => void) | undefined;
  let gpuUnsub: (() => void) | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let fitScheduled = false;
  // The top-edge fade dissolves scrolled output into the top edge, but never the live
  // prompt: after `clear`/Ctrl+L the cursor homes to the top, so the fade must lift
  // there (see terminalFade). Recomputed after every write too, since those resets
  // move the viewport without firing onScroll.
  let scrolled = $state(false);
  function syncScrolled(): void {
    const buf = term?.buffer.active;
    scrolled = !!buf && shouldFadeTop(buf.viewportY, buf.baseY, buf.cursorY);
  }

  /** Fit the terminal to its container and tell the backend, but only while visible —
   *  a hidden (display:none) container measures 0, so it refits when shown instead. */
  function safeFit(): void {
    if (!term || !fitAddon || !active) return;
    try {
      fitAddon.fit();
    } catch {
      return;
    }
    if (termId != null) void terminalResize(termId, term.cols, term.rows).catch(() => {});
  }

  function scheduleFit(): void {
    if (fitScheduled) return;
    fitScheduled = true;
    requestAnimationFrame(() => {
      fitScheduled = false;
      safeFit();
    });
  }

  onMount(() => {
    let stopProgress: (() => void) | undefined;
    const showTimer = setTimeout(() => (showConnecting = true), 400);
    if (!session.localProfileId) {
      events.sshConnectProgress
        .listen((e) => {
          if (e.payload.key === progressKey) connectStage = advance(connectSteps, connectStage, e.payload.stage);
        })
        .then((off) => (destroyed ? off() : (stopProgress = off)))
        .catch(() => {
          // No Electron bridge (tests): the steps just don't advance on their own.
        });
    }
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit')
      ]);
      if (destroyed) return;

      term = new Terminal({
        fontFamily: MONO,
        fontSize: 13,
        cursorBlink: true,
        scrollback: 5000
      });
      fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(container);
      gpuUnsub = followGpuPref(term, terminalGpu);
      term.onScroll(syncScrolled);

      // The #1 theme-regression guard (§5.1): push the matching xterm theme to this
      // terminal — including already-open ones — whenever the store flips. Its
      // synchronous first call (pre-paint) also sets the initial theme.
      themeUnsub = theme.subscribe((t) => {
        if (term) term.options.theme = xtermTheme(t);
      });

      // Route raw output into xterm. The channel is typed `number[]`, but the raw path
      // actually delivers an `ArrayBuffer` (§3.3); `Uint8Array` wraps either.
      const channel = new Channel<TerminalBytes>();
      channel.onmessage = (msg) => {
        if (!term) return;
        if (!connected) {
          connected = true;
          sessions.setStatus(session.id, 'connected');
        }
        term.write(new Uint8Array(msg as unknown as ArrayBuffer), syncScrolled);
      };

      // Fit before opening so the remote PTY starts at the visible size.
      safeFit();
      // A local tab is a shell on this machine (its profile), not a host.
      const id = session.localProfileId
        ? await terminalOpenLocal(session.localProfileId, term.cols || 80, term.rows || 24, channel)
        : await terminalOpen(session.hostName, term.cols || 80, term.rows || 24, channel, progressKey);
      connectPhase = 'open';
      clearTimeout(showTimer);
      stopProgress?.();
      if (destroyed) {
        void terminalClose(id).catch(() => {});
        return;
      }
      termId = id;
      sessions.setTermId(session.id, id);
      // The remote may have already exited before this id was recorded (fast-fail
      // connect race): terminal-exited couldn't match the tab, so close it now.
      if (terminalDidExit(id)) {
        closeSession(session.id);
        return;
      }

      // The host's configured default path (tech-gui.md §4.1 — SFTP already opens
      // there; a fresh terminal cd's into it too), same technique as
      // SftpTerminalDrawer.svelte: queued by the pty until the shell is ready to read
      // it, no race with the shell's own startup.
      const host = session.localProfileId ? undefined : get(hosts).find((h) => h.name === session.hostName);
      // A 1Password reference can't be typed as a path; the backend read it and
      // started the shell there already.
      if (host?.defaultPath && !isOnePasswordReference(host.defaultPath)) sendInput(ENCODER.encode(`cd ${shellQuote(host.defaultPath)}\n`));
      // The host's startup command, typed in after that `cd` — visible in the terminal and
      // its history, exactly as if the user had entered it.
      if (host?.startupCommand) sendInput(ENCODER.encode(`${host.startupCommand}\n`));

      // Text keystrokes/paste are UTF-8; onBinary carries raw 8-bit sequences
      // (e.g. legacy mouse reporting) that must go byte-for-byte, not re-encoded.
      term.attachCustomKeyEventHandler(handleClipboardKey);
      term.onSelectionChange(handleSelectionChange);
      term.onData((data) => sendInput(ENCODER.encode(data)));
      term.onBinary((data) => sendInput(Uint8Array.from(data, (ch) => ch.charCodeAt(0) & 0xff)));

      resizeObserver = new ResizeObserver(() => scheduleFit());
      resizeObserver.observe(container);

      ready = true;
      if (active) term.focus();
    })().catch((err) => {
      // `terminal_open` itself failed (e.g. the session could not be spawned): no
      // PtyExited follows, so mark the tab failed here instead of leaving it hung. An SSH
      // tab says where and why on its own screen; a local one in the status bar.
      const message = err instanceof Error ? err.message : String(err);
      if (session.localProfileId) lastError.set(message);
      connectError = message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      // The error says where it stopped, also when no step was reported (the tab joined a
      // connection the dashboard was already making).
      const failedAt = stageOfError(connectError);
      if (failedAt) connectStage = advance(connectSteps, connectStage, failedAt);
      connectPhase = 'failed';
      showConnecting = true;
      clearTimeout(showTimer);
      stopProgress?.();
      sessions.setStatus(session.id, 'failed');
    });
    return () => {
      clearTimeout(showTimer);
      stopProgress?.();
    };
  });

  onDestroy(() => {
    destroyed = true;
    themeUnsub?.();
    gpuUnsub?.();
    resizeObserver?.disconnect();
    // Idempotent: a remote-exit teardown already dropped this id backend-side (§3.4).
    if (termId != null) void terminalClose(termId).catch(() => {});
    term?.dispose();
    // Null it so a byte still in flight (destroyed-before-open race) can't write to
    // a disposed terminal — the channel callback's `if (!term)` guard then bails.
    term = undefined;
  });

  // Becoming visible: a hidden container measured 0, so refit and take focus.
  $effect(() => {
    if (active && ready) {
      requestAnimationFrame(() => {
        safeFit();
        term?.focus();
        syncScrolled();
      });
    }
  });
</script>

<!-- bg-surface fills behind the macOS traffic lights (no seam). Text selection stays
     disabled app-wide (app.css); the terminal is the one selectable surface, handled
     by xterm's own selection (not CSS). -->
<div class="absolute inset-0 overflow-hidden bg-surface {active ? '' : 'hidden'}">
  <!-- Inset via this wrapper, not the xterm host: padding on the element xterm mounts
       into makes FitAddon over-size, sliding the last row under the status bar. The top
       inset clears the macOS traffic-light strip; the bottom gap clears the footer. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -- the terminal's own keyboard
       handling lives in xterm; this only replaces the browser's context menu. -->
  <div
    class="h-full w-full"
    style="padding: max(var(--titlebar-h), 0.75rem) 0.5rem 1rem;"
    oncontextmenu={handleContextMenu}
  >
    <div bind:this={container} class="h-full w-full" class:term-fade={scrolled}></div>
  </div>

  {#if !session.localProfileId && connectPhase !== 'open' && showConnecting}
    <div class="absolute inset-0 z-20 grid place-items-center bg-surface p-6" style="padding-top: var(--titlebar-h);">
      <div class="w-full max-w-md space-y-3 text-center">
        <p class="font-medium">
          {connectPhase === 'failed' ? `Could not connect to ${session.hostName}` : `Connecting to ${session.hostName}`}
        </p>
        {#if connectPhase === 'connecting'}
          <div class="connect-bar mx-auto h-1 w-56 overflow-hidden rounded-full bg-surface-inset" aria-hidden="true"></div>
        {/if}
        <ol class="mx-auto w-72 space-y-2 pt-2 text-left text-sm" aria-label="Connection steps">
          {#each connectSteps as step, i (step.stage)}
            {@const status = stepStatus(connectSteps, connectStage, i, connectPhase === 'failed')}
            <li class="flex items-center gap-2.5 {status === 'pending' ? 'text-faint' : status === 'done' ? 'text-muted' : 'text-fg'}" data-status={status}>
              <span class="grid h-4 w-4 shrink-0 place-items-center">
                {#if status === 'done'}
                  <span class="step-in text-status-ok"><Icon name="check" size={14} /></span>
                {:else if status === 'active'}
                  <span class="spinner h-3.5 w-3.5 rounded-full border-2 border-[var(--border)] border-t-[var(--accent)]"></span>
                {:else if status === 'failed'}
                  <span class="step-in text-status-crit"><Icon name="close" size={14} /></span>
                {:else}
                  <span class="h-1.5 w-1.5 rounded-full bg-[var(--border)]"></span>
                {/if}
              </span>
              <span class="min-w-0 flex-1 truncate">{step.label}</span>
            </li>
          {/each}
        </ol>
        {#if connectPhase === 'failed'}
          <p class="rounded-lg bg-surface-inset px-3 py-2 text-left text-sm text-muted" role="alert">{connectError}</p>
          <div class="flex flex-wrap justify-center gap-2 pt-1">
            {#if keygen}
              <button type="button" class={btn} onclick={() => void copyCommand()} title={keygen}>
                {copied ? 'Copied' : 'Copy the ssh-keygen command'}
              </button>
            {/if}
            <button type="button" class={btn} onclick={tryAgain}>
              <Icon name="refresh" size={12} />
              Try again
            </button>
            <button type="button" class={btn} onclick={() => closeSession(session.id)}>Close tab</button>
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>
{#if terminalMenu}
  <ContextMenu
    x={terminalMenu.x}
    y={terminalMenu.y}
    items={terminalMenu.items}
    onClose={() => {
      terminalMenu = null;
      // Back to the terminal, so typing (or Enter after a paste) goes to the shell.
      term?.focus();
    }}
  />
{/if}

<style>
  .spinner {
    animation: spin 0.8s linear infinite;
  }
  .step-in {
    animation: pop 0.25s ease-out;
  }
  .connect-bar {
    position: relative;
  }
  .connect-bar::after {
    content: '';
    position: absolute;
    inset: 0;
    width: 40%;
    border-radius: 9999px;
    background: var(--accent);
    animation: sweep 1.4s ease-in-out infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @keyframes pop {
    from {
      transform: scale(0.4);
      opacity: 0;
    }
  }
  @keyframes sweep {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(250%);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .spinner,
    .step-in,
    .connect-bar::after {
      animation: none;
    }
  }
  /* Scrolled output dissolves into the top edge instead of hard-clipping (on only while
     scrolled, so the first line stays crisp). black/transparent are mask alphas. */
  .term-fade {
    -webkit-mask-image: linear-gradient(to bottom, transparent, black 2.25rem);
    mask-image: linear-gradient(to bottom, transparent, black 2.25rem);
  }
</style>
