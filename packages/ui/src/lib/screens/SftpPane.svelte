<script lang="ts">
  // One side of the dual-pane SFTP browser (tech-gui.md §3.2): a current-path header
  // with a parent-supplied toolbar, then the entry list. A plain click on a directory
  // navigates straight into it (and on a file, selects it — a file has nothing to
  // "open" on a single click); ctrl/cmd-click toggles the clicked entry into the
  // selection without navigating, and shift-click selects the range from the last
  // touched entry — both work the same on files and directories, so a batch of folders
  // can still be marked for delete/download. A double-click (or Enter) opens the
  // clicked entry either way (a file opens — in the editor if `fileEdit.ts` allows it,
  // else a read-only preview, the parent's call via `onOpenFile`; navigating a
  // directory again is a harmless no-op there). The leading checkbox stays as an
  // explicit, always-additive toggle for touch/trackpad use. Right-click opens a
  // context menu with the equivalent actions; the parent owns building and positioning
  // it. Semantic tokens only (§5.1).
  import type { Snippet } from 'svelte';
  import { Icon } from '$lib/theme';
  import type { FileEntryDto } from '$lib/bindings';
  import { formatBytes, type Pane } from '$lib/stores/sftp';

  let {
    title,
    pane,
    onNavigate,
    onToggleMark,
    onSelectOnly,
    onSelectRange,
    onClearMarks,
    onOpenFile,
    onDragStart,
    onDrop,
    onEntryContextMenu,
    onEmptyContextMenu,
    toolbar
  }: {
    title: string;
    pane: Pane;
    onNavigate: (entry: FileEntryDto) => void;
    onToggleMark: (path: string) => void;
    onSelectOnly: (path: string) => void;
    onSelectRange: (path: string) => void;
    onClearMarks: () => void;
    onOpenFile: (entry: FileEntryDto) => void;
    onDragStart: (entry: FileEntryDto) => void;
    onDrop: () => void;
    onEntryContextMenu: (entry: FileEntryDto, event: MouseEvent) => void;
    onEmptyContextMenu: (event: MouseEvent) => void;
    toolbar?: Snippet;
  } = $props();

  let dragActive = $state(false);

  function open(entry: FileEntryDto): void {
    if (entry.isDir) onNavigate(entry);
    else onOpenFile(entry);
  }

  function click(entry: FileEntryDto, event: MouseEvent): void {
    if (event.shiftKey) onSelectRange(entry.path);
    else if (event.ctrlKey || event.metaKey) onToggleMark(entry.path);
    else if (entry.isDir) onNavigate(entry);
    else onSelectOnly(entry.path);
  }

  function keydown(entry: FileEntryDto, event: KeyboardEvent): void {
    // Enter opens, matching every OS file manager; Space still selects via the button's
    // native click activation.
    if (event.key === 'Enter') {
      event.preventDefault();
      open(entry);
    }
  }

  const rowBase =
    'flex w-full min-w-0 items-center gap-2 rounded px-2 py-1.5 text-left text-sm transition ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';
</script>

<section aria-label={title} class="flex min-h-0 min-w-0 flex-1 flex-col">
  <header class="shrink-0 border-b border-default px-3 py-2.5">
    <div class="flex items-center justify-between gap-2">
      <h2
        title={title}
        class="truncate text-xs font-semibold uppercase tracking-[0.14em] text-muted"
      >
        {title}
      </h2>
      <div class="flex shrink-0 items-center gap-1">
        {@render toolbar?.()}
      </div>
    </div>
    <div class="mt-1 truncate font-mono text-xs text-faint" title={pane.path}>
      {pane.path || '—'}
    </div>
  </header>

  <!-- The click/contextmenu handlers here are a deselect-empty-space convenience, not
       the only way to change selection (clicking a different entry already replaces
       it), and this region carries no tabindex — so there's no keyboard-reachable
       interaction to lose. -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    role="region"
    aria-label="{title} file list"
    class="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5 {dragActive ? 'bg-accent/10' : ''}"
    ondragover={(event) => {
      event.preventDefault();
      dragActive = true;
    }}
    ondragleave={(event) => {
      if (event.currentTarget === event.target) dragActive = false;
    }}
    ondrop={(event) => {
      event.preventDefault();
      dragActive = false;
      onDrop();
    }}
    onclick={(event) => {
      if (event.currentTarget === event.target) onClearMarks();
    }}
    oncontextmenu={(event) => {
      if (event.currentTarget === event.target) {
        event.preventDefault();
        onEmptyContextMenu(event);
      }
    }}
  >
    {#if pane.error}
      <p class="px-2 py-6 text-center text-sm text-status-crit">{pane.error}</p>
    {:else if pane.loading && pane.entries.length === 0}
      <p class="px-2 py-6 text-center text-sm text-faint">Loading…</p>
    {:else if pane.entries.length === 0}
      <p class="px-2 py-6 text-center text-sm text-faint">Empty directory</p>
    {:else}
      <ul class="space-y-0.5">
        {#each pane.entries as entry, i (i)}
          {@const isParent = entry.name === '..'}
          {@const marked = pane.marked.has(entry.path)}
          <li
            class="flex items-center gap-1.5"
            oncontextmenu={(event) => {
              if (isParent) return;
              event.preventDefault();
              event.stopPropagation();
              // Right-clicking an entry outside the current selection replaces it (so the
              // menu always acts on what's under the cursor); right-clicking inside an
              // existing multi-selection keeps it, so the menu can act on the whole batch.
              if (!marked) onSelectOnly(entry.path);
              onEntryContextMenu(entry, event);
            }}
          >
            {#if isParent}
              <span class="h-4 w-4 shrink-0"></span>
            {:else}
              <button
                type="button"
                role="checkbox"
                aria-checked={marked}
                aria-label="Mark {entry.name}"
                class="grid h-4 w-4 shrink-0 place-items-center rounded border transition
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus
                  {marked ? 'border-accent bg-accent text-accent-fg' : 'border-strong text-transparent'}"
                onclick={() => onToggleMark(entry.path)}
              >
                {#if marked}<Icon name="check" size={11} />{/if}
              </button>
            {/if}
            <button
              type="button"
              class="{rowBase} {marked ? 'bg-accent/15 text-fg' : 'text-muted hover:bg-surface-inset hover:text-fg'}"
              title={entry.name}
              draggable={!isParent && !entry.isDir}
              ondragstart={() => {
                if (!isParent && !entry.isDir) onDragStart(entry);
              }}
              onclick={(event) => (isParent ? onNavigate(entry) : click(entry, event))}
              ondblclick={() => open(entry)}
              onkeydown={(event) => keydown(entry, event)}
            >
              <Icon name={entry.isDir ? 'folder' : 'file'} size={15} />
              <span class="min-w-0 flex-1 truncate {entry.isDir ? 'font-medium text-fg' : ''}">
                {entry.name}
              </span>
              {#if !entry.isDir}
                <span class="shrink-0 tabular-nums text-xs text-faint">{formatBytes(entry.size)}</span>
              {/if}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</section>
