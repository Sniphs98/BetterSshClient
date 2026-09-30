<script lang="ts">
  // A built-in GitHub step on the Automation canvas (AutomationEditor.svelte), laid out
  // like the upload node: label, then its own fields, edited in place via
  // `updateNodeData`. Two kinds:
  //   - Start a workflow: repository, workflow, branch, and the workflow's own inputs
  //     (read from its YAML — a `choice` input offers its options). Output: the tag of
  //     the release the run made, e.g. v1.4.2.
  //   - Download a release file: repository, release tag, which file. Output: its path
  //     on this computer, ready for an upload node.
  // Suggestions come from GitHub (githubLookups.ts); every field also takes
  // {{params.…}} and {{nodes.….output}}, which are only known when the run starts.
  import { Handle, Position, useSvelteFlow, type NodeProps } from '@xyflow/svelte';
  import type { GitHubStepDto, GitHubWorkflowInputDto } from '$lib/bindings';
  import { Icon } from '$lib/theme';
  import type { GitHubNode } from './automationCanvasTypes';
  import { branches, lookupable, repositories, workflowInputs, workflows } from './githubLookups';

  let { id, data, selected }: NodeProps<GitHubNode> = $props();
  const { updateNodeData, deleteElements } = useSvelteFlow();

  const step = $derived(data.step);
  const uid = $derived(`gh-${id}`);

  function set(patch: Partial<GitHubStepDto>): void {
    updateNodeData(id, { step: { ...step, ...patch } as GitHubStepDto });
  }

  // Suggestions, loaded as the fields they depend on are filled in.
  let repoList = $state<string[]>([]);
  let workflowList = $state<string[]>([]);
  let branchList = $state<string[]>([]);
  let inputs = $state<GitHubWorkflowInputDto[]>([]);
  let lookupError = $state<string | null>(null);

  const note = (e: unknown): void => {
    lookupError = e instanceof Error ? e.message : String(e);
  };

  function loadRepos(): void {
    if (repoList.length > 0) return;
    repositories().then((r) => ((repoList = r), (lookupError = null)), note);
  }

  $effect(() => {
    const repo = step.repo;
    if (!lookupable(repo)) return;
    if (step.action === 'runWorkflow') {
      workflows(repo).then((w) => (workflowList = w.map((x) => x.file)), note);
      branches(repo).then((b) => (branchList = b), note);
    }
  });

  // The workflow's inputs: shown as fields, defaults filled into the ones still empty.
  $effect(() => {
    if (step.action !== 'runWorkflow') return;
    const { repo, workflow } = step;
    if (!lookupable(repo) || !lookupable(workflow)) {
      inputs = [];
      return;
    }
    workflowInputs(repo, workflow).then((found) => {
      inputs = found;
      if (step.action !== 'runWorkflow') return;
      const missing = found.filter((i) => i.default != null && step.inputs[i.name] === undefined);
      if (missing.length > 0) {
        set({ inputs: { ...step.inputs, ...Object.fromEntries(missing.map((i) => [i.name, i.default as string])) } });
      }
    }, note);
  });

  // Inputs saved earlier but no longer in the workflow still show, so none vanish unseen.
  const inputNames = $derived(
    step.action === 'runWorkflow' ? [...new Set([...inputs.map((i) => i.name), ...Object.keys(step.inputs)])] : []
  );

  const input =
    'nodrag w-full rounded bg-surface-inset px-2 py-1 font-mono text-xs text-fg outline-none ' +
    'focus-visible:ring-2 focus-visible:ring-focus placeholder:text-faint';
</script>

