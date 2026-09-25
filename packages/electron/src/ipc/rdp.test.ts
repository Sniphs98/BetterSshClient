import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ clipboard: {}, shell: {} }));

const { CLIPBOARD_CLEAR_MS, launchNotice, offerPasswordOnClipboard } = await import('./rdp.js');

function fakeClipboard(): { writeText: (t: string) => void; readText: () => string; clear: () => void; text: string } {
  const board = {
    text: '',
    writeText: (t: string) => void (board.text = t),
    readText: () => board.text,
    clear: () => void (board.text = '')
  };
  return board;
}

describe('offerPasswordOnClipboard', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('puts the password on the clipboard and takes it off again', () => {
    vi.useFakeTimers();
    const board = fakeClipboard();
    offerPasswordOnClipboard('secret', board);
    expect(board.text).toBe('secret');
    vi.advanceTimersByTime(CLIPBOARD_CLEAR_MS);
    expect(board.text).toBe('');
  });

  it('leaves the clipboard alone if something else was copied since', () => {
    vi.useFakeTimers();
    const board = fakeClipboard();
    offerPasswordOnClipboard('secret', board);
    board.writeText('something the user copied');
    vi.advanceTimersByTime(CLIPBOARD_CLEAR_MS);
    expect(board.text).toBe('something the user copied');
  });
});

describe('launchNotice', () => {
  it('says when Windows uses its own saved password', () => {
    expect(launchNotice({ opened: 'mstsc', credential: 'kept-existing' })).toContain('already has a saved password');
  });

  it('says where the password went when it had to go on the clipboard', () => {
    expect(launchNotice({ opened: 'file' }, {}, true)).toContain('on the clipboard for 45 seconds');
  });

  it("says what to tick in Windows' prompt for .rdp files, which shares nothing by default", () => {
    expect(launchNotice({ opened: 'mstsc', redirectionPrompt: true }, { drives: true, clipboard: true })).toContain(
      'tick Drives and Clipboard in its security prompt'
    );
    expect(launchNotice({ opened: 'mstsc', redirectionPrompt: true }, { drives: true, clipboard: false })).toContain(
      'tick Drives in its security prompt'
    );
    // Without drives there's nothing to tick: the clipboard off or sound elsewhere need no consent.
    expect(launchNotice({ opened: 'mstsc', redirectionPrompt: true }, { clipboard: false })).toBeUndefined();
  });

  it('has nothing to say about an ordinary launch', () => {
    expect(launchNotice({ opened: 'mstsc', credential: 'staged' })).toBeUndefined();
    expect(launchNotice({ opened: 'xfreerdp' })).toBeUndefined();
  });
});
