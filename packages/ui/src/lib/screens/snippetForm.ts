// Pure Snippet form + validation logic, kept free of Svelte components so it's
// unit-testable; `SnippetEditor.svelte` renders it. Mirrors `hostForm.ts`'s shape
// (raw string fields, a `formToSnippet` result union) and its numeric-field
// validation style (`timeoutSecs`, like `hostForm.ts`'s `port`). No host field here —
// a `kind: 'remote'` snippet's target is resolved at run time from the *automation*'s
// host parameter, not baked into the snippet, so the same snippet runs
// identically against whichever host that automation is run with this time.

import type { SnippetDto, SnippetKindDto } from '$lib/bindings';

export interface SnippetFormFields {
  name: string;
  kind: SnippetKindDto;
  command: string;
  timeoutSecs: string;
}

export function emptyForm(): SnippetFormFields {
  return { name: '', kind: 'local', command: '', timeoutSecs: '300' };
}

/** Seed the edit form from an `SnippetDto`. */
export function formFromSnippet(a: SnippetDto): SnippetFormFields {
  return {
    name: a.name,
    kind: a.kind,
    command: a.command,
    timeoutSecs: String(a.timeoutSecs)
  };
}

export type SnippetFormResult = { ok: true; snippet: SnippetDto } | { ok: false; error: string };

/** Validate + build an `SnippetDto`. `id` is supplied by the caller (a fresh
 *  `crypto.randomUUID()` for a new snippet, the existing id when editing) — the
 *  form itself never generates or shows it. */
export function formToSnippet(f: SnippetFormFields, id: string): SnippetFormResult {
  const name = f.name.trim();
  if (!name) return { ok: false, error: 'Name cannot be empty' };

  const command = f.command.trim();
  if (!command) return { ok: false, error: 'Command cannot be empty' };

  const timeoutRaw = f.timeoutSecs.trim();
  let timeoutSecs = 300;
  if (timeoutRaw !== '') {
    if (!/^\+?\d+$/.test(timeoutRaw) || Number(timeoutRaw) < 1) {
      return { ok: false, error: `Timeout must be a positive whole number of seconds, got '${timeoutRaw}'` };
    }
    timeoutSecs = Number(timeoutRaw);
  }

  return {
    ok: true,
    snippet: { id, name, kind: f.kind, command, timeoutSecs }
  };
}
