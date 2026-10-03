// Copy and paste of canvas nodes: Ctrl+C puts the selected nodes and the connections
// between them on the clipboard (as JSON text, so it works across automations — and
// windows); Ctrl+V adds a copy to the automation that's open. Kept free of Svelte and
// svelte-flow so it's unit-testable; AutomationEditor.svelte handles the keys.

import type { AutomationCanvasEdge, StepNode } from './automationCanvasTypes';

const KIND = 'remoty-automation-nodes';

export interface ClipboardNodes {
  kind: typeof KIND;
  version: 1;
  nodes: Array<Pick<StepNode, 'id' | 'type' | 'position' | 'data'>>;
  edges: Array<{ source: string; target: string; sourceHandle?: string | null }>;
}

/** What to put on the clipboard for `selected` nodes: them, and every connection whose
 *  both ends are among them (one leading out of the selection has nowhere to go). */
export function copyNodes(selected: StepNode[], edges: AutomationCanvasEdge[]): ClipboardNodes {
  const ids = new Set(selected.map((n) => n.id));
  return {
    kind: KIND,
    version: 1,
    nodes: selected.map((n) => ({ id: n.id, type: n.type, position: { ...n.position }, data: $snapshot(n.data) })) as ClipboardNodes['nodes'],
    edges: edges
      .filter((e) => ids.has(e.source) && ids.has(e.target))
      .map((e) => ({ source: e.source, target: e.target, ...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}) }))
  };
}

/** A plain copy of node data that may be a Svelte state proxy (structuredClone can't
 *  clone a proxy). */
function $snapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** The nodes on the clipboard, or null when it holds anything else. */
export function readClipboard(text: string): ClipboardNodes | null {
  try {
    const raw = JSON.parse(text) as Partial<ClipboardNodes>;
    if (raw?.kind !== KIND || !Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) return null;
    const known = ['snippet', 'upload', 'github', 'if', 'call'];
    if (!raw.nodes.every((n) => typeof n?.id === 'string' && known.includes(n.type as string) && n.data && typeof (n.data as { label?: unknown }).label === 'string')) {
      return null;
    }
    return raw as ClipboardNodes;
  } catch {
    return null;
  }
}

/** A label not in `taken`: `base`, else `base-2`, `base-3`, … (as new nodes get theirs). */
export function freeLabel(base: string, taken: Set<string>): string {
  const slug = base.trim() || 'node';
  if (!taken.has(slug)) return slug;
  let i = 2;
  while (taken.has(`${slug}-${i}`)) i += 1;
  return `${slug}-${i}`;
}

/** Every string in `value`, with `{{nodes.<old>.output}}` pointed at the renamed labels. */
function relabel<T>(value: T, renamed: Map<string, string>): T {
  if (renamed.size === 0) return value;
  if (typeof value === 'string') {
    return value.replace(/\{\{nodes\.([^.}]+)\.output\}\}/g, (all, label: string) =>
      renamed.has(label) ? `{{nodes.${renamed.get(label)}.output}}` : all
    ) as T;
  }
  if (Array.isArray(value)) return value.map((v) => relabel(v, renamed)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, relabel(v, renamed)])) as T;
  }
  return value;
}

/**
 * The nodes and connections to add for `clip`: new ids, moved by `offset`, selected (so
 * they can be dragged on together), and each with a label not already in `takenLabels` —
 * a renamed one is renamed in the copied nodes' own `{{nodes.<label>.output}}` too. A
 * snippet's command lives in the snippet, so it can't be: saving says if one refers to a
 * label that changed.
 */
export function pasteNodes(
  clip: ClipboardNodes,
  takenLabels: Set<string>,
  offset: { x: number; y: number },
  newId: () => string = () => crypto.randomUUID()
): { nodes: StepNode[]; edges: AutomationCanvasEdge[]; renamed: Map<string, string> } {
  const taken = new Set(takenLabels);
  const ids = new Map<string, string>();
  const renamed = new Map<string, string>();
  for (const n of clip.nodes) {
    ids.set(n.id, newId());
    const label = (n.data as { label: string }).label;
    const free = freeLabel(label, taken);
    taken.add(free);
    if (free !== label) renamed.set(label, free);
  }
  const nodes = clip.nodes.map((n) => {
    const data = relabel(n.data, renamed) as { label: string };
    const label = (n.data as { label: string }).label;
    return {
      id: ids.get(n.id)!,
      type: n.type,
      position: { x: n.position.x + offset.x, y: n.position.y + offset.y },
      data: { ...data, label: renamed.get(label) ?? label },
      selected: true
    } as StepNode;
  });
  const edges: AutomationCanvasEdge[] = clip.edges
    .filter((e) => ids.has(e.source) && ids.has(e.target))
    .map((e) => {
      const source = ids.get(e.source)!;
      const target = ids.get(e.target)!;
      const branch = e.sourceHandle === 'yes' || e.sourceHandle === 'no' ? e.sourceHandle : undefined;
      return branch
        ? { id: `${source}:${branch}->${target}`, source, target, sourceHandle: branch, label: branch }
        : { id: `${source}->${target}`, source, target };
    });
  return { nodes, edges, renamed };
}
