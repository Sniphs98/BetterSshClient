// Turning clipboard text into a path to browse to, for the SFTP panes' "Paste path".
// People paste from all over: a terminal (trailing newline), Windows Explorer's
// "Copy as path" (wrapped in double quotes), a shell (single quotes), an editor
// (surrounding spaces).

/** The path in `text`: its first non-blank line, trimmed, with one pair of matching
 *  surrounding quotes removed. `undefined` when there is nothing path-like to use. */
export function pastedPath(text: string): string | undefined {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== '');
  if (line === undefined) return undefined;
  const unquoted = /^(["'])(.*)\1$/.exec(line)?.[2].trim() ?? line;
  return unquoted === '' ? undefined : unquoted;
}
