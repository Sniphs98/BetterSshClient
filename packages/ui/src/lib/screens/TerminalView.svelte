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
  import { closeSession } from '$lib/stores/navigation';
  import { terminalDidExit } from '$lib/ipc/router';
  import { lastError } from '$lib/stores/notifications';
  import { terminalOpen, terminalWrite, terminalResize, terminalClose } from '$lib/ipc/commands';
  import { shouldFadeTop } from './terminalFade';
  import { chunkBytes } from './terminalInput';
  import { shellQuote } from './shellQuote';
  import { copySelection, isCopyChord, isMacPlatform, isPasteChord, pasteFromClipboard } from './terminalClipboard';
  import { terminalCopyOnSelect, terminalGpu, terminalRightClick } from '$lib/stores/terminalPrefs';
  import { followGpuPref } from './terminalRenderer';
  import ContextMenu, { type ContextMenuItem } from '$lib/components/ContextMenu.svelte';
  import { Channel, type TerminalBytes } from '$lib/bindings';

  let { session, active }: { session: Session; active: boolean } = $props();

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
      const id = await terminalOpen(session.hostName, term.cols || 80, term.rows || 24, channel);
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
      const host = get(hosts).find((h) => h.name === session.hostName);
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
      // PtyExited follows, so mark the tab failed here instead of leaving it hung.
      lastError.set(err instanceof Error ? err.message : String(err));
      sessions.setStatus(session.id, 'failed');
    });
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
</div>
{#if terminalMenu}
  <ContextMenu
    x={terminalMenu.x}
    y={terminalMenu.y}
    items={terminalMenu.items}
    onClose={() => (terminalMenu = null)}
  />
{/if}

<style>
  /* Scrolled output dissolves into the top edge instead of hard-clipping (on only while
     scrolled, so the first line stays crisp). black/transparent are mask alphas. */
  .term-fade {
    -webkit-mask-image: linear-gradient(to bottom, transparent, black 2.25rem);
    mask-image: linear-gradient(to bottom, transparent, black 2.25rem);
  }
</style>
