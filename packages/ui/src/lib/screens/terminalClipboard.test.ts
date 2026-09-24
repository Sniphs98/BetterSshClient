// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { copySelection, isCopyChord, isPasteChord, pasteFromClipboard, type ClipboardTerminal } from './terminalClipboard';

const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);

function fakeTerm(selection = '', overrides: Partial<ClipboardTerminal> = {}): ClipboardTerminal {
  return {
    getSelection: () => selection,
    hasSelection: () => selection !== '',
    paste: vi.fn(),
    focus: vi.fn(),
    ...overrides
  };
}

describe('isCopyChord / isPasteChord on Windows and Linux', () => {
  it('matches Ctrl+Shift+C and Ctrl+Shift+V, either case', () => {
    expect(isCopyChord(key({ key: 'c', ctrlKey: true, shiftKey: true }), false)).toBe(true);
    expect(isCopyChord(key({ key: 'C', ctrlKey: true, shiftKey: true }), false)).toBe(true);
    expect(isPasteChord(key({ key: 'v', ctrlKey: true, shiftKey: true }), false)).toBe(true);
  });

  it('leaves the shell control keys alone — plain Ctrl+C stays the interrupt', () => {
    expect(isCopyChord(key({ key: 'c', ctrlKey: true }), false)).toBe(false);
    expect(isPasteChord(key({ key: 'v', ctrlKey: true }), false)).toBe(false);
  });

  it('ignores the Cmd chord off macOS', () => {
    expect(isCopyChord(key({ key: 'c', metaKey: true }), false)).toBe(false);
  });

  it('ignores an Alt-composed variant, which is a different binding', () => {
    expect(isCopyChord(key({ key: 'c', ctrlKey: true, shiftKey: true, altKey: true }), false)).toBe(false);
  });
});

describe('isCopyChord / isPasteChord on macOS', () => {
  it('matches Cmd+C and Cmd+V', () => {
    expect(isCopyChord(key({ key: 'c', metaKey: true }), true)).toBe(true);
    expect(isPasteChord(key({ key: 'v', metaKey: true }), true)).toBe(true);
  });

  it('also accepts Ctrl+Shift there — the chord that works on every platform', () => {
    expect(isCopyChord(key({ key: 'c', ctrlKey: true, shiftKey: true }), true)).toBe(true);
  });

  it('still leaves plain Ctrl+C to the shell', () => {
    expect(isCopyChord(key({ key: 'c', ctrlKey: true }), true)).toBe(false);
  });
});

describe('copySelection', () => {
  it('writes the selection and reports that it handled the key', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    await expect(copySelection(fakeTerm('ls -la'))).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('ls -la');
    vi.unstubAllGlobals();
  });

  it('reports false with nothing selected, so the keystroke can reach the shell', async () => {
    const writeText = vi.fn();
    vi.stubGlobal('navigator', { clipboard: { writeText } });

    await expect(copySelection(fakeTerm(''))).resolves.toBe(false);
    expect(writeText).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe('pasteFromClipboard', () => {
  it("hands the clipboard text to xterm's own paste, not raw stdin", async () => {
    vi.stubGlobal('navigator', { clipboard: { readText: vi.fn().mockResolvedValue('echo hi') } });
    const term = fakeTerm();

    await pasteFromClipboard(term);

    expect(term.paste).toHaveBeenCalledWith('echo hi');
    vi.unstubAllGlobals();
  });

  it('does nothing on an empty clipboard', async () => {
    vi.stubGlobal('navigator', { clipboard: { readText: vi.fn().mockResolvedValue('') } });
    const term = fakeTerm();

    await pasteFromClipboard(term);

    expect(term.paste).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
