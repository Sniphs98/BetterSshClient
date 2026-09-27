/**
 * The macOS "genie" minimise, for the update banner flying into the version badge: the
 * banner narrows into a funnel towards the badge, then is drawn in through it — the
 * side nearest the badge first.
 *
 * A CSS transform can only scale or skew a box evenly, and the genie bends it. So for
 * the length of the animation the banner is drawn as strips — copies of it, each clipped
 * to one slice across the direction of travel — and every strip gets its own transform
 * each frame. Strips share their edges' positions, so the shape stays one piece.
 */

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Where one strip goes: its slice of the source (along the travel axis, 0..1 from the
 *  far edge to the edge nearest the target) drawn at `dest` on screen. */
export interface StripFrame {
  from: number;
  to: number;
  dest: Rect;
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/**
 * The strips at progress `p` (0 = the banner as it is, 1 = inside the target). Pure, so
 * the shape can be tested without a DOM. The travel axis is the one the target is
 * mostly away along; the funnel narrows across it.
 */
export function genieFrame(source: Rect, target: Rect, p: number, strips: number): StripFrame[] {
  const dx = target.left + target.width / 2 - (source.left + source.width / 2);
  const dy = target.top + target.height / 2 - (source.top + source.height / 2);
  const alongX = Math.abs(dx) >= Math.abs(dy);
  // Axis helpers: "main" is the direction of travel, "cross" the one the funnel narrows.
  const main = (r: Rect) => (alongX ? { start: r.left, size: r.width } : { start: r.top, size: r.height });
  const cross = (r: Rect) => (alongX ? { start: r.top, size: r.height } : { start: r.left, size: r.width });
  const towardsStart = alongX ? dx < 0 : dy < 0;

  const sm = main(source);
  const tm = main(target);
  const sc = cross(source);
  const tc = cross(target);

  // How far along an edge at `f` (0 = far edge, 1 = nearest the target) is:
  // pinch — narrowing towards the target's width across — comes first and most at the
  // near edge; the draw-in follows, near edge first.
  const pinch = (f: number) => clamp01(ease(clamp01(p / 0.5)) * (0.25 + 0.75 * f));
  // A small lead for the near edge only: more stretches the banner along its way.
  const drawIn = (f: number) => ease(clamp01(((p - 0.3) / 0.7) * 1.2 - (1 - f) * 0.2));

  // An edge at `f`: where it sits along the travel axis, and the cross span there.
  const edge = (f: number) => {
    const b = drawIn(f);
    const k = Math.max(pinch(f), b);
    // Position along travel: from its place in the banner to its place in the target,
    // keeping the order (far edge stays farthest).
    const fromPos = towardsStart ? sm.start + (1 - f) * sm.size : sm.start + f * sm.size;
    const toPos = towardsStart ? tm.start + (1 - f) * tm.size : tm.start + f * tm.size;
    const pos = lerp(fromPos, toPos, b);
    const start = lerp(sc.start, tc.start, k);
    const size = lerp(sc.size, tc.size, k);
    return { pos, start, size };
  };

  const frames: StripFrame[] = [];
  for (let i = 0; i < strips; i += 1) {
    const f0 = i / strips;
    const f1 = (i + 1) / strips;
    const a = edge(f0);
    const b = edge(f1);
    const lo = Math.min(a.pos, b.pos);
    const len = Math.max(0.01, Math.abs(b.pos - a.pos));
    // The strip spans the wider of its two edges across, centred between them.
    const start = Math.min(a.start, b.start);
    const size = Math.max(a.start + a.size, b.start + b.size) - start;
    frames.push({
      from: f0,
      to: f1,
      dest: alongX ? { left: lo, top: start, width: len, height: size } : { left: start, top: lo, width: size, height: len }
    });
  }
  return frames;
}

/** Which way the source is sliced for `genieFrame`: across x (columns) or y (rows),
 *  and whether f = 0 is its right/bottom side. */
export function genieSlicing(source: Rect, target: Rect): { columns: boolean; reversed: boolean } {
  const dx = target.left + target.width / 2 - (source.left + source.width / 2);
  const dy = target.top + target.height / 2 - (source.top + source.height / 2);
  const columns = Math.abs(dx) >= Math.abs(dy);
  return { columns, reversed: columns ? dx < 0 : dy < 0 };
}
