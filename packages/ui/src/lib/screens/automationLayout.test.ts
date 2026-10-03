import { describe, expect, it } from 'vitest';
import { autoLayout } from './automationLayout';

const box = (id: string, width = 200, height = 100) => ({ id, width, height });

describe('autoLayout', () => {
  it('lays a chain out left to right, Start first', () => {
    const pos = autoLayout([box('start'), box('a'), box('b')], [{ source: 'a', target: 'b' }], 'start');
    expect(pos.get('start')!.x).toBeLessThan(pos.get('a')!.x);
    expect(pos.get('a')!.x).toBeLessThan(pos.get('b')!.x);
  });

  it('puts parallel branches one above the other, the join after both', () => {
    const pos = autoLayout(
      [box('start'), box('left'), box('right'), box('join')],
      [
        { source: 'start', target: 'left' },
        { source: 'start', target: 'right' },
        { source: 'left', target: 'join' },
        { source: 'right', target: 'join' }
      ],
      'start'
    );
    expect(pos.get('left')!.x).toBe(pos.get('right')!.x);
    expect(pos.get('left')!.y).not.toBe(pos.get('right')!.y);
    expect(pos.get('join')!.x).toBeGreaterThan(pos.get('left')!.x);
  });

  it('never lets two nodes overlap, whatever their sizes', () => {
    const nodes = [box('start', 300, 260), box('a', 240, 400), box('b', 240, 120), box('c', 240, 180)];
    const pos = autoLayout(nodes, [], 'start');
    for (const n of nodes) {
      for (const m of nodes) {
        if (n.id >= m.id) continue;
        const p = pos.get(n.id)!;
        const q = pos.get(m.id)!;
        const apart = p.x + n.width <= q.x || q.x + m.width <= p.x || p.y + n.height <= q.y || q.y + m.height <= p.y;
        expect(apart, `${n.id} and ${m.id} overlap`).toBe(true);
      }
    }
  });

  it('ignores edges to nodes that are not there', () => {
    const pos = autoLayout([box('a')], [{ source: 'a', target: 'ghost' }]);
    expect([...pos.keys()]).toEqual(['a']);
  });
});
