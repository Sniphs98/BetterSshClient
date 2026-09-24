// Substitution for running a Snippet straight from the SFTP file browser, where the
// only value on offer is the clicked file. Deliberately separate from the backend
// engine's `substituteTemplate` (`{{nodes.<label>.output}}` / `{{params.<name>}}`),
// which only makes sense inside an automation run — here there is no graph and no
// parameter prompt, just one path.

import { shellQuote } from './shellQuote';

/** The handle a snippet uses to say "put the clicked file's path here". */
export const FILE_PLACEHOLDER = '{{file}}';

/** Replaces every `{{file}}` with `path`, shell-quoted so a space or a quote in the
 *  name can't break (or reshape) the command. A snippet that never mentions the
 *  placeholder comes back unchanged, which is what makes "run this snippet here"
 *  work on snippets that don't care about the file at all. */
export function fillFilePlaceholder(command: string, path: string): string {
  return command.split(FILE_PLACEHOLDER).join(shellQuote(path));
}

/** Whether this snippet actually wants a file — drives the wording of the menu entry,
 *  so the user can tell which snippets will use what they right-clicked. */
export function usesFilePlaceholder(command: string): boolean {
  return command.includes(FILE_PLACEHOLDER);
}
