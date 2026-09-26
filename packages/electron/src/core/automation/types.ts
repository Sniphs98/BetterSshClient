/**
 * Automations — graph-based, shell-only nodes.
 *
 * Two-tier model: a reusable `Snippet` library (just a named shell command) and
 * `Automation`s that place Snippets as nodes and wire dependency edges between them.
 * `AutomationNode.snippetId` references `Snippet.id` (a stable id, never `.name`), so
 * renaming a Snippet never breaks an Automation that uses it.
 */

export interface Snippet {
  id: string;
  name: string;
  /** Shell command string; may reference `{{nodes.<label>.output}}` and
   *  `{{params.<name>}}`. Says nothing about where it runs — that's the placing
   *  node's `target` (see `AutomationNode`), so one snippet can be used locally in
   *  one automation and against a host in another without being duplicated. */
  command: string;
  timeoutSecs: number;
}

export type AutomationParamKind = 'text' | 'host';

/** A value the automation asks for right before it runs, rather than baking it into any
 *  node. An automation may declare at most one `kind: 'host'` param — its value is the host
 *  every remote node in the automation connects to; any number of `kind: 'text'` params are
 *  also allowed, substituted into commands via `{{params.<name>}}` just like a
 *  `'host'` param's own value is. */
export interface AutomationParam {
  /** Unique within the automation; the `{{params.<name>}}` handle and the key into the
   *  `paramValues` map supplied to `run_automation`. */
  name: string;
  kind: AutomationParamKind;
  /** Shown in the "run this automation" prompt in place of `name`, if set. */
  label?: string;
  /** Prefills the "run this automation" prompt for a `'text'` param; unused for `'host'`. */
  default?: string;
}

/** Where a node's snippet runs: on this machine, or on the host the automation's
 *  `'host'` param resolves at run time. */
export type NodeTarget = 'local' | 'remote';

/** A built-in step instead of a snippet: copies a file from this machine to the
 *  automation's host over the app's own SFTP connection (its saved password,
 *  1Password, jump hosts, known host keys). Both paths may use `{{params.<name>}}`
 *  and `{{nodes.<label>.output}}`. */
export interface UploadStep {
  /** A file on this machine; relative to the home folder, like local nodes' commands. */
  from: string;
  /** Where on the host: a file path, or a folder ending in `/` to keep the file's name. */
  to: string;
}

export interface AutomationNode {
  /** Instance id, unique within the automation — a Snippet can appear more than once. */
  id: string;
  /** The snippet this node runs; `''` for an upload node. */
  snippetId: string;
  /** Set for an upload node, which runs no snippet (and always targets the host). */
  upload?: UploadStep;
  /** Unique within the automation; the `{{nodes.<label>.output}}` handle. */
  label: string;
  /** An automation-wiring concern, not a property of the reusable Snippet: does this
   *  node's failure block the nodes that depend on it? */
  continueOnError: boolean;
  /** Also a wiring concern rather than the snippet's own: the same command may belong
   *  on this machine in one automation and on a server in another. */
  target: NodeTarget;
  /** Unused by the v1 (non-canvas) UI; round-tripped so a future Svelte Automation canvas
   *  needs no data migration. */
  position?: { x: number; y: number };
}

/** `to` depends on `from` — `from` must complete before `to` can start. */
export interface AutomationEdge {
  from: string;
  to: string;
}

export interface Automation {
  name: string;
  params: AutomationParam[];
  nodes: AutomationNode[];
  edges: AutomationEdge[];
  /** Node ids the canvas draws a line from the Start node to — purely decorative
   *  ("params flow in from here"), never read by `topoOrder`/`validateAutomation`/`runAutomation`.
   *  A real dependency edge (`AutomationEdge`) would falsely claim a node depends on Start,
   *  when every param is already visible to every node regardless of edges (see
   *  `AutomationParam`'s doc comment); this is round-tripped only so the line the user drew
   *  is still there next time the automation opens, the same way `AutomationNode.position` is. */
  startLinks?: string[];
}

export type NodeStatus = 'success' | 'failed' | 'skipped';

export interface NodeResult {
  nodeId: string;
  label: string;
  status: NodeStatus;
  /** Combined stdout+stderr, for both local and remote nodes — so a
   *  `{{nodes.<label>.output}}` reference means the same thing regardless of target. */
  output: string;
  /** Present when `status !== 'success'`. */
  error?: string;
  durationMs: number;
}
