import { describe, expect, it } from 'vitest';
import { genieFrame, genieSlicing } from './genie';

// The update banner (bottom centre) and the version badge (bottom left of the sidebar).
const banner = { left: 450, top: 780, width: 576, height: 60 };
const badge = { left: 128, top: 827, width: 70, height: 20 };

const span = (frames: ReturnType<typeof genieFrame>) => ({
  left: Math.min(...frames.map((f) => f.dest.left)),
  right: Math.max(...frames.map((f) => f.dest.left + f.dest.width)),
  top: Math.min(...frames.map((f) => f.dest.top)),
  bottom: Math.max(...frames.map((f) => f.dest.top + f.dest.height))
});

describe('genieFrame', () => {
  it('slices the banner into columns when the badge is off to the side, nearest edge towards it', () => {
    expect(genieSlicing(banner, badge)).toEqual({ columns: true, reversed: true });
  });

  it('starts as the banner itself, whole and in place', () => {
    const s = span(genieFrame(banner, badge, 0, 20));
    expect(s.left).toBeCloseTo(450, 0);
    expect(s.right).toBeCloseTo(1026, 0);
    // Already the first hint of the funnel is off by less than a pixel.
    expect(s.bottom - s.top).toBeCloseTo(60, 0);
  });

  it('funnels first: the edge nearest the badge narrows most, the far edge stays tall', () => {
    const frames = genieFrame(banner, badge, 0.4, 20);
    const near = frames[frames.length - 1].dest;
    const far = frames[0].dest;
    expect(near.height).toBeLessThan(far.height);
    expect(far.height).toBeGreaterThan(40);
  });

  it('ends inside the badge', () => {
    const s = span(genieFrame(banner, badge, 1, 20));
    expect(s.left).toBeCloseTo(128, 0);
    expect(s.right).toBeCloseTo(198, 0);
    expect(s.top).toBeCloseTo(827, 0);
    expect(s.bottom).toBeCloseTo(847, 0);
  });

  it('keeps the strips in one piece — each edge where its neighbour ends', () => {
    for (const p of [0.2, 0.5, 0.8]) {
      const frames = genieFrame(banner, badge, p, 20);
      // Travelling left, strip i (from the far, right edge) sits right of strip i+1.
      for (let i = 0; i < frames.length - 1; i += 1) {
        expect(frames[i + 1].dest.left + frames[i + 1].dest.width).toBeCloseTo(frames[i].dest.left, 3);
      }
    }
  });
});
