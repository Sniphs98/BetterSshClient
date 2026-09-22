<script lang="ts">
  // A standalone terminal, not a sidebar tab — the SFTP view's "drop a shell in here"
  // drawer (tech-gui.md §3.2 extension). Mirrors TerminalView.svelte's xterm wiring
  // (same fit/resize/theme/input handling) but has no `sessions` entry: it's mounted
  // only while the drawer is open, and closing the drawer really closes the shell
  // (`terminalClose`) rather than hiding a persistent tab — reopening starts fresh, cd'd
  // into whatever the current remote directory is *then*. Because it isn't a tab,
  // `applyTerminalExited` (router.ts) can't find it in `sessions` to close it; it
  // instead notifies via `onOrphanTerminalExit`, registered right after `terminalOpen`
  // resolves with this instance's id (same fast-fail-race handling `terminalDidExit`
  // gives real tabs).
  import '@xterm/xterm/css/xterm.css';
  import { onMount, onDestroy } from 'svelte';
  import type { Terminal } from '@xterm/xterm';
  import type { FitAddon } from '@xterm/addon-fit';
  import { theme } from '$lib/stores/theme';
  import { xtermTheme } from '$lib/theme/terminalTheme';
  import { onOrphanTerminalExit, offOrphanTerminalExit } from '$lib/ipc/router';
  import { lastError } from '$lib/stores/notifications';
  import { terminalOpen, terminalWrite, terminalResize, terminalClose } from '$lib/ipc/commands';
  import { shouldFadeTop } from './terminalFade';
  import { chunkBytes } from './terminalInput';
  import { shellQuote } from './shellQuote';
  import { copySelection, isCopyChord, isMacPlatform, isPasteChord, pasteFromClipboard } from './terminalClipboard';
  import { terminalCopyOnSelect, terminalRightClick } from '$lib/stores/terminalPrefs';
  import ContextMenu, { type ContextMenuItem } from '$lib/components/ContextMenu.svelte';
  import { Channel, type TerminalBytes } from '$lib/bindings';

  let { hostName, cwd }: { hostName: string; cwd: string } = $props();

  const MONO =
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace, ' +
    '"Symbols Nerd Font Mono", "Symbols Nerd Font", "MesloLGS NF", ' +
    '"JetBrainsMono Nerd Font Mono", "JetBrainsMono Nerd Font", ' +
    '"Hack Nerd Font Mono", "Hack Nerd Font", ' +
    '"FiraCode Nerd Font Mono", "FiraCode Nerd Font"';
  const ENCODER = new TextEncoder();

  // Set when a command arrives before the shell exists; flushed right after the
  // opening `cd`. Only ever one — a second pick before the first has even connected
  // replaces it rather than queueing a pile-up the user didn't ask for.
  let queuedCommand: string | undefined;

  /** Types `command` into this shell as if the user had, then presses Enter. Used by
   *  SftpView's "run a snippet here" — the drawer may still be connecting, so this
   *  queues rather than dropping the command. */
  export function runCommand(command: string): void {
    if (termId == null) {
      queuedCommand = command;
      return;
    }
    sendInput(ENCODER.encode(`${command}\n`));
  }

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
          await terminalWrite(termId, Array.from(chunk));
        } catch {
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
  let ready = $state(false);
  let exited = $state(false);
  let themeUnsub: (() => void) | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let fitScheduled = false;
  let scrolled = $state(false);
  function syncScrolled(): void {
    const buf = term?.buffer.active;
    scrolled = !!buf && shouldFadeTop(buf.viewportY, buf.baseY, buf.cursorY);
  }

  function safeFit(): void {
    if (!term || !fitAddon) return;
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
      term.onScroll(syncScrolled);

      themeUnsub = theme.subscribe((t) => {
        if (term) term.options.theme = xtermTheme(t);
      });

      const channel = new Channel<TerminalBytes>();
      channel.onmessage = (msg) => {
        term?.write(new Uint8Array(msg as unknown as ArrayBuffer), syncScrolled);
      };

      safeFit();
      const id = await terminalOpen(hostName, term.cols || 80, term.rows || 24, channel);
      if (destroyed) {
        void terminalClose(id).catch(() => {});
        return;
      }
      termId = id;
      onOrphanTerminalExit(id, () => {
        exited = true;
      });

      // Queued by the pty until the shell is ready to read it — no race with the
      // shell's own startup (same reasoning a `ssh host 'cd X && bash'` relies on).
      sendInput(ENCODER.encode(`cd ${shellQuote(cwd)}\n`));
      // A snippet the user picked while this shell was still connecting (opening the
      // drawer and running are one gesture — see SftpView's runSnippetHere), sent
      // after the cd so it runs in the directory they were looking at.
      if (queuedCommand !== undefined) {
        sendInput(ENCODER.encode(`${queuedCommand}\n`));
        queuedCommand = undefined;
      }

      term.attachCustomKeyEventHandler(handleClipboardKey);
      term.onSelectionChange(handleSelectionChange);
      term.onData((data) => sendInput(ENCODER.encode(data)));
      term.onBinary((data) => sendInput(Uint8Array.from(data, (ch) => ch.charCodeAt(0) & 0xff)));

      resizeObserver = new ResizeObserver(() => scheduleFit());
      resizeObserver.observe(container);

      ready = true;
      term.focus();
    })().catch((err) => {
      lastError.set(err instanceof Error ? err.message : String(err));
      exited = true;
    });
  });

  onDestroy(() => {
    destroyed = true;
    themeUnsub?.();
    resizeObserver?.disconnect();
    if (termId != null) {
      offOrphanTerminalExit(termId);
      void terminalClose(termId).catch(() => {});
    }
    term?.dispose();
    term = undefined;
  });
</script>

<div class="relative h-full w-full overflow-hidden bg-surface">
  <!-- svelte-ignore a11y_no_static_element_interactions -- see TerminalView: this only
       replaces the browser's context menu over the terminal surface. -->
  <div class="h-full w-full px-2 pb-2 pt-1" oncontextmenu={handleContextMenu}>
    <div bind:this={container} class="h-full w-full" class:term-fade={scrolled}></div>
  </div>
  {#if exited}
    <div class="absolute inset-0 flex items-center justify-center bg-surface/90 text-sm text-muted">
      Session ended.
    </div>
  {:else if !ready}
    <div class="absolute inset-0 flex items-center justify-center text-sm text-muted">
      Connecting…
    </div>
  {/if}
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
  .term-fade {
    -webkit-mask-image: linear-gradient(to bottom, transparent, black 2.25rem);
    mask-image: linear-gradient(to bottom, transparent, black 2.25rem);
  }
</style>
