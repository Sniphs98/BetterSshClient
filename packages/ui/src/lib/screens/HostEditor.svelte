<script lang="ts">
  // Add/edit host form (tech-gui.md §4.1). Always writes a manual entry: editing an
  // SSH-config import adopts it, leaving ~/.ssh/config untouched. Validation mirrors the TUI via
  // `formToInput`; on submit the parent persists + reloads, and a rejected save
  // surfaces inline without closing. Semantic tokens only.
  import { onMount } from 'svelte';
  import type { HostInputDto } from '$lib/bindings';
  import { Button } from '$lib/theme';
  import Modal from '$lib/components/Modal.svelte';
  import OnePasswordCliHint from '$lib/components/OnePasswordCliHint.svelte';
  import OnePasswordToggle from '$lib/components/OnePasswordToggle.svelte';
  import Select from '$lib/components/Select.svelte';
  import { formToInput, type HostFormFields } from './hostForm';

  let {
    mode,
    initial,
    previousName,
    imported = false,
    onSubmit,
    onCancel
  }: {
    mode: 'add' | 'edit';
    initial: HostFormFields;
    previousName?: string;
    /** Editing an `~/.ssh/config` import, so the save is an adoption — say so. */
    imported?: boolean;
    onSubmit: (input: HostInputDto, previousName: string | undefined) => Promise<void>;
    onCancel: () => void;
  } = $props();

  // Seeded once from `initial`; the editor is remounted per open, so the prop never
  // changes under a live instance.
  // svelte-ignore state_referenced_locally
  let fields = $state<HostFormFields>({ ...initial });
  let error = $state<string | null>(null);
  let saving = $state(false);
  let nameEl = $state<HTMLInputElement>();
  let hostnameEl = $state<HTMLInputElement>();

  // The name is the on-disk key; a rename can't carry backend-only secrets across the
  // boundary (§3.4), so on edit it is immutable — rename by delete + re-add. Focus the
  // first editable field accordingly.
  onMount(() => (mode === 'add' ? nameEl : hostnameEl)?.focus());

  async function save(): Promise<void> {
    const result = formToInput(fields);
    if (!result.ok) {
      error = result.error;
      return;
    }
    error = null;
    saving = true;
    try {
      await onSubmit(result.input, previousName);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }

  // On edit the DTO omits identity/password (§3.4), so the fields start blank and mean
  // "keep the stored value"; on add they mean "none".
  const secretHint = $derived(mode === 'edit' ? 'Leave blank to keep the current value' : undefined);

  const label = 'block space-y-1 text-xs font-medium text-muted';
  const labelRow = 'flex items-center justify-between gap-2';
  const field =
    'w-full rounded-lg bg-surface-inset px-3 py-2 text-sm text-fg outline-none ' +
    'focus-visible:ring-2 focus-visible:ring-focus placeholder:text-faint';
</script>

<Modal label={mode === 'add' ? 'Add host' : 'Edit host'} onClose={onCancel}>
  <form
    onsubmit={(e) => {
      e.preventDefault();
      void save();
    }}
    class="flex min-h-0 flex-col"
  >
    <header class="border-b border-default px-5 py-3.5">
      <h2 class="text-sm font-semibold">{mode === 'add' ? 'Add host' : 'Edit host'}</h2>
    </header>

    <div class="min-h-0 flex-1 space-y-3.5 overflow-y-auto px-5 py-4">
      {#if imported}
        <p class="rounded-lg bg-surface-inset px-3 py-2 text-xs text-muted">
          Imported from <span class="font-mono">~/.ssh/config</span>. Saving keeps your own copy in
          <span class="font-mono">hosts.toml</span> and BetterSshClient uses it from then on — your SSH config
          file is never written, and later edits to it stop showing up for this host.
        </p>
      {/if}
      <label class={label}>
        <span>Name {mode === 'edit' ? '(fixed)' : ''}</span>
        <input
          bind:this={nameEl}
          bind:value={fields.name}
          class="{field} {mode === 'edit' ? 'cursor-not-allowed text-muted' : ''}"
          placeholder="web-prod-1"
          readonly={mode === 'edit'}
          title={mode === 'edit' ? 'To rename, delete this host and add it again' : undefined}
        />
      </label>

      <div class={label}>
        <div class={labelRow}>
          <label for="host-hostname">Hostname / IP</label>
          <OnePasswordToggle bind:on={fields.hostnameFrom1P} field="Hostname" />
        </div>
        <input
          id="host-hostname"
          bind:this={hostnameEl}
          bind:value={fields.hostname}
          class="{field} font-mono"
          placeholder={fields.hostnameFrom1P ? 'op://Servers/web-1/hostname' : '10.0.0.1'}
          spellcheck="false"
        />
      </div>

      <div class="grid grid-cols-[1fr,7rem] gap-3">
        <div class={label}>
          <div class={labelRow}>
            <label for="host-user">User</label>
            <OnePasswordToggle bind:on={fields.userFrom1P} field="User" />
          </div>
          <input
            id="host-user"
            bind:value={fields.user}
            class="{field} {fields.userFrom1P ? 'font-mono' : ''}"
            placeholder={fields.userFrom1P ? 'op://Servers/web-1/username' : 'root'}
            spellcheck="false"
          />
        </div>
        <div class={label}>
          <div class={labelRow}>
            <label for="host-port">Port</label>
            <OnePasswordToggle bind:on={fields.portFrom1P} field="Port" />
          </div>
          {#if fields.portFrom1P}
            <input
              id="host-port"
              bind:value={fields.portRef}
              class="{field} font-mono"
              placeholder="op://…/port"
              title={fields.portRef}
              spellcheck="false"
            />
          {:else}
            <input id="host-port" bind:value={fields.port} inputmode="numeric" class={field} placeholder="22" />
          {/if}
        </div>
      </div>

      <label class={label}>
        <span>Identity file</span>
        <input
          bind:value={fields.identityFile}
          class="{field} font-mono"
          placeholder={secretHint ?? '~/.ssh/id_ed25519'}
        />
      </label>

      <div class={label}>
        <div class={labelRow}>
          <label for="host-password">Password</label>
          <OnePasswordToggle bind:on={fields.passwordFrom1P} field="Password" />
        </div>
        {#if fields.passwordFrom1P}
          <input
            id="host-password"
            bind:value={fields.passwordRef}
            class="{field} font-mono"
            placeholder="op://Servers/web-1/password"
            autocomplete="off"
            spellcheck="false"
          />
        {:else}
          <input
            id="host-password"
            type="password"
            bind:value={fields.password}
            class={field}
            placeholder={secretHint ?? 'For initial key setup only'}
            autocomplete="off"
          />
        {/if}
      </div>

      {#if fields.hostnameFrom1P || fields.userFrom1P || fields.portFrom1P || fields.passwordFrom1P}
        <p class="-mt-2.5 text-xs text-faint">
          Fields marked 1Password take a secret reference and are read from 1Password when connecting (needs the
          1Password CLI). In 1Password: right-click a field → Copy Secret Reference.
        </p>
        <OnePasswordCliHint />
      {/if}

      <label class={label}>
        <span>Default path</span>
        <input
          bind:value={fields.defaultPath}
          class="{field} font-mono"
          placeholder="/var/www (optional)"
        />
      </label>
      <p class="-mt-2.5 text-xs text-faint">
        Opens a terminal or the SFTP browser already here, instead of the login directory /
        server root.
      </p>

      <label class={label}>
        <span>Startup command</span>
        <input
          bind:value={fields.startupCommand}
          class="{field} font-mono"
          placeholder="tmux attach || tmux (optional)"
          autocomplete="off"
          spellcheck="false"
        />
      </label>
      <p class="-mt-2.5 text-xs text-faint">
        Runs in every new terminal on this host, right after it connects.
      </p>

      <label class={label}>
        <span>Tags</span>
        <input bind:value={fields.tags} class={field} placeholder="prod, web" />
      </label>

      <label class={label}>
        <span>Notes</span>
        <textarea bind:value={fields.notes} rows="2" class="{field} resize-y" placeholder="Optional"></textarea>
      </label>

      <div class="grid grid-cols-2 gap-3">
        <label class={label}>
          <span>Monitoring</span>
          <Select bind:value={fields.monitoring} class={field}>
            <option value="ssh">SSH metrics</option>
            <option value="tcpPort">TCP port check</option>
          </Select>
        </label>
        {#if fields.monitoring === 'tcpPort'}
          <label class={label}>
            <span>Probe port</span>
            <input
              bind:value={fields.monitorPort}
              inputmode="numeric"
              class={field}
              placeholder={fields.portFrom1P ? 'SSH port' : fields.port || '22'}
            />
          </label>
        {/if}
      </div>
      {#if fields.monitoring === 'tcpPort'}
        <p class="text-xs text-faint">Checks the port only — no login, and no metrics on the card.</p>
      {/if}

      {#if error}
        <p class="text-xs text-status-crit">{error}</p>
      {/if}
    </div>

    <footer class="flex justify-end gap-2 border-t border-default px-5 py-3">
      <Button variant="ghost" onclick={onCancel}>Cancel</Button>
      <Button variant="primary" type="submit" disabled={saving}>
        {mode === 'add' ? 'Add host' : 'Save'}
      </Button>
    </footer>
  </form>
</Modal>
