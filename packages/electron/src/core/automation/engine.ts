import type { Automation, Flow, FlowNode, NodeResult } from './types.js';

/**
 * The Automations v2 execution engine: a `Flow` is a DAG of `FlowNode`s (each an
 * instance of a reusable `Automation`), executed in topological order. Pure
 * logic — `topoOrder`/`validateFlow`/`substituteTemplate` — is exported separately
 * from the `runFlow` orchestrator so it's fully unit-testable without a real SSH
 * session or child process (see `RunFlowDeps`, injected rather than imported).
 */

const TEMPLATE_REF = /\{\{nodes\.([^.}]+)\.output\}\}/g;

export class AutomationCycleError extends Error {}

/** Kahn's algorithm. Deterministic for a given flow: nodes become "ready" (all
 *  predecessors already ordered) in the order their last-completing predecessor was
 *  processed, ties broken by the flow's own node order. Throws `AutomationCycleError`
 *  naming one of the nodes that couldn't be ordered when the flow isn't a DAG.
 *  Dangling edges (referencing a node id not in the flow) are ignored here —
 *  `validateFlow` reports those as a problem instead of failing the sort. */
export function topoOrder(flow: Flow): string[] {
  const nodeIds = flow.nodes.map((n) => n.id);
  const inDegree = new Map<string, number>(nodeIds.map((id) => [id, 0]));
  const adjacency = new Map<string, string[]>(nodeIds.map((id) => [id, []]));

  for (const edge of flow.edges) {
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
    const stuckLabel = flow.nodes.find((n) => n.id === stuckId)?.label ?? stuckId;
    throw new AutomationCycleError(`automation flow has a cycle involving node "${stuckLabel}"`);
  }

  return order;
}

/** The direct predecessors (by node id) of every node, from the flow's edges. */
function predecessorMap(flow: Flow): Map<string, string[]> {
  const map = new Map<string, string[]>(flow.nodes.map((n) => [n.id, []]));
  for (const edge of flow.edges) {
    if (map.has(edge.to) && map.has(edge.from)) map.get(edge.to)!.push(edge.from);
  }
  return map;
}

/** Save-time structural validation — not execution. Returns a list of problem
 *  strings (empty means valid): an unknown `automationId`, a remote Automation with
 *  no `hostName`, a duplicate label, a dangling edge, a `{{nodes.<label>.output}}`
 *  reference to a label that isn't a *direct* predecessor (template scope is exactly
 *  what an edge means — "this output is visible to that node"), and a cycle. */
export function validateFlow(flow: Flow, automationsById: Map<string, Automation>): string[] {
  const problems: string[] = [];
  const nodeIds = new Set(flow.nodes.map((n) => n.id));
  const nodeById = new Map(flow.nodes.map((n) => [n.id, n]));
  const labelToNode = new Map<string, FlowNode>();
  const labelCounts = new Map<string, number>();

  for (const node of flow.nodes) {
    const automation = automationsById.get(node.automationId);
    if (automation === undefined) {
      problems.push(`node "${node.label}" references an unknown automation`);
    } else if (automation.kind === 'remote' && automation.hostName === undefined) {
      problems.push(`node "${node.label}" uses automation "${automation.name}", a remote automation with no host set`);
    }
    labelCounts.set(node.label, (labelCounts.get(node.label) ?? 0) + 1);
    labelToNode.set(node.label, node);
  }
  for (const [label, count] of labelCounts) {
    if (count > 1) problems.push(`label "${label}" is used by more than one node`);
  }

  for (const edge of flow.edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      problems.push('an edge references a node that is not in this flow');
    }
  }

  const predecessorsOf = predecessorMap(flow);
  for (const node of flow.nodes) {
    const automation = automationsById.get(node.automationId);
    if (automation === undefined) continue;
    const directPredecessorLabels = new Set(
      (predecessorsOf.get(node.id) ?? []).map((id) => nodeById.get(id)?.label)
    );
    for (const match of automation.command.matchAll(TEMPLATE_REF)) {
      const ref = match[1];
      if (!labelToNode.has(ref)) {
        problems.push(`node "${node.label}" references unknown label "${ref}"`);
      } else if (!directPredecessorLabels.has(ref)) {
        problems.push(`node "${node.label}" references "${ref}", which is not a direct dependency (add an edge from it)`);
      }
    }
  }

  try {
    topoOrder(flow);
  } catch (e) {
    problems.push((e as Error).message);
  }

  return problems;
}

