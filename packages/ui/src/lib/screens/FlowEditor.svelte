<script lang="ts">
  // A single Flow, full-page: the canvas needs the room a modal can't give it. Reached
  // via `activeEntity.selectFlow(name | null)` and rendered by +page.svelte as another
  // selector (tech-gui.md §2) — it occupies the whole content area, sidebar and status
  // bar excluded, same chrome every other selector gets for free. Nodes are placed and
  // wired directly on an actual svelte-flow canvas: click a node's source (right) dot
  // then another's target (left) dot to add a dependency edge (or drag between them).
  // Structural validation (unknown automation, a cycle, a template reference that
  // isn't a direct dependency, …) happens server-side in `validateFlow`
  // (core/automation/engine.ts) — this stays a plain UI package with no dependency on
  // the electron package's code, so a rejected save just surfaces that message inline.
  // `FlowNode.position` (already part of the DTO) is what makes a layout persist
  // across reopens instead of re-flowing every time.
  //
  // Parameters (`FlowParam`) are values collected right before the flow runs rather
  // than baked into any automation node — at most one `'host'`-kind, whose run-time
  // value is the target for every remote automation node in this flow, plus any
  // number of `'text'`-kind ones substituted via `{{params.<name>}}`. This is what
  // lets one flow definition run identically against different hosts. They're drawn
  // as the graph's own permanent "Start" node (FlowStartNode.svelte) rather than a
  // toolbar above the canvas — see flowCanvasTypes.ts's note on `START_NODE_ID`.
  import { onMount, setContext } from 'svelte';
  import { SvelteFlow, Background, BackgroundVariant, Controls, type Connection, type OnConnectEnd } from '@xyflow/svelte';
  import '@xyflow/svelte/dist/style.css';
  import type { AutomationDto, FlowDto, FlowParamDto, FlowParamKindDto } from '$lib/bindings';
  import { Button, Icon } from '$lib/theme';
  import { automations, flows } from '$lib/stores/automations';
  import { listAutomations, listFlows, saveAutomation, saveFlow } from '$lib/ipc/commands';
  import { activeEntity } from '$lib/stores/activeEntity';
  import { palette } from '$lib/stores/palette';
  import { theme } from '$lib/stores/theme';
  import FlowCanvasNode from './FlowCanvasNode.svelte';
  import FlowStartNode from './FlowStartNode.svelte';
  import AutomationEditor from './AutomationEditor.svelte';
  import { emptyForm, formFromAutomation } from './automationForm';
  import {
    FLOW_NODE_ACTIONS_CONTEXT,
    FLOW_PARAMS_CONTEXT,
    START_NODE_ID,
    type AnyFlowNode,
    type AutomationFlowEdge,
    type AutomationFlowNode,
    type FlowNodeActionsContext,
    type StartFlowNode
  } from './flowCanvasTypes';

  /** `null` opens a fresh, unsaved flow; a name loads that existing Flow from the
   *  `flows` store (already loaded by Automations.svelte before navigation ever gets
   *  here). +page.svelte keys this component on `flowName`, so a switch between two
   *  flows (or from an existing one to a new draft) always gets a fresh instance —
   *  the "seeded once" state below never has to react to a changed prop. */
  let { flowName }: { flowName: string | null } = $props();

  // svelte-ignore state_referenced_locally
  const existing = flowName ? $flows.find((f) => f.name === flowName) : undefined;
  const mode: 'add' | 'edit' = existing ? 'edit' : 'add';
  const initial: FlowDto = existing ?? { name: '', params: [], nodes: [], edges: [] };
  // A name was passed but no longer matches anything in the store (deleted from
  // elsewhere between listing and opening) — surface that instead of silently
  // presenting an empty "new flow" draft under the old name.
  // svelte-ignore state_referenced_locally
  const notFound = flowName !== null && existing === undefined;

  const nodeTypes = { automation: FlowCanvasNode, start: FlowStartNode };

  /** A simple left-to-right, wrapping grid — used only for a node that has no saved
   *  `position` yet (freshly added, or a flow saved before positions existed). */
  function layoutPosition(index: number): { x: number; y: number } {
    return { x: 60 + (index % 4) * 230, y: 60 + Math.floor(index / 4) * 150 };
  }

  function isAutomationNode(n: AnyFlowNode): n is AutomationFlowNode {
    return n.type === 'automation';
  }

  const startNode: StartFlowNode = {
    id: START_NODE_ID,
    type: 'start',
    position: { x: -280, y: 60 },
    data: {},
    deletable: false,
    selectable: false
  };

  let name = $state(initial.name);
  let params = $state<FlowParamDto[]>(initial.params.map((p) => ({ ...p })));
  let canvasNodes = $state<AnyFlowNode[]>([
    startNode,
    ...initial.nodes.map((n, i) => {
      const automation = $automations.find((a) => a.id === n.automationId);
      return {
        id: n.id,
        type: 'automation' as const,
        position: n.position ?? layoutPosition(i),
        data: {
          automationId: n.automationId,
          label: n.label,
          continueOnError: n.continueOnError,
          automationName: automation?.name ?? 'unknown automation',
          automationKind: automation?.kind ?? 'local'
        }
      };
    })
  ]);
  /** A decorative "params flow in from here" line, never a real `FlowEdge` — see
   *  flowCanvasTypes.ts's note on `START_NODE_ID`. Dashed + faded so it reads as
   *  cosmetic rather than a dependency, the same visual language a disabled control
   *  elsewhere in this app uses for "present but not load-bearing". */
  function startLinkEdge(targetId: string): AutomationFlowEdge {
    return {
      id: `${START_NODE_ID}->${targetId}`,
      source: START_NODE_ID,
      target: targetId,
      style: 'stroke-dasharray: 4 4; opacity: 0.55;'
    };
  }

  let canvasEdges = $state<AutomationFlowEdge[]>([
    ...initial.edges.map((e) => ({ id: `${e.from}->${e.to}`, source: e.from, target: e.to })),
    // Dropping a link to a node id that no longer exists (the Automation/node was
    // deleted since this was last saved) rather than letting svelte-flow choke on an
    // edge with a dangling target.
    ...(initial.startLinks ?? [])
      .filter((targetId) => initial.nodes.some((n) => n.id === targetId))
      .map(startLinkEdge)
  ]);
  /** Where a newly picked/created Automation lands: `position` is a drag-to-empty
   *  drop's flow coordinates (`null` for the toolbar's "+" button, which just appends
   *  at a default grid spot), `wireFrom` is the node the drag started at (`null` for
   *  the "+" button — nothing to wire). Shared by every way a node gets added. */
  interface NodeTarget {
    position: { x: number; y: number } | null;
    wireFrom: string | null;
  }

  // The "+ New automation…" row inside the picker — opens the same add-automation form
  // the library screen uses; on save, the new Automation is placed as a node using the
  // `target` it was opened with (still known here, carried over from that call).
  let newAutomationDialog = $state<{ id: string; target: NodeTarget } | null>(null);
  let error = $state<string | null>(null);
  let saving = $state(false);
  let nameEl = $state<HTMLInputElement>();

  // Editing a node's underlying Automation (its command/kind/timeout, not just this
  // node's label or wiring) reuses the library's own AutomationEditor modal rather than
  // a second form — opened via FLOW_NODE_ACTIONS_CONTEXT from FlowCanvasNode's
  // double-click/edit button. Looked up from the live `automations` store (not
  // snapshotted onto the node) so the form always shows the current definition.
  let editingAutomationId = $state<string | null>(null);
  const editingAutomation = $derived($automations.find((a) => a.id === editingAutomationId) ?? null);

  setContext<FlowNodeActionsContext>(FLOW_NODE_ACTIONS_CONTEXT, {
    editAutomation: (automationId: string) => {
      editingAutomationId = automationId;
    }
  });

  async function submitAutomationEdit(automation: AutomationDto): Promise<void> {
    await saveAutomation(automation);
    automations.set(await listAutomations());
    // The node's automationName/automationKind are a denormalized snapshot (see
    // flowCanvasTypes.ts's FlowCanvasNodeData doc comment) — refresh it on the canvas
    // node(s) using this automation so a rename/re-kind shows immediately without
    // reopening the flow.
    canvasNodes = canvasNodes.map((n) =>
      isAutomationNode(n) && n.data.automationId === automation.id
        ? { ...n, data: { ...n.data, automationName: automation.name, automationKind: automation.kind } }
        : n
    );
    editingAutomationId = null;
  }

  /** Places `automation` as a new node — at `target.position` if given (a drag-to-empty
   *  drop), otherwise the default append-to-grid spot — and, if `target.wireFrom` names
   *  a node, wires an edge from it to the new node (a real dependency edge, unless
   *  `wireFrom` is the Start node, in which case it's the decorative `startLinkEdge`
   *  instead — see that function's doc comment). Shared by every way a node gets added:
   *  the toolbar's "+" menu, the drag-to-empty popup, and creating a brand new
   *  Automation from either of those. */
  function addAutomationNode(automation: AutomationDto, target: NodeTarget): void {
    const id = crypto.randomUUID();
    canvasNodes = [
      ...canvasNodes,
      {
        id,
        type: 'automation',
        position: target.position ?? layoutPosition(canvasNodes.filter(isAutomationNode).length),
        data: {
          automationId: automation.id,
          label: uniqueLabel(automation.name),
          continueOnError: false,
          automationName: automation.name,
          automationKind: automation.kind
        }
      }
    ];
    if (target.wireFrom) {
      canvasEdges = [
        ...canvasEdges,
        target.wireFrom === START_NODE_ID
          ? startLinkEdge(id)
          : { id: `${target.wireFrom}->${id}`, source: target.wireFrom, target: id }
      ];
    }
  }

  async function submitNewAutomation(automation: AutomationDto): Promise<void> {
    await saveAutomation(automation);
    automations.set(await listAutomations());
    // Read before nulling: `newAutomationDialog` is a plain $state variable (not a
    // reactive `{@const}` alias), so this is a real snapshot — see Automations.svelte's
    // note on why the order matters for a value read inside a callback like this one.
    const target = newAutomationDialog?.target ?? { position: null, wireFrom: null };
    newAutomationDialog = null;
    addAutomationNode(automation, target);
  }

  onMount(() => {
    if (!notFound) nameEl?.focus();
  });

  const hasHostParam = $derived(params.some((p) => p.kind === 'host'));

  setContext(FLOW_PARAMS_CONTEXT, {
    params: () => params,
    addParam: (paramName: string, kind: FlowParamKindDto) => {
      const trimmed = paramName.trim();
      if (!trimmed || params.some((p) => p.name === trimmed)) return;
      if (kind === 'host' && hasHostParam) return;
      params = [...params, { name: trimmed, kind, default: undefined }];
    },
    removeParam: (paramName: string) => {
      params = params.filter((p) => p.name !== paramName);
    },
    updateParam: (paramName: string, patch: { name?: string; kind?: FlowParamKindDto }) => {
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
    const taken = new Set(canvasNodes.filter(isAutomationNode).map((n) => n.data.label));
    if (!taken.has(slug)) return slug;
    let i = 2;
    while (taken.has(`${slug}-${i}`)) i += 1;
    return `${slug}-${i}`;
  }

  /** Opens the shared Automation picker (⌘K's own overlay, in `pickAutomation` mode —
   *  the same "centered over everything" component the SFTP/host spawners already use
   *  for "pick a host") for either the toolbar's "+" button (`target` all-null) or a
   *  drag-to-empty drop (`target` carrying where/what to wire). Picking an existing
   *  Automation places it immediately; picking "New automation…" opens the add form
   *  first and places it once that's saved (see `submitNewAutomation`). */
  async function openAutomationPicker(target: NodeTarget): Promise<void> {
    const result = await palette.pickAutomation();
    if (result === null) return;
    if (result === 'new') {
      newAutomationDialog = { id: crypto.randomUUID(), target };
      return;
    }
    addAutomationNode(result, target);
  }

  /** A dependency edge: connecting from a node's source (right) handle to another's
   *  target (left) handle means "the target depends on the source" — `to` waits for
   *  `from`, matching `FlowEdge`'s own `{ from, to }` shape exactly.
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
   *  space, instead of dropping it on another node, opens the same Automation picker as
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
    void openAutomationPicker({
      position: source ? { x: source.position.x + 260, y: source.position.y } : null,
      wireFrom: connectionState.fromNode.id
    });
  };

  async function save(): Promise<void> {
    const flowNameTrimmed = name.trim();
    if (!flowNameTrimmed) {
      error = 'Name cannot be empty';
      return;
    }
    const automationNodes = canvasNodes.filter(isAutomationNode);
    if (automationNodes.length === 0) {
      error = 'Add at least one node';
      return;
    }
    const labels = automationNodes.map((n) => n.data.label.trim());
    if (labels.some((l) => !l)) {
      error = 'Every node needs a label';
      return;
    }
    if (new Set(labels).size !== labels.length) {
      error = 'Node labels must be unique within the flow';
      return;
    }
    const usesRemote = automationNodes.some((n) => n.data.automationKind === 'remote');
    if (usesRemote && !hasHostParam) {
      error = 'This flow runs a remote automation — add a host parameter on the Start node';
      return;
    }

    // A connection out of the Start node is decorative, never a real dependency (see
    // startLinkEdge's doc comment) — split out of `edges` into `startLinks` (target ids
    // only) rather than sent as a FlowEdge, which the backend's validateFlow would
    // reject outright (Start isn't a FlowNode, so an edge naming it as `from` fails "an
    // edge references a node that is not in this flow").
    const realEdges = canvasEdges.filter((e) => e.source !== START_NODE_ID);
    const startLinks = canvasEdges.filter((e) => e.source === START_NODE_ID).map((e) => e.target);

    // n.position is a $state proxy (svelte-flow's bind:nodes lives in a $state array,
    // and Svelte 5 deep-proxies nested objects) — Electron's ipcRenderer.invoke sends
    // this over the structured-clone algorithm, which throws "An object could not be
    // cloned" on a Proxy. Rebuilding it as a plain {x, y} (rather than assigning
    // n.position directly) strips that away, same as everything else here already
    // does implicitly by only copying primitive fields off n/n.data.
    const flow: FlowDto = {
      name: flowNameTrimmed,
      params: params.map((p) => ({ ...p })),
      nodes: automationNodes.map((n) => ({
        id: n.id,
        automationId: n.data.automationId,
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
      await saveFlow(flow);
      flows.set(await listFlows());
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
    <button type="button" class={iconBtn} title="Back to Flows" aria-label="Back to Flows" onclick={back}>
      <Icon name="arrow-left" size={18} />
    </button>
    {#if notFound}
      <h1 class="text-lg font-semibold tracking-tight">Flow not found</h1>
    {:else}
      <input
        bind:this={nameEl}
        bind:value={name}
        class="{field} min-w-0 flex-1 max-w-sm text-base font-semibold"
        placeholder="Flow name"
        aria-label="Flow name"
      />
      <div class="ml-auto flex items-center gap-2">
        <Button variant="ghost" onclick={back}>Cancel</Button>
        <Button variant="primary" onclick={save} disabled={saving}>
          {mode === 'add' ? 'Create flow' : 'Save'}
        </Button>
      </div>
    {/if}
  </header>

  {#if notFound}
    <div class="flex flex-1 items-center justify-center">
      <p class="text-sm text-muted">“{flowName}” no longer exists — it may have been deleted.</p>
    </div>
  {:else}
    {#if error}
      <p class="border-b border-default px-6 py-2 text-xs text-status-crit">{error}</p>
    {/if}

    <div class="relative min-h-0 flex-1">
      <button
        type="button"
        class="absolute right-4 top-4 z-10 grid h-10 w-10 place-items-center rounded-full border border-default bg-surface text-fg shadow-soft transition hover:bg-surface-inset focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
        title="Add an automation to this flow"
        aria-label="Add an automation to this flow"
        onclick={() => openAutomationPicker({ position: null, wireFrom: null })}
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

{#if editingAutomation}
  <AutomationEditor
    mode="edit"
    id={editingAutomation.id}
    initial={formFromAutomation(editingAutomation)}
    onSubmit={submitAutomationEdit}
    onCancel={() => (editingAutomationId = null)}
  />
{/if}

{#if newAutomationDialog}
  <AutomationEditor
    mode="add"
    id={newAutomationDialog.id}
    initial={emptyForm()}
    onSubmit={submitNewAutomation}
    onCancel={() => (newAutomationDialog = null)}
  />
{/if}
