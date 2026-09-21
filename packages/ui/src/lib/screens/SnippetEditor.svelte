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
  import { Button } from '$lib/theme';
  import Modal from '$lib/components/Modal.svelte';
  import Select from '$lib/components/Select.svelte';
  import { formToSnippet, type SnippetFormFields } from './snippetForm';

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

  const label = 'block space-y-1 text-xs font-medium text-muted';
  const field =
    'w-full rounded-lg bg-surface-inset px-3 py-2 text-sm text-fg outline-none ' +
    'focus-visible:ring-2 focus-visible:ring-focus placeholder:text-faint';
</script>

<Modal label={mode === 'add' ? 'New snippet' : 'Edit snippet'} onClose={onCancel}>
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

    <div class="min-h-0 flex-1 space-y-3.5 overflow-y-auto px-5 py-4">
      <label class={label}>
        <span>Name</span>
        <input bind:this={nameEl} bind:value={fields.name} class={field} placeholder="Build image" />
      </label>

      <div class="grid grid-cols-2 gap-3">
        <label class={label}>
          <span>Runs</span>
          <Select bind:value={fields.kind} class={field}>
            <option value="local">locally</option>
            <option value="remote">on a remote host</option>
          </Select>
        </label>
        <label class={label}>
          <span>Timeout (seconds)</span>
          <input bind:value={fields.timeoutSecs} inputmode="numeric" class={field} placeholder="300" />
        </label>
      </div>

      <label class={label}>
        <span>Command</span>
        <textarea
          bind:value={fields.command}
          rows="4"
          class="{field} resize-y font-mono"
          placeholder="docker build -t app {'{{nodes.checkout.output}}'}"
        ></textarea>
      </label>
      <p class="text-[11px] text-faint">
        Reference an upstream node's output as {'{{nodes.<label>.output}}'} once this
        snippet is placed in an automation with an edge into it from that node, or an automation
        parameter's value as {'{{params.<name>}}'}.
        {#if fields.kind === 'remote'}
          This snippet runs on whichever host the automation is run with — add a host
          parameter to the automation if it doesn't have one yet.
        {/if}
      </p>

      {#if error}
        <p class="text-xs text-status-crit">{error}</p>
      {/if}
    </div>

    <footer class="flex justify-end gap-2 border-t border-default px-5 py-3">
      <Button variant="ghost" onclick={onCancel}>Cancel</Button>
      <Button variant="primary" type="submit" disabled={saving}>
        {mode === 'add' ? 'Add snippet' : 'Save'}
      </Button>
    </footer>
  </form>
</Modal>
