<script lang="ts">
  // Add/edit form for a remote-desktop connection profile. Validation mirrors
  // `remoteDesktopForm.ts`'s `formToInput`; on submit the parent persists + refreshes,
  // and a rejected save surfaces inline without closing. Only 'rdp' is reachable this
  // round (see remoteDesktopForm.ts) — no protocol picker yet.
  import { onMount } from 'svelte';
  import type { RemoteDesktopConnectionInputDto } from '$lib/bindings';
  import { Button, Icon } from '$lib/theme';
  import Modal from '$lib/components/Modal.svelte';
  import Select from '$lib/components/Select.svelte';
  import Switch from '$lib/components/Switch.svelte';
  import OnePasswordCliHint from '$lib/components/OnePasswordCliHint.svelte';
  import OnePasswordToggle from '$lib/components/OnePasswordToggle.svelte';
  import { hosts } from '$lib/stores/hosts';
  import { remoteDesktopConnections } from '$lib/stores/remoteDesktop';
  import { rdpKeptFolders } from '$lib/stores/dashboardLayout';
  import { folderNames } from './dashboardSections';
  import { describeSettings, formToInput, type RemoteDesktopFormFields } from './remoteDesktopForm';

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

  // Changed since the dialog opened: closing it by accident then asks first (Modal).
  // svelte-ignore state_referenced_locally
  const opened = JSON.stringify(initial);
  const dirty = $derived(JSON.stringify(fields) !== opened);
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

  // The folders already in use, offered as suggestions; typing a new name makes a new one.
  const folders = $derived(
    folderNames([...$remoteDesktopConnections, ...$rdpKeptFolders.map((folder) => ({ folder }))])
  );

  // Shown under the section's title: what's set, in one line.
  const settingsSummary = $derived(describeSettings(fields).join(' · '));

  // Windows asks before sharing drives from a .rdp file (see core/rdp/launch.ts).
  const onWindows = typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent);

  const label = 'block space-y-1 text-xs font-medium text-muted';
  const labelRow = 'flex items-center justify-between gap-2';
  const row = 'flex items-center justify-between gap-4 px-3.5 py-3';
  // The two columns are matching cards of equal height.
  const card = 'flex flex-col rounded-xl border border-default bg-surface-inset/40';
  const cardHeader = 'flex items-center gap-3 px-4 py-3';
  const cardIcon = 'grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-surface-inset text-muted';
  const field =
    'w-full rounded-lg bg-surface-inset px-3 py-2 text-sm text-fg outline-none ' +
    'focus-visible:ring-2 focus-visible:ring-focus placeholder:text-faint';
</script>

<Modal
  label={mode === 'add' ? 'New RDP connection' : 'Edit RDP connection'}
  size="large"
  onClose={onCancel}
  dirty={dirty && !saving}
  onSave={save}
