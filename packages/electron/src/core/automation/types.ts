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

/** `'text'`/`'host'` are asked for when the automation runs; `'fixed'` is a variable set
 *  in the automation itself (its `default` is its value) and never asked for. */
export type AutomationParamKind = 'text' | 'host' | 'fixed';

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
  /** Prefills the "run this automation" prompt for a `'text'` param; unused for `'host'`.
   *  For a `'fixed'` one, its value — used as is on every run. */
  default?: string;
}

/** Where a node's snippet runs: on this machine, in a WSL distribution on it (Windows),
 *  or on the host the automation's `'host'` param resolves at run time. */
export type NodeTarget = 'local' | 'wsl' | 'remote';

/** A built-in step instead of a snippet: copies a file from this machine to the
 *  automation's host over the app's own SFTP connection (its saved password,
 *  1Password, jump hosts, known host keys). Both paths may use `{{params.<name>}}`
 *  and `{{nodes.<label>.output}}`. */
export interface UploadStep {
  /** A file on this machine; relative to the home folder, like local nodes' commands —
   *  or, with `source: 'wsl'`, a path inside WSL (`/tmp/image.tar.gz`, `~/build/app.tgz`;
   *  relative ones start where WSL nodes run, the Windows home folder). */
  from: string;
  /** Where `from` lives: this machine's own file system (unset), or a WSL distribution —
   *  for a file a `'wsl'` node just wrote to, say, `/tmp`, which Windows can't see there. */
  source?: 'wsl';
  /** For `source: 'wsl'`: which distribution; unset means WSL's default one. */
  wslDistro?: string;
  /** Where on the host: a file path, or a folder ending in `/` to keep the file's name. */
  to: string;
}

/** A built-in GitHub step instead of a snippet — see core/github/steps.ts. Runs on this
 *  machine (it talks to GitHub, not to a host). Every text field takes
 *  `{{params.<name>}}` and `{{nodes.<label>.output}}`. */
export type GitHubStep =
  | {
      /** Start a workflow and follow it to the end; output: the tag of the release it made. */
      action: 'runWorkflow';
      repo: string;
      workflow: string;
      ref: string;
      inputs: Record<string, string>;
    }
  | {
      /** Download a release's file to the home folder; output: its path. */
      action: 'downloadAsset';
      repo: string;
      tag: string;
      pattern: string;
    };

/** How an If node compares: `left`, with `right` where it takes one. Both sides are
 *  trimmed first (a command's output ends in a line break); text compares exactly. */
export type IfOperator = 'equals' | 'notEquals' | 'contains' | 'notContains' | 'isEmpty' | 'notEmpty';

/** An If node's question: a comparison of texts (params, earlier nodes' outputs), or
 *  whether a command succeeds (exit code 0) — run where the node's `target` says. Every
 *  text field takes `{{params.<name>}}` and `{{nodes.<label>.output}}`. */
export type IfCondition =
  | { kind: 'compare'; left: string; op: IfOperator; right: string }
  | { kind: 'command'; command: string; timeoutSecs: number };

/** A built-in step instead of a snippet: runs another automation, as a whole, and waits
 *  for it. `params` gives the values its run would ask for (by its parameters' names);
 *  each may use `{{params.<name>}}` and `{{nodes.<label>.output}}` of this automation —
 *  to hand on the host, say. Its output is the output of the called automation's last step. */
export interface AutomationCall {
  /** The called automation's name. */
  automation: string;
  params: Record<string, string>;
}

/** Which of an If node's two ways an edge out of it is. */
export type IfBranch = 'yes' | 'no';

export interface AutomationNode {
  /** Instance id, unique within the automation — a Snippet can appear more than once. */
  id: string;
  /** The snippet this node runs; `''` for an upload node. */
  snippetId: string;
  /** Set for an upload node, which runs no snippet (and always targets the host). */
  upload?: UploadStep;
  /** Set for a GitHub node, which runs no snippet (and runs here, target 'local'). */
  github?: GitHubStep;
  /** Set for an If node, which runs no snippet: its output is `yes` or `no`, and only the
   *  nodes on that way out of it run (see `AutomationEdge.branch`). A `'command'`
   *  condition runs where `target` says; a `'compare'` one targets 'local'. */
  condition?: IfCondition;
  /** Set for a "run automation" node, which runs no snippet itself (target 'local'). */
  call?: AutomationCall;
  /** Unique within the automation; the `{{nodes.<label>.output}}` handle. */
  label: string;
  /** An automation-wiring concern, not a property of the reusable Snippet: does this
   *  node's failure block the nodes that depend on it? */
  continueOnError: boolean;
  /** Also a wiring concern rather than the snippet's own: the same command may belong
   *  on this machine in one automation and on a server in another. */
  target: NodeTarget;
  /** For `target: 'wsl'`: which distribution; unset means WSL's default one. */
  wslDistro?: string;
  /** Unused by the v1 (non-canvas) UI; round-tripped so a future Svelte Automation canvas
   *  needs no data migration. */
  position?: { x: number; y: number };
}

/** `to` depends on `from` — `from` must complete before `to` can start. */
export interface AutomationEdge {
  from: string;
  to: string;
  /** For an edge out of an If node: the way it is. `to` only runs when the If's answer is
   *  this one — otherwise it's skipped, and so is what depends only on it. */
  branch?: IfBranch;
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
  /** How many nodes may run at once. Unset or 1: one after the other, as always. More:
   *  nodes whose predecessors are all done run side by side, up to this many — so two
   *  independent branches run in parallel. */
  maxParallel?: number;
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
