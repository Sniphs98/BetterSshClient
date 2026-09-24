import Store from 'electron-store';
import type { BrowserWindow } from 'electron';

/**
 * Restores/persists window geometry only — never visibility, maximized, or
 * fullscreen state. Those would show the hidden window ahead of the
 * did-finish-load reveal (on Windows, `maximize()` alone reaches
 * `ShowWindow(SW_MAXIMIZE)`, which carries no visibility guard of its own).
 * Ported intent of `WINDOW_STATE_FLAGS = SIZE | POSITION` in main.rs.
 */

interface Geometry {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

const DEFAULT_GEOMETRY: Geometry = { width: 1100, height: 720 };

let store: Store<Geometry> | undefined;

function getStore(): Store<Geometry> {
  store ??= new Store<Geometry>({ name: 'window-state', defaults: DEFAULT_GEOMETRY });
  return store;
}

export function loadWindowGeometry(): Geometry {
  const s = getStore();
  return { x: s.get('x'), y: s.get('y'), width: s.get('width'), height: s.get('height') };
}

/** Wires `resize`/`move` listeners that persist geometry — size and position
 *  only, nothing that would touch visibility. */
export function trackWindowGeometry(win: BrowserWindow): void {
  const persist = (): void => {
    if (win.isDestroyed() || win.isMinimized()) return;
    const [width, height] = win.getSize();
    const [x, y] = win.getPosition();
    const s = getStore();
    s.set({ x, y, width, height });
  };
  win.on('resize', persist);
  win.on('move', persist);
}
