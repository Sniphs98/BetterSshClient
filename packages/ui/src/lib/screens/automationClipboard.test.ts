import { describe, expect, it } from 'vitest';
import type { AutomationCanvasEdge, StepNode } from './automationCanvasTypes';
import { copyNodes, freeLabel, pasteNodes, readClipboard } from './automationClipboard';

const snippetNode = (id: string, label: string, x = 0): StepNode =>
  ({ id, type: 'snippet', position: { x, y: 0 }, data: { snippetId: 's', label, continueOnError: false, snippetName: 'S', target: 'local', wslDistro: '' } }) as StepNode;
const ifNode = (id: string, label: string, left: string): StepNode =>
  ({ id, type: 'if', position: { x: 0, y: 100 }, data: { label, continueOnError: false, condition: { kind: 'compare', left, op: 'equals', right: 'yes' }, target: 'local', wslDistro: '' } }) as StepNode;

describe('copyNodes', () => {
  it('copies the nodes and only the connections between them', () => {
    const edges: AutomationCanvasEdge[] = [
      { id: 'e1', source: 'a', target: 'b' },
      { id: 'e2', source: 'b', target: 'c' }
    ];
    const clip = copyNodes([snippetNode('a', 'build'), snippetNode('b', 'test')], edges);
    expect(clip.nodes.map((n) => n.id)).toEqual(['a', 'b']);
    expect(clip.edges).toEqual([{ source: 'a', target: 'b' }]);
  });

  it('round-trips through the clipboard as text; anything else is not nodes', () => {
    const clip = copyNodes([snippetNode('a', 'build')], []);
    expect(readClipboard(JSON.stringify(clip))).toEqual(clip);
    expect(readClipboard('echo hello')).toBeNull();
    expect(readClipboard('{"kind":"something-else"}')).toBeNull();
  });
});

describe('pasteNodes', () => {
  let n = 0;
  const id = () => `new-${++n}`;

  it('gives new ids, moves them by the offset, selects them, and keeps free labels', () => {
    n = 0;
    const clip = copyNodes([snippetNode('a', 'build', 10), snippetNode('b', 'test', 300)], [{ id: 'e', source: 'a', target: 'b' }]);
    const { nodes, edges } = pasteNodes(clip, new Set(['deploy']), { x: 40, y: 40 }, id);
    expect(nodes.map((x) => [x.id, x.data.label, x.position.x, x.selected])).toEqual([
      ['new-1', 'build', 50, true],
      ['new-2', 'test', 340, true]
    ]);
    expect(edges).toEqual([{ id: 'new-1->new-2', source: 'new-1', target: 'new-2' }]);
  });

  it('renames a taken label, also where the copied nodes refer to it', () => {
    n = 0;
    const clip = copyNodes([snippetNode('a', 'build'), ifNode('b', 'check', '{{nodes.build.output}}')], [
      { id: 'e', source: 'a', target: 'b' }
    ]);
    const { nodes, renamed } = pasteNodes(clip, new Set(['build', 'build-2']), { x: 0, y: 0 }, id);
    expect(nodes.map((x) => x.data.label)).toEqual(['build-3', 'check']);
    expect((nodes[1].data as { condition: { left: string } }).condition.left).toBe('{{nodes.build-3.output}}');
    expect([...renamed]).toEqual([['build', 'build-3']]);
  });

  it("keeps an if's yes/no on its connections", () => {
    n = 0;
    const clip = copyNodes([ifNode('i', 'check', 'x'), snippetNode('a', 'run')], [
      { id: 'e', source: 'i', target: 'a', sourceHandle: 'yes', label: 'yes' }
    ]);
    const { edges } = pasteNodes(clip, new Set(), { x: 0, y: 0 }, id);
    expect(edges).toEqual([{ id: 'new-1:yes->new-2', source: 'new-1', target: 'new-2', sourceHandle: 'yes', label: 'yes' }]);
  });
});

describe('freeLabel', () => {
  it('appends a number when taken', () => {
    expect(freeLabel('build', new Set())).toBe('build');
    expect(freeLabel('build', new Set(['build']))).toBe('build-2');
  });
});
