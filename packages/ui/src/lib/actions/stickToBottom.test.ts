import { describe, expect, it } from 'vitest';
import { isAtBottom } from './stickToBottom';

describe('isAtBottom', () => {
  it('counts the last few pixels as the bottom', () => {
    expect(isAtBottom(600, 400, 1000)).toBe(true);
    expect(isAtBottom(580, 400, 1000)).toBe(true);
    expect(isAtBottom(500, 400, 1000)).toBe(false);
  });

  it('a box that does not scroll is always at the bottom', () => {
    expect(isAtBottom(0, 400, 300)).toBe(true);
  });
});
