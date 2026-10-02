<script lang="ts">
  // Add/edit Snippet form: the reusable, named shell-command building block an Automation
  // places as a node. Validation mirrors the TUI-style forms elsewhere (`hostForm.ts`,
  // `snippetForm.ts`) via `formToSnippet`; on submit the parent persists + refreshes,
  // and a rejected save surfaces inline without closing. Semantic tokens only. No host
  // field for a remote snippet — its target host is an Automation-level parameter,
  // collected when the automation runs (see AutomationEditor's Parameters section), so the same
  // snippet works unchanged against whichever host that automation is run with.
  import { onMount } from 'svelte';
  import type { SnippetDto } from '$lib/bindings';
  import type * as Monaco from 'monaco-editor';
  import { Button, Icon } from '$lib/theme';
  import CodeEditor from '$lib/components/CodeEditor.svelte';
  import Modal from '$lib/components/Modal.svelte';
  import { formToSnippet, type SnippetFormFields } from './snippetForm';
  import { PLACEHOLDERS, placeholderPrefix, placeholderRanges, plainInsert } from './snippetCompletions';

  let {
    mode,
    id,
    initial,
    onSubmit,
    onCancel
  }: {
    mode: 'add' | 'edit';
    /** A fresh `crypto.randomUUID()` for `mode: 'add'`, the existing id for `'edit'` —
     *  the form itself never generates or shows it. */
    id: string;
    initial: SnippetFormFields;
    onSubmit: (snippet: SnippetDto) => Promise<void>;
    onCancel: () => void;
  } = $props();

  // Seeded once from `initial`; the editor is remounted per open, so the prop never
  // changes under a live instance.
  // svelte-ignore state_referenced_locally
  let fields = $state<SnippetFormFields>({ ...initial });
  let error = $state<string | null>(null);
  let saving = $state(false);
  let nameEl = $state<HTMLInputElement>();

  onMount(() => nameEl?.focus());

  async function save(): Promise<void> {
    const result = formToSnippet(fields, id);
    if (!result.ok) {
      error = result.error;
      return;
    }
    error = null;
    saving = true;
    try {
      await onSubmit(result.snippet);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }

  let codeEditor: Monaco.editor.IStandaloneCodeEditor | undefined;

  /** The command editor's extras: `{{` suggestions, highlighted placeholders, Ctrl+S. */
  function setUpEditor(monaco: typeof Monaco, editor: Monaco.editor.IStandaloneCodeEditor): () => void {
    codeEditor = editor;
    const suggestions = monaco.languages.registerCompletionItemProvider('shell', {
      triggerCharacters: ['{'],
      provideCompletionItems(model, position) {
        // Only in this editor (the provider is per language, FileEditor's shell files too).
        if (model !== editor.getModel()) return { suggestions: [] };
        const before = model.getValueInRange({
          startLineNumber: position.lineNumber,
          startColumn: 1,
          endLineNumber: position.lineNumber,
          endColumn: position.column
        });
        const typed = placeholderPrefix(before);
        if (typed === null) return { suggestions: [] };
        // Replace what's typed of the placeholder, and a `}}` the editor closed for us.
        const after = model.getLineContent(position.lineNumber).slice(position.column - 1);
        const closing = after.startsWith('}}') ? 2 : 0;
        const range = new monaco.Range(position.lineNumber, position.column - typed, position.lineNumber, position.column + closing);
        return {
          suggestions: PLACEHOLDERS.map((p, i) => ({
            label: p.label,
            kind: monaco.languages.CompletionItemKind.Variable,
            detail: p.detail,
            insertText: p.insert,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            filterText: p.label,
            sortText: String(i),
            range
          }))
        };
      }
    });

    const decorations = editor.createDecorationsCollection();
    const highlight = (): void => {
      decorations.set(
        placeholderRanges(editor.getValue()).map((r) => ({
          range: new monaco.Range(r.line, r.start, r.line, r.end),
          options: { inlineClassName: 'snippet-placeholder' }
        }))
      );
    };
    highlight();
    const changes = editor.onDidChangeModelContent(highlight);

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void save());
    return () => {
      suggestions.dispose();
      changes.dispose();
      codeEditor = undefined;
    };
  }

  /** A placeholder from the side list, at the cursor. */
  function insertPlaceholder(text: string): void {
    if (!codeEditor) {
      fields.command += text;
      return;
    }
    const selection = codeEditor.getSelection();
    if (selection) codeEditor.executeEdits('placeholder', [{ range: selection, text, forceMoveMarkers: true }]);
    codeEditor.focus();
  }

  const label = 'block space-y-1 text-xs font-medium text-muted';
  const field =
    'w-full rounded-lg bg-surface-inset px-3 py-2 text-sm text-fg outline-none ' +
    'focus-visible:ring-2 focus-visible:ring-focus placeholder:text-faint';
  const card = 'flex flex-col rounded-xl border border-default bg-surface-inset/40';
  const cardHeader = 'flex items-center gap-3 px-4 py-3';
  const cardIcon = 'grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface-inset text-muted';
