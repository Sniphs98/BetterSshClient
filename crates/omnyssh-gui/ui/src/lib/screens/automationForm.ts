// Pure automation form + list logic, kept free of Svelte components so it is
// unit-testable; `Automations.svelte`/`AutomationEditor.svelte` render it. The
// steps DSL and validation mirror the TUI's `parse_steps_text`/`to_automation`
// so both frontends produce the same `automations.toml` shape.

import type { AutomationDto, AutomationStepDto, AutomationStepKindDto } from '$lib/bindings';

/** The editable form fields. `steps` is the freeform textarea DSL — one step per
 *  line, e.g. `local: docker save {{tag}} -o image.tar` — parsed by
 *  `parseStepsText`. Params are comma-separated raw text. */
export interface AutomationFormFields {
  name: string;
  host: string;
  params: string;
  steps: string;
}

export function emptyForm(): AutomationFormFields {
  return { name: '', host: '', params: '', steps: '' };
}

export function formFromAutomation(a: AutomationDto): AutomationFormFields {
  return {
    name: a.name,
    host: a.host ?? '',
    params: (a.params ?? []).join(', '),
    steps: stepsToText(a.steps)
  };
}

function splitCsv(raw: string): string[] {
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

const DEFAULT_TIMEOUT_SECS = 300;

/** Parses the steps textarea into a step list. Throws with a human-readable
 *  message naming the offending line on the first failure — mirrors the TUI's
 *  `parse_steps_text` (`crates/omnyssh/src/app/automations.rs`) line-for-line. */
export function parseStepsText(text: string): AutomationStepDto[] {
  const steps: AutomationStepDto[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const lineNo = i + 1;

    const colon = line.indexOf(':');
    if (colon === -1) throw new Error(`Line ${lineNo}: expected 'kind: ...', got '${line}'`);
    const prefix = line.slice(0, colon).trim().toLowerCase();
    const rest = line.slice(colon + 1).trim();
    if (!rest) throw new Error(`Line ${lineNo}: missing content after '${prefix}:'`);

    const base = { continueOnError: false, timeoutSecs: DEFAULT_TIMEOUT_SECS };
    if (prefix === 'local') {
      steps.push({ kind: 'local', command: rest, ...base });
    } else if (prefix === 'remote') {
      steps.push({ kind: 'remote', command: rest, ...base });
    } else if (prefix === 'upload') {
      const [local, remote] = splitArrow(rest, lineNo, "expected 'local -> remote'");
      steps.push({ kind: 'upload', localPath: local, remotePath: remote, ...base });
    } else if (prefix === 'download') {
      const [remote, local] = splitArrow(rest, lineNo, "expected 'remote -> local'");
      steps.push({ kind: 'download', localPath: local, remotePath: remote, ...base });
    } else {
      throw new Error(
        `Line ${lineNo}: unknown step kind '${prefix}' (expected local/remote/upload/download)`
      );
    }
  }
  return steps;
}

function splitArrow(text: string, lineNo: number, message: string): [string, string] {
  const idx = text.indexOf('->');
  if (idx === -1) throw new Error(`Line ${lineNo}: ${message}`);
  const a = text.slice(0, idx).trim();
  const b = text.slice(idx + 2).trim();
  if (!a || !b) throw new Error(`Line ${lineNo}: ${message}`);
  return [a, b];
}

/** Renders a step list back into editable text — the inverse of `parseStepsText`. */
export function stepsToText(steps: AutomationStepDto[]): string {
  return steps.map(describeStepLine).join('\n');
}

function describeStepLine(s: AutomationStepDto): string {
  switch (s.kind) {
    case 'local':
      return `local: ${s.command ?? ''}`;
    case 'remote':
      return `remote: ${s.command ?? ''}`;
    case 'upload':
      return `upload: ${s.localPath ?? ''} -> ${s.remotePath ?? ''}`;
    case 'download':
      return `download: ${s.remotePath ?? ''} -> ${s.localPath ?? ''}`;
  }
}

/** A one-line human description of a step, used in the results panel. */
export function describeStep(s: AutomationStepDto): string {
  const kindLabel: Record<AutomationStepKindDto, string> = {
    local: 'Local',
    remote: 'Remote',
    upload: 'Upload',
    download: 'Download'
  };
  switch (s.kind) {
    case 'local':
    case 'remote':
      return `${kindLabel[s.kind]}: ${s.command ?? ''}`;
    case 'upload':
      return `Upload: ${s.localPath ?? ''} → ${s.remotePath ?? ''}`;
    case 'download':
      return `Download: ${s.remotePath ?? ''} → ${s.localPath ?? ''}`;
  }
}

function stepNeedsHost(kind: AutomationStepKindDto): boolean {
  return kind !== 'local';
}

export type FormResult =
  | { ok: true; automation: AutomationDto }
  | { ok: false; error: string };

/** Validate + build an `AutomationDto`, or return an error message. Mirrors the
 *  TUI's `AutomationForm::to_automation`: name and at least one step are
 *  required; a host is required when any step needs one. */
export function formToAutomation(f: AutomationFormFields): FormResult {
  const name = f.name.trim();
  if (!name) return { ok: false, error: 'Name cannot be empty' };

  const host = f.host.trim();

  let steps: AutomationStepDto[];
  try {
    steps = parseStepsText(f.steps);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (steps.length === 0) {
    return { ok: false, error: 'Add at least one step' };
  }
  if (!host && steps.some((s) => stepNeedsHost(s.kind))) {
    return { ok: false, error: 'This automation has a remote/upload/download step — set a Host' };
  }

  const params = splitCsv(f.params);

  return {
    ok: true,
    automation: {
      name,
      host: host || undefined,
      steps,
      params: params.length ? params : undefined
    }
  };
}

/** An automation's declared parameter names (drives the run dialog's prompts). */
export function declaredParams(a: AutomationDto): string[] {
  return a.params ?? [];
}

/** Case-insensitive substring filter over name / host / step text (mirrors the
 *  TUI's `filter_automations`). An empty query keeps everything; order is
 *  preserved. */
export function filterAutomations(list: AutomationDto[], query: string): AutomationDto[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter(
    (a) =>
      a.name.toLowerCase().includes(q) ||
      (a.host ?? '').toLowerCase().includes(q) ||
      stepsToText(a.steps).toLowerCase().includes(q)
  );
}
