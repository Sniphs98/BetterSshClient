// What the snippet editor offers for placeholders: the list on its side panel, the
// suggestions after typing `{{`, and where the placeholders in a command are (to
// highlight them). Kept free of Monaco so it's unit-testable; SnippetEditor.svelte
// hands these to the editor.

export interface PlaceholderHelp {
  /** As shown in the list. */
  label: string;
  /** Monaco snippet syntax: `${1:name}` is a tab stop, selected for typing over. */
  insert: string;
  detail: string;
}

export const PLACEHOLDERS: PlaceholderHelp[] = [
  {
    label: '{{file}}',
    insert: '{{file}}',
    detail: 'The file right-clicked in the SFTP browser (quoted for you).'
  },
  {
    label: '{{params.name}}',
    insert: '{{params.${1:name}}}',
    detail: "An automation parameter's value, asked for when the automation runs."
  },
  {
    label: '{{nodes.label.output}}',
    insert: '{{nodes.${1:label}.output}}',
    detail: "The output of an earlier node in the automation, with an edge from it to this one."
  }
];

/** The text a placeholder becomes when inserted by a click (no tab stops). */
export function plainInsert(p: PlaceholderHelp): string {
  return p.insert.replace(/\$\{\d+:([^}]*)\}/g, '$1');
}

/** Where `{{…}}` placeholders are in `text`: 1-based line and column, end exclusive, as
 *  Monaco ranges count. */
export function placeholderRanges(text: string): Array<{ line: number; start: number; end: number }> {
  const out: Array<{ line: number; start: number; end: number }> = [];
  text.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/\{\{[^{}\n]*\}\}/g)) {
      out.push({ line: i + 1, start: m.index + 1, end: m.index + 1 + m[0].length });
    }
  });
  return out;
}

/** Whether the text just before the cursor opens a placeholder (`{{`, maybe with a few
 *  letters typed), and how many characters of it to replace with a suggestion. */
export function placeholderPrefix(beforeCursor: string): number | null {
  const m = /\{\{[\w.]*$/.exec(beforeCursor);
  return m ? m[0].length : null;
}
