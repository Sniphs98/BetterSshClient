<script lang="ts">
  // Add/edit automation form. Validation mirrors the TUI via `formToAutomation`;
  // on submit the parent persists + refreshes, and a rejected save surfaces
  // inline without closing. Steps are edited as plain text, one step per line
  // (`local: …` / `remote: …` / `upload: a -> b` / `download: a -> b`) — the same
  // DSL the TUI's steps editor uses, so both frontends write the same file shape.
  import { onMount } from 'svelte';
  import type { AutomationDto } from '$lib/bindings';
  import { Button } from '$lib/theme';
  import Modal from '$lib/components/Modal.svelte';
  import { formToAutomation, type AutomationFormFields } from './automationForm';

  let {
    mode,
    initial,
    previousName,
    onSubmit,
    onCancel
  }: {
    mode: 'add' | 'edit';
    initial: AutomationFormFields;
    previousName?: string;
    onSubmit: (automation: AutomationDto, previousName: string | undefined) => Promise<void>;
    onCancel: () => void;
  } = $props();

  // Seeded once from `initial`; the editor is remounted per open, so the prop never
  // changes under a live instance.
  // svelte-ignore state_referenced_locally
  let fields = $state<AutomationFormFields>({ ...initial });
  let error = $state<string | null>(null);
  let saving = $state(false);
  let nameEl = $state<HTMLInputElement>();

  onMount(() => nameEl?.focus());

  async function save(): Promise<void> {
    const result = formToAutomation(fields);
    if (!result.ok) {
      error = result.error;
      return;
    }
    error = null;
    saving = true;
    try {
      await onSubmit(result.automation, previousName);
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

<Modal label={mode === 'add' ? 'New automation' : 'Edit automation'} onClose={onCancel}>
  <form
    onsubmit={(e) => {
      e.preventDefault();
      void save();
    }}
    class="flex min-h-0 flex-col"
  >
    <header class="border-b border-default px-5 py-3.5">
      <h2 class="text-sm font-semibold">{mode === 'add' ? 'New automation' : 'Edit automation'}</h2>
    </header>

    <div class="min-h-0 flex-1 space-y-3.5 overflow-y-auto px-5 py-4">
      <label class={label}>
        <span>Name</span>
        <input bind:this={nameEl} bind:value={fields.name} class={field} placeholder="deploy-image" />
      </label>

      <div class="grid grid-cols-2 gap-3">
        <label class={label}>
          <span>Host (blank = local-only)</span>
          <input bind:value={fields.host} class={field} placeholder="web-1" />
        </label>
        <label class={label}>
          <span>Params</span>
          <input bind:value={fields.params} class={field} placeholder="tag, service" />
        </label>
      </div>

      <div class="space-y-1">
        <label class={label}>
          <span>Steps</span>
          <textarea
            bind:value={fields.steps}
            rows="7"
            class="{field} resize-y font-mono"
            placeholder={'local: docker save {{tag}} -o image.tar\nupload: image.tar -> /srv/deploy/image.tar\nremote: systemctl restart myapp'}
          ></textarea>
        </label>
        <p class="text-[11px] text-faint">
          One step per line: <span class="font-mono">local:</span>, <span class="font-mono">remote:</span>,
          <span class="font-mono">upload: local -&gt; remote</span>, or
          <span class="font-mono">download: remote -&gt; local</span>. Reference params as {'{{name}}'}.
        </p>
      </div>

      {#if error}
        <p class="text-xs text-status-crit">{error}</p>
      {/if}
    </div>

    <footer class="flex justify-end gap-2 border-t border-default px-5 py-3">
      <Button variant="ghost" onclick={onCancel}>Cancel</Button>
      <Button variant="primary" type="submit" disabled={saving}>
        {mode === 'add' ? 'Add automation' : 'Save'}
      </Button>
    </footer>
  </form>
</Modal>
