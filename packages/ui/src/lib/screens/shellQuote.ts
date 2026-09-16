// Single-quotes a path for a POSIX shell — shared by every place that types a `cd`
// into a terminal's stdin on the app's behalf (TerminalView.svelte's default-path
// autocd, SftpTerminalDrawer.svelte's cd into the remote pane's current directory).

/** Wraps `path` in single quotes, escaping any embedded `'` — the one character that
 *  can't just sit inside them (`'` -> `'\''`, closing the quote, an escaped literal
 *  quote, then reopening it). */
export function shellQuote(path: string): string {
  return `'${path.replaceAll("'", `'\\''`)}'`;
}
