import { describe, expect, it, vi } from 'vitest';

vi.mock('electron-store', () => ({ default: class {} }));

import { clampToDisplays } from './windowState.js';

const primary = { x: 0, y: 0, width: 1920, height: 1040 };
const secondary = { x: 1920, y: 0, width: 2560, height: 1400 };

describe('clampToDisplays', () => {
  it('keeps a position that is on a display', () => {
    const state = { x: 2000, y: 100, width: 1100, height: 720, maximized: true };
    expect(clampToDisplays(state, [primary, secondary])).toEqual(state);
  });

  it('drops the position of a window whose monitor is gone, keeping its size', () => {
    const state = { x: 2000, y: 100, width: 1100, height: 720, maximized: false };
    expect(clampToDisplays(state, [primary])).toEqual({
      x: undefined,
      y: undefined,
      width: 1100,
      height: 720,
      maximized: false
    });
  });

  it('drops a position with only a sliver left on screen', () => {
    const state = { x: 1880, y: 100, width: 1100, height: 720, maximized: false };
    expect(clampToDisplays(state, [primary]).x).toBeUndefined();
  });

  it('leaves a state without a saved position alone', () => {
    const state = { width: 1100, height: 720, maximized: false };
    expect(clampToDisplays(state, [primary])).toEqual(state);
  });
});
