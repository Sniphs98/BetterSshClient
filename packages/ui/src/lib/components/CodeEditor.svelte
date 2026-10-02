<script lang="ts">
  // A Monaco editor (VS Code's) for a form field: syntax highlighting, multiple
  // cursors, find/replace, bracket matching — loaded on first use, like FileEditor's, so
  // it never weighs on the app's start. `value` follows what's typed; anything more
  // (suggestions, decorations, shortcuts) the caller adds in `onReady`, which gets the
  // live editor and may return a cleanup.
  import { onDestroy, onMount } from 'svelte';
  import type * as Monaco from 'monaco-editor';
  import { theme } from '$lib/stores/theme';

  let {
    value = $bindable(''),
    language,
    ariaLabel,
    placeholder = '',
    onReady
  }: {
    value?: string;
    language: string;
    /** Names the editor for screen readers and tests (its hidden textarea's label). */
    ariaLabel: string;
    placeholder?: string;
    onReady?: (monaco: typeof Monaco, editor: Monaco.editor.IStandaloneCodeEditor) => void | (() => void);
  } = $props();

  let container = $state<HTMLDivElement>();
  let ready = $state(false);
  let editor: Monaco.editor.IStandaloneCodeEditor | undefined;
  let cleanup: (() => void) | undefined;
  let themeUnsub: (() => void) | undefined;
  let destroyed = false;

  onMount(() => {
    void (async () => {
      const [monaco, WorkerCtor] = await Promise.all([
        import('monaco-editor'),
        import('monaco-editor/editor/editor.worker.js?worker').then((m) => m.default)
      ]);
      if (destroyed || !container) return;
      (self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = { getWorker: () => new WorkerCtor() };

      editor = monaco.editor.create(container, {
        value,
        language,
        ariaLabel,
        placeholder,
        theme: $theme === 'dark' ? 'vs-dark' : 'vs',
        automaticLayout: true,
        minimap: { enabled: false },
        fontSize: 13,
        lineNumbersMinChars: 3,
        scrollBeyondLastLine: false,
        wordWrap: 'on',
        renderLineHighlight: 'none',
        padding: { top: 10, bottom: 10 },
        fixedOverflowWidgets: true,
        tabSize: 2
      });
      editor.onDidChangeModelContent(() => (value = editor!.getValue()));
      themeUnsub = theme.subscribe((t) => monaco.editor.setTheme(t === 'dark' ? 'vs-dark' : 'vs'));
      cleanup = onReady?.(monaco, editor) || undefined;
      ready = true;
    })();
  });

  onDestroy(() => {
    destroyed = true;
    cleanup?.();
    themeUnsub?.();
    editor?.getModel()?.dispose();
    editor?.dispose();
  });
</script>

<div class="relative h-full min-h-[200px] overflow-hidden">
  {#if !ready}
    <div class="absolute inset-0 grid place-items-center text-sm text-faint">Loading editor…</div>
  {/if}
  <div bind:this={container} class="absolute inset-0"></div>
</div>
