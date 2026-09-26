<script lang="ts">
  // A single Automation, full-page: the canvas needs the room a modal can't give it. Reached
  // via `activeEntity.selectAutomation(name | null)` and rendered by +page.svelte as another
  // selector (tech-gui.md §2) — it occupies the whole content area, sidebar and status
  // bar excluded, same chrome every other selector gets for free. Nodes are placed and
  // wired directly on an actual svelte-flow canvas: click a node's source (right) dot
  // then another's target (left) dot to add a dependency edge (or drag between them).
  // Structural validation (unknown snippet, a cycle, a template reference that
  // isn't a direct dependency, …) happens server-side in `validateAutomation`
  // (core/automation/engine.ts) — this stays a plain UI package with no dependency on
  // the electron package's code, so a rejected save just surfaces that message inline.
  // `AutomationNode.position` (already part of the DTO) is what makes a layout persist
  // across reopens instead of re-flowing every time.
  //
  // Parameters (`AutomationParam`) are values collected right before the automation runs rather
  // than baked into any snippet node — at most one `'host'`-kind, whose run-time
  // value is the target for every remote snippet node in this automation, plus any
  // number of `'text'`-kind ones substituted via `{{params.<name>}}`. This is what
  // lets one automation definition run identically against different hosts. They're drawn
  // as the graph's own permanent "Start" node (AutomationStartNode.svelte) rather than a
  // toolbar above the canvas — see automationCanvasTypes.ts's note on `START_NODE_ID`.
  import { onMount, setContext } from 'svelte';
  import { SvelteFlow, Background, BackgroundVariant, Controls, type Connection, type OnConnectEnd } from '@xyflow/svelte';
  import '@xyflow/svelte/dist/style.css';
  import type { SnippetDto, AutomationDto, AutomationParamDto, AutomationParamKindDto } from '$lib/bindings';
  import { Button, Icon } from '$lib/theme';
  import { snippets, automations } from '$lib/stores/automations';
  import { listSnippets, listAutomations, saveSnippet, saveAutomation } from '$lib/ipc/commands';
  import { activeEntity } from '$lib/stores/activeEntity';
  import { palette } from '$lib/stores/palette';
  import { theme } from '$lib/stores/theme';
  import AutomationCanvasNode from './AutomationCanvasNode.svelte';
  import AutomationStartNode from './AutomationStartNode.svelte';
  import AutomationUploadNode from './AutomationUploadNode.svelte';
  import SnippetEditor from './SnippetEditor.svelte';
  import { emptyForm, formFromSnippet } from './snippetForm';
  import {
    AUTOMATION_NODE_ACTIONS_CONTEXT,
    AUTOMATION_PARAMS_CONTEXT,
    START_NODE_ID,
    type AnyCanvasNode,
    type AutomationCanvasEdge,
    type SnippetNode,
    type StepNode,
    type UploadNode,
    type AutomationNodeActionsContext,
    type StartNode
  } from './automationCanvasTypes';

  /** `null` opens a fresh, unsaved automation; a name loads that existing Automation from the
   *  `automations` store (already loaded by Snippets.svelte before navigation ever gets
   *  here). +page.svelte keys this component on `automationName`, so a switch between two
   *  automations (or from an existing one to a new draft) always gets a fresh instance —
   *  the "seeded once" state below never has to react to a changed prop. */
  let { automationName }: { automationName: string | null } = $props();

  // svelte-ignore state_referenced_locally
  const existing = automationName ? $automations.find((f) => f.name === automationName) : undefined;
  const mode: 'add' | 'edit' = existing ? 'edit' : 'add';
  const initial: AutomationDto = existing ?? { name: '', params: [], nodes: [], edges: [] };
  // A name was passed but no longer matches anything in the store (deleted from
  // elsewhere between listing and opening) — surface that instead of silently
  // presenting an empty "new automation" draft under the old name.
  // svelte-ignore state_referenced_locally
  const notFound = automationName !== null && existing === undefined;

  const nodeTypes = { snippet: AutomationCanvasNode, upload: AutomationUploadNode, start: AutomationStartNode };

  /** A simple left-to-right, wrapping grid — used only for a node that has no saved
   *  `position` yet (freshly added, or an automation saved before positions existed). */
  function layoutPosition(index: number): { x: number; y: number } {
    return { x: 60 + (index % 4) * 230, y: 60 + Math.floor(index / 4) * 150 };
  }

  function isSnippetNode(n: AnyCanvasNode): n is SnippetNode {
    return n.type === 'snippet';
  }

  /** Every node that is saved as an `AutomationNode` — snippets and upload steps. */
  function isStepNode(n: AnyCanvasNode): n is StepNode {
    return n.type === 'snippet' || n.type === 'upload';
  }

  const startNode: StartNode = {
    id: START_NODE_ID,
    type: 'start',
    position: { x: -280, y: 60 },
    data: {},
    deletable: false,
    selectable: false
  };

  let name = $state(initial.name);
  let params = $state<AutomationParamDto[]>(initial.params.map((p) => ({ ...p })));
  let canvasNodes = $state<AnyCanvasNode[]>([
    startNode,
    ...initial.nodes.map((n, i): StepNode => {
      if (n.upload) {
        return {
          id: n.id,
          type: 'upload' as const,
          position: n.position ?? layoutPosition(i),
          data: { label: n.label, continueOnError: n.continueOnError, from: n.upload.from, to: n.upload.to }
        };
      }
      const snippet = $snippets.find((a) => a.id === n.snippetId);
      return {
        id: n.id,
        type: 'snippet' as const,
        position: n.position ?? layoutPosition(i),
        data: {
          snippetId: n.snippetId,
          label: n.label,
          continueOnError: n.continueOnError,
          snippetName: snippet?.name ?? 'unknown snippet',
          target: n.target
        }
      };
    })
  ]);
  /** A decorative "params automation in from here" line, never a real `AutomationEdge` — see
   *  automationCanvasTypes.ts's note on `START_NODE_ID`. Dashed + faded so it reads as
   *  cosmetic rather than a dependency, the same visual language a disabled control
   *  elsewhere in this app uses for "present but not load-bearing". */
  function startLinkEdge(targetId: string): AutomationCanvasEdge {
    return {
      id: `${START_NODE_ID}->${targetId}`,
      source: START_NODE_ID,
      target: targetId,
      style: 'stroke-dasharray: 4 4; opacity: 0.55;'
    };
  }

  let canvasEdges = $state<AutomationCanvasEdge[]>([
    ...initial.edges.map((e) => ({ id: `${e.from}->${e.to}`, source: e.from, target: e.to })),
    // Dropping a link to a node id that no longer exists (the Snippet/node was
    // deleted since this was last saved) rather than letting svelte-flow choke on an
    // edge with a dangling target.
    ...(initial.startLinks ?? [])
      .filter((targetId) => initial.nodes.some((n) => n.id === targetId))
      .map(startLinkEdge)
  ]);
  /** Where a newly picked/created Snippet lands: `position` is a drag-to-empty
   *  drop's flow coordinates (`null` for the toolbar's "+" button, which just appends
   *  at a default grid spot), `wireFrom` is the node the drag started at (`null` for
   *  the "+" button — nothing to wire). Shared by every way a node gets added. */
  interface NodePlacement {
    position: { x: number; y: number } | null;
    wireFrom: string | null;
  }

  // The "+ New snippet…" row inside the picker — opens the same add-snippet form
  // the library screen uses; on save, the new Snippet is placed as a node using the
  // `target` it was opened with (still known here, carried over from that call).
  let newSnippetDialog = $state<{ id: string; placement: NodePlacement } | null>(null);
  let error = $state<string | null>(null);
  let saving = $state(false);
  let nameEl = $state<HTMLInputElement>();

  // Editing a node's underlying Snippet (its command/kind/timeout, not just this
  // node's label or wiring) reuses the library's own SnippetEditor modal rather than
  // a second form — opened via AUTOMATION_NODE_ACTIONS_CONTEXT from AutomationCanvasNode's
  // double-click/edit button. Looked up from the live `snippets` store (not
  // snapshotted onto the node) so the form always shows the current definition.
  let editingSnippetId = $state<string | null>(null);
  const editingSnippet = $derived($snippets.find((a) => a.id === editingSnippetId) ?? null);

  setContext<AutomationNodeActionsContext>(AUTOMATION_NODE_ACTIONS_CONTEXT, {
    editSnippet: (snippetId: string) => {
      editingSnippetId = snippetId;
    }
  });

  async function submitSnippetEdit(snippet: SnippetDto): Promise<void> {
    await saveSnippet(snippet);
    snippets.set(await listSnippets());
    // The node's snippetName/snippetKind are a denormalized snapshot (see
    // automationCanvasTypes.ts's SnippetNodeData doc comment) — refresh it on the canvas
    // node(s) using this snippet so a rename shows immediately without
    // reopening the automation.
    canvasNodes = canvasNodes.map((n) =>
      isSnippetNode(n) && n.data.snippetId === snippet.id
        ? { ...n, data: { ...n.data, snippetName: snippet.name } }
        : n
    );
    editingSnippetId = null;
  }

  /** Places `snippet` as a new node — at `placement.position` if given (a drag-to-empty
   *  drop), otherwise the default append-to-grid spot — and, if `placement.wireFrom` names
   *  a node, wires an edge from it to the new node (a real dependency edge, unless
   *  `wireFrom` is the Start node, in which case it's the decorative `startLinkEdge`
   *  instead — see that function's doc comment). Shared by every way a node gets added:
   *  the toolbar's "+" menu, the drag-to-empty popup, and creating a brand new
   *  Snippet from either of those. */
  function addSnippetNode(snippet: SnippetDto, placement: NodePlacement): void {
    const id = crypto.randomUUID();
    canvasNodes = [
      ...canvasNodes,
      {
        id,
        type: 'snippet',
        position: placement.position ?? layoutPosition(canvasNodes.filter(isStepNode).length),
        data: {
          snippetId: snippet.id,
          label: uniqueLabel(snippet.name),
          continueOnError: false,
          snippetName: snippet.name,
          // A new node runs locally until the user flips it on the node itself.
          target: 'local' as const
        }
      }
    ];
    wire(placement.wireFrom, id);
  }

  /** Places a new upload step, the same way `addSnippetNode` places a snippet. */
  function addUploadNode(placement: NodePlacement): void {
    const id = crypto.randomUUID();
    const node: UploadNode = {
      id,
      type: 'upload',
      position: placement.position ?? layoutPosition(canvasNodes.filter(isStepNode).length),
      data: { label: uniqueLabel('upload'), continueOnError: false, from: '', to: '/tmp/' }
    };
    canvasNodes = [...canvasNodes, node];
    wire(placement.wireFrom, id);
  }

  /** The edge a placement asks for, from `wireFrom` to the new node `id`. */
  function wire(wireFrom: string | null, id: string): void {
    if (!wireFrom) return;
    canvasEdges = [
      ...canvasEdges,
      wireFrom === START_NODE_ID ? startLinkEdge(id) : { id: `${wireFrom}->${id}`, source: wireFrom, target: id }
    ];
  }

  async function submitNewSnippet(snippet: SnippetDto): Promise<void> {
    await saveSnippet(snippet);
    snippets.set(await listSnippets());
    // Read before nulling: `newSnippetDialog` is a plain $state variable (not a
    // reactive `{@const}` alias), so this is a real snapshot — see Snippets.svelte's
    // note on why the order matters for a value read inside a callback like this one.
    const placement = newSnippetDialog?.placement ?? { position: null, wireFrom: null };
    newSnippetDialog = null;
    addSnippetNode(snippet, placement);
  }

  onMount(() => {
    if (!notFound) nameEl?.focus();
  });

  const hasHostParam = $derived(params.some((p) => p.kind === 'host'));

  setContext(AUTOMATION_PARAMS_CONTEXT, {
    params: () => params,
    addParam: (paramName: string, kind: AutomationParamKindDto) => {
      const trimmed = paramName.trim();
      if (!trimmed || params.some((p) => p.name === trimmed)) return;
      if (kind === 'host' && hasHostParam) return;
      params = [...params, { name: trimmed, kind, default: undefined }];
    },
    removeParam: (paramName: string) => {
      params = params.filter((p) => p.name !== paramName);
    },
    updateParam: (paramName: string, patch: { name?: string; kind?: AutomationParamKindDto }) => {
      const idx = params.findIndex((p) => p.name === paramName);
      if (idx === -1) return;
      const current = params[idx];
      const nextName = patch.name !== undefined ? patch.name.trim() : current.name;
      const nextKind = patch.kind ?? current.kind;
      if (!nextName) return;
      if (nextName !== current.name && params.some((p, i) => i !== idx && p.name === nextName)) return;
      if (nextKind === 'host' && params.some((p, i) => i !== idx && p.kind === 'host')) return;
      const next = [...params];
      next[idx] = { ...current, name: nextName, kind: nextKind };
      params = next;
    }
  });

  function back(): void {
    activeEntity.selectAutomations();
  }

  function uniqueLabel(base: string): string {
    const slug = base.trim() || 'node';
    const taken = new Set(canvasNodes.filter(isStepNode).map((n) => n.data.label));
    if (!taken.has(slug)) return slug;
    let i = 2;
    while (taken.has(`${slug}-${i}`)) i += 1;
    return `${slug}-${i}`;
  }

  /** Opens the shared Snippet picker (⌘K's own overlay, in `pickSnippet` mode —
   *  the same "centered over everything" component the SFTP/host spawners already use
   *  for "pick a host") for either the toolbar's "+" button (`placement` all-null) or a
   *  drag-to-empty drop (`placement` carrying where/what to wire). Picking an existing
   *  Snippet places it immediately; picking "New snippet…" opens the add form
   *  first and places it once that's saved (see `submitNewSnippet`). */
  async function openSnippetPicker(placement: NodePlacement): Promise<void> {
    const result = await palette.pickSnippet();
    if (result === null) return;
    if (result === 'new') {
      newSnippetDialog = { id: crypto.randomUUID(), placement };
      return;
    }
    if (result === 'upload') {
      addUploadNode(placement);
      return;
    }
    addSnippetNode(result, placement);
  }

  /** A dependency edge: connecting from a node's source (right) handle to another's
   *  target (left) handle means "the target depends on the source" — `to` waits for
   *  `from`, matching `AutomationEdge`'s own `{ from, to }` shape exactly.
   *
   *  svelte-flow's `Handle` always adds a plain edge to the store *itself* the instant a
   *  drag connects two handles (`store.addEdge`, inside `Handle.svelte`'s
   *  `onConnectExtended`) — this callback runs only afterward, as a notification, with
   *  that edge already sitting in `canvasEdges`. So for a connection out of the Start
   *  node — never a real dependency, see `startLinkEdge`'s doc comment — this restyles
   *  the edge already added rather than pushing a second one (which the `exists`-style
   *  guard an earlier version had would've just silently dropped anyway). Every other
   *  connection needs no handling here at all; the store already added it correctly. */
  function onconnect(connection: Connection): void {
    if (!connection.source || !connection.target || connection.source !== START_NODE_ID) return;
    canvasEdges = canvasEdges.map((e) =>
      e.source === connection.source && e.target === connection.target ? startLinkEdge(e.target) : e
    );
  }

  /** Dragging a connection out from a node's handle and releasing over empty canvas
   *  space, instead of dropping it on another node, opens the same Snippet picker as
   *  the toolbar's "+" button — whatever gets picked (or newly created) is wired to the
   *  node the drag started from. `connectionState.isValid` is `null`/`false` whenever
   *  the drag didn't end on a valid target handle (dropped on the pane, or over a node
   *  with no compatible handle); `fromNode` is null only when no drag was actually in
   *  progress (e.g. this fires from a stray click), which this ignores. The new node's
   *  position is a simple offset from the source node's own — no need for svelte-flow's
   *  screen-to-flow-coordinate conversion (its `useSvelteFlow()` hook isn't callable
   *  from here anyway, since this component isn't itself rendered inside a
   *  `<SvelteFlow>`/`<SvelteFlowProvider>` tree), and the picker is centered on screen
   *  now rather than anchored to the drop point, so no screen position is needed either. */
  const onconnectend: OnConnectEnd = (_event, connectionState) => {
    if (connectionState.isValid || !connectionState.fromNode) return;
    const source = canvasNodes.find((n) => n.id === connectionState.fromNode!.id);
    void openSnippetPicker({
      position: source ? { x: source.position.x + 260, y: source.position.y } : null,
      wireFrom: connectionState.fromNode.id
    });
  };

  async function save(): Promise<void> {
    const automationNameTrimmed = name.trim();
    if (!automationNameTrimmed) {
      error = 'Name cannot be empty';
      return;
    }
    const stepNodes = canvasNodes.filter(isStepNode);
    if (stepNodes.length === 0) {
      error = 'Add at least one node';
      return;
    }
    const labels = stepNodes.map((n) => n.data.label.trim());
    if (labels.some((l) => !l)) {
      error = 'Every node needs a label';
      return;
    }
    if (new Set(labels).size !== labels.length) {
      error = 'Node labels must be unique within the automation';
      return;
    }
    // An upload always goes to the host.
    const usesRemote = stepNodes.some((n) => n.type === 'upload' || n.data.target === 'remote');
    if (usesRemote && !hasHostParam) {
      error = 'This automation runs something on a host — add a host parameter on the Start node';
      return;
    }

    // A connection out of the Start node is decorative, never a real dependency (see
    // startLinkEdge's doc comment) — split out of `edges` into `startLinks` (target ids
    // only) rather than sent as an AutomationEdge, which the backend's validateAutomation would
    // reject outright (Start isn't an AutomationNode, so an edge naming it as `from` fails "an
    // edge references a node that is not in this automation").
    const realEdges = canvasEdges.filter((e) => e.source !== START_NODE_ID);
    const startLinks = canvasEdges.filter((e) => e.source === START_NODE_ID).map((e) => e.target);

    // n.position is a $state proxy (svelte-flow's bind:nodes lives in a $state array,
    // and Svelte 5 deep-proxies nested objects) — Electron's ipcRenderer.invoke sends
    // this over the structured-clone algorithm, which throws "An object could not be
    // cloned" on a Proxy. Rebuilding it as a plain {x, y} (rather than assigning
    // n.position directly) strips that away, same as everything else here already
    // does implicitly by only copying primitive fields off n/n.data.
    const automation: AutomationDto = {
      name: automationNameTrimmed,
      params: params.map((p) => ({ ...p })),
      nodes: stepNodes.map((n) => ({
        id: n.id,
        ...(n.type === 'upload'
          ? { snippetId: '', upload: { from: n.data.from.trim(), to: n.data.to.trim() }, target: 'remote' as const }
          : { snippetId: n.data.snippetId, target: n.data.target }),
        label: n.data.label.trim(),
        continueOnError: n.data.continueOnError,
        position: { x: n.position.x, y: n.position.y }
      })),
      edges: realEdges.map((e) => ({ from: e.source, to: e.target })),
      startLinks: startLinks.length > 0 ? startLinks : undefined
    };
    error = null;
    saving = true;
    try {
      await saveAutomation(automation);
      automations.set(await listAutomations());
      back();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }

  const field =
    'rounded-lg bg-surface-inset px-3 py-2 text-sm text-fg outline-none ' +
    'focus-visible:ring-2 focus-visible:ring-focus placeholder:text-faint';
  const iconBtn =
    'grid h-9 w-9 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-surface-inset ' +
    'hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus';
</script>

<section class="flex h-full flex-col">
  <header class="flex items-center gap-3 border-b border-default px-6 py-3">
    <button type="button" class={iconBtn} title="Back to Automations" aria-label="Back to Automations" onclick={back}>
      <Icon name="arrow-left" size={18} />
    </button>
    {#if notFound}
      <h1 class="text-lg font-semibold tracking-tight">Automation not found</h1>
    {:else}
      <input
        bind:this={nameEl}
        bind:value={name}
        class="{field} min-w-0 flex-1 max-w-sm text-base font-semibold"
        placeholder="Automation name"
        aria-label="Automation name"
      />
      <div class="ml-auto flex items-center gap-2">
        <Button variant="ghost" onclick={back}>Cancel</Button>
        <Button variant="primary" onclick={save} disabled={saving}>
          {mode === 'add' ? 'Create automation' : 'Save'}
        </Button>
      </div>
    {/if}
  </header>

  {#if notFound}
    <div class="flex flex-1 items-center justify-center">
      <p class="text-sm text-muted">“{automationName}” no longer exists — it may have been deleted.</p>
    </div>
  {:else}
    {#if error}
      <p class="border-b border-default px-6 py-2 text-xs text-status-crit">{error}</p>
    {/if}

    <div class="relative min-h-0 flex-1">
      <button
        type="button"
        class="absolute right-4 top-4 z-10 grid h-10 w-10 place-items-center rounded-full border border-default bg-surface text-fg shadow-soft transition hover:bg-surface-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        title="Add a snippet to this automation"
        aria-label="Add a snippet to this automation"
        onclick={() => openSnippetPicker({ position: null, wireFrom: null })}
      >
        <Icon name="plus" size={18} />
      </button>

      <SvelteFlow
        bind:nodes={canvasNodes}
        bind:edges={canvasEdges}
        {nodeTypes}
        {onconnect}
        {onconnectend}
        colorMode={$theme}
        class="h-full w-full"
        fitView
        minZoom={0.3}
      >
        <Background variant={BackgroundVariant.Dots} />
        <Controls showLock={false} />
      </SvelteFlow>
    </div>
  {/if}
</section>

{#if editingSnippet}
  <SnippetEditor
    mode="edit"
    id={editingSnippet.id}
    initial={formFromSnippet(editingSnippet)}
    onSubmit={submitSnippetEdit}
    onCancel={() => (editingSnippetId = null)}
  />
{/if}

{#if newSnippetDialog}
  <SnippetEditor
    mode="add"
    id={newSnippetDialog.id}
    initial={emptyForm()}
    onSubmit={submitNewSnippet}
    onCancel={() => (newSnippetDialog = null)}
  />
{/if}
