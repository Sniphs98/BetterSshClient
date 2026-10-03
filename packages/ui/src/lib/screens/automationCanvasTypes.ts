import type { Edge, Node } from '@xyflow/svelte';
import type { NodeTargetDto, AutomationParamDto, AutomationParamKindDto, GitHubStepDto, IfConditionDto, AutomationCallDto } from '$lib/bindings';

// The svelte-flow canvas's node/edge shapes for the Automation graph editor — denormalized
// from AutomationNodeDto/AutomationEdgeDto (see AutomationEditor.svelte) so the canvas never has to look
// a snippet up mid-render: `snippetName` is snapshotted onto
// the node's data when it's added or the editor opens, the same way the old
// checkbox-list editor read them once per render from `$snippets`.
export interface SnippetNodeData extends Record<string, unknown> {
  snippetId: string;
  label: string;
  continueOnError: boolean;
  snippetName: string;
  /** Where this placement runs — the node's own call, not the snippet's. */
  target: NodeTargetDto;
  /** For `target: 'wsl'`: the distribution; '' means WSL's default one. */
  wslDistro: string;
}

export type SnippetNode = Node<SnippetNodeData, 'snippet'>;

/** A built-in upload step (no snippet): a file on this machine to the automation's host.
 *  Always runs "on host" — it needs the host's connection — so it has no target switch. */
export interface UploadNodeData extends Record<string, unknown> {
  label: string;
  continueOnError: boolean;
  /** A file on this machine; relative paths are from the home folder. With `source:
   *  'wsl'`, a path inside WSL instead (`/tmp/image.tar.gz`). */
  from: string;
  /** Where `from` lives: Windows' own file system, or a WSL distribution. */
  source: 'local' | 'wsl';
  /** For `source: 'wsl'`: the distribution; '' means WSL's default one. */
  wslDistro: string;
  /** On the host: a file path, or a folder ending in `/` to keep the name. */
  to: string;
}

export type UploadNode = Node<UploadNodeData, 'upload'>;

/** A built-in GitHub step (no snippet): start a workflow and wait for it, or download a
 *  release file. Always runs on this machine, so it has no target switch either. */
export interface GitHubNodeData extends Record<string, unknown> {
  label: string;
  continueOnError: boolean;
  step: GitHubStepDto;
}

export type GitHubNode = Node<GitHubNodeData, 'github'>;

/** A built-in If (no snippet): asks a question, then only the nodes on its "yes" or its
 *  "no" way out run. Its two source handles have the ids `yes` and `no`. */
export interface IfNodeData extends Record<string, unknown> {
  label: string;
  continueOnError: boolean;
  condition: IfConditionDto;
  /** Where a command condition runs; a compare runs here. */
  target: NodeTargetDto;
  /** For `target: 'wsl'`: the distribution; '' means WSL's default one. */
  wslDistro: string;
}

export type IfNode = Node<IfNodeData, 'if'>;

/** A built-in "run automation" step (no snippet): runs another automation as a whole,
 *  with the values it asks for. Runs on this machine, so no target switch. */
export interface CallNodeData extends Record<string, unknown> {
  label: string;
  continueOnError: boolean;
  call: AutomationCallDto;
}

export type CallNode = Node<CallNodeData, 'call'>;

/** A node that becomes an `AutomationNode` when saved. */
export type StepNode = SnippetNode | UploadNode | GitHubNode | IfNode | CallNode;
export type AutomationCanvasEdge = Edge;

export type AnyCanvasNode = StepNode;

/** Passed via `setContext(AUTOMATION_PARAMS_CONTEXT, …)` from AutomationEditor.svelte down to the
 *  parameter bar (AutomationParamsBar.svelte). `params` is a function, not a getter, so a
 *  read in its template is an explicit, trackable call to the editor's live `$state`. */
export interface AutomationParamsContext {
  params: () => AutomationParamDto[];
  addParam: (name: string, kind: AutomationParamKindDto) => void;
  removeParam: (name: string) => void;
  /** Renames and/or re-kinds the param currently named `name` — a no-op if the new
   *  name is blank, collides with another param, or the new kind would be a second
   *  `'host'` param. Identifies the row being edited by its *current* name, since
   *  that's what's stable within one edit (see AutomationParamsBar.svelte's index-keyed
   *  `{#each}`, which is what actually keeps the input focused across keystrokes). */
  updateParam: (name: string, patch: { name?: string; kind?: AutomationParamKindDto; value?: string }) => void;
}

export const AUTOMATION_PARAMS_CONTEXT = 'automation-params';

/** Passed via `setContext(AUTOMATION_NODE_ACTIONS_CONTEXT, …)` from AutomationEditor.svelte down to
 *  AutomationCanvasNode.svelte, so a node can ask its parent to open the underlying
 *  Snippet for editing (double-click, or the node's own edit button) without an
 *  event round-trip through svelte-flow's `data`. AutomationEditor owns the dialog because
 *  the edit form is a page-level Modal, not something a single graph node can render
 *  itself. */
export interface AutomationNodeActionsContext {
  editSnippet: (snippetId: string) => void;
  /** The WSL distributions a node can run in — [] where there is no WSL, in which case
   *  a node offers no WSL option (unless it already runs in WSL). */
  wslDistros: () => string[];
  /** The automation being edited, as named right now — a "run automation" node can't run it. */
  automationName: () => string;
  /** Opens automation `name` in the editor instead (asking first if this one has unsaved changes). */
  openAutomation: (name: string) => void;
}

export const AUTOMATION_NODE_ACTIONS_CONTEXT = 'automation-node-actions';
