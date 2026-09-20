/**
 * Automations v2 — graph-based, shell-only nodes.
 *
 * Two-tier model: a reusable `Automation` library (like snippets — a named shell
 * command, local or against one specific remote host) and `Flow`s that place
 * Automations as nodes and wire dependency edges between them. `FlowNode.automationId`
 * references `Automation.id` (a stable id, never `.name`), so renaming an Automation
 * never breaks a Flow that uses it.
 */

export type AutomationKind = 'local' | 'remote';

export interface Automation {
  id: string;
  name: string;
  kind: AutomationKind;
  /** Shell command string; may reference `{{nodes.<label>.output}}` and
   *  `{{params.<name>}}`. No target host here — a `kind === 'remote'` automation runs
   *  against whichever host the *flow* resolves at run time (its one `'host'`-kind
   *  `FlowParam`), so the same automation and the same flow both work unchanged
   *  against a different host without editing anything. */
  command: string;
  timeoutSecs: number;
}

export type FlowParamKind = 'text' | 'host';

/** A value the flow asks for right before it runs, rather than baking it into any
 *  node. A flow may declare at most one `kind: 'host'` param — its value is the host
 *  every remote node in the flow connects to; any number of `kind: 'text'` params are
 *  also allowed, substituted into commands via `{{params.<name>}}` just like a
 *  `'host'` param's own value is. */
export interface FlowParam {
  /** Unique within the flow; the `{{params.<name>}}` handle and the key into the
   *  `paramValues` map supplied to `run_flow`. */
  name: string;
  kind: FlowParamKind;
  /** Shown in the "run this flow" prompt in place of `name`, if set. */
  label?: string;
  /** Prefills the "run this flow" prompt for a `'text'` param; unused for `'host'`. */
  default?: string;
}

export interface FlowNode {
  /** Instance id, unique within the flow — an Automation can appear more than once. */
  id: string;
  automationId: string;
  /** Unique within the flow; the `{{nodes.<label>.output}}` handle. */
  label: string;
  /** A flow-wiring concern, not a property of the reusable Automation: does this
   *  node's failure block the nodes that depend on it? */
  continueOnError: boolean;
  /** Unused by the v1 (non-canvas) UI; round-tripped so a future Svelte Flow canvas
   *  needs no data migration. */
  position?: { x: number; y: number };
}

/** `to` depends on `from` — `from` must complete before `to` can start. */
export interface FlowEdge {
  from: string;
  to: string;
}

export interface Flow {
  name: string;
  params: FlowParam[];
  nodes: FlowNode[];
  edges: FlowEdge[];
  /** Node ids the canvas draws a line from the Start node to — purely decorative
   *  ("params flow in from here"), never read by `topoOrder`/`validateFlow`/`runFlow`.
   *  A real dependency edge (`FlowEdge`) would falsely claim a node depends on Start,
   *  when every param is already visible to every node regardless of edges (see
   *  `FlowParam`'s doc comment); this is round-tripped only so the line the user drew
   *  is still there next time the flow opens, the same way `FlowNode.position` is. */
  startLinks?: string[];
}

export type NodeStatus = 'success' | 'failed' | 'skipped';

export interface NodeResult {
  nodeId: string;
  label: string;
  status: NodeStatus;
  /** Combined stdout+stderr, for both local and remote nodes — so a
   *  `{{nodes.<label>.output}}` reference means the same thing regardless of kind. */
  output: string;
  /** Present when `status !== 'success'`. */
  error?: string;
  durationMs: number;
}
