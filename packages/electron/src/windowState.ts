import Store from 'electron-store';
import type { BrowserWindow, Rectangle } from 'electron';

/**
 * Restores/persists the window's normal (un-maximized) geometry plus whether
 * it was maximized. Geometry is applied at construction; the maximized flag is
 * applied only at reveal time via `revealWindow` — never earlier, because on
 * Windows `maximize()` reaches `ShowWindow(SW_MAXIMIZE)`, which carries no
 * visibility guard of its own and would show the hidden window ahead of the
 * did-finish-load reveal.
 */

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

const DEFAULT_STATE: WindowState = { width: 1100, height: 720, maximized: false };

let store: Store<WindowState> | undefined;

function getStore(): Store<WindowState> {
  store ??= new Store<WindowState>({ name: 'window-state', defaults: DEFAULT_STATE });
  return store;
}

/** How much of the saved window must still overlap a display for its position to be kept. */
const MIN_VISIBLE_PX = 100;

/**
 * Drops a saved position that no display shows anymore (a monitor that was
 * unplugged, a resolution change), so the window can't open off-screen. The
 * size is kept; without x/y Electron centers the window.
 */
export function clampToDisplays(state: WindowState, workAreas: Rectangle[]): WindowState {
  const { x, y, width, height } = state;
  if (x === undefined || y === undefined) return state;
  const visible = workAreas.some((area) => {
    const overlapX = Math.min(x + width, area.x + area.width) - Math.max(x, area.x);
    const overlapY = Math.min(y + height, area.y + area.height) - Math.max(y, area.y);
    return overlapX >= MIN_VISIBLE_PX && overlapY >= MIN_VISIBLE_PX;
  });
  return visible ? state : { ...state, x: undefined, y: undefined };
}

export function loadWindowState(workAreas: Rectangle[]): WindowState {
  const s = getStore();
  return clampToDisplays(
    {
      x: s.get('x'),
      y: s.get('y'),
      width: s.get('width'),
      height: s.get('height'),
      maximized: s.get('maximized')
    },
    workAreas
  );
}

/** Wires listeners that persist the normal bounds and the maximized flag —
 *  nothing that would touch visibility. */
export function trackWindowState(win: BrowserWindow): void {
  const persist = (): void => {
    if (win.isDestroyed() || win.isMinimized() || win.isFullScreen()) return;
    // The normal bounds, not the maximized ones — so un-maximizing after the
    // next launch returns to the size the user actually picked.
    const { x, y, width, height } = win.getNormalBounds();
    getStore().set({ x, y, width, height, maximized: win.isMaximized() });
  };
  win.on('resize', persist);
  win.on('move', persist);
  win.on('maximize', persist);
  win.on('unmaximize', persist);
}

/** Shows the hidden window, maximized if it was maximized when last closed. */
export function revealWindow(win: BrowserWindow, maximized: boolean): void {
  if (maximized) win.maximize();
  win.show();
}
