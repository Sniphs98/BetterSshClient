import type { Snippet, Automation, AutomationNode, GitHubStep, IfCondition, IfOperator, NodeResult } from './types.js';

/**
 * The Automation execution engine: an `Automation` is a DAG of `AutomationNode`s (each an
 * instance of a reusable `Snippet`), executed in topological order. Pure
 * logic — `topoOrder`/`validateAutomation`/`substituteTemplate` — is exported separately
 * from the `runAutomation` orchestrator so it's fully unit-testable without a real SSH
 * session or child process (see `RunAutomationDeps`, injected rather than imported).
 */

const TEMPLATE_REF = /\{\{nodes\.([^.}]+)\.output\}\}/g;
const PARAM_REF = /\{\{params\.([^.}]+)\}\}/g;

export class AutomationCycleError extends Error {}

/** Kahn's algorithm. Deterministic for a given automation: nodes become "ready" (all
 *  predecessors already ordered) in the order their last-completing predecessor was
 *  processed, ties broken by the automation's own node order. Throws `AutomationCycleError`
 *  naming one of the nodes that couldn't be ordered when the automation isn't a DAG.
 *  Dangling edges (referencing a node id not in the automation) are ignored here —
 *  `validateAutomation` reports those as a problem instead of failing the sort. */
export function topoOrder(automation: Automation): string[] {
  const nodeIds = automation.nodes.map((n) => n.id);
  const inDegree = new Map<string, number>(nodeIds.map((id) => [id, 0]));
  const adjacency = new Map<string, string[]>(nodeIds.map((id) => [id, []]));

  for (const edge of automation.edges) {
    if (!inDegree.has(edge.from) || !inDegree.has(edge.to)) continue;
    adjacency.get(edge.from)!.push(edge.to);
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }

  const queue = nodeIds.filter((id) => inDegree.get(id) === 0);
  const order: string[] = [];

  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of adjacency.get(id) ?? []) {
      const remaining = (inDegree.get(next) ?? 0) - 1;
      inDegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }

  if (order.length !== nodeIds.length) {
    const stuckId = nodeIds.find((id) => !order.includes(id))!;
    const stuckLabel = automation.nodes.find((n) => n.id === stuckId)?.label ?? stuckId;
    throw new AutomationCycleError(`automation has a cycle involving node "${stuckLabel}"`);
  }

  return order;
}

/** The direct predecessors (by node id) of every node, from the automation's edges. */
function predecessorMap(automation: Automation): Map<string, string[]> {
  const map = new Map<string, string[]>(automation.nodes.map((n) => [n.id, []]));
  for (const edge of automation.edges) {
    if (map.has(edge.to) && map.has(edge.from)) map.get(edge.to)!.push(edge.from);
  }
  return map;
}

/** The automation's one `'host'`-kind `AutomationParam`, if it declared one — its run-time value
 *  is the host every remote node in the automation connects to. `validateAutomation` enforces at
 *  most one. */
function hostParamOf(automation: Automation): { name: string } | undefined {
  return automation.params.find((p) => p.kind === 'host');
}

/** Everything in a node that templates are substituted into: its snippet's command, or
 *  an upload's two paths. Undefined for a node whose snippet is gone. */
function templatedText(node: AutomationNode, snippetsById: Map<string, Snippet>): string | undefined {
  if (node.upload !== undefined) return `${node.upload.from}\n${node.upload.to}`;
  if (node.condition !== undefined) return conditionTexts(node.condition).join('\n');
  if (node.github !== undefined) return githubTexts(node.github).join('\n');
  if (node.call !== undefined) return Object.values(node.call.params).join('\n');
  return snippetsById.get(node.snippetId)?.command;
}

/** Every text field of an If condition — what templates are substituted into. */
function conditionTexts(condition: IfCondition): string[] {
  return condition.kind === 'compare' ? [condition.left, condition.right] : [condition.command];
}

/** Whether `left` `op` `right` holds; both sides trimmed (an output ends in a line break). */
export function compareTexts(left: string, op: IfOperator, right: string): boolean {
  const a = left.trim();
  const b = right.trim();
  switch (op) {
    case 'equals':
      return a === b;
    case 'notEquals':
      return a !== b;
    case 'contains':
      return a.includes(b);
    case 'notContains':
      return !a.includes(b);
    case 'isEmpty':
      return a === '';
    case 'notEmpty':
      return a !== '';
  }
}