</script>

<Modal label={mode === 'add' ? 'New snippet' : 'Edit snippet'} size="wide" onClose={onCancel}>
  <form
    onsubmit={(e) => {
      e.preventDefault();
      void save();
    }}
    class="flex min-h-0 flex-col"
  >
    <header class="border-b border-default px-5 py-3.5">
      <h2 class="text-sm font-semibold">{mode === 'add' ? 'New snippet' : 'Edit snippet'}</h2>
    </header>

    <!-- The command gets the room (screens are wider than tall); name, timeout and the
         placeholders sit beside it. Stacked on narrow windows. -->
    <div class="grid min-h-0 flex-1 gap-4 overflow-y-auto px-5 py-4 md:grid-cols-[minmax(0,1fr),19rem]">
      <section class="{card} min-h-[320px] md:h-[min(62vh,640px)]" aria-labelledby="snippet-command-title">
        <div class={cardHeader}>
          <span class={cardIcon}><Icon name="terminal" size={15} /></span>
          <span class="min-w-0 flex-1">
            <span id="snippet-command-title" class="block text-sm font-medium">Command</span>
            <span class="block truncate text-xs text-faint">Shell, one or more lines · type {'{{'} for placeholders</span>
          </span>
        </div>
        <div class="min-h-0 flex-1 overflow-hidden rounded-b-xl border-t border-default">
          <CodeEditor
            bind:value={fields.command}
            language="shell"
            ariaLabel="Command"
            placeholder={'docker build -t app {{nodes.checkout.output}}'}
            onReady={setUpEditor}
          />
        </div>
      </section>

      <div class="space-y-4">
        <section class={card} aria-labelledby="snippet-details-title">
          <div class={cardHeader}>
            <span class={cardIcon}><Icon name="snippets" size={15} /></span>
            <span id="snippet-details-title" class="text-sm font-medium">Snippet</span>
          </div>
          <div class="space-y-3.5 border-t border-default px-4 pb-4 pt-4">
            <label class={label}>
              <span>Name</span>
              <input bind:this={nameEl} bind:value={fields.name} class={field} placeholder="Build image" />
            </label>
            <label class={label}>
              <span>Timeout (seconds)</span>
              <input bind:value={fields.timeoutSecs} inputmode="numeric" class={field} placeholder="300" />
            </label>
          </div>
        </section>

        <section class={card} aria-labelledby="snippet-placeholders-title">
          <div class={cardHeader}>
            <span class={cardIcon}><Icon name="plus" size={15} /></span>
            <span class="min-w-0 flex-1">
              <span id="snippet-placeholders-title" class="block text-sm font-medium">Placeholders</span>
              <span class="block text-xs text-faint">Click to insert at the cursor</span>
            </span>
          </div>
          <ul class="space-y-1 border-t border-default p-2">
            {#each PLACEHOLDERS as p (p.label)}
              <li>
                <button
                  type="button"
                  class="w-full rounded-lg px-2.5 py-2 text-left transition hover:bg-surface-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
                  onclick={() => insertPlaceholder(plainInsert(p))}
                >
                  <span class="block font-mono text-xs text-fg">{p.label}</span>
                  <span class="block text-[11px] text-faint">{p.detail}</span>
                </button>
              </li>
            {/each}
          </ul>
          <p class="border-t border-default px-4 py-3 text-[11px] text-faint">
            Where it runs (this machine, WSL or a host) is set per node in the automation. Without {'{{file}}'}, a snippet
            is also under Run snippet here… in the SFTP browser and runs in that folder.
          </p>
        </section>
      </div>
    </div>

    {#if error}
      <p class="px-5 pb-3 text-xs text-status-crit">{error}</p>
    {/if}

    <footer class="flex items-center justify-between gap-2 border-t border-default px-5 py-3">
      <span class="text-xs text-faint">Ctrl+S saves</span>
      <div class="flex gap-2">
        <Button variant="ghost" onclick={onCancel}>Cancel</Button>
        <Button variant="primary" type="submit" disabled={saving}>
          {mode === 'add' ? 'Add snippet' : 'Save'}
        </Button>
      </div>
    </footer>
  </form>
</Modal>

<style>
  /* Placeholders in the command stand out from the shell around them. */
  :global(.snippet-placeholder) {
    color: var(--accent) !important;
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    border-radius: 3px;
    font-weight: 600;
  }
</style>
