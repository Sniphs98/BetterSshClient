<script lang="ts">
  // Settings → GitHub: how the app signs in for the automation's GitHub steps (start a
  // workflow, download a release file). A 1Password reference when switched on, else a
  // token kept in the app, encrypted like host passwords; "Test connection" says who
  // that is and, given a repository, whether it can see it. The token never comes back
  // from the app — only whether one is stored.
  import { onMount } from 'svelte';
  import { Surface, Icon } from '$lib/theme';
  import OnePasswordToggle from './OnePasswordToggle.svelte';
  import OnePasswordCliHint from './OnePasswordCliHint.svelte';
  import { githubSaveSettings, githubSettings, githubTest } from '$lib/ipc/commands';
  import { openExternal } from '$lib/ipc/openExternal';

  let loaded = $state(false);
  let hasToken = $state(false);
  let from1P = $state(false);
  let tokenRef = $state('');
  let token = $state('');
  let saving = $state(false);
  let testRepo = $state('');
  let status = $state<{ kind: 'idle' } | { kind: 'busy' } | { kind: 'ok'; text: string } | { kind: 'error'; text: string }>({ kind: 'idle' });

  onMount(async () => {
    try {
      const s = await githubSettings();
      hasToken = s.hasToken;
      tokenRef = s.tokenRef ?? '';
      from1P = Boolean(s.tokenRef);
    } catch {
      // Not under Electron: the section shows, empty.
    }
    loaded = true;
  });

  const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

  async function save(): Promise<void> {
    saving = true;
    status = { kind: 'idle' };
    try {
      await githubSaveSettings(from1P ? { tokenRef } : { token: token || undefined, tokenRef: '' });
      if (!from1P && token) hasToken = true;
      if (from1P) tokenRef = tokenRef.trim();
      token = '';
      await test();
    } catch (e) {
      status = { kind: 'error', text: message(e) };
    } finally {
      saving = false;
    }
  }

  async function forgetToken(): Promise<void> {
    await githubSaveSettings({ clearToken: true, tokenRef: from1P ? tokenRef : '' });
    hasToken = false;
    status = { kind: 'idle' };
  }

  async function test(): Promise<void> {
    status = { kind: 'busy' };
    try {
      const r = await githubTest(testRepo.trim() || undefined);
      status = {
        kind: 'ok',
        text: r.repository
          ? `Signed in as ${r.login} — can see ${r.repository.fullName}${r.repository.private ? ' (private)' : ''}.`
          : `Signed in as ${r.login}.`
      };
    } catch (e) {
      status = { kind: 'error', text: message(e) };
    }
  }

  const TOKEN_HELP = 'https://github.com/settings/personal-access-tokens/new';
  const field =
    'w-full rounded-lg bg-surface-inset px-3 py-2 text-sm text-fg outline-none placeholder:text-faint focus-visible:ring-2 focus-visible:ring-focus';
  const pill =
    'inline-flex shrink-0 items-center gap-1.5 rounded-full border border-strong px-4 py-1.5 text-sm text-fg transition hover:bg-accent hover:text-accent-fg disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';
</script>

<Surface class="p-5">
  <h2 class="mb-1 text-sm font-semibold">GitHub</h2>
  <p class="mb-4 text-xs text-muted">
    For automations that start a workflow or download a release file. A fine-grained token for the repository with
    <span class="text-fg">Actions: read and write</span> and <span class="text-fg">Contents: read</span> does it.
    <button type="button" class="underline decoration-dotted hover:text-fg" onclick={() => void openExternal(TOKEN_HELP)}>Create one</button>
  </p>

  <div class="space-y-3">
    <div class="block space-y-1 text-xs font-medium text-muted">
      <div class="flex items-center justify-between gap-2">
        <label for="github-token">Token</label>
        <OnePasswordToggle bind:on={from1P} field="Token" />
      </div>
      {#if from1P}
        <input id="github-token" bind:value={tokenRef} class="{field} font-mono" placeholder="op://Private/GitHub/token" spellcheck="false" autocomplete="off" />
      {:else}
        <input
          id="github-token"
          type="password"
          bind:value={token}
          class={field}
          placeholder={hasToken ? 'Saved — leave blank to keep it' : 'github_pat_…'}
          autocomplete="off"
        />
      {/if}
    </div>
    {#if from1P && tokenRef.trim()}
      <OnePasswordCliHint />
    {/if}

    <label class="block space-y-1 text-xs font-medium text-muted">
      <span>Check access to a repository (optional)</span>
      <input bind:value={testRepo} class="{field} font-mono" placeholder="Enable-Energy-Solutions/Frontend" spellcheck="false" />
    </label>

    <div class="flex flex-wrap items-center gap-2 pt-1">
      <button type="button" class={pill} disabled={!loaded || saving} onclick={save}>
        <Icon name="check" size={14} />
        Save and test
      </button>
      <button type="button" class={pill} disabled={!loaded || status.kind === 'busy'} onclick={test}>
        <Icon name="refresh" size={14} />
        Test connection
      </button>
      {#if hasToken && !from1P}
        <button type="button" class="text-xs text-muted underline decoration-dotted hover:text-fg" onclick={forgetToken}>
          Forget the saved token
        </button>
      {/if}
    </div>

    {#if status.kind === 'busy'}
      <p class="text-xs text-muted">Asking GitHub…</p>
    {:else if status.kind === 'ok'}
      <p class="flex items-center gap-1.5 text-xs text-status-ok"><Icon name="check" size={12} />{status.text}</p>
    {:else if status.kind === 'error'}
      <p class="text-xs text-status-crit">{status.text}</p>
    {/if}
  </div>
</Surface>