/** The values every node sees as `{{params.<name>}}`: what was asked for at run time,
 *  plus each `'fixed'` variable's own value (which nothing at run time overrides). */
export function effectiveParamValues(automation: Automation, paramValues: Record<string, string>): Record<string, string> {
  const values = { ...paramValues };
  for (const p of automation.params) if (p.kind === 'fixed') values[p.name] = p.default ?? '';
  return values;
}

/** Every text field of a GitHub step — what templates are substituted into. */
function githubTexts(step: GitHubStep): string[] {
  return step.action === 'runWorkflow'
    ? [step.repo, step.workflow, step.ref, ...Object.values(step.inputs)]
    : [step.repo, step.tag, step.pattern];
}

/** `step` with templates substituted into every text field. */
function substituteGitHubStep(step: GitHubStep, predecessors: Map<string, NodeResult>, params: Record<string, string>): GitHubStep {
  const sub = (text: string) => substituteTemplate(text, predecessors, params).trim();
  if (step.action === 'runWorkflow') {
    return {
      ...step,
      repo: sub(step.repo),
      workflow: sub(step.workflow),
      ref: sub(step.ref),
      inputs: Object.fromEntries(Object.entries(step.inputs).map(([k, v]) => [k, sub(v)]))
    };
  }
  return { ...step, repo: sub(step.repo), tag: sub(step.tag), pattern: sub(step.pattern) };
}

/** Where an upload lands: `to` itself, or — when `to` ends in `/` — that folder plus the
 *  local file's name. The host is POSIX; the local path may use either separator. */
export function uploadDestination(from: string, to: string): string {
  const dest = to.trim();
  if (!dest.endsWith('/')) return dest;
  const name = from.trim().split(/[\\/]/).filter(Boolean).pop() ?? '';
  return `${dest}${name}`;
}

/** "1.4 GB" — a size for a progress line. */
export function formatSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/** An upload's progress line: `Uploading image.tar.gz — 45% (120 MB of 266 MB, 11 MB/s)`.
 *  The panel draws a bar from it and replaces the previous one rather than adding a line. */
export function uploadProgressLine(name: string, done: number, total: number, elapsedMs: number): string {
  const percent = total > 0 ? Math.min(100, Math.floor((done / total) * 100)) : 0;
  const speed = elapsedMs >= 1000 ? `, ${formatSize(done / (elapsedMs / 1000))}/s` : '';
  return `Uploading ${name} — ${percent}% (${formatSize(done)} of ${formatSize(total)}${speed})`;
}

/** Once every byte is sent: the server still has to finish writing the file (closing
 *  it can take seconds for a big one), so the panel says so instead of sitting at 100%. */
export function uploadFinishingLine(name: string): string {
  return `Finishing ${name} on the host — the server is writing it to disk…`;
}

/** The upload is done: `Uploaded image.tar.gz (266 MB in 12.1 s, 22 MB/s)`. */
export function uploadDoneLine(name: string, bytes: number, elapsedMs: number): string {
  const secs = elapsedMs / 1000;
  const speed = secs >= 1 ? `, ${formatSize(bytes / secs)}/s` : '';
  return `Uploaded ${name} (${formatSize(bytes)} in ${secs.toFixed(1)} s${speed})`;
}

/** Save-time structural validation — not execution. Returns a list of problem
 *  strings (empty means valid): an unknown `snippetId`, a duplicate label or
 *  parameter name, more than one `'host'`-kind parameter, a remote node with no host
 *  parameter declared to supply it at run time, a dangling edge, a
 *  `{{nodes.<label>.output}}`/`{{params.<name>}}` reference that doesn't resolve
 *  (a node reference must additionally be a *direct* predecessor — template scope is
 *  exactly what an edge means, "this output is visible to that node"; a param
 *  reference has no such restriction, since every param is automation-wide), and a cycle. */
