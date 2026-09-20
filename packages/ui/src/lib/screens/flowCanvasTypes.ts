import type { Edge, Node } from '@xyflow/svelte';
import type { AutomationKindDto, FlowParamDto, FlowParamKindDto } from '$lib/bindings';

// The svelte-flow canvas's node/edge shapes for the Flow graph editor — denormalized
// from FlowNodeDto/FlowEdgeDto (see FlowEditor.svelte) so the canvas never has to look
// an automation up mid-render: `automationName`/`automationKind` are snapshotted onto
// the node's data when it's added or the editor opens, the same way the old
// checkbox-list editor read them once per render from `$automations`.
export interface FlowCanvasNodeData extends Record<string, unknown> {
  automationId: string;
  label: string;
  continueOnError: boolean;
  automationName: string;
  automationKind: AutomationKindDto;
}

export type AutomationFlowNode = Node<FlowCanvasNodeData, 'automation'>;
export type AutomationFlowEdge = Edge;

/** The one, permanent "Start" node — the flow's parameters, drawn as a node instead of
 *  a toolbar so the graph reads as "parameters flow in from here." It carries no data
 *  of its own (`FlowStartNode.svelte` reads/writes `params` via `FLOW_PARAMS_CONTEXT`
 *  instead) and has no handles — parameters are referenced by every node via
 *  `{{params.<name>}}` regardless of edges (unlike `{{nodes.<label>.output}}`, whose
 *  scope really is direct predecessors), so a real connection into it would claim a
 *  dependency relationship that doesn't exist. Never saved as a `FlowNode` — it's
 *  filtered out before building the `FlowDto` (see `isAutomationNode` in
 *  FlowEditor.svelte) and always reappears at a fixed position on reopen. */
export const START_NODE_ID = '__start__';
export type StartNodeData = Record<string, never>;
export type StartFlowNode = Node<StartNodeData, 'start'>;

export type AnyFlowNode = AutomationFlowNode | StartFlowNode;

/** Passed via `setContext(FLOW_PARAMS_CONTEXT, …)` from FlowEditor.svelte down to the
 *  Start node so it can read/mutate `params` without that state needing to travel
 *  through `Node.data` (which would mean rebuilding the whole node array on every
 *  keystroke). `params` is a function, not a getter property, so a read inside the
 *  node's template is an explicit, trackable call to the parent's live `$state`. */
export interface FlowParamsContext {
  params: () => FlowParamDto[];
  addParam: (name: string, kind: FlowParamKindDto) => void;
  removeParam: (name: string) => void;
  /** Renames and/or re-kinds the param currently named `name` — a no-op if the new
   *  name is blank, collides with another param, or the new kind would be a second
   *  `'host'` param. Identifies the row being edited by its *current* name, since
   *  that's what's stable within one edit (see FlowStartNode.svelte's index-keyed
   *  `{#each}`, which is what actually keeps the input focused across keystrokes). */
  updateParam: (name: string, patch: { name?: string; kind?: FlowParamKindDto }) => void;
}

export const FLOW_PARAMS_CONTEXT = 'flow-params';

/** Passed via `setContext(FLOW_NODE_ACTIONS_CONTEXT, …)` from FlowEditor.svelte down to
 *  FlowCanvasNode.svelte, so a node can ask its parent to open the underlying
 *  Automation for editing (double-click, or the node's own edit button) without an
 *  event round-trip through svelte-flow's `data`. FlowEditor owns the dialog because
 *  the edit form is a page-level Modal, not something a single graph node can render
 *  itself. */
export interface FlowNodeActionsContext {
  editAutomation: (automationId: string) => void;
}

export const FLOW_NODE_ACTIONS_CONTEXT = 'flow-node-actions';
