<script lang="ts">
  // A live SFTP tab (tech-gui.md §3.2). One instance per SFTP session, kept mounted for
  // the session's life — hidden, not destroyed, when another entity is active — so pane
  // state survives tab switches. Opens the session on mount, drives both panes via the
  // sftp_* commands, and reads its per-session state from the sftp store (fed by the
  // `sftp-*` events, §3.4). Local browsing uses list_local_dir (returns directly);
  // remote uses sftp_list (arrives as an event). Semantic tokens only (§5.1).
  import { onMount, onDestroy, tick } from 'svelte';
  import { Button, Icon } from '$lib/theme';
  import Modal from '$lib/components/Modal.svelte';
  import ContextMenu, { type ContextMenuItem } from '$lib/components/ContextMenu.svelte';
  import SftpPane from './SftpPane.svelte';
  import FileEditor from './FileEditor.svelte';
  import SftpTerminalDrawer from './SftpTerminalDrawer.svelte';
  import AutomationRunDialog from './AutomationRunDialog.svelte';
  import { isEditableFile, languageForFile } from './fileEdit';
  import { formFromHost, formToInput } from './hostForm';
  import { pastedPath } from './pathClipboard';
  import type { FileEntryDto, AutomationDto, SnippetDto } from '$lib/bindings';
  import { get } from 'svelte/store';
  import { sessions, type Session } from '$lib/stores/sessions';
  import { hosts } from '$lib/stores/hosts';
  import { sftp, markedEntries, formatBytes, type PaneSide, type PendingOp } from '$lib/stores/sftp';
  import { opKey, readyOps } from '$lib/stores/sftpQueue';
  import { lastError } from '$lib/stores/notifications';
  import { runAutomationNow } from '$lib/stores/automations';
  import {
    sftpOpen,
    sftpList,
    sftpClose,
    sftpUpload,
    sftpDownload,
    sftpMkdir,
    sftpRename,
    sftpDelete,
    sftpPreview,
    sftpReadFile,
    sftpWriteFile,
    listLocalDir,
    previewLocalFile,
    readLocalFile,
    writeLocalFile,
    listAutomations,
    listSnippets,
    reloadHosts,
    saveHost
  } from '$lib/ipc/commands';
  import { commandInFolder, fillFilePlaceholder, usesFilePlaceholder } from './snippetPlaceholders';

  let { session, active }: { session: Session; active: boolean } = $props();

  let backendId = $state<number | undefined>(undefined);
  let openError = $state<string | undefined>(undefined);
  let destroyed = false;
  let mirrored: string | undefined;
  let dragged: { side: PaneSide; entry: FileEntryDto } | undefined;
  let stopExternalDrop: (() => void) | undefined;

  // Queued mutations not yet sent. The pump effect starts whichever `readyOps` allows —
  // side by side within a batch, batches in order, never two on one path (see
  // stores/sftpQueue.ts) — and each sent op then waits in the store's `pending` for the
  // `sftp-op-done` carrying its id.
  type QueuedOp = Omit<PendingOp, 'id'> & { id: number; send: (opId: number) => Promise<void> };
  let outbox = $state.raw<QueuedOp[]>([]);
  let nextOpId = 1;
  let nextBatch = 1;

  // A pending mkdir/rename input. Rename carries the entry being renamed.
  let prompt = $state<{ kind: 'mkdir' | 'rename'; value: string; target?: FileEntryDto } | null>(
    null
  );

  // The open right-click menu, if any — built fresh from the current selection each time
  // it opens (see openEntryMenu/openEmptyMenu), so its items always match what's marked.
  let contextMenu = $state<{ side: PaneSide; x: number; y: number; items: ContextMenuItem[] } | null>(
    null
  );

  // The open file editor, if any (one at a time, §2) — holds the content already read
  // from disk, so the editor mounts with it ready rather than loading async itself.
  let fileEditor = $state<{ side: PaneSide; path: string; language: string; content: string } | null>(
    null
  );

  // "Run automation with this file" (a file's context menu, both panes): once an automation is
  // picked from the fresh-fetched, file-eligible list, this holds the automation plus the
  // values to prefill AutomationRunDialog with — the clicked file's path in the automation's first
  // `'text'` param (there's no schema for "this param wants a file", so the first one
  // is the documented convention), and, for a remote-pane file, this session's host in
  // the automation's `'host'` param, if it has one — the file already lives on that host.
  let fileAutomationRun = $state<{ automation: AutomationDto; initialValues: Record<string, string> } | null>(null);

  // Delete is destructive and irreversible (no trash can over SFTP), so — unlike the
  // other mutations here — it asks first. Reads the live `remoteMarked` selection at
  // confirm time rather than snapshotting it, same as `remove()` already did.
  let deleteConfirm = $state(false);

  // The local pane can be hidden to see more of the remote side; the drawer terminal
  // (SftpTerminalDrawer, cd'd into the remote path at the moment it opens) docks below
  // both panes. Both are plain UI state, not persisted — they live as long as this
  // component does (the whole SFTP tab's life, §3.2), same as everything else here.
  let hideLocal = $state(false);
  let showTerminal = $state(false);
  // Bound to the drawer while it's mounted, so "Run snippet here" can hand it a
  // command. The drawer queues internally if it is still connecting, which is the
  // normal case when the same click both opens it and runs something.
  let terminalDrawer = $state<{ runCommand: (command: string) => void } | undefined>();
  const MIN_TERMINAL_HEIGHT = 140;
  const MAX_TERMINAL_HEIGHT = 640;
  let terminalHeight = $state(260);
  let resizingTerminal = false;
  let resizeStartY = 0;
  let resizeStartHeight = 0;

  function startTerminalResize(event: PointerEvent): void {
    resizingTerminal = true;
    resizeStartY = event.clientY;
    resizeStartHeight = terminalHeight;
    window.addEventListener('pointermove', onTerminalResizeMove);
    window.addEventListener('pointerup', stopTerminalResize);
  }

  function onTerminalResizeMove(event: PointerEvent): void {
    if (!resizingTerminal) return;
    const delta = resizeStartY - event.clientY; // dragging the handle up grows the drawer
    terminalHeight = Math.min(MAX_TERMINAL_HEIGHT, Math.max(MIN_TERMINAL_HEIGHT, resizeStartHeight + delta));
  }

  function stopTerminalResize(): void {
    resizingTerminal = false;
    window.removeEventListener('pointermove', onTerminalResizeMove);
    window.removeEventListener('pointerup', stopTerminalResize);
  }

  const view = $derived(backendId != null ? $sftp.get(backendId) : undefined);
  // The progress bar: one transfer as before, several (a batch running side by side)
  // as their combined bytes, named by the oldest with a count of the rest.
  const transfers = $derived(view?.transfers ?? []);
  const queuedTransfers = $derived(outbox.filter((op) => op.kind === 'upload' || op.kind === 'download').length);
  const transfer = $derived(
    transfers.length === 0
      ? undefined
      : {
          kind: transfers[0].kind,
          name: transfers[0].name,
          others: transfers.length - 1 + queuedTransfers,
          done: transfers.reduce((sum, t) => sum + t.done, 0),
          total: transfers.reduce((sum, t) => sum + t.total, 0)
        }
  );

  const localMarkedFiles = $derived(view ? markedEntries(view.local).filter((e) => !e.isDir) : []);
  const remoteMarked = $derived(view ? markedEntries(view.remote) : []);
  const remoteMarkedFiles = $derived(remoteMarked.filter((e) => !e.isDir));
  const singleRemoteMark = $derived(remoteMarked.length === 1 ? remoteMarked[0] : undefined);

  function errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  function joinRemote(dir: string, name: string): string {
    return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
  }

  function joinLocal(dir: string, name: string): string {
    const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
    return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`;
  }

  async function refreshLocal(path: string): Promise<void> {
    const id = backendId;
    if (id == null) return;
    sftp.beginLoading(id, 'local');
    try {
      const entries = await listLocalDir(path);
      sftp.listing(id, 'local', path, entries);
    } catch (err) {
      sftp.paneError(id, 'local', errMsg(err));
    }
  }

  function refreshRemote(path: string): void {
    const id = backendId;
    if (id == null) return;
    sftp.beginLoading(id, 'remote');
    void sftpList(id, path).catch((err) => sftp.paneError(id, 'remote', errMsg(err)));
  }

  /** Wires the OS's native drag/drop of external files onto the window (replaces
   *  Tauri's webview drag/drop event). `getPathForFile` resolves each dropped
   *  `File` to an absolute path via the preload bridge. */
  function attachExternalDrop(onDrop: (paths: string[]) => void): () => void {
    const preventDefault = (e: DragEvent): void => e.preventDefault();
    const handleDrop = (e: DragEvent): void => {
      e.preventDefault();
      const bridge = window.bsshClient;
      if (!bridge || !e.dataTransfer) return;
      const paths = Array.from(e.dataTransfer.files)
        .map((f) => {
          try {
            return bridge.getPathForFile(f);
          } catch {
            return '';
          }
        })
        .filter((p) => p !== '');
      if (paths.length > 0) onDrop(paths);
    };
    window.addEventListener('dragover', preventDefault);
    window.addEventListener('drop', handleDrop);
    return () => {
      window.removeEventListener('dragover', preventDefault);
      window.removeEventListener('drop', handleDrop);
    };
  }

  onMount(() => {
    void (async () => {
      let home = '/';
      try {
        home = (await window.bsshClient?.homeDir()) ?? '/';
      } catch {
        home = '/';
      }
      let id: number;
      try {
        id = await sftpOpen(session.hostName);
      } catch (err) {
        sessions.setStatus(session.id, 'failed');
        openError = errMsg(err);
        lastError.set(errMsg(err));
        return;
      }
      if (destroyed) {
        void sftpClose(id).catch(() => {});
        return;
      }
      backendId = id;
      sftp.open(id, session.hostName);
      stopExternalDrop = attachExternalDrop((paths) => {
        if (active && paths.length > 0) uploadExternal(paths);
      });
      if (destroyed) {
        stopExternalDrop();
        stopExternalDrop = undefined;
      }
      void refreshLocal(home);
      // The host's configured default path, if any (tech-gui.md §4.1) — otherwise the
      // server root, as before.
      const host = get(hosts).find((h) => h.name === session.hostName);
      refreshRemote(host?.defaultPath || '/');
    })();
  });

  onDestroy(() => {
    destroyed = true;
    if (backendId != null) {
      void sftpClose(backendId).catch(() => {});
      sftp.remove(backendId);
    }
    stopExternalDrop?.();
  });

  // Mirror the store connection status to the sidebar dot (the sessions store is the
  // sidebar's source of truth); only on change, to avoid churning the sessions list.
  $effect(() => {
    if (view && view.status !== mirrored) {
      mirrored = view.status;
      sessions.setStatus(session.id, view.status);
    }
  });

  // Start every queued mutation that may run now; re-runs as ops finish (pending
  // shrinks) or new batches arrive.
  $effect(() => {
    const id = backendId;
    if (id == null || !view || outbox.length === 0) return;
    const ready = readyOps(outbox, view.pending);
    if (ready.length === 0) return;
    outbox = outbox.filter((op) => !ready.includes(op));
    for (const { send, ...op } of ready) {
      sftp.pushOp(id, op);
      void send(op.id).catch(onDispatchError(id, op.id));
    }
  });

  // Re-list the affected pane once every queued mutation has drained — the FS changed
  // (§3.2). Gated on an empty outbox so a batch re-lists once at the end, not per op.
  $effect(() => {
    const id = backendId;
    if (id == null || !view || view.pending.length > 0 || outbox.length > 0 || !view.refresh) return;
    const target = view.refresh;
    sftp.clearRefresh(id);
    if (target === 'local' || target === 'both') void refreshLocal(view.local.path);
    if (target === 'remote' || target === 'both') refreshRemote(view.remote.path);
  });

  function navigate(side: PaneSide, entry: FileEntryDto): void {
    if (side === 'local') void refreshLocal(entry.path);
    else refreshRemote(entry.path);
  }

  function toggleMark(side: PaneSide, path: string): void {
    if (backendId != null) sftp.toggleMark(backendId, side, path);
  }

  function selectOnly(side: PaneSide, path: string): void {
    if (backendId != null) sftp.selectOnly(backendId, side, path);
  }

  function selectRange(side: PaneSide, path: string): void {
    if (backendId != null) sftp.selectRange(backendId, side, path);
  }

  function clearMarks(side: PaneSide): void {
    if (backendId != null) sftp.clearMarks(backendId, side);
  }

  // The read-only fallback for a file `fileEdit.ts` won't open in the editor (too
  // large, or a known-binary extension) — truncated to the first 4096 bytes server/
  // fs-side (core/ssh/sftp.ts's readPreview/previewLocalFile), not loaded whole.
  async function preview(side: PaneSide, entry: FileEntryDto): Promise<void> {
    const id = backendId;
    if (id == null) return;
    if (side === 'local') {
      try {
        const content = await previewLocalFile(entry.path);
        sftp.setPreview(id, { path: entry.path, content });
      } catch (err) {
        lastError.set(errMsg(err));
      }
    } else {
      void sftpPreview(id, entry.path).catch((err) => lastError.set(errMsg(err)));
    }
  }

  // If a mutating invoke itself rejects (it never does for a normal enqueue, but an IPC
  // failure could), finish its pending op so the batch doesn't wait on it forever.
  function onDispatchError(id: number, opId: number): (err: unknown) => void {
    return (err) => {
      lastError.set(errMsg(err));
      sftp.opDone(id, false, errMsg(err), opId);
    };
  }

  /** One op of a batch: what it is, the path it writes (its conflict key), and how to
   *  send it once the queue lets it start. */
  type BatchOp = Pick<PendingOp, 'kind' | 'name' | 'refresh' | 'key'> & {
    send: (sessionId: number, opId: number) => Promise<void>;
  };

  /** Queues `ops` as one batch — the unit that runs side by side (stores/sftpQueue.ts). */
  function enqueue(...ops: BatchOp[]): void {
    const id = backendId;
    if (id == null || !ops.length) return;
    // Clear the prior batch's lingering error only when starting from idle. Piling onto a
    // batch that is still draining must not wipe a failure it already recorded (that error
    // stays visible until the next fresh action — see applyOpDone).
    const draining = outbox.length > 0 || (view?.pending.length ?? 0) > 0;
    if (!draining) sftp.clearError(id);
    const batch = nextBatch++;
    outbox = [
      ...outbox,
      ...ops.map(({ send, ...op }) => ({ ...op, id: nextOpId++, batch, send: (opId: number) => send(id, opId) }))
    ];
  }

  function uploadOp(localPath: string, remoteDir: string, name: string): BatchOp {
    const dest = joinRemote(remoteDir, name);
    return {
      kind: 'upload',
      name,
      refresh: 'remote',
      key: opKey('remote', dest),
      send: (sid, opId) => sftpUpload(sid, localPath, dest, opId)
    };
  }

  function downloadOp(remotePath: string, localDir: string, name: string): BatchOp {
    const dest = joinLocal(localDir, name);
    return {
      kind: 'download',
      name,
      refresh: 'local',
      key: opKey('local', dest),
      send: (sid, opId) => sftpDownload(sid, dest, remotePath, opId)
    };
  }

  function upload(): void {
    if (!view) return;
    const dir = view.remote.path;
    enqueue(...localMarkedFiles.map((file) => uploadOp(file.path, dir, file.name)));
  }

  function uploadExternal(paths: string[]): void {
    if (!view) return;
    const remoteDir = view.remote.path;
    enqueue(
      ...paths
        .map((path) => ({ path, name: path.split(/[\\/]/).pop() ?? '' }))
        .filter((file) => file.name && file.name !== '.' && file.name !== '..')
        .map((file) => uploadOp(file.path, remoteDir, file.name))
    );
  }

  function download(): void {
    if (!view) return;
    const dir = view.local.path;
    enqueue(...remoteMarkedFiles.map((file) => downloadOp(file.path, dir, file.name)));
  }

  function startDrag(side: PaneSide, entry: FileEntryDto): void {
    if (entry.isDir) return;
    dragged = { side, entry };
  }

  function dropOn(side: PaneSide): void {
    const id = backendId;
    const source = dragged;
    dragged = undefined;
    if (id == null || !view || !source || source.side === side || source.entry.isDir) return;

    if (source.side === 'local' && side === 'remote') {
      enqueue(uploadOp(source.entry.path, view.remote.path, source.entry.name));
    } else if (source.side === 'remote' && side === 'local') {
      enqueue(downloadOp(source.entry.path, view.local.path, source.entry.name));
    }
  }

  function remove(): void {
    enqueue(
      ...remoteMarked.map(
        (entry): BatchOp => ({
          kind: 'delete',
          name: entry.name,
          refresh: 'remote',
          key: opKey('remote', entry.path),
          send: (sid, opId) => sftpDelete(sid, entry.path, opId)
        })
      )
    );
  }

  function confirmRemove(): void {
    remove();
    deleteConfirm = false;
  }

  function openPrompt(kind: 'mkdir' | 'rename'): void {
    if (kind === 'rename' && singleRemoteMark) {
      prompt = { kind, value: singleRemoteMark.name, target: singleRemoteMark };
    } else if (kind === 'mkdir') {
      prompt = { kind, value: '' };
    }
  }

  function openEntry(side: PaneSide, entry: FileEntryDto): void {
    if (entry.isDir) navigate(side, entry);
    else void openFile(side, entry);
  }

  // The one "open a file" action (tech-gui.md §3.2) — double-click, Enter, and the
  // context menu's "Open" all funnel through here. `fileEdit.ts`'s isEditableFile
  // decides which of the two paths below runs; there's no separate user-facing "Edit".
  async function openFile(side: PaneSide, entry: FileEntryDto): Promise<void> {
    if (isEditableFile(entry.name, entry.size)) await openEditor(side, entry);
    else await preview(side, entry);
  }

  // Opens the file editor: reads the file whole up front — unlike the preview, which is
  // deliberately truncated — so the editor mounts with content already in hand.
  // `fileEdit.ts`'s isEditableFile already gated this to a size the process can hold
  // comfortably.
  async function openEditor(side: PaneSide, entry: FileEntryDto): Promise<void> {
    const id = backendId;
    if (id == null) return;
    try {
      const content = side === 'remote' ? await sftpReadFile(id, entry.path) : await readLocalFile(entry.path);
      fileEditor = { side, path: entry.path, language: languageForFile(entry.name), content };
    } catch (err) {
      lastError.set(errMsg(err));
    }
  }

  async function saveEditor(content: string): Promise<void> {
    const id = backendId;
    const editing = fileEditor;
    if (id == null || !editing || !view) return;
    if (editing.side === 'remote') {
      await sftpWriteFile(id, editing.path, content);
      refreshRemote(view.remote.path);
    } else {
      await writeLocalFile(editing.path, content);
      void refreshLocal(view.local.path);
    }
  }

  function closeEditor(): void {
    fileEditor = null;
  }

  // Right-click menus (tech-gui.md §3.2): built fresh from the current selection each
  // time one opens, so a batch right-click (an entry inside an existing multi-mark, see
  // SftpPane's oncontextmenu) offers the batch actions rather than just the one entry.
  // The remote side already supports rename/delete via the core; the local side is
  // browse + upload only — there's no local filesystem mutation command (yet).
  // Fetches the current Automation library fresh (this tab never keeps its own copy — the
  // Snippets screen may have changed it since) and opens a second-level menu, at the
  // same spot, listing the ones that can actually take a file: at least one `'text'`
  // param to hold its path. Selecting one opens AutomationRunDialog prefilled (see
  // fileAutomationRun's doc comment) rather than running immediately, so the user still
  // confirms/adjusts the other values first.
  async function openFileAutomationPicker(
    side: PaneSide,
    entry: FileEntryDto,
    hostName: string | undefined,
    x: number,
    y: number
  ): Promise<void> {
    let eligible: AutomationDto[];
    try {
      eligible = (await listAutomations()).filter((f) => f.params.some((p) => p.kind === 'text'));
    } catch (err) {
      lastError.set(errMsg(err));
      return;
    }
    contextMenu = {
      side,
      x,
      y,
      items:
        eligible.length === 0
          ? [{ label: 'No automations accept a file input yet', onSelect: () => {}, disabled: true }]
          : eligible.map((automation) => ({
              label: automation.name,
              icon: 'play',
              onSelect: () => {
                const initialValues: Record<string, string> = {};
                const textParam = automation.params.find((p) => p.kind === 'text');
                if (textParam) initialValues[textParam.name] = entry.path;
                if (hostName) {
                  const hostParam = automation.params.find((p) => p.kind === 'host');
                  if (hostParam) initialValues[hostParam.name] = hostName;
                }
                fileAutomationRun = { automation, initialValues };
              }
            }))
    };
  }

  /** Offers the Snippet library for this file, then types the chosen command into the
   *  drawer terminal on this host — opening the drawer first if it's closed, so one
   *  click both reveals the shell and runs the thing. `{{file}}` in the command becomes
   *  the clicked path; snippets without it just run in the current directory, which is
   *  why they're offered too rather than filtered out. Remote pane only: the drawer is
   *  a shell *on the host*, so a local path would mean nothing in it. */
  async function openFileSnippetPicker(entry: FileEntryDto, x: number, y: number): Promise<void> {
    let snippets: SnippetDto[];
    try {
      snippets = await listSnippets();
    } catch (err) {
      lastError.set(errMsg(err));
      return;
    }
    contextMenu = {
      side: 'remote',
      x,
      y,
      items:
        snippets.length === 0
          ? [{ label: 'No snippets saved yet', onSelect: () => {}, disabled: true }]
          : snippets.map((snippet) => ({
              label: usesFilePlaceholder(snippet.command) ? `${snippet.name} (uses this file)` : snippet.name,
              icon: 'play' as const,
              onSelect: () => {
                const command = fillFilePlaceholder(snippet.command, entry.path);
                showTerminal = true;
                // `bind:this` is only populated once the drawer has actually mounted,
                // which is after this tick — the drawer then queues the command itself
                // until its shell finishes connecting.
                void tick().then(() => terminalDrawer?.runCommand(command));
              }
            }))
    };
  }

  function remoteEntryMenuItems(currentView: NonNullable<typeof view>, entry: FileEntryDto, event: MouseEvent): ContextMenuItem[] {
    const count = remoteMarked.length;
    const files = remoteMarkedFiles.length;
    return [
      { label: 'Open', icon: entry.isDir ? 'folder' : 'file', onSelect: () => openEntry('remote', entry), disabled: count > 1 },
      { label: files > 1 ? `Download ${files} files` : 'Download', icon: 'download', onSelect: download, disabled: files === 0 },
      { label: 'Rename', icon: 'edit', onSelect: () => openPrompt('rename'), disabled: !singleRemoteMark },
      { label: count > 1 ? `Delete ${count} items` : 'Delete', icon: 'trash', danger: true, onSelect: () => (deleteConfirm = true), disabled: count === 0 },
      {
        label: 'Run automation with this file…',
        icon: 'play',
        onSelect: () => void openFileAutomationPicker('remote', entry, session.hostName, event.clientX, event.clientY),
        disabled: entry.isDir
      },
      {
        label: 'Run snippet with this file…',
        icon: 'play',
        onSelect: () => void openFileSnippetPicker(entry, event.clientX, event.clientY),
        disabled: entry.isDir
      },
      { label: 'New folder', icon: 'plus', onSelect: () => openPrompt('mkdir') },
      { label: 'Refresh', icon: 'refresh', onSelect: () => refreshRemote(currentView.remote.path) }
    ];
  }

  /** Offers the snippets that don't take a file (`docker system prune`, `git pull`) for
   *  the folder being browsed, and runs the chosen one in the drawer terminal there —
   *  the same way as a file snippet, just with a `cd` into the folder first. */
  async function openFolderSnippetPicker(folder: string, x: number, y: number): Promise<void> {
    let snippets: SnippetDto[];
    try {
      snippets = (await listSnippets()).filter((s) => !usesFilePlaceholder(s.command));
    } catch (err) {
      lastError.set(errMsg(err));
      return;
    }
    contextMenu = {
      side: 'remote',
      x,
      y,
      items:
        snippets.length === 0
          ? [{ label: 'No snippets without {{file}} saved yet', onSelect: () => {}, disabled: true }]
          : snippets.map((snippet) => ({
              label: snippet.name,
              icon: 'play' as const,
              onSelect: () => {
                const command = commandInFolder(snippet.command, folder);
                showTerminal = true;
                void tick().then(() => terminalDrawer?.runCommand(command));
              }
            }))
    };
  }

  function remoteEmptyMenuItems(currentView: NonNullable<typeof view>, event: MouseEvent): ContextMenuItem[] {
    return [
      {
        label: 'Run snippet here…',
        icon: 'play',
        onSelect: () => void openFolderSnippetPicker(currentView.remote.path, event.clientX, event.clientY)
      },
      { label: 'New folder', icon: 'plus', onSelect: () => openPrompt('mkdir') },
      { label: 'Refresh', icon: 'refresh', onSelect: () => refreshRemote(currentView.remote.path) }
    ];
  }

  function localEntryMenuItems(currentView: NonNullable<typeof view>, entry: FileEntryDto, event: MouseEvent): ContextMenuItem[] {
    const marked = markedEntries(currentView.local).length;
    const files = localMarkedFiles.length;
    return [
      { label: 'Open', icon: entry.isDir ? 'folder' : 'file', onSelect: () => openEntry('local', entry), disabled: marked > 1 },
      { label: files > 1 ? `Upload ${files} files` : 'Upload', icon: 'upload', onSelect: upload, disabled: files === 0 },
      {
        label: 'Run automation with this file…',
        icon: 'play',
        // No host to prefill — this file isn't necessarily on any host yet. A remote
        // snippet's host param is left for the AutomationRunDialog's own picker.
        onSelect: () => void openFileAutomationPicker('local', entry, undefined, event.clientX, event.clientY),
        disabled: entry.isDir
      },
      { label: 'Refresh', icon: 'refresh', onSelect: () => void refreshLocal(currentView.local.path) }
    ];
  }

  function localEmptyMenuItems(currentView: NonNullable<typeof view>): ContextMenuItem[] {
    return [{ label: 'Refresh', icon: 'refresh', onSelect: () => void refreshLocal(currentView.local.path) }];
  }

  function openEntryContextMenu(side: PaneSide, entry: FileEntryDto, event: MouseEvent): void {
    if (!view) return;
    const items = side === 'remote' ? remoteEntryMenuItems(view, entry, event) : localEntryMenuItems(view, entry, event);
    contextMenu = { side, x: event.clientX, y: event.clientY, items };
  }

  // Right-click on a pane's current path: copy it, jump to a path from the clipboard, and
  // (remote side) make it the host's default path — where its terminals and this browser
  // open from now on.
  function pathMenuItems(side: PaneSide, currentView: NonNullable<typeof view>): ContextMenuItem[] {
    const path = currentView[side].path;
    const items: ContextMenuItem[] = [
      { label: 'Copy path', icon: 'file', onSelect: () => void copyPath(path), disabled: !path },
      { label: 'Paste path', icon: 'upload', onSelect: () => void pastePath(side) }
    ];
    if (side === 'remote') {
      const isDefault = get(hosts).find((h) => h.name === session.hostName)?.defaultPath === path;
      items.push({
        label: isDefault ? 'Already the default path' : 'Set as default path',
        icon: 'check',
        onSelect: () => void setDefaultPath(path),
        disabled: !path || isDefault
      });
    }
    return items;
  }

  function openPathContextMenu(side: PaneSide, event: MouseEvent): void {
    if (!view) return;
    contextMenu = { side, x: event.clientX, y: event.clientY, items: pathMenuItems(side, view) };
  }

  async function copyPath(path: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(path);
    } catch (err) {
      lastError.set(errMsg(err));
    }
  }

  async function pastePath(side: PaneSide): Promise<void> {
    let path: string | undefined;
    try {
      path = pastedPath(await navigator.clipboard.readText());
    } catch (err) {
      lastError.set(errMsg(err));
      return;
    }
    if (path === undefined) return;
    // A path that doesn't exist shows as the pane's listing error, like any other.
    if (side === 'local') void refreshLocal(path);
    else refreshRemote(path);
  }

  // The same save the host form does, with only the default path changed — every other
  // setting (and a stored password or key, which the form leaves blank) is preserved.
  async function setDefaultPath(path: string): Promise<void> {
    const host = get(hosts).find((h) => h.name === session.hostName);
    if (!host) return;
    const result = formToInput({ ...formFromHost(host), defaultPath: path });
    if (!result.ok) {
      lastError.set(result.error);
      return;
    }
    try {
      await saveHost(result.input);
      await reloadHosts();
    } catch (err) {
      lastError.set(errMsg(err));
    }
  }

  function openEmptyContextMenu(side: PaneSide, event: MouseEvent): void {
    if (!view) return;
    const items = side === 'remote' ? remoteEmptyMenuItems(view, event) : localEmptyMenuItems(view);
    contextMenu = { side, x: event.clientX, y: event.clientY, items };
  }

  function submitPrompt(): void {
    const id = backendId;
    if (id == null || !view || !prompt) return;
    const value = prompt.value.trim();
    if (!value) return;
    const dir = view.remote.path;
    const dest = joinRemote(dir, value);
    if (prompt.kind === 'mkdir') {
      enqueue({
        kind: 'mkdir',
        refresh: 'remote',
        key: opKey('remote', dest),
        send: (sid, opId) => sftpMkdir(sid, dest, opId)
      });
    } else if (prompt.target) {
      const from = prompt.target.path;
      enqueue({
        kind: 'rename',
        refresh: 'remote',
        key: opKey('remote', from),
        send: (sid, opId) => sftpRename(sid, from, dest, opId)
      });
    }
    prompt = null;
  }

  function closePreview(): void {
    if (backendId != null) sftp.clearPreview(backendId);
  }

  function transferPercent(done: number, total: number): number {
    return total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  }

  const toolBtn =
    'inline-flex items-center gap-1 rounded-full border border-default px-2 py-1 text-xs ' +
    'font-medium text-muted transition hover:border-strong hover:bg-accent hover:text-accent-fg ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus ' +
    'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent ' +
    'disabled:hover:text-muted disabled:hover:border-default';
  const field =
    'w-full rounded-lg bg-surface-inset px-3 py-2 text-sm text-fg outline-none ' +
    'focus-visible:ring-2 focus-visible:ring-focus placeholder:text-faint';
</script>

<!-- bg-surface fills behind the macOS traffic lights (no seam); the pt insets the
     panes below them. -->
<div class="absolute inset-0 flex flex-col bg-surface pt-[var(--titlebar-h)] {active ? '' : 'hidden'}">
  {#if openError}
    <div class="flex flex-1 flex-col items-center justify-center gap-2 p-10 text-center">
      <p class="font-medium">Could not open SFTP on {session.hostName}</p>
      <p class="max-w-md text-sm text-muted">{openError}</p>
    </div>
  {:else if !view}
    <div class="flex flex-1 items-center justify-center p-10 text-center">
      <p class="text-sm text-muted">Connecting to {session.hostName}…</p>
    </div>
  {:else}
    <div class="grid min-h-0 flex-1 {hideLocal ? '' : 'grid-cols-2 divide-x divide-default'}">
      {#if !hideLocal}
        <SftpPane
          title="Local"
          pane={view.local}
          onNavigate={(e) => navigate('local', e)}
          onToggleMark={(p) => toggleMark('local', p)}
          onSelectOnly={(p) => selectOnly('local', p)}
          onSelectRange={(p) => selectRange('local', p)}
          onClearMarks={() => clearMarks('local')}
          onOpenFile={(e) => void openFile('local', e)}
          onDragStart={(e) => startDrag('local', e)}
          onDrop={() => dropOn('local')}
          onEntryContextMenu={(e, event) => openEntryContextMenu('local', e, event)}
          onEmptyContextMenu={(event) => openEmptyContextMenu('local', event)}
          onPathContextMenu={(event) => openPathContextMenu('local', event)}
        >
          {#snippet toolbar()}
            <button
              type="button"
              class={toolBtn}
              title="Upload marked files to the remote directory"
              disabled={localMarkedFiles.length === 0}
              onclick={upload}
            >
              <Icon name="upload" size={13} />
              Upload
            </button>
            <button
              type="button"
              class={toolBtn}
              title="Refresh"
              aria-label="Refresh local"
              onclick={() => refreshLocal(view.local.path)}
            >
              <Icon name="refresh" size={13} />
            </button>
          {/snippet}
        </SftpPane>
      {/if}

      <SftpPane
        title={session.hostName}
        pane={view.remote}
        onNavigate={(e) => navigate('remote', e)}
        onToggleMark={(p) => toggleMark('remote', p)}
        onSelectOnly={(p) => selectOnly('remote', p)}
        onSelectRange={(p) => selectRange('remote', p)}
        onClearMarks={() => clearMarks('remote')}
        onOpenFile={(e) => void openFile('remote', e)}
        onDragStart={(e) => startDrag('remote', e)}
        onDrop={() => dropOn('remote')}
        onEntryContextMenu={(e, event) => openEntryContextMenu('remote', e, event)}
        onEmptyContextMenu={(event) => openEmptyContextMenu('remote', event)}
        onPathContextMenu={(event) => openPathContextMenu('remote', event)}
      >
        {#snippet toolbar()}
          <button
            type="button"
            class={toolBtn}
            title="Download marked files to the local directory"
            disabled={remoteMarkedFiles.length === 0}
            onclick={download}
          >
            <Icon name="download" size={13} />
            Download
          </button>
          <button type="button" class={toolBtn} title="New folder" onclick={() => openPrompt('mkdir')}>
            <Icon name="plus" size={13} />
            Folder
          </button>
          <button
            type="button"
            class={toolBtn}
            title="Rename the marked entry"
            disabled={!singleRemoteMark}
            onclick={() => openPrompt('rename')}
          >
            <Icon name="edit" size={13} />
          </button>
          <button
            type="button"
            class={toolBtn}
            title="Delete marked entries"
            aria-label="Delete marked entries"
            disabled={remoteMarked.length === 0}
            onclick={() => (deleteConfirm = true)}
          >
            <Icon name="trash" size={13} />
          </button>
          <button
            type="button"
            class={toolBtn}
            title="Refresh"
            aria-label="Refresh remote"
            onclick={() => refreshRemote(view.remote.path)}
          >
            <Icon name="refresh" size={13} />
          </button>
          <button
            type="button"
            class={toolBtn}
            title={hideLocal ? 'Show local files' : 'Hide local files'}
            aria-label={hideLocal ? 'Show local files' : 'Hide local files'}
            aria-pressed={hideLocal}
            onclick={() => (hideLocal = !hideLocal)}
          >
            <Icon name={hideLocal ? 'eye-off' : 'eye'} size={13} />
          </button>
          <button
            type="button"
            class={toolBtn}
            title={showTerminal ? 'Hide terminal' : 'Open a terminal here'}
            aria-label={showTerminal ? 'Hide terminal' : 'Open a terminal here'}
            aria-pressed={showTerminal}
            onclick={() => (showTerminal = !showTerminal)}
          >
            <Icon name="terminal" size={13} />
          </button>
        {/snippet}
      </SftpPane>
    </div>

    {#if transfer}
      <div class="shrink-0 border-t border-default px-4 py-2.5" aria-label="transfer progress">
        <div class="flex items-center justify-between gap-3 text-xs text-muted">
          <span class="min-w-0 truncate">
            {transfer.kind === 'upload' ? 'Uploading' : 'Downloading'}
            <span class="font-mono text-fg">{transfer.name}</span>
            {#if transfer.others > 0}
              <span>and {transfer.others} more</span>
            {/if}
          </span>
          <span class="shrink-0 tabular-nums">
            {formatBytes(transfer.done)}{transfer.total > 0
              ? ` / ${formatBytes(transfer.total)}`
              : ''}
          </span>
        </div>
        <div class="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-inset">
          <div
            class="h-full rounded-full bg-accent transition-[width]"
            style="width: {transferPercent(transfer.done, transfer.total)}%"
          ></div>
        </div>
      </div>
    {:else if view.error}
      <div class="shrink-0 border-t border-default px-4 py-2 text-xs text-status-crit">
        {view.error}
      </div>
    {/if}

    {#if showTerminal}
      <div class="relative shrink-0 border-t border-default" style="height: {terminalHeight}px">
        <!-- The drag handle: straddles the border so a small mouse-down there always
             hits it rather than the panes above. -->
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize terminal"
          class="absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize"
          onpointerdown={startTerminalResize}
        ></div>
        <div class="flex items-center justify-between border-b border-default px-3 py-1.5">
          <span class="min-w-0 truncate font-mono text-xs text-muted" title={view.remote.path}>
            {session.hostName} · {view.remote.path}
          </span>
          <button
            type="button"
            class={toolBtn}
            title="Close terminal"
            aria-label="Close terminal"
            onclick={() => (showTerminal = false)}
          >
            <Icon name="close" size={13} />
          </button>
        </div>
        <div class="h-[calc(100%-2.25rem)]">
          <!-- Not keyed on view.remote.path: the drawer only reads `cwd` once, at
               open, to run its initial `cd` (see SftpTerminalDrawer's doc comment) —
               remounting on every later navigation would kill whatever the user is
               running in there each time they browse a different folder. -->
          <SftpTerminalDrawer bind:this={terminalDrawer} hostName={session.hostName} cwd={view.remote.path} />
        </div>
      </div>
    {/if}
  {/if}
</div>

{#if active && contextMenu}
  <ContextMenu
    x={contextMenu.x}
    y={contextMenu.y}
    items={contextMenu.items}
    onClose={() => (contextMenu = null)}
  />
{/if}

{#if active && prompt}
  <Modal label={prompt.kind === 'mkdir' ? 'New folder' : 'Rename'} onClose={() => (prompt = null)}>
    <form
      onsubmit={(e) => {
        e.preventDefault();
        submitPrompt();
      }}
    >
      <header class="border-b border-default px-5 py-3.5">
        <h2 class="text-sm font-semibold">
          {prompt.kind === 'mkdir' ? 'New folder' : `Rename ${prompt.target?.name ?? ''}`}
        </h2>
      </header>
      <div class="px-5 py-4">
        <!-- svelte-ignore a11y_autofocus -->
        <input
          autofocus
          bind:value={prompt.value}
          class={field}
          placeholder={prompt.kind === 'mkdir' ? 'Folder name' : 'New name'}
          aria-label={prompt.kind === 'mkdir' ? 'Folder name' : 'New name'}
        />
      </div>
      <footer class="flex justify-end gap-2 border-t border-default px-5 py-3">
        <button
          type="button"
          class="rounded-full px-4 py-2 text-sm text-muted transition hover:bg-surface-inset hover:text-fg"
          onclick={() => (prompt = null)}
        >
          Cancel
        </button>
        <button
          type="submit"
          class="rounded-full bg-accent px-5 py-2 text-sm font-medium text-accent-fg transition hover:opacity-90 disabled:opacity-50"
          disabled={!prompt.value.trim()}
        >
          {prompt.kind === 'mkdir' ? 'Create' : 'Rename'}
        </button>
      </footer>
    </form>
  </Modal>
{/if}

{#if active && view?.preview}
  <Modal label="File preview" onClose={closePreview}>
    <header class="border-b border-default px-5 py-3.5">
      <h2 class="truncate font-mono text-xs text-muted" title={view.preview.path}>
        {view.preview.path}
      </h2>
    </header>
    <div class="min-h-0 flex-1 overflow-auto px-5 py-4">
      <p class="mb-3 text-xs text-faint">
        Read-only — too large or not a text type the editor opens.
      </p>
      {#if view.preview.content.length === 0}
        <p class="text-sm text-faint">Empty file.</p>
      {:else}
        <pre class="select-text whitespace-pre-wrap break-words font-mono text-xs text-fg">{view.preview
            .content}</pre>
      {/if}
    </div>
    <footer class="flex justify-end border-t border-default px-5 py-3">
      <button
        type="button"
        class="rounded-full px-4 py-2 text-sm text-muted transition hover:bg-surface-inset hover:text-fg"
        onclick={closePreview}
      >
        Close
      </button>
    </footer>
  </Modal>
{/if}

{#if active && fileEditor}
  <FileEditor
    path={fileEditor.path}
    language={fileEditor.language}
    initialContent={fileEditor.content}
    onSave={saveEditor}
    onClose={closeEditor}
  />
{/if}

{#if active && fileAutomationRun}
  <AutomationRunDialog
    automation={fileAutomationRun.automation}
    initialValues={fileAutomationRun.initialValues}
    onRun={(values) => {
      const name = fileAutomationRun?.automation.name;
      fileAutomationRun = null;
      if (name) void runAutomationNow(name, values);
    }}
    onCancel={() => (fileAutomationRun = null)}
  />
{/if}

{#if active && deleteConfirm}
  {@const count = remoteMarked.length}
  <Modal label="Delete" onClose={() => (deleteConfirm = false)}>
    <div class="space-y-3 px-5 py-4">
      <h2 class="text-sm font-semibold">
        Delete {count > 1 ? `${count} items` : `“${remoteMarked[0]?.name}”`}?
      </h2>
      <p class="text-sm text-muted">
        This removes {count > 1 ? 'them' : 'it'} from {session.hostName}. There's no undo.
      </p>
      <div class="flex justify-end gap-2 pt-1">
        <Button variant="ghost" onclick={() => (deleteConfirm = false)}>Cancel</Button>
        <Button variant="primary" onclick={confirmRemove}>Delete</Button>
      </div>
    </div>
  </Modal>
{/if}