export function validateAutomation(
  automation: Automation,
  snippetsById: Map<string, Snippet>,
  /** Every automation, by name — to check "run automation" nodes against. Without it
   *  those are checked only for having a name. */
  automationsByName?: Map<string, Automation>
): string[] {
  const problems: string[] = [];
  const nodeIds = new Set(automation.nodes.map((n) => n.id));
  const nodeById = new Map(automation.nodes.map((n) => [n.id, n]));
  const labelToNode = new Map<string, AutomationNode>();
  const labelCounts = new Map<string, number>();

  for (const node of automation.nodes) {
    if (node.github !== undefined) {
      const g = node.github;
      if (!g.repo.trim()) problems.push(`GitHub step "${node.label}" needs a repository`);
      if (g.action === 'runWorkflow') {
        if (!g.workflow.trim()) problems.push(`GitHub step "${node.label}" needs a workflow`);
        if (!g.ref.trim()) problems.push(`GitHub step "${node.label}" needs a branch to run on`);
      } else if (!g.tag.trim()) {
        problems.push(`GitHub step "${node.label}" needs a release tag`);
      }
      if (node.target !== 'local') problems.push(`GitHub step "${node.label}" runs on this machine`);
    } else if (node.upload !== undefined) {
      if (!node.upload.from.trim()) problems.push(`upload "${node.label}" needs a file to upload`);
      if (!node.upload.to.trim()) problems.push(`upload "${node.label}" needs a destination on the host`);
      if (node.target !== 'remote') problems.push(`upload "${node.label}" must target the host`);
    } else if (node.condition !== undefined) {
      const c = node.condition;
      if (c.kind === 'compare') {
        if (!c.left.trim()) problems.push(`if "${node.label}" needs something to check`);
        // "equals nothing" is a fine question; "contains nothing" always holds.
        if ((c.op === 'contains' || c.op === 'notContains') && !c.right.trim()) {
          problems.push(`if "${node.label}" needs something to look for`);
        }
      } else if (!c.command.trim()) {
        problems.push(`if "${node.label}" needs a command to run`);
      }
    } else if (node.call !== undefined) {
      problems.push(...callProblems(automation, node, automationsByName));
    } else if (snippetsById.get(node.snippetId) === undefined) {
      problems.push(`node "${node.label}" references an unknown snippet`);
    }
    labelCounts.set(node.label, (labelCounts.get(node.label) ?? 0) + 1);
    labelToNode.set(node.label, node);
  }
  for (const [label, count] of labelCounts) {
    if (count > 1) problems.push(`label "${label}" is used by more than one node`);
  }

  const paramNames = new Set<string>();
  const paramNameCounts = new Map<string, number>();
  let hostParamCount = 0;
  for (const param of automation.params) {
    if (!param.name.trim()) problems.push('a parameter needs a name');
    paramNames.add(param.name);
    paramNameCounts.set(param.name, (paramNameCounts.get(param.name) ?? 0) + 1);
    if (param.kind === 'host') hostParamCount += 1;
  }
  for (const [name, count] of paramNameCounts) {
    if (count > 1) problems.push(`parameter "${name}" is declared more than once`);
  }
  if (hostParamCount > 1) problems.push('an automation can have at most one host parameter');

  const hasRemoteNode = automation.nodes.some((n) => n.target === 'remote');
  if (hasRemoteNode && hostParamCount === 0) {
    problems.push('this automation has a node set to run on a host but no host parameter — add one so a host can be chosen when the automation runs');
  }

  for (const edge of automation.edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      problems.push('an edge references a node that is not in this automation');
      continue;
    }
    const from = nodeById.get(edge.from)!;
    if (from.condition !== undefined && edge.branch === undefined) {
      problems.push(`a connection out of if "${from.label}" must leave by its "yes" or its "no"`);
    } else if (from.condition === undefined && edge.branch !== undefined) {
      problems.push(`only an if node's connections have a "yes" or "no" (from "${from.label}")`);
    }
  }

  const predecessorsOf = predecessorMap(automation);
  for (const node of automation.nodes) {
    const text = templatedText(node, snippetsById);
    if (text === undefined) continue;
    const directPredecessorLabels = new Set(
      (predecessorsOf.get(node.id) ?? []).map((id) => nodeById.get(id)?.label)
    );
    for (const match of text.matchAll(TEMPLATE_REF)) {
      const ref = match[1];
      if (!labelToNode.has(ref)) {
        problems.push(`node "${node.label}" references unknown label "${ref}"`);
      } else if (!directPredecessorLabels.has(ref)) {
        problems.push(`node "${node.label}" references "${ref}", which is not a direct dependency (add an edge from it)`);
      }
    }
    for (const match of text.matchAll(PARAM_REF)) {
      const ref = match[1];
      if (!paramNames.has(ref)) {
        problems.push(`node "${node.label}" references unknown parameter "${ref}"`);
      }
    }
  }

  try {
    topoOrder(automation);
  } catch (e) {
    problems.push((e as Error).message);
  }

  return problems;
}