>
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

    <!-- Two columns side by side where there's room (screens are wider than tall):
         the connection on the left, display & devices on the right. Stacked otherwise. -->
    <div class="grid min-h-0 flex-1 gap-4 overflow-y-auto px-5 py-4 md:grid-cols-2">
    <section class={card} aria-labelledby="rdp-connection-title">
      <div class={cardHeader}>
        <span class={cardIcon}><Icon name="key" size={15} /></span>
        <span class="min-w-0 flex-1">
          <span id="rdp-connection-title" class="block text-sm font-medium">Connection</span>
          <span class="block truncate text-xs text-faint">Where to connect and how to sign in</span>
        </span>
      </div>
    <div class="space-y-3.5 border-t border-default px-4 pb-4 pt-4">
      <div class="grid grid-cols-2 gap-3">
        <label class={label}>
          <span>Name</span>
          <input bind:this={nameEl} bind:value={fields.name} class={field} placeholder="office-pc" />
        </label>
        <label class={label}>
          <span>Folder</span>
          <input
            bind:value={fields.folder}
            list="rdp-folders"
            class={field}
            placeholder="Optional"
            autocomplete="off"
          />
          <datalist id="rdp-folders">
            {#each folders as name (name)}
              <option value={name}></option>
            {/each}
          </datalist>
        </label>
      </div>

      <div class="grid grid-cols-[1fr,7rem] gap-3">
        <div class={label}>
          <div class={labelRow}>
            <label for="rdp-hostname">Hostname / IP</label>
            <OnePasswordToggle bind:on={fields.hostnameFrom1P} field="Hostname" />
          </div>
          <input
            id="rdp-hostname"
            bind:value={fields.hostname}
            class="{field} font-mono"
            placeholder={fields.hostnameFrom1P ? 'op://Servers/office-pc/hostname' : '10.0.0.5'}
            spellcheck="false"
          />
        </div>
        <div class={label}>
          <div class={labelRow}>
            <label for="rdp-port">Port</label>
            <OnePasswordToggle bind:on={fields.portFrom1P} field="Port" />
          </div>
          {#if fields.portFrom1P}
            <input
              id="rdp-port"
              bind:value={fields.portRef}
              class="{field} font-mono"
              placeholder="op://…/port"
              title={fields.portRef}
              spellcheck="false"
            />
          {:else}
            <input id="rdp-port" bind:value={fields.port} inputmode="numeric" class={field} placeholder="3389" />
          {/if}
        </div>
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

      <div class="border-t border-default pt-3.5 text-[11px] font-semibold uppercase tracking-wider text-faint">Sign-in</div>

      <div class="grid grid-cols-2 gap-3">
        <div class={label}>
          <div class={labelRow}>
            <label for="rdp-username">Username</label>
            <OnePasswordToggle bind:on={fields.usernameFrom1P} field="Username" />
          </div>
          <input
            id="rdp-username"
            bind:value={fields.username}
            class="{field} {fields.usernameFrom1P ? 'font-mono' : ''}"
            placeholder={fields.usernameFrom1P ? 'op://Servers/office-pc/username' : 'admin'}
            spellcheck="false"
          />
        </div>
        <div class={label}>
          <div class={labelRow}>
            <label for="rdp-domain">Domain</label>
            <OnePasswordToggle bind:on={fields.domainFrom1P} field="Domain" />
          </div>
          <input
            id="rdp-domain"
            bind:value={fields.domain}
            class="{field} {fields.domainFrom1P ? 'font-mono' : ''}"
            placeholder={fields.domainFrom1P ? 'op://Servers/office-pc/domain' : 'Optional'}
            spellcheck="false"
          />
        </div>
      </div>

      <div class={label}>
        <div class={labelRow}>
          <label for="rdp-password">Password</label>
          <OnePasswordToggle bind:on={fields.passwordFrom1P} field="Password" />
        </div>
        {#if fields.passwordFrom1P}
          <input
            id="rdp-password"
            bind:value={fields.passwordRef}
            class="{field} font-mono"
            placeholder="op://Servers/office-pc/password"
            autocomplete="off"
            spellcheck="false"
          />
        {:else}
          <input
            id="rdp-password"
            type="password"
            bind:value={fields.password}
            class={field}
            placeholder={secretHint ?? 'Optional — you can also enter it at connect time'}
            autocomplete="off"
          />
        {/if}
      </div>

      {#if fields.hostnameFrom1P || fields.portFrom1P || fields.usernameFrom1P || fields.domainFrom1P || fields.passwordFrom1P}
        <p class="-mt-2 text-xs text-faint">
          Fields marked 1Password take a secret reference and are read from 1Password when connecting (needs the
          1Password CLI). In 1Password: right-click a field → Copy Secret Reference.
        </p>
        <OnePasswordCliHint />
      {/if}
    </div>
    </section>

      <section class={card} aria-labelledby="rdp-display-devices-title">
        <div class={cardHeader}>
          <span class={cardIcon}><Icon name="monitor" size={15} /></span>
          <span class="min-w-0 flex-1">
            <span id="rdp-display-devices-title" class="block text-sm font-medium">Display &amp; devices</span>
            <span class="block truncate text-xs text-faint">{settingsSummary}</span>
          </span>
        </div>
        <div class="space-y-4 border-t border-default px-4 pb-4 pt-4">
          <div class="grid grid-cols-2 gap-3">
            <label class={label}>
              <span>Display</span>
              <Select bind:value={fields.display} class={field}>
                <option value="">Client default</option>
                <option value="fullscreen">Full screen</option>
                <option value="fit">Fit to screen</option>
                <option value="window">Window</option>
              </Select>
            </label>
            <label class={label}>
              <span>Sound</span>
              <Select bind:value={fields.audio} class={field}>
                <option value="local">On this computer</option>
                <option value="remote">On the remote computer</option>
                <option value="off">Don't play</option>
              </Select>
            </label>
            {#if fields.display === 'window'}
              <label class={label}>
                <span>Width</span>
                <input bind:value={fields.width} inputmode="numeric" class={field} placeholder="1600" />
              </label>
              <label class={label}>
                <span>Height</span>
                <input bind:value={fields.height} inputmode="numeric" class={field} placeholder="900" />
              </label>
            {/if}
          </div>

          <div class="divide-y divide-[var(--border)] rounded-lg bg-surface-inset/60">
            <div class={row}>
              <div class="min-w-0">
                <p class="text-sm">Resize with the window</p>
                <p class="text-xs text-muted">
                  The remote resolution follows the window, so there are never scrollbars.{#if onWindows}{" "}
                    Windows then shows its security prompt each time.{/if}
                </p>
              </div>
              <Switch bind:checked={fields.dynamicResolution} label="Resize with the window" />
            </div>
            <div class={row}>
              <div class="min-w-0">
                <p class="text-sm">Use all my monitors</p>
                <p class="text-xs text-muted">The remote desktop spans every screen.</p>
              </div>
              <Switch bind:checked={fields.multiMonitor} label="Use all my monitors" />
            </div>
            <div class={row}>
              <div class="min-w-0">
                <p class="text-sm">Share the clipboard</p>
                <p class="text-xs text-muted">Copy here, paste there — and back.</p>
              </div>
              <Switch bind:checked={fields.clipboard} label="Share the clipboard" />
            </div>
            <div class={row}>
              <div class="min-w-0">
                <p class="text-sm">Share my drives</p>
                <p class="text-xs text-muted">
                  Your local drives show up on the remote computer.{#if onWindows}{" "}
                    Windows asks each time: tick <span class="text-fg">Drives</span> in its security prompt.{/if}
                </p>
              </div>
              <Switch bind:checked={fields.drives} label="Share my drives" />
            </div>
          </div>
        </div>
      </section>
    </div>

    {#if error}
      <p class="px-5 pb-3 text-xs text-status-crit">{error}</p>
    {/if}

    <footer class="flex justify-end gap-2 border-t border-default px-5 py-3">
      <Button variant="ghost" onclick={onCancel}>Cancel</Button>
      <Button variant="primary" type="submit" disabled={saving}>
        {mode === 'add' ? 'Add connection' : 'Save'}
      </Button>
    </footer>
  </form>
</Modal>
