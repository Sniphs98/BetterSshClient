<script lang="ts">
  // Add/edit form for a remote-desktop connection profile. Validation mirrors
  // `remoteDesktopForm.ts`'s `formToInput`; on submit the parent persists + refreshes,
  // and a rejected save surfaces inline without closing. Only 'rdp' is reachable this
  // round (see remoteDesktopForm.ts) — no protocol picker yet.
  import { onMount } from 'svelte';
  import type { RemoteDesktopConnectionInputDto } from '$lib/bindings';
  import { Button } from '$lib/theme';
  import Modal from '$lib/components/Modal.svelte';
  import Select from '$lib/components/Select.svelte';
  import { hosts } from '$lib/stores/hosts';
  import { formToInput, type RemoteDesktopFormFields } from './remoteDesktopForm';

  let {
    mode,
    initial,
    onSubmit,
    onCancel
  }: {
    mode: 'add' | 'edit';
    initial: RemoteDesktopFormFields;
    onSubmit: (input: RemoteDesktopConnectionInputDto) => Promise<void>;
    onCancel: () => void;
  } = $props();

  // Seeded once from `initial`; the editor is remounted per open, so the prop never
  // changes under a live instance.
  // svelte-ignore state_referenced_locally
  let fields = $state<RemoteDesktopFormFields>({ ...initial });
  let error = $state<string | null>(null);
  let saving = $state(false);
  let nameEl = $state<HTMLInputElement>();

  onMount(() => nameEl?.focus());

  async function save(): Promise<void> {
    const result = formToInput(fields);
    if (!result.ok) {
      error = result.error;
      return;
    }
    error = null;
    saving = true;
    try {
      await onSubmit(result.input);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }

  // On edit the DTO omits the password (only `hasPassword` travels out), so the field
  // starts blank and means "keep the stored value"; on add it means "none".
  const secretHint = $derived(mode === 'edit' ? 'Leave blank to keep the current value' : undefined);

  // SSH hosts to tunnel through — plus the saved one if it has since been renamed or
  // removed, so opening the editor doesn't silently switch the profile to direct.
  const tunnelHosts = $derived.by(() => {
    const names = $hosts.map((h) => h.name);
    return fields.viaHost && !names.includes(fields.viaHost) ? [fields.viaHost, ...names] : names;
  });

  const label = 'block space-y-1 text-xs font-medium text-muted';
  const field =
    'w-full rounded-lg bg-surface-inset px-3 py-2 text-sm text-fg outline-none ' +
    'focus-visible:ring-2 focus-visible:ring-focus placeholder:text-faint';
</script>

<Modal label={mode === 'add' ? 'New RDP connection' : 'Edit RDP connection'} onClose={onCancel}>
  <form
    onsubmit={(e) => {
      e.preventDefault();
      void save();
    }}
    class="flex min-h-0 flex-col"
  >
    <header class="border-b border-default px-5 py-3.5">
      <h2 class="text-sm font-semibold">{mode === 'add' ? 'New RDP connection' : 'Edit RDP connection'}</h2>
    </header>

    <div class="min-h-0 flex-1 space-y-3.5 overflow-y-auto px-5 py-4">
      <label class={label}>
        <span>Name</span>
        <input bind:this={nameEl} bind:value={fields.name} class={field} placeholder="office-pc" />
      </label>

      <div class="grid grid-cols-[1fr,7rem] gap-3">
        <label class={label}>
          <span>Hostname / IP</span>
          <input bind:value={fields.hostname} class="{field} font-mono" placeholder="10.0.0.5" />
        </label>
        <label class={label}>
          <span>Port</span>
          <input bind:value={fields.port} inputmode="numeric" class={field} placeholder="3389" />
        </label>
      </div>

      <label class={label}>
        <span>Connect</span>
        <Select bind:value={fields.viaHost} class={field}>
          <option value="">Directly</option>
          {#each tunnelHosts as name (name)}
            <option value={name}>Through SSH host {name}</option>
          {/each}
        </Select>
      </label>
      {#if fields.viaHost}
        <p class="-mt-2 text-xs text-faint">
          Hostname and port are as seen from {fields.viaHost}. The connection runs through an SSH tunnel, so the
          remote machine's RDP port doesn't need to be reachable from here.
        </p>
      {/if}

      <div class="grid grid-cols-2 gap-3">
        <label class={label}>
          <span>Username</span>
          <input bind:value={fields.username} class={field} placeholder="admin" />
        </label>
        <label class={label}>
          <span>Domain</span>
          <input bind:value={fields.domain} class={field} placeholder="Optional" />
        </label>
      </div>

      <label class={label}>
        <span>Password</span>
        <input
          type="password"
          bind:value={fields.password}
          class={field}
          placeholder={secretHint ?? 'Optional — you can also enter it at connect time'}
          autocomplete="off"
        />
      </label>

      {#if error}
        <p class="text-xs text-status-crit">{error}</p>
      {/if}
    </div>

    <footer class="flex justify-end gap-2 border-t border-default px-5 py-3">
      <Button variant="ghost" onclick={onCancel}>Cancel</Button>
      <Button variant="primary" type="submit" disabled={saving}>
        {mode === 'add' ? 'Add connection' : 'Save'}
      </Button>
    </footer>
  </form>
</Modal>
