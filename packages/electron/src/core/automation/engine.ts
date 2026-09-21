import type { Snippet, Automation, AutomationNode, NodeResult } from './types.js';

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

/** Save-time structural validation — not execution. Returns a list of problem
 *  strings (empty means valid): an unknown `snippetId`, a duplicate label or
 *  parameter name, more than one `'host'`-kind parameter, a remote node with no host
 *  parameter declared to supply it at run time, a dangling edge, a
 *  `{{nodes.<label>.output}}`/`{{params.<name>}}` reference that doesn't resolve
 *  (a node reference must additionally be a *direct* predecessor — template scope is
 *  exactly what an edge means, "this output is visible to that node"; a param
 *  reference has no such restriction, since every param is automation-wide), and a cycle. */
export function validateAutomation(automation: Automation, snippetsById: Map<string, Snippet>): string[] {
  const problems: string[] = [];
  const nodeIds = new Set(automation.nodes.map((n) => n.id));
  const nodeById = new Map(automation.nodes.map((n) => [n.id, n]));
  const labelToNode = new Map<string, AutomationNode>();
  const labelCounts = new Map<string, number>();

  for (const node of automation.nodes) {
    const snippet = snippetsById.get(node.snippetId);
    if (snippet === undefined) {
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
    }
  }

  const predecessorsOf = predecessorMap(automation);
  for (const node of automation.nodes) {
    const snippet = snippetsById.get(node.snippetId);
    if (snippet === undefined) continue;
    const directPredecessorLabels = new Set(
      (predecessorsOf.get(node.id) ?? []).map((id) => nodeById.get(id)?.label)
    );
    for (const match of snippet.command.matchAll(TEMPLATE_REF)) {
      const ref = match[1];
      if (!labelToNode.has(ref)) {
        problems.push(`node "${node.label}" references unknown label "${ref}"`);
      } else if (!directPredecessorLabels.has(ref)) {
        problems.push(`node "${node.label}" references "${ref}", which is not a direct dependency (add an edge from it)`);
      }
    }
    for (const match of snippet.command.matchAll(PARAM_REF)) {
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

/** Run-time check, distinct from `validateAutomation`'s save-time structural check: does
 *  `paramValues` (what the user typed into the "run this automation" prompt) supply a
 *  non-blank value for every parameter the automation declares? Returns each missing
 *  param's `label ?? name`; empty means ready to run. */
export function missingParamValues(automation: Automation, paramValues: Record<string, string>): string[] {
  return automation.params.filter((p) => !paramValues[p.name]?.trim()).map((p) => p.label || p.name);
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

export interface RunAutomationConnection {
  runShell(cmd: string, timeoutMs: number): Promise<{ output: string; ok: boolean; error?: string }>;
  disconnect(): void;
}

export interface RunAutomationDeps {
  /** Injected so `engine.ts` imports neither `ssh2` nor `child_process` — fully
   *  fakeable in tests. */
  connectHost: (hostName: string) => Promise<RunAutomationConnection>;
  runLocal: (command: string, timeoutMs: number) => Promise<{ output: string; ok: boolean; error?: string }>;
}

export type AutomationProgressEvent =
  | { kind: 'nodeStarted'; nodeId: string; label: string }
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
  paramValues: Record<string, string>,
  deps: RunAutomationDeps,
  onProgress?: (event: AutomationProgressEvent) => void
): Promise<NodeResult[]> {
  const order = topoOrder(automation);
  const nodeById = new Map(automation.nodes.map((n) => [n.id, n]));
  const predecessorsOf = predecessorMap(automation);
  const hostParam = hostParamOf(automation);
  const resultsById = new Map<string, NodeResult>();
  const connections = new Map<string, RunAutomationConnection>();

  function settle(nodeId: string, result: NodeResult): void {
    resultsById.set(nodeId, result);
    onProgress?.({ kind: 'nodeResult', result });
  }

  try {
    for (const nodeId of order) {
      const node = nodeById.get(nodeId)!;
      const snippet = snippetsById.get(node.snippetId);

      if (snippet === undefined) {
        settle(nodeId, { nodeId, label: node.label, status: 'failed', output: '', error: 'snippet no longer exists', durationMs: 0 });
        continue;
      }
      const nodeHostName = hostParam ? paramValues[hostParam.name] : undefined;
      if (node.target === 'remote' && !nodeHostName) {
        settle(nodeId, { nodeId, label: node.label, status: 'failed', output: '', error: 'node runs on a host but the automation has no host parameter value', durationMs: 0 });
        continue;
      }

      const predecessorIds = predecessorsOf.get(nodeId) ?? [];
      const predecessorResults = predecessorIds.map((id) => resultsById.get(id)!);
      const blocked = predecessorResults.some((r) => r.status !== 'success' && !nodeById.get(r.nodeId)!.continueOnError);
      if (blocked) {
        settle(nodeId, { nodeId, label: node.label, status: 'skipped', output: '', durationMs: 0 });
        continue;
      }

      onProgress?.({ kind: 'nodeStarted', nodeId, label: node.label });
      const predecessorsByLabel = new Map(predecessorIds.map((id) => [nodeById.get(id)!.label, resultsById.get(id)!]));
      const timeoutMs = snippet.timeoutSecs * 1000;
      const startedAt = Date.now();

      let exec: { output: string; ok: boolean; error?: string };
      try {
        const command = substituteTemplate(snippet.command, predecessorsByLabel, paramValues);
        if (node.target === 'local') {
          exec = await deps.runLocal(command, timeoutMs);
        } else {
          const hostName = nodeHostName!;
          let connection = connections.get(hostName);
          if (connection === undefined) {
            connection = await deps.connectHost(hostName);
            connections.set(hostName, connection);
          }
          exec = await connection.runShell(command, timeoutMs);
        }
      } catch (e) {
        exec = { output: '', ok: false, error: (e as Error).message };
      }

      settle(nodeId, {
        nodeId,
        label: node.label,
        status: exec.ok ? 'success' : 'failed',
        output: exec.output,
        error: exec.ok ? undefined : exec.error,
        durationMs: Date.now() - startedAt
      });
    }
  } finally {
    for (const connection of connections.values()) connection.disconnect();
  }

  return order.map((id) => resultsById.get(id)!);
}
