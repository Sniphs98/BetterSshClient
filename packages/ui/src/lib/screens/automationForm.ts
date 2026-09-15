// Pure Automation form + validation logic, kept free of Svelte components so it's
// unit-testable; `AutomationEditor.svelte` renders it. Mirrors `hostForm.ts`'s shape
// (raw string fields, a `formToAutomation` result union) and its numeric-field
// validation style (`timeoutSecs`, like `hostForm.ts`'s `port`). No host field here —
// a `kind: 'remote'` automation's target is resolved at run time from the *flow*'s
// host parameter, not baked into the automation, so the same automation runs
// identically against whichever host that flow is run with this time.

import type { AutomationDto, AutomationKindDto } from '$lib/bindings';

export interface AutomationFormFields {
  name: string;
  kind: AutomationKindDto;
  command: string;
  timeoutSecs: string;
}

export function emptyForm(): AutomationFormFields {
  return { name: '', kind: 'local', command: '', timeoutSecs: '300' };
}

/** Seed the edit form from an `AutomationDto`. */
export function formFromAutomation(a: AutomationDto): AutomationFormFields {
  return {
    name: a.name,
    kind: a.kind,
    command: a.command,
    timeoutSecs: String(a.timeoutSecs)
  };
}

export type AutomationFormResult = { ok: true; automation: AutomationDto } | { ok: false; error: string };

/** Validate + build an `AutomationDto`. `id` is supplied by the caller (a fresh
 *  `crypto.randomUUID()` for a new automation, the existing id when editing) — the
 *  form itself never generates or shows it. */
export function formToAutomation(f: AutomationFormFields, id: string): AutomationFormResult {
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
    automation: { id, name, kind: f.kind, command, timeoutSecs }
  };
}
