// Copy/paste for the xterm terminals (TerminalView, SftpTerminalDrawer).
//
// A terminal can't use the platform's plain Copy/Paste chord: Ctrl+C is the interrupt
// the shell needs, and Ctrl+V is readline's quoted-insert. So Windows/Linux use the
// terminal convention of adding Shift, while macOS keeps Cmd (which never collides,
// since the control keys there are Ctrl). The app's own menu is built to leave these
// keys alone — see `applicationMenu` in the electron package.
//
// Copy can't go through the browser/Electron "copy" role either: xterm draws its
// selection itself rather than selecting DOM text, so `document`'s selection is empty
// and the role would copy nothing. `term.getSelection()` is the real source.

/**
 * Ctrl+Shift everywhere, plus Cmd on macOS.
 *
 * Ctrl+Shift is the chord every terminal emulator uses, and it's the only one that
 * reaches us on Windows/Linux — the app's menu there deliberately claims nothing, so
 * the shell keeps Ctrl+C/Z/A. macOS is the awkward one: Chromium needs an Edit menu
 * with the copy/paste roles for ordinary text inputs to work at all, and those roles
 * swallow Cmd+C before the page sees it. So Cmd is accepted here for the case where it
 * does arrive, and Ctrl+Shift stays available as the chord that always works.
 */
function isClipboardChord(event: KeyboardEvent, isMac: boolean): boolean {
  if (event.altKey) return false;
  if (event.ctrlKey && event.shiftKey) return true;
  return isMac && event.metaKey && !event.ctrlKey;
}

export function isCopyChord(event: KeyboardEvent, isMac: boolean): boolean {
  return (event.key === 'c' || event.key === 'C') && isClipboardChord(event, isMac);
}

export function isPasteChord(event: KeyboardEvent, isMac: boolean): boolean {
  return (event.key === 'v' || event.key === 'V') && isClipboardChord(event, isMac);
}

/** True on a Mac, where the chord is Cmd rather than Ctrl+Shift. Reads the UA rather
 *  than taking a prop so both terminals agree without threading it through. */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /mac/i.test(navigator.platform ?? '') || /mac os x/i.test(navigator.userAgent ?? '');
}

export interface ClipboardTerminal {
  getSelection: () => string;
  hasSelection: () => boolean;
  paste: (text: string) => void;
  focus: () => void;
}

/** Writes the terminal's selection to the clipboard. Resolves `false` when there was
 *  nothing selected, so a copy chord with no selection can fall through to the shell
 *  instead of silently swallowing the keystroke. */
export async function copySelection(term: ClipboardTerminal): Promise<boolean> {
  const selection = term.getSelection();
  if (!selection) return false;
  await navigator.clipboard.writeText(selection);
  return true;
}

/** Reads the clipboard into the terminal. `term.paste` handles bracketed-paste mode
 *  and the chunking that a large paste needs, so this never writes raw bytes itself. */
export async function pasteFromClipboard(term: ClipboardTerminal): Promise<void> {
  const text = await navigator.clipboard.readText();
  if (text) term.paste(text);
}
