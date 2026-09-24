import { describe, expect, it } from 'vitest';
import { listWindow } from './listWindow';

describe('listWindow', () => {
  it('renders the rows in view plus the overscan below, at the top', () => {
    // 10 rows fit (+1 for a partly visible one), 5 of overscan.
    expect(listWindow(1000, 20, 0, 200, 5)).toEqual({ start: 0, end: 16 });
  });

  it('follows the scroll position, with overscan on both sides', () => {
    expect(listWindow(1000, 20, 2000, 200, 5)).toEqual({ start: 95, end: 116 });
  });

  it('clamps at the end of the list', () => {
    expect(listWindow(100, 20, 1900, 200, 5)).toEqual({ start: 90, end: 100 });
  });

  it('survives a scroll position past the end (a list that just shrank)', () => {
    expect(listWindow(10, 20, 5000, 200, 5)).toEqual({ start: 4, end: 10 });
  });

  it('renders nothing for an empty list or before the row size is known', () => {
    expect(listWindow(0, 20, 0, 200)).toEqual({ start: 0, end: 0 });
    expect(listWindow(50, 0, 0, 200)).toEqual({ start: 0, end: 0 });
  });

  it('treats a not-yet-measured viewport as showing just one row', () => {
    expect(listWindow(1000, 20, 0, 0, 0)).toEqual({ start: 0, end: 1 });
  });
});