/** What's wrong with "run automation" node `node` of `automation`: no automation named,
 *  one that doesn't exist, a value missing for something it asks for (or one for a
 *  parameter it doesn't have), or a loop — it calling, through any number of others, back. */
function callProblems(automation: Automation, node: AutomationNode, automationsByName?: Map<string, Automation>): string[] {
  const call = node.call!;
  const name = call.automation.trim();
  if (!name) return [`"${node.label}" needs an automation to run`];
  const problems: string[] = [];
  if (node.target !== 'local') problems.push(`"${node.label}" runs another automation, so it runs on this machine`);
  if (automationsByName === undefined) return problems;
  const called = automationsByName.get(name);
  if (called === undefined) return [...problems, `"${node.label}" runs automation "${name}", which doesn't exist`];
  for (const p of called.params) {
    if (p.kind !== 'fixed' && !call.params[p.name]?.trim()) {
      problems.push(`"${node.label}" needs a value for "${p.label || p.name}" of automation "${name}"`);
    }
  }
  for (const given of Object.keys(call.params)) {
    if (!called.params.some((p) => p.name === given && p.kind !== 'fixed')) {
      problems.push(`"${node.label}" sets "${given}", which automation "${name}" doesn't ask for`);
    }
  }
  const loop = callLoop(automation.name, name, automationsByName);
  if (loop) problems.push(`"${node.label}" would run in a loop: ${loop.join(' → ')}`);
  return problems;
}

/** The chain of calls from `from` that leads back to `start`, if one does. */
export function callLoop(start: string, from: string, automationsByName: Map<string, Automation>): string[] | undefined {
  const seen = new Set<string>();
  function walk(name: string, path: string[]): string[] | undefined {
    if (name === start) return [...path, name];
    if (seen.has(name)) return undefined;
    seen.add(name);
    for (const n of automationsByName.get(name)?.nodes ?? []) {
      if (n.call === undefined) continue;
      const found = walk(n.call.automation.trim(), [...path, name]);
      if (found) return found;
    }
    return undefined;
  }
  return walk(from, [start]);
}

/** Run-time check, distinct from `validateAutomation`'s save-time structural check: does
 *  `paramValues` (what the user typed into the "run this automation" prompt) supply a
 *  non-blank value for every parameter the automation declares? Returns each missing
 *  param's `label ?? name`; empty means ready to run. */
export function missingParamValues(automation: Automation, paramValues: Record<string, string>): string[] {
  return automation.params
    .filter((p) => p.kind !== 'fixed' && !paramValues[p.name]?.trim())
    .map((p) => p.label || p.name);
}

/** Replaces every `{{nodes.<label>.output}}` and `{{params.<name>}}` in `command`.
 *  `predecessors` is the calling node's *direct* predecessors, keyed by label —
 *  matching `validateAutomation`'s "node-reference scope is direct edges only" rule;
 *  `paramValues` is the whole automation's run-time parameter values, keyed by name — every
 *  node sees every param, matching `validateAutomation`'s "params are automation-wide" rule.
 *  Throws if a referenced label or param isn't present; `validateAutomation`/
 *  `missingParamValues` should already have caught that before a run starts, so this
 *  is defense in depth, not the primary UX. */
export function substituteTemplate(
  command: string,
  predecessors: Map<string, NodeResult>,
  paramValues: Record<string, string> = {}
): string {
  const withNodeRefs = command.replace(TEMPLATE_REF, (_full, label: string) => {
    const result = predecessors.get(label);
    if (result === undefined) throw new Error(`no predecessor result for label "${label}"`);
    return result.output;
  });
  return withNodeRefs.replace(PARAM_REF, (_full, name: string) => {
    if (!(name in paramValues)) throw new Error(`no value for parameter "${name}"`);
    return paramValues[name];
  });
}

