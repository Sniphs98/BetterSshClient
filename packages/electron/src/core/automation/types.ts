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
  /** Required iff `kind === 'remote'`. */
  hostName?: string;
  /** Shell command string; may reference `{{nodes.<label>.output}}`. */
  command: string;
  timeoutSecs: number;
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
  nodes: FlowNode[];
  edges: FlowEdge[];
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
