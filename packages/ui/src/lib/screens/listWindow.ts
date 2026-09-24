// Windowing for long, fixed-height lists (the SFTP panes): only the rows in view, plus
// a margin either side, exist in the DOM. A directory like /usr/lib or node_modules
// otherwise mounts thousands of rows — each with an icon, two buttons and their
// handlers — and every selection change re-renders them all.

/** Lists up to this long render every row; above it they are windowed. Small lists
 *  keep full keyboard/tab order and cost nothing to render whole. */
export const WINDOW_ABOVE = 200;

/** Rows rendered beyond each edge of the viewport, so a fast scroll doesn't flash
 *  empty space before the next frame fills it. */
export const OVERSCAN = 10;

export interface ListWindow {
  /** First rendered index. */
  start: number;
  /** One past the last rendered index. */
  end: number;
}

/**
 * The slice of a `count`-row list to render, for rows `stride` px apart (row height
 * plus gap) whose first row starts `scrollTop` px above a `viewport`-px-tall view.
 */
export function listWindow(
  count: number,
  stride: number,
  scrollTop: number,
  viewport: number,
  overscan: number = OVERSCAN
): ListWindow {
  if (count === 0 || stride <= 0) return { start: 0, end: 0 };
  const first = Math.floor(Math.max(0, scrollTop) / stride);
  const visible = Math.ceil(Math.max(0, viewport) / stride) + 1;
  const start = Math.max(0, Math.min(first, count - 1) - overscan);
  const end = Math.min(count, first + visible + overscan);
  return { start, end };
}
