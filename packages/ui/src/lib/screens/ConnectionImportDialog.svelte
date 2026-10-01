<script lang="ts">
  // The second step of importing an SSH-host or RDP-profile file: the file is read
  // (preview), this lists what it holds, and for every name that's taken here the user
  // picks overwrite or rename before anything is written. Passwords never come along;
  // 1Password references do, so those entries sign in through 1Password when used.
  import type { ConnectionImportEntryDto, ConnectionImportPreviewDto, ConnectionImportResultDto } from '$lib/bindings';
  import { Button, Icon } from '$lib/theme';
  import Modal from '$lib/components/Modal.svelte';
  import { applyConnectionImport, discardConnectionImport } from '$lib/ipc/commands';
  import { chooseAll, choicesProblem, entryNotes, initialChoices, toDecisions, type ImportChoices } from './connectionImport';

  let {
    title,
    preview,
    onDone,
    onCancel
  }: {
    title: string;
    preview: ConnectionImportPreviewDto;
    onDone: (result: ConnectionImportResultDto) => void;
    onCancel: () => void;
  } = $props();

  const isRdp = $derived(preview.profiles.length > 0);
  // Seeded once: the dialog is opened anew for every file.
  // svelte-ignore state_referenced_locally
  let hostChoices = $state<ImportChoices>(initialChoices(preview.hosts));
  // svelte-ignore state_referenced_locally
  let profileChoices = $state<ImportChoices>(initialChoices(preview.profiles));
  let error = $state<string | null>(null);
  let busy = $state(false);

  const usesOnePassword = $derived([...preview.hosts, ...preview.profiles].some((e) => e.references.length > 0));
  const conflicts = $derived(Object.keys(hostChoices).length + Object.keys(profileChoices).length);
  const problem = $derived(
    choicesProblem(preview.profiles, profileChoices, 'profile') ?? choicesProblem(preview.hosts, hostChoices, 'host')
  );

  function setAll(action: 'overwrite' | 'rename'): void {
    hostChoices = chooseAll(hostChoices, action);
    profileChoices = chooseAll(profileChoices, action);
  }

  function cancel(): void {
    void discardConnectionImport(preview.token);
    onCancel();
  }

  async function submit(): Promise<void> {
    if (problem) return;
    busy = true;
    error = null;
    try {
      const result = await applyConnectionImport(preview.token, {
        hosts: toDecisions(hostChoices),
        profiles: toDecisions(profileChoices)
      });
      onDone(result);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  const segment =
    'px-2.5 py-1 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';
  const input =
    'w-full rounded-lg bg-surface-inset px-3 py-1.5 text-sm text-fg outline-none ' +
    'focus-visible:ring-2 focus-visible:ring-focus placeholder:text-faint';
</script>

<Modal label={title} onClose={cancel}>
  <form
    class="flex min-h-0 flex-col"
    onsubmit={(e) => {
      e.preventDefault();
      void submit();
    }}
  >
    <div class="space-y-1 border-b border-default px-5 py-4">
      <h2 class="text-sm font-semibold">{title}</h2>
      <p class="truncate font-mono text-xs text-faint" title={preview.fileName}>{preview.fileName}</p>
      <p class="pt-1 text-xs text-muted">
        Passwords are never part of the file. Entries using 1Password sign in through it when you connect.
      </p>
      {#if usesOnePassword}
        <!-- A reference sends that item's value to the entry's host: a file from someone
             else could pair their server with an item of yours. -->
        <p class="text-xs text-status-warn">
          Check the 1Password references below: when you connect, the value of each is sent to that entry's host.
          <strong>Only import files from people you trust.</strong>
        </p>
      {/if}
    </div>

    <div class="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
      {#if conflicts > 1}
        <div class="flex items-center gap-2 text-xs text-muted">
          <span>Names already taken: {conflicts}.</span>
          <span class="ml-auto">For all:</span>
          <button type="button" class="rounded-full border border-default {segment}" onclick={() => setAll('overwrite')}>
            Overwrite
          </button>
          <button type="button" class="rounded-full border border-default {segment}" onclick={() => setAll('rename')}>
            Rename
          </button>
        </div>
      {/if}

      {#if isRdp}
        {@render group('Profiles', preview.profiles, profileChoices, (key, c) => (profileChoices = { ...profileChoices, [key]: c }))}
      {/if}
      {#if preview.hosts.length > 0}
        {@render group(
          isRdp ? 'SSH hosts the profiles tunnel through' : 'SSH hosts',
          preview.hosts,
          hostChoices,
          (key, c) => (hostChoices = { ...hostChoices, [key]: c })
        )}
      {/if}

      {#if preview.missingTunnelHosts.length > 0}
        <p class="rounded-lg bg-surface-inset px-3 py-2 text-xs text-muted" role="status">
          Not in the file and not here: {preview.missingTunnelHosts.join(', ')}. Add that SSH host before connecting
          through it.
        </p>
      {/if}
    </div>

    <div class="space-y-2 border-t border-default px-5 py-3">
      {#if error ?? problem}
        <p class="text-xs text-status-crit" role="alert">{error ?? problem}</p>
      {/if}
      <div class="flex justify-end gap-2">
        <Button variant="ghost" onclick={cancel}>Cancel</Button>
        <Button variant="primary" type="submit" disabled={busy || problem !== null}>
          {busy ? 'Importing…' : 'Import'}
        </Button>
      </div>
    </div>
  </form>
</Modal>

{#snippet group(
  heading: string,
  entries: ConnectionImportEntryDto[],
  choices: ImportChoices,
  set: (key: string, choice: ImportChoices[string]) => void
)}
  <section class="space-y-2">
    <h3 class="text-[11px] font-semibold uppercase tracking-wider text-faint">{heading}</h3>
    <ul class="space-y-2">
      {#each entries as entry (entry.key)}
        {@const choice = choices[entry.key]}
        <li class="rounded-lg border border-default px-3 py-2.5">
          <div class="flex min-w-0 items-center gap-2">
            <span class="truncate text-sm font-medium" title={entry.name}>{entry.name}</span>
            {#if entry.onePassword}
              <span
                class="inline-flex shrink-0 items-center gap-1 rounded-full border border-default px-1.5 py-0.5 text-[10px] text-faint"
                title="Read from 1Password when connecting"
              >
                <Icon name="key" size={10} />
                1Password
              </span>
            {/if}
            {#if choice}
              <span class="ml-auto shrink-0 text-[11px] text-status-warn">name taken</span>
            {/if}
          </div>
          <div class="truncate font-mono text-xs text-faint">{entry.detail}</div>
          {#each entry.references as reference (reference)}
            <div class="truncate font-mono text-[11px] text-muted" title={reference}>{reference}</div>
          {/each}
          {#if entryNotes(entry).filter((n) => n !== '1Password').length > 0}
            <div class="mt-1 text-xs text-muted">{entryNotes(entry).filter((n) => n !== '1Password').join(' · ')}</div>
          {/if}

          {#if choice}
            <div class="mt-2 flex items-center gap-2">
              <div class="inline-flex shrink-0 overflow-hidden rounded-full border border-default" role="radiogroup" aria-label="What to do with {entry.name}">
                <button
                  type="button"
                  role="radio"
                  aria-checked={choice.action === 'overwrite'}
                  class="{segment} {choice.action === 'overwrite' ? 'bg-accent text-accent-fg' : 'text-muted hover:text-fg'}"
                  onclick={() => set(entry.key, { ...choice, action: 'overwrite' })}
                >
                  Overwrite
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={choice.action === 'rename'}
                  class="{segment} {choice.action === 'rename' ? 'bg-accent text-accent-fg' : 'text-muted hover:text-fg'}"
                  onclick={() => set(entry.key, { ...choice, action: 'rename' })}
                >
                  Rename
                </button>
              </div>
              {#if choice.action === 'rename'}
                <input
                  class={input}
                  value={choice.name}
                  aria-label="New name for {entry.name}"
                  oninput={(e) => set(entry.key, { ...choice, name: e.currentTarget.value })}
                />
              {:else}
                <span class="text-xs text-faint">replaces the one here; its saved password is kept</span>
              {/if}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  </section>
{/snippet}
