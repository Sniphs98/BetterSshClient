<script lang="ts">
  // Edit a text file straight from the SFTP browser (tech-gui.md §3.2), via a Monaco
  // instance — full syntax highlighting for the config/script formats someone managing a
  // server actually opens (`fileEdit.ts` decides which). Monaco itself is dynamically
  // imported so its ~sizeable bundle only loads the first time a file is actually opened,
  // never as part of the app's initial load. `path`/`language`/`initialContent` are
  // supplied by the caller (already read via sftpReadFile/readLocalFile); `onSave`
  // performs the actual write and re-throws on failure, which this keeps the modal open
  // and shows inline rather than losing the edit.
  import { onDestroy, onMount } from 'svelte';
  import { Button } from '$lib/theme';
  import Modal from '$lib/components/Modal.svelte';
  import { theme } from '$lib/stores/theme';

  let {
    path,
    language,
    initialContent,
    onSave,
    onClose
  }: {
    path: string;
    language: string;
    initialContent: string;
    onSave: (content: string) => Promise<void>;
    onClose: () => void;
  } = $props();

  let container = $state<HTMLDivElement | undefined>();
  let ready = $state(false);
  let dirty = $state(false);
  let saving = $state(false);
  let error = $state<string | undefined>(undefined);
  let themeUnsub: (() => void) | undefined;

  // Typed loosely (the real type comes from the dynamically-imported module) — this
  // component never calls anything on it before Monaco has resolved.
  let editorInstance: { getValue(): string; dispose(): void } | undefined;

  onMount(() => {
    let disposed = false;
    void (async () => {
      const [monaco, WorkerCtor] = await Promise.all([
        import('monaco-editor'),
        import('monaco-editor/editor/editor.worker.js?worker').then((m) => m.default)
      ]);
      if (disposed || !container) return;

      (self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
        getWorker: () => new WorkerCtor()
      };

      const editor = monaco.editor.create(container, {
        value: initialContent,
        language,
        theme: $theme === 'dark' ? 'vs-dark' : 'vs',
        automaticLayout: true,
        minimap: { enabled: false },
        fontSize: 13,
        scrollBeyondLastLine: false
      });
      editorInstance = editor;
      ready = true;
      editor.onDidChangeModelContent(() => {
        dirty = true;
      });

      // The #1 theme-regression guard (§5.1), same as the terminal: re-theme a live
      // editor rather than only setting it once at creation.
      themeUnsub = theme.subscribe((t) => monaco.editor.setTheme(t === 'dark' ? 'vs-dark' : 'vs'));
    })();
    return () => {
      disposed = true;
    };
  });

  onDestroy(() => {
    themeUnsub?.();
    editorInstance?.dispose();
  });

  async function save(): Promise<void> {
    if (!editorInstance) return;
    saving = true;
    error = undefined;
    try {
      await onSave(editorInstance.getValue());
      onClose();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }
</script>

<Modal label="Edit {path}" size="large" onClose={onClose}>
  <div class="flex min-h-0 flex-1 flex-col">
    <header class="flex items-center justify-between gap-3 border-b border-default px-5 py-3">
      <h2 class="min-w-0 truncate font-mono text-xs text-muted" title={path}>{path}</h2>
      <span class="shrink-0 text-xs text-faint">{language}</span>
    </header>

    <div class="relative h-[60vh] min-h-[280px]">
      {#if !ready}
        <div class="absolute inset-0 grid place-items-center text-sm text-faint">Loading editor…</div>
      {/if}
      <div bind:this={container} class="absolute inset-0"></div>
    </div>

    {#if error}
      <p class="border-t border-default px-5 py-2 text-xs text-status-crit">{error}</p>
    {/if}

    <footer class="flex items-center justify-between gap-2 border-t border-default px-5 py-3">
      <span class="text-xs text-faint">{dirty ? 'Unsaved changes' : 'No changes yet'}</span>
      <div class="flex gap-2">
        <Button variant="ghost" onclick={onClose}>Cancel</Button>
        <Button variant="primary" onclick={save} disabled={!ready || saving || !dirty}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </footer>
  </div>
</Modal>