/** Replaces every `{{nodes.<label>.output}}` in `command`, using only `predecessors`
 *  (the calling node's *direct* predecessors, keyed by label) — matching
 *  `validateFlow`'s "template scope is direct edges only" rule. Throws if a
 *  referenced label isn't present; `validateFlow` should already have caught that at
 *  save time, so this is defense in depth, not the primary UX. */
export function substituteTemplate(command: string, predecessors: Map<string, NodeResult>): string {
  return command.replace(TEMPLATE_REF, (_full, label: string) => {
    const result = predecessors.get(label);
    if (result === undefined) throw new Error(`no predecessor result for label "${label}"`);
    return result.output;
  });
}

export interface RunFlowConnection {
  runShell(cmd: string, timeoutMs: number): Promise<{ output: string; ok: boolean; error?: string }>;
  disconnect(): void;
}

export interface RunFlowDeps {
  /** Injected so `engine.ts` imports neither `ssh2` nor `child_process` — fully
   *  fakeable in tests. */
  connectHost: (hostName: string) => Promise<RunFlowConnection>;
  runLocal: (command: string, timeoutMs: number) => Promise<{ output: string; ok: boolean; error?: string }>;
}

export type FlowProgressEvent =
  | { kind: 'nodeStarted'; nodeId: string; label: string }
  | { kind: 'nodeResult'; result: NodeResult };

/** Runs every node in `flow`, sequentially in topological order (matching the SFTP
 *  pending-queue "one op at a time" precedent elsewhere in this codebase — simpler to
 *  reason about and debug than parallel branches). A node whose direct predecessors
 *  aren't all `success` (or `failed`/`skipped` with that predecessor's own
 *  `continueOnError: true`) is skipped rather than run — see `types.ts`'s doc comment
 *  on `FlowNode.continueOnError` for the exact rule. Opens one connection per distinct
 *  remote host actually touched, lazily on first use, reused across nodes targeting
 *  it, and disconnects every opened connection in `finally`. */
export async function runFlow(
  flow: Flow,
  automationsById: Map<string, Automation>,
  deps: RunFlowDeps,
  onProgress?: (event: FlowProgressEvent) => void
): Promise<NodeResult[]> {
  const order = topoOrder(flow);
  const nodeById = new Map(flow.nodes.map((n) => [n.id, n]));
  const predecessorsOf = predecessorMap(flow);
  const resultsById = new Map<string, NodeResult>();
  const connections = new Map<string, RunFlowConnection>();

  function settle(nodeId: string, result: NodeResult): void {
    resultsById.set(nodeId, result);
    onProgress?.({ kind: 'nodeResult', result });
  }

  try {
    for (const nodeId of order) {
      const node = nodeById.get(nodeId)!;
      const automation = automationsById.get(node.automationId);

      if (automation === undefined) {
        settle(nodeId, { nodeId, label: node.label, status: 'failed', output: '', error: 'automation no longer exists', durationMs: 0 });
        continue;
      }
      if (automation.kind === 'remote' && automation.hostName === undefined) {
        settle(nodeId, { nodeId, label: node.label, status: 'failed', output: '', error: 'remote automation has no host set', durationMs: 0 });
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
      const timeoutMs = automation.timeoutSecs * 1000;
      const startedAt = Date.now();

      let exec: { output: string; ok: boolean; error?: string };
      try {
        const command = substituteTemplate(automation.command, predecessorsByLabel);
        if (automation.kind === 'local') {
          exec = await deps.runLocal(command, timeoutMs);
        } else {
          const hostName = automation.hostName!;
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