/** Why a node stopped when the run was stopped — its error, and every later node's. */
export const CANCELED = 'canceled';

export interface RunAutomationConnection {
  /** `signal` stops the command (the run was canceled); it resolves then all the same. */
  runShell(cmd: string, timeoutMs: number, signal?: AbortSignal): Promise<{ output: string; ok: boolean; error?: string }>;
  /** Copies the local file `from` to `to` on the host; rejects with why it failed.
   *  `onProgress` hears how far it is (bytes sent, of the file's size). */
  upload(from: string, to: string, signal?: AbortSignal, onProgress?: (done: number, total: number) => void): Promise<void>;
  disconnect(): void;
}

export interface RunAutomationDeps {
  /** Injected so `engine.ts` imports neither `ssh2` nor `child_process` — fully
   *  fakeable in tests. */
  connectHost: (hostName: string) => Promise<RunAutomationConnection>;
  /** Every runner takes the run's `signal`, which stops what it's doing when the run is
   *  canceled — a process killed, a remote command interrupted, a wait given up. */
  runLocal: (command: string, timeoutMs: number, signal?: AbortSignal) => Promise<{ output: string; ok: boolean; error?: string }>;
  /** A GitHub node: runs `step`, telling `report` how it's going; resolves with the node's output. */
  runGitHub: (step: GitHubStep, report: (message: string) => void, signal?: AbortSignal) => Promise<string>;
  /** A `'wsl'` node: `command` in WSL distribution `distro` (its default one when unset). */
  runWsl: (
    distro: string | undefined,
    command: string,
    timeoutMs: number,
    signal?: AbortSignal
  ) => Promise<{ output: string; ok: boolean; error?: string }>;
  /** An upload from WSL: the path Windows reads WSL file `path` at; rejects if it isn't there. */
  wslUploadSource: (distro: string | undefined, path: string) => Promise<string>;
  /** Every automation, by name — what a "run automation" node can run. */
  automations?: Map<string, Automation>;
}

export type AutomationProgressEvent =
  | { kind: 'nodeStarted'; nodeId: string; label: string }
  /** A line of news from a long-running node (a GitHub run's progress). */
  | { kind: 'nodeProgress'; nodeId: string; message: string }
  | { kind: 'nodeResult'; result: NodeResult };

/** Runs every node in `automation`, sequentially in topological order (matching the SFTP
 *  pending-queue "one op at a time" precedent elsewhere in this codebase — simpler to
 *  reason about and debug than parallel branches). A node whose direct predecessors
 *  aren't all `success` (or `failed`/`skipped` with that predecessor's own
 *  `continueOnError: true`) is skipped rather than run — see `types.ts`'s doc comment
 *  on `AutomationNode.continueOnError` for the exact rule. `paramValues` is what the caller
 *  collected from the "run this automation" prompt (see `missingParamValues`) — the same
 *  values for every node, so one automation definition runs identically against whichever
 *  host (and whichever text param values) are supplied this time. Opens one
 *  connection per distinct remote host actually touched, lazily on first use, reused
 *  across nodes targeting it, and disconnects every opened connection in `finally`. */
