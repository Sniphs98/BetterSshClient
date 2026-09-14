<script lang="ts">
  // Add/edit Flow form: a v1, non-canvas graph builder — add nodes by picking from the
  // Automation library, wire dependencies via a "depends on" chip picker per node
  // (there's no reusable multi-select component to reach for, so this mirrors
  // SnippetRunner.svelte's inline-checkbox pattern instead). Structural validation
  // (unknown automation, a cycle, a template reference that isn't a direct dependency,
  // …) happens server-side in `validateFlow` (core/automation/engine.ts) — this stays a
  // plain UI package with no dependency on the electron package's code, so a rejected
  // save just surfaces that message inline, the same as any other form here.
  import { onMount } from 'svelte';
  import type { FlowDto, FlowEdgeDto } from '$lib/bindings';
  import { Button, Icon, Surface } from '$lib/theme';
  import Modal from '$lib/components/Modal.svelte';
  import Select from '$lib/components/Select.svelte';
  import { automations } from '$lib/stores/automations';

  interface EditableNode {
    id: string;
    automationId: string;
    label: string;
    continueOnError: boolean;
  }

  let {
    mode,
    initial,
    onSubmit,
    onCancel
  }: {
    mode: 'add' | 'edit';
    initial: FlowDto;
    onSubmit: (flow: FlowDto) => Promise<void>;
    onCancel: () => void;
  } = $props();

  // Seeded once from `initial`; the editor is remounted per open, so the prop never
  // changes under a live instance.
  // svelte-ignore state_referenced_locally
  let name = $state(initial.name);
  // svelte-ignore state_referenced_locally
  let nodes = $state<EditableNode[]>(initial.nodes.map((n) => ({ ...n })));
  // svelte-ignore state_referenced_locally
  let edges = $state<FlowEdgeDto[]>(initial.edges.map((e) => ({ ...e })));
  let addAutomationId = $state('');
  let error = $state<string | null>(null);
  let saving = $state(false);
  let nameEl = $state<HTMLInputElement>();

  onMount(() => nameEl?.focus());

  function dependsOn(nodeId: string): Set<string> {
    return new Set(edges.filter((e) => e.to === nodeId).map((e) => e.from));
  }

  function toggleDependency(nodeId: string, dependsOnId: string): void {
    const has = edges.some((e) => e.from === dependsOnId && e.to === nodeId);
    edges = has ? edges.filter((e) => !(e.from === dependsOnId && e.to === nodeId)) : [...edges, { from: dependsOnId, to: nodeId }];
  }

  function uniqueLabel(base: string): string {
    const slug = base.trim() || 'node';
    if (!nodes.some((n) => n.label === slug)) return slug;
    let i = 2;
    while (nodes.some((n) => n.label === `${slug}-${i}`)) i += 1;
    return `${slug}-${i}`;
  }

  function addNode(): void {
    const automation = $automations.find((a) => a.id === addAutomationId);
    if (!automation) return;
    nodes = [...nodes, { id: crypto.randomUUID(), automationId: automation.id, label: uniqueLabel(automation.name), continueOnError: false }];
    addAutomationId = '';
  }

  function removeNode(id: string): void {
    nodes = nodes.filter((n) => n.id !== id);
    edges = edges.filter((e) => e.from !== id && e.to !== id);
  }

  async function save(): Promise<void> {
    const flowName = name.trim();
    if (!flowName) {
      error = 'Name cannot be empty';
      return;
    }
    if (nodes.length === 0) {
      error = 'Add at least one node';
      return;
    }
    const labels = nodes.map((n) => n.label.trim());
    if (labels.some((l) => !l)) {
      error = 'Every node needs a label';
      return;
    }
    if (new Set(labels).size !== labels.length) {
      error = 'Node labels must be unique within the flow';
      return;
    }

    const flow: FlowDto = {
      name: flowName,
      nodes: nodes.map((n) => ({ id: n.id, automationId: n.automationId, label: n.label.trim(), continueOnError: n.continueOnError })),
      edges: [...edges]
    };
    error = null;
    saving = true;
    try {
      await onSubmit(flow);
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
  const iconBtn =
    'grid h-7 w-7 shrink-0 place-items-center rounded text-muted transition hover:bg-surface-inset ' +
    'hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';
</script>

<Modal label={mode === 'add' ? 'New flow' : 'Edit flow'} size="large" onClose={onCancel}>
  <div class="flex min-h-0 flex-1 flex-col">
    <header class="border-b border-default px-5 py-3.5">
      <h2 class="text-sm font-semibold">{mode === 'add' ? 'New flow' : 'Edit flow'}</h2>
    </header>

    <div class="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
      <label class={label}>
        <span>Name</span>
        <input bind:this={nameEl} bind:value={name} class={field} placeholder="Deploy to prod" />
      </label>

      <div class="space-y-2">
        <h3 class="text-[11px] font-medium uppercase tracking-[0.18em] text-faint">Nodes</h3>

        {#if nodes.length === 0}
          <p class="text-sm text-muted">No nodes yet — add one below.</p>
        {/if}

        {#each nodes as node (node.id)}
          {@const automation = $automations.find((a) => a.id === node.automationId)}
          <Surface class="space-y-2.5 p-3">
            <div class="flex items-center gap-2">
              <input bind:value={node.label} class="{field} flex-1 font-mono text-xs" placeholder="label" aria-label="Label" />
              <span class="min-w-0 shrink truncate text-xs text-muted" title={automation?.name}>
                {automation ? `${automation.name} · ${automation.kind}` : 'unknown automation'}
              </span>
              <button
                type="button"
                class={iconBtn}
                title="Remove node"
                aria-label="Remove {node.label || 'node'}"
                onclick={() => removeNode(node.id)}
              >
                <Icon name="trash" size={14} />
              </button>
            </div>

            <label class="flex items-center gap-2 text-xs text-muted">
              <input type="checkbox" bind:checked={node.continueOnError} class="accent-current" />
              Let dependents run even if this node fails
            </label>

            {#if nodes.length > 1}
              <div class="space-y-1">
                <span class="text-[11px] font-medium uppercase tracking-[0.14em] text-faint">Depends on</span>
                <div class="flex flex-wrap gap-1.5">
                  {#each nodes.filter((n) => n.id !== node.id) as other (other.id)}
                    {@const checked = dependsOn(node.id).has(other.id)}
                    <button
                      type="button"
                      role="checkbox"
                      aria-checked={checked}
                      aria-label="{node.label || 'node'} depends on {other.label || 'node'}"
                      class="rounded-full border px-2.5 py-1 text-xs transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus
                        {checked ? 'border-accent bg-accent text-accent-fg' : 'border-default text-muted hover:border-strong'}"
                      onclick={() => toggleDependency(node.id, other.id)}
                    >
                      {other.label || 'node'}
                    </button>
                  {/each}
                </div>
              </div>
            {/if}
          </Surface>
        {/each}

        <div class="flex items-center gap-2 pt-1">
          <Select bind:value={addAutomationId} class={field}>
            <option value="" disabled selected>Add an automation…</option>
            {#each $automations as a (a.id)}
              <option value={a.id}>{a.name} ({a.kind})</option>
            {/each}
          </Select>
          <Button variant="secondary" onclick={addNode} disabled={!addAutomationId}>Add</Button>
        </div>
        {#if $automations.length === 0}
          <p class="text-xs text-faint">No automations yet — create one first.</p>
        {/if}
      </div>

      {#if error}
        <p class="text-xs text-status-crit">{error}</p>
      {/if}
    </div>

    <footer class="flex justify-end gap-2 border-t border-default px-5 py-3">
      <Button variant="ghost" onclick={onCancel}>Cancel</Button>
      <Button variant="primary" onclick={save} disabled={saving}>
        {mode === 'add' ? 'Add flow' : 'Save'}
      </Button>
    </footer>
  </div>
</Modal>
