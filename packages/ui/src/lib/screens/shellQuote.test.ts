import { describe, expect, it } from 'vitest';
import { shellQuote } from './shellQuote';

describe('shellQuote', () => {
  it('wraps a plain path in single quotes', () => {
    expect(shellQuote('/var/www')).toBe("'/var/www'");
  });

  it('escapes an embedded single quote', () => {
    expect(shellQuote("/home/o'brien")).toBe(`'/home/o'\\''brien'`);
  });

  it('handles a path with spaces — the whole point of quoting at all', () => {
    expect(shellQuote('/path with spaces/dir')).toBe("'/path with spaces/dir'");
  });

  it('handles an empty path', () => {
    expect(shellQuote('')).toBe("''");
  });
});
