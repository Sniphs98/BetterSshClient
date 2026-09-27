import { cubicInOut } from 'svelte/easing';
import type { TransitionConfig } from 'svelte/transition';

/** The element the update banner flies into: the sidebar's version badge (or, with the
 *  sidebar collapsed, the update button standing in for it). */
export const UPDATE_BADGE_ID = 'update-badge';

/**
 * Outro for the update banner: it shrinks and slides into the version badge, fading as
 * it lands — so it's clear where the update went rather than it just vanishing. Falls
 * back to a plain fade when the badge isn't on screen or motion is reduced.
 */
export function flyToBadge(node: HTMLElement, { duration = 500 }: { duration?: number } = {}): TransitionConfig {
  const target = document.getElementById(UPDATE_BADGE_ID);
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const card = (node.firstElementChild as HTMLElement | null) ?? node;
  if (!target || reduced) return { duration: 150, css: (t) => `opacity: ${t}` };

  const from = card.getBoundingClientRect();
  const to = target.getBoundingClientRect();
  if (from.width === 0 || from.height === 0) return { duration: 150, css: (t) => `opacity: ${t}` };
  const dx = to.left + to.width / 2 - (from.left + from.width / 2);
  const dy = to.top + to.height / 2 - (from.top + from.height / 2);
  const sx = to.width / from.width;
  const sy = to.height / from.height;
  // The transform applies to `node` (the full-width wrapper), so it scales about the
  // card's centre expressed in the wrapper's own coordinates.
  const box = node.getBoundingClientRect();
  const originX = from.left - box.left + from.width / 2;
  const originY = from.top - box.top + from.height / 2;

  return {
    duration,
    easing: cubicInOut,
    // `u` runs 0 → 1 as it leaves: 0 is where the banner is, 1 is on the badge.
    css: (t, u) =>
      `transform: translate(${dx * u}px, ${dy * u}px) scale(${1 + (sx - 1) * u}, ${1 + (sy - 1) * u});` +
      `transform-origin: ${originX}px ${originY}px;` +
      // Solid most of the way, fading only in the last quarter — so it's seen landing.
      `opacity: ${Math.min(1, t * 4)};`
  };
}
