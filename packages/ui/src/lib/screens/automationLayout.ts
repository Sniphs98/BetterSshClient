// "Auto-arrange" for the Automation canvas: lays the graph out left to right with dagre —
// Start on the left, each step to the right of what it waits for, parallel branches one
// above the other. Kept free of svelte-flow so it's unit-testable; AutomationEditor.svelte
// applies the positions it returns.

import dagre from '@dagrejs/dagre';

export interface LayoutNode {
  id: string;
  /** As drawn (svelte-flow's `measured`); a guess before the node has rendered. */
  width?: number;
  height?: number;
}

export interface LayoutEdge {
  source: string;
  target: string;
}

const DEFAULT_SIZE = { width: 240, height: 140 };

/**
 * New top-left positions for `nodes`. `startId` is the Start node: it's put before every
 * step nothing else leads to, so it always sits on the far left — even though its lines
 * to steps are only decorative.
 */
export function autoLayout(nodes: LayoutNode[], edges: LayoutEdge[], startId?: string): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 90, marginx: 0, marginy: 0 });
  g.setDefaultEdgeLabel(() => ({}));

  const ids = new Set(nodes.map((n) => n.id));
  for (const n of nodes) {
    g.setNode(n.id, { width: n.width || DEFAULT_SIZE.width, height: n.height || DEFAULT_SIZE.height });
  }
  const real = edges.filter((e) => ids.has(e.source) && ids.has(e.target) && e.source !== e.target);
  for (const e of real) g.setEdge(e.source, e.target);
  if (startId && ids.has(startId)) {
    const led = new Set(real.filter((e) => e.source !== startId).map((e) => e.target));
    for (const n of nodes) if (n.id !== startId && !led.has(n.id)) g.setEdge(startId, n.id);
  }

  dagre.layout(g);

  // dagre gives centres; svelte-flow positions a node by its top-left corner.
  const out = new Map<string, { x: number; y: number }>();
  for (const n of nodes) {
    const p = g.node(n.id);
    out.set(n.id, { x: Math.round(p.x - p.width / 2), y: Math.round(p.y - p.height / 2) });
  }
  return out;
}
