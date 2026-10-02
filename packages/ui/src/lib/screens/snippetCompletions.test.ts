import { describe, expect, it } from 'vitest';
import { PLACEHOLDERS, placeholderPrefix, placeholderRanges, plainInsert } from './snippetCompletions';

describe('placeholderRanges', () => {
  it('finds every placeholder, per line, in Monaco columns', () => {
    const text = 'scp {{file}} host:/tmp\ndocker build -t {{params.tag}} {{nodes.checkout.output}}';
    expect(placeholderRanges(text)).toEqual([
      { line: 1, start: 5, end: 13 },
      { line: 2, start: 17, end: 31 },
      { line: 2, start: 32, end: 57 }
    ]);
  });

  it('ignores unclosed braces and plain shell braces', () => {
    expect(placeholderRanges('echo {{file} ${HOME} {a,b}')).toEqual([]);
  });
});

describe('placeholderPrefix', () => {
  it('is the length of an open placeholder before the cursor', () => {
    expect(placeholderPrefix('docker run {{')).toBe(2);
    expect(placeholderPrefix('echo {{par')).toBe(5);
    expect(placeholderPrefix('echo {{nodes.build.')).toBe(14);
  });

  it('is null when no placeholder is being typed', () => {
    expect(placeholderPrefix('echo {')).toBeNull();
    expect(placeholderPrefix('echo {{file}} ')).toBeNull();
  });
});

describe('plainInsert', () => {
  it('drops the tab stops for a click-to-insert', () => {
    expect(PLACEHOLDERS.map(plainInsert)).toEqual(['{{file}}', '{{params.name}}', '{{nodes.label.output}}']);
  });
});