export async function runAutomation(
  automation: Automation,
  snippetsById: Map<string, Snippet>,
  askedParamValues: Record<string, string>,
  deps: RunAutomationDeps,
  onProgress?: (event: AutomationProgressEvent) => void,
  /** Cancels the run: the running node stops and fails as `canceled`, every node after it
   *  is skipped, and the run still completes with all its results. */
  signal?: AbortSignal,
  /** For a nested run (a "run automation" node): the automations already running above
   *  it, so a loop the save-time check didn't see still stops. */
  callStack: string[] = []
): Promise<NodeResult[]> {
  const order = topoOrder(automation);
  const paramValues = effectiveParamValues(automation, askedParamValues);
  const nodeById = new Map(automation.nodes.map((n) => [n.id, n]));
  const predecessorsOf = predecessorMap(automation);
  const edgesInto = new Map<string, Automation['edges']>(automation.nodes.map((n) => [n.id, []]));
  for (const edge of automation.edges) edgesInto.get(edge.to)?.push(edge);
  /** Nodes skipped because they weren't on the way an If went — unlike a node skipped
   *  for a failure, these don't hold up what comes after them through another way. */
  const offBranch = new Set<string>();

  /** An edge that doesn't count: out of an If, the way it didn't go — or out of a node
   *  that was itself off the way taken. */
  function offBranchEdge(edge: Automation['edges'][number]): boolean {
    if (offBranch.has(edge.from)) return true;
    const from = nodeById.get(edge.from);
    const result = resultsById.get(edge.from);
    return from?.condition !== undefined && result?.status === 'success' && edge.branch !== undefined && result.output !== edge.branch;
  }
  const hostParam = hostParamOf(automation);
  const resultsById = new Map<string, NodeResult>();
  // Kept as promises, so one still connecting when the run is canceled is closed too.
  const connections = new Map<string, Promise<RunAutomationConnection>>();

  /** The host's connection, opened on first use and shared by every node after. */
  function connectionFor(hostName: string): Promise<RunAutomationConnection> {
    let connection = connections.get(hostName);
    if (connection === undefined) {
      connection = deps.connectHost(hostName);
      connections.set(hostName, connection);
    }
    return connection;
  }

  /** `work`, or a `canceled` rejection the moment the run is canceled — so a runner
   *  that's slow to stop never holds the run up. */
  function untilCanceled<T>(work: Promise<T>): Promise<T> {
    if (signal === undefined) return work;
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => reject(new Error(CANCELED));
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  }

  /** An If node's answer as its output: `yes` or `no`. A command that doesn't succeed —
   *  a non-zero exit, a timeout — is a `no`; only a cancel fails the node. */
  async function evaluateCondition(
    node: AutomationNode,
    condition: IfCondition,
    predecessors: Map<string, NodeResult>,
    hostName: string | undefined
  ): Promise<{ output: string; ok: boolean; error?: string }> {
    if (condition.kind === 'compare') {
      const left = substituteTemplate(condition.left, predecessors, paramValues);
      const right = substituteTemplate(condition.right, predecessors, paramValues);
      return { output: compareTexts(left, condition.op, right) ? 'yes' : 'no', ok: true };
    }
    const command = substituteTemplate(condition.command, predecessors, paramValues);
    const timeoutMs = condition.timeoutSecs * 1000;
    const result =
      node.target === 'local'
        ? await deps.runLocal(command, timeoutMs, signal)
        : node.target === 'wsl'
          ? await deps.runWsl(node.wslDistro || undefined, command, timeoutMs, signal)
          : await (await connectionFor(hostName!)).runShell(command, timeoutMs, signal);
    if (signal?.aborted) return { output: '', ok: false, error: CANCELED };
    return { output: result.ok ? 'yes' : 'no', ok: true };
  }

  /** A "run automation" node: runs the automation as a nested run with the values given,
   *  reporting each of its steps as a line of progress. Fails when one of its steps
   *  fails (one that isn't set to continue on error); its output is the output of the
   *  last step that ran. */
  async function runCall(
    nodeId: string,
    node: AutomationNode,
    predecessors: Map<string, NodeResult>
  ): Promise<{ output: string; ok: boolean; error?: string }> {
    const call = node.call!;
    const name = call.automation.trim();
    const called = deps.automations?.get(name);
    if (called === undefined) return { output: '', ok: false, error: `automation "${name}" no longer exists` };
    const stack = [...callStack, automation.name];
    if (stack.includes(called.name)) return { output: '', ok: false, error: `runs in a loop: ${[...stack, called.name].join(' → ')}` };
    const problems = validateAutomation(called, snippetsById, deps.automations);
    if (problems.length > 0) return { output: '', ok: false, error: `automation "${name}": ${problems.join('; ')}` };
    const values = Object.fromEntries(
      Object.entries(call.params).map(([k, v]) => [k, substituteTemplate(v, predecessors, paramValues).trim()])
    );
    const missing = missingParamValues(called, values);
    if (missing.length > 0) return { output: '', ok: false, error: `automation "${name}" needs a value for: ${missing.join(', ')}` };

    const report = (message: string): void => onProgress?.({ kind: 'nodeProgress', nodeId, message });
    report(`Running automation "${name}"`);
    const results = await runAutomation(
      called,
      snippetsById,
      values,
      deps,
      (event) => {
        if (event.kind === 'nodeStarted') report(`▸ ${event.label}`);
        else if (event.kind === 'nodeProgress') report(`  ${event.message}`);
        else if (event.result.status === 'success') report(`✓ ${event.result.label}`);
        else if (event.result.status === 'failed') report(`✗ ${event.result.label}: ${event.result.error ?? 'failed'}`);
      },
      signal,
      stack
    );
    const calledNodes = new Map(called.nodes.map((n) => [n.id, n]));
    const failure = results.find((r) => r.status === 'failed' && !calledNodes.get(r.nodeId)?.continueOnError);
    const last = [...results].reverse().find((r) => r.status === 'success');
    if (failure) return { output: last?.output ?? '', ok: false, error: `step "${failure.label}" of "${name}" failed: ${failure.error ?? 'failed'}` };
    return { output: last?.output ?? '', ok: true };
  }

  function settle(nodeId: string, result: NodeResult): void {
    resultsById.set(nodeId, result);
    onProgress?.({ kind: 'nodeResult', result });
  }

  /** One node, once everything before it has settled: skipped, failed early, or run. */
  async function runNode(nodeId: string): Promise<void> {
      const node = nodeById.get(nodeId)!;
      const snippet = snippetsById.get(node.snippetId);

      if (signal?.aborted) {
        settle(nodeId, { nodeId, label: node.label, status: 'skipped', output: '', error: CANCELED, durationMs: 0 });
        return;
      }

      if (snippet === undefined && node.upload === undefined && node.github === undefined && node.condition === undefined && node.call === undefined) {
        settle(nodeId, { nodeId, label: node.label, status: 'failed', output: '', error: 'snippet no longer exists', durationMs: 0 });
        return;
      }
      const nodeHostName = hostParam ? paramValues[hostParam.name] : undefined;
      if (node.target === 'remote' && !nodeHostName) {
        settle(nodeId, { nodeId, label: node.label, status: 'failed', output: '', error: 'node runs on a host but the automation has no host parameter value', durationMs: 0 });
        return;
      }

      const predecessorIds = predecessorsOf.get(nodeId) ?? [];
      // Off the way an If went — every way in leads from there: skipped, and so is
      // what only this leads to. Where ways join, the one taken is what counts.
      const incoming = edgesInto.get(nodeId) ?? [];
      const live = incoming.filter((e) => !offBranchEdge(e));
      if (incoming.length > 0 && live.length === 0) {
        offBranch.add(nodeId);
        settle(nodeId, { nodeId, label: node.label, status: 'skipped', output: '', durationMs: 0 });
        return;
      }
      const blocked = live.some((e) => {
        const r = resultsById.get(e.from)!;
        return r.status !== 'success' && !nodeById.get(e.from)!.continueOnError;
      });
      if (blocked) {
        settle(nodeId, { nodeId, label: node.label, status: 'skipped', output: '', durationMs: 0 });
        return;
      }

      onProgress?.({ kind: 'nodeStarted', nodeId, label: node.label });
      const predecessorsByLabel = new Map(predecessorIds.map((id) => [nodeById.get(id)!.label, resultsById.get(id)!]));
      const startedAt = Date.now();

      let exec: { output: string; ok: boolean; error?: string };
      try {
        if (node.call !== undefined) {
          exec = await untilCanceled(runCall(nodeId, node, predecessorsByLabel));
        } else if (node.condition !== undefined) {
          exec = await untilCanceled(evaluateCondition(node, node.condition, predecessorsByLabel, nodeHostName));
        } else if (node.github !== undefined) {
          const step = substituteGitHubStep(node.github, predecessorsByLabel, paramValues);
          const output = await untilCanceled(deps.runGitHub(step, (message) => onProgress?.({ kind: 'nodeProgress', nodeId, message }), signal));
          exec = { output, ok: true };
        } else if (node.upload !== undefined) {
          // No timeout: a big image takes as long as the line allows, and a stalled
          // transfer fails on the SSH connection's own keepalive.
          const from = substituteTemplate(node.upload.from, predecessorsByLabel, paramValues).trim();
          const to = uploadDestination(from, substituteTemplate(node.upload.to, predecessorsByLabel, paramValues));
          // A file in WSL is read where WSL keeps it, not looked up by name on Windows.
          const local = node.upload.source === 'wsl' ? await untilCanceled(deps.wslUploadSource(node.upload.wslDistro || undefined, from)) : from;
          const connection = await untilCanceled(connectionFor(nodeHostName!));
          const fileName = from.split(/[\\/]/).filter(Boolean).pop() ?? from;
          const uploadStarted = Date.now();
          const report = (message: string): void => onProgress?.({ kind: 'nodeProgress', nodeId, message });
          let size: number | undefined;
          await untilCanceled(
            connection.upload(local, to, signal, (done, total) => {
              size = total;
              report(uploadProgressLine(fileName, done, total, Date.now() - uploadStarted));
              if (done === total) report(uploadFinishingLine(fileName));
            })
          );
          // Only after progress lines — a transfer that told nothing has no size to give.
          if (size !== undefined) report(uploadDoneLine(fileName, size, Date.now() - uploadStarted));
          // The output is where it landed, so the next node can use it as is:
          // `docker load < {{nodes.upload.output}}`.
          exec = { output: to, ok: true };
        } else if (node.target === 'local') {
          const command = substituteTemplate(snippet!.command, predecessorsByLabel, paramValues);
          exec = await untilCanceled(deps.runLocal(command, snippet!.timeoutSecs * 1000, signal));
        } else if (node.target === 'wsl') {
          const command = substituteTemplate(snippet!.command, predecessorsByLabel, paramValues);
          exec = await untilCanceled(deps.runWsl(node.wslDistro || undefined, command, snippet!.timeoutSecs * 1000, signal));
        } else {
          const command = substituteTemplate(snippet!.command, predecessorsByLabel, paramValues);
          const connection = await untilCanceled(connectionFor(nodeHostName!));
          exec = await untilCanceled(connection.runShell(command, snippet!.timeoutSecs * 1000, signal));
        }
      } catch (e) {
        exec = { output: '', ok: false, error: (e as Error).message };
      }
      // However the runner reported its stop, a canceled run's node failed by cancelation.
      if (signal?.aborted && !exec.ok) exec = { ...exec, error: CANCELED };

      settle(nodeId, {
        nodeId,
        label: node.label,
        status: exec.ok ? 'success' : 'failed',
        output: exec.output,
        error: exec.ok ? undefined : exec.error,
        durationMs: Date.now() - startedAt
      });
  }

  // Which nodes come after which, and how many unsettled predecessors each still has.
  const successors = new Map<string, string[]>(automation.nodes.map((n) => [n.id, []]));
  const waitingOn = new Map<string, number>(automation.nodes.map((n) => [n.id, 0]));
  for (const edge of automation.edges) {
    if (!successors.has(edge.from) || !waitingOn.has(edge.to)) continue;
    successors.get(edge.from)!.push(edge.to);
    waitingOn.set(edge.to, waitingOn.get(edge.to)! + 1);
  }
  // At most `limit` nodes at once: 1 (one after the other, in `order`) unless the
  // automation lets its branches run in parallel.
  const limit = Math.max(1, Math.floor(automation.maxParallel ?? 1));
  const ready = order.filter((id) => waitingOn.get(id) === 0);
  const running = new Map<string, Promise<string>>();

  try {
    while (ready.length > 0 || running.size > 0) {
      while (ready.length > 0 && running.size < limit) {
        const nodeId = ready.shift()!;
        running.set(nodeId, runNode(nodeId).then(() => nodeId));
      }
      const done = await Promise.race(running.values());
      running.delete(done);
      // Its successors may be ready now — taken in the automation's own order.
      for (const next of successors.get(done) ?? []) {
        const left = waitingOn.get(next)! - 1;
        waitingOn.set(next, left);
        if (left === 0) ready.push(next);
      }
    }
  } finally {
    for (const connection of connections.values()) connection.then((c) => c.disconnect(), () => {});
  }

  return order.map((id) => resultsById.get(id)!);
}
