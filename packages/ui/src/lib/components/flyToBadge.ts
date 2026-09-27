import type { TransitionConfig } from 'svelte/transition';
import { genieFrame, genieSlicing, type Rect } from './genie';

/** The element the update banner flies into: the sidebar's version badge (or, with the
 *  sidebar collapsed, the update button standing in for it). */
export const UPDATE_BADGE_ID = 'update-badge';

// Enough that the funnel's edge reads as a curve rather than steps.
const STRIPS = 40;

function rectOf(el: Element): Rect {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

/**
 * Outro for the update banner: the macOS genie into the version badge (genie.ts) — it
 * narrows into a funnel towards the badge and is drawn in through it. While it runs the
 * banner is hidden and drawn as strips in a layer above everything; the layer goes when
 * it's done. Falls back to a plain fade when the badge isn't on screen or motion is
 * reduced.
 */
export function flyToBadge(node: HTMLElement, { duration = 650 }: { duration?: number } = {}): TransitionConfig {
  const target = document.getElementById(UPDATE_BADGE_ID);
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const card = (node.firstElementChild as HTMLElement | null) ?? node;
  const fade: TransitionConfig = { duration: 150, css: (t) => `opacity: ${t}` };
  if (!target || reduced) return fade;

  const source = rectOf(card);
  const dest = rectOf(target);
  if (source.width === 0 || source.height === 0) return fade;
  const { columns, reversed } = genieSlicing(source, dest);

  // The strips: each a copy of the banner, clipped to its slice.
  const layer = document.createElement('div');
  layer.setAttribute('aria-hidden', 'true');
  layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:60;';
  const strips: HTMLElement[] = [];
  for (let i = 0; i < STRIPS; i += 1) {
    const strip = document.createElement('div');
    strip.style.cssText =
      `position:fixed;left:${source.left}px;top:${source.top}px;width:${source.width}px;height:${source.height}px;` +
      'transform-origin:0 0;will-change:transform;';
    const copy = card.cloneNode(true) as HTMLElement;
    copy.style.cssText = `width:${source.width}px;max-width:none;margin:0;`;
    copy.removeAttribute('role');
    strip.appendChild(copy);
    layer.appendChild(strip);
    strips.push(strip);
  }

  let removed = false;
  const cleanup = (): void => {
    if (removed) return;
    removed = true;
    layer.remove();
  };
  document.body.appendChild(layer);
  node.style.visibility = 'hidden';
  // However the transition ends (finished, or cut short), the layer goes.
  setTimeout(cleanup, duration + 200);

  // Local slice [a, b) of the banner (in px along the sliced axis) for f-range [from, to).
  const size = columns ? source.width : source.height;
  const slice = (from: number, to: number): [number, number] =>
    reversed ? [(1 - to) * size, (1 - from) * size] : [from * size, to * size];

  const draw = (p: number): void => {
    const frames = genieFrame(source, dest, p, STRIPS);
    const opacity = p > 0.85 ? Math.max(0, (1 - p) / 0.15) : 1;
    frames.forEach((frame, i) => {
      const [a, b] = slice(frame.from, frame.to);
      const strip = strips[i];
      // A hair of overlap so no seam shows between neighbours.
      const clipA = Math.max(0, a - 0.5);
      const clipB = Math.min(size, b + 0.5);
      strip.style.clipPath = columns
        ? `inset(0 ${source.width - clipB}px 0 ${clipA}px)`
        : `inset(${clipA}px 0 ${source.height - clipB}px 0)`;
      const sx = columns ? frame.dest.width / (b - a) : frame.dest.width / source.width;
      const sy = columns ? frame.dest.height / source.height : frame.dest.height / (b - a);
      const tx = frame.dest.left - source.left - (columns ? sx * a : 0);
      const ty = frame.dest.top - source.top - (columns ? 0 : sy * a);
      strip.style.transform = `translate(${tx}px, ${ty}px) scale(${sx}, ${sy})`;
      strip.style.opacity = String(opacity);
    });
  };
  draw(0);

  return {
    duration,
    // `u` runs 0 → 1 as it leaves: 0 is the banner as it was, 1 is inside the badge.
    tick: (_t, u) => {
      if (u >= 1) cleanup();
      else draw(u);
    }
  };
}