<div class="w-56 space-y-2 rounded-lg border bg-surface p-3 text-left shadow-sm {selected ? 'border-accent' : 'border-default'}">
  <Handle type="target" position={Position.Left} />

  <div class="flex items-center gap-1.5">
    <input
      value={data.label}
      oninput={(e) => updateNodeData(id, { label: e.currentTarget.value })}
      class="nodrag min-w-0 flex-1 rounded bg-surface-inset px-2 py-1 font-mono text-xs text-fg outline-none focus-visible:ring-2 focus-visible:ring-focus"
      placeholder="label"
      aria-label="Label"
    />
    <button
      type="button"
      class="nodrag nopan grid h-6 w-6 shrink-0 place-items-center rounded text-muted transition hover:bg-surface-inset hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
      title="Remove node"
      aria-label="Remove {data.label || 'node'}"
      onclick={() => void deleteElements({ nodes: [{ id }] })}
    >
      <Icon name="trash" size={13} />
    </button>
  </div>

  <div class="flex items-center gap-1.5 text-[11px] text-muted">
    <Icon name={step.action === 'runWorkflow' ? 'play' : 'download'} size={12} />
    {step.action === 'runWorkflow' ? 'Start a GitHub workflow' : 'Download a GitHub release file'}
  </div>

  <label class="block space-y-0.5 text-[11px] text-muted">
    <span>Repository</span>
    <input
      value={step.repo}
      oninput={(e) => set({ repo: e.currentTarget.value })}
      onfocus={loadRepos}
      list="{uid}-repos"
      class={input}
      placeholder="owner/name"
      spellcheck="false"
    />
    <datalist id="{uid}-repos">{#each repoList as r (r)}<option value={r}></option>{/each}</datalist>
  </label>

  {#if step.action === 'runWorkflow'}
    <label class="block space-y-0.5 text-[11px] text-muted">
      <span>Workflow</span>
      <input value={step.workflow} oninput={(e) => set({ workflow: e.currentTarget.value })} list="{uid}-wf" class={input} placeholder="release.yml" spellcheck="false" />
      <datalist id="{uid}-wf">{#each workflowList as w (w)}<option value={w}></option>{/each}</datalist>
    </label>
    <label class="block space-y-0.5 text-[11px] text-muted">
      <span>Branch</span>
      <input value={step.ref} oninput={(e) => set({ ref: e.currentTarget.value })} list="{uid}-br" class={input} placeholder="main" spellcheck="false" />
      <datalist id="{uid}-br">{#each branchList as b (b)}<option value={b}></option>{/each}</datalist>
    </label>
    {#each inputNames as name (name)}
      {@const spec = inputs.find((i) => i.name === name)}
      <label class="block space-y-0.5 text-[11px] text-muted" title={spec?.description ?? undefined}>
        <span>{name}{spec?.required ? ' *' : ''}</span>
        <input
          value={step.inputs[name] ?? ''}
          oninput={(e) => step.action === 'runWorkflow' && set({ inputs: { ...step.inputs, [name]: e.currentTarget.value } })}
          list="{uid}-in-{name}"
          class={input}
          placeholder={spec?.options?.join(' / ') ?? ''}
          spellcheck="false"
          aria-label="Input {name}"
        />
        {#if spec?.options}
          <datalist id="{uid}-in-{name}">{#each spec.options as o (o)}<option value={o}></option>{/each}</datalist>
        {/if}
      </label>
    {/each}
  {:else}
    <label class="block space-y-0.5 text-[11px] text-muted">
      <span>Release tag</span>
      <input value={step.tag} oninput={(e) => set({ tag: e.currentTarget.value })} class={input} placeholder={'{{nodes.release.output}}'} spellcheck="false" />
    </label>
    <label class="block space-y-0.5 text-[11px] text-muted">
      <span>File</span>
      <input value={step.pattern} oninput={(e) => set({ pattern: e.currentTarget.value })} class={input} placeholder="*.tar.gz" spellcheck="false" />
    </label>
  {/if}

  {#if lookupError}
    <p class="text-[10px] text-faint" title={lookupError}>No suggestions from GitHub — check Settings → GitHub.</p>
  {/if}

  <label class="nodrag flex items-center gap-1.5 text-[11px] text-muted">
    <input
      type="checkbox"
      checked={data.continueOnError}
      onchange={(e) => updateNodeData(id, { continueOnError: e.currentTarget.checked })}
      class="accent-current"
    />
    Continue on error
  </label>

  <Handle type="source" position={Position.Right} />
</div>
