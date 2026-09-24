// GPU rendering for the terminals. xterm.js draws with DOM elements by default, which
// is what limits how fast a burst of output (a build log, `cat` of a big file) can be
// painted; the WebGL addon draws the same cells on a canvas at a fraction of the cost.
// It is a setting (`terminalGpu`) because a broken GPU driver is the one thing that can
// make it worse than the default, and flipping it applies to open terminals right away.
// Whenever WebGL isn't there — no WebGL2, or the browser reclaims the context (it keeps
// only so many alive at once) — the terminal quietly stays on, or returns to, the DOM
// renderer.

import type { ITerminalAddon } from '@xterm/xterm';
import type { Readable } from 'svelte/store';

/** The slice of the WebGL addon this module relies on. */
export interface GpuAddon extends ITerminalAddon {
  onContextLoss(listener: () => void): unknown;
}

/** The slice of an xterm `Terminal` this module relies on. */
export interface AddonHost {
  loadAddon(addon: ITerminalAddon): void;
}

async function loadWebglAddon(): Promise<GpuAddon | undefined> {
  try {
    const { WebglAddon } = await import('@xterm/addon-webgl');
    return new WebglAddon();
  } catch {
    return undefined;
  }
}

/**
 * Keeps `term`'s renderer in line with `pref`: the WebGL addon while it is on, the
 * DOM renderer while it is off. Call after `term.open()`; returns a disposer.
 */
export function followGpuPref(
  term: AddonHost,
  pref: Readable<boolean>,
  load: () => Promise<GpuAddon | undefined> = loadWebglAddon
): () => void {
  let addon: GpuAddon | undefined;
  let stopped = false;
  // Bumped on every pref change, so a load that resolves after the pref moved on is dropped.
  let generation = 0;

  const drop = (): void => {
    addon?.dispose();
    addon = undefined;
  };

  const unsubscribe = pref.subscribe((on) => {
    const gen = ++generation;
    if (!on) {
      drop();
      return;
    }
    if (addon !== undefined) return;
    void load().then((next) => {
      if (next === undefined) return;
      if (stopped || gen !== generation || addon !== undefined) {
        next.dispose();
        return;
      }
      try {
        term.loadAddon(next); // throws without WebGL2
      } catch {
        next.dispose();
        return;
      }
      next.onContextLoss(() => {
        if (addon === next) drop();
      });
      addon = next;
    });
  });

  return () => {
    stopped = true;
    unsubscribe();
    drop();
  };
}
