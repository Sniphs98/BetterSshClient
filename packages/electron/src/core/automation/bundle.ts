import { randomUUID } from 'node:crypto';
import type { Snippet, NodeTarget, Automation, AutomationEdge, AutomationNode, AutomationParam, AutomationParamKind } from './types.js';

/**
 * Export/import file format for sharing a single Snippet or Automation between people or
 * machines. An Automation bundle is self-contained — it carries every Snippet its nodes
 * reference, not just the Automation's own graph shape, so the file works unchanged on a
 * machine that has never seen those Snippets before. Plain JSON (not TOML, unlike
 * the on-disk config) since this is a one-off file meant to be emailed/committed/pasted
 * around, not maintained by hand like automations.toml is.
 */

export const BUNDLE_VERSION = 1;

export interface SnippetBundle {
  kind: 'better-ssh-client-snippet';
  version: number;
  snippet: Snippet;
}

export interface AutomationBundle {
  kind: 'better-ssh-client-automation';
  version: number;
  automation: Automation;
  snippets: Snippet[];
}

export type Bundle = SnippetBundle | AutomationBundle;

export function buildSnippetBundle(snippet: Snippet): SnippetBundle {
  return { kind: 'better-ssh-client-snippet', version: BUNDLE_VERSION, snippet };
}

/** Gathers exactly the Snippets `automation` actually references, in node order and
 *  deduplicated — never the whole library. Throws if a node's `snippetId` doesn't
 *  resolve; `save_automation` always validates this first so an automation reached through normal
 *  use can't be in that state, but a hand-edited automations.toml could be. */
export function buildAutomationBundle(automation: Automation, snippetsById: Map<string, Snippet>): AutomationBundle {
  const seen = new Set<string>();
  const snippets: Snippet[] = [];
  for (const node of automation.nodes) {
    if (node.upload !== undefined || seen.has(node.snippetId)) continue;
    const snippet = snippetsById.get(node.snippetId);
    if (snippet === undefined) {
      throw new Error(`automation "${automation.name}" references an unknown snippet`);
    }
    seen.add(node.snippetId);
    snippets.push(snippet);
  }
  return { kind: 'better-ssh-client-automation', version: BUNDLE_VERSION, automation, snippets };
}

// ---------------------------------------------------------------------------
// Parsing an imported file's already-`JSON.parse`d contents — the file might be
// hand-edited, from a future app version, or not a BetterSshClient bundle at all, so every
// field is checked explicitly and a bad one throws a descriptive `Error`, the same
// discipline core/config/automations.ts's *FromToml functions apply to a hand-edited TOML.
// ---------------------------------------------------------------------------

function str(v: unknown, ctx: string): string {
  if (typeof v !== 'string') throw new Error(`${ctx}: expected a string`);
  return v;
}

function optionalStr(v: unknown, ctx: string): string | undefined {
  return v === undefined ? undefined : str(v, ctx);
}

function num(v: unknown, ctx: string): number {
  if (typeof v !== 'number') throw new Error(`${ctx}: expected a number`);
  return v;
}

function bool(v: unknown, ctx: string): boolean {
  if (typeof v !== 'boolean') throw new Error(`${ctx}: expected a boolean`);
  return v;
}

function obj(v: unknown, ctx: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null) throw new Error(`${ctx}: expected an object`);
  return v as Record<string, unknown>;
}

function arr(v: unknown, ctx: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`${ctx}: expected an array`);
  return v;
}

function parseSnippet(raw: unknown, ctx: string): Snippet {
  const o = obj(raw, ctx);
  return {
    id: str(o.id, `${ctx}.id`),
    name: str(o.name, `${ctx}.name`),
    command: str(o.command, `${ctx}.command`),
    timeoutSecs: num(o.timeoutSecs, `${ctx}.timeoutSecs`)
  };
}

function parseAutomationNode(raw: unknown, ctx: string): AutomationNode {
  const o = obj(raw, ctx);
  const target: NodeTarget | undefined =
    o.target === 'local' ? 'local' : o.target === 'wsl' ? 'wsl' : o.target === 'remote' ? 'remote' : undefined;
  if (target === undefined) throw new Error(`${ctx}.target: must be "local", "wsl" or "remote"`);
  let position: { x: number; y: number } | undefined;
  if (o.position !== undefined && o.position !== null) {
    const p = obj(o.position, `${ctx}.position`);
    position = { x: num(p.x, `${ctx}.position.x`), y: num(p.y, `${ctx}.position.y`) };
  }
  let upload: AutomationNode['upload'];
  if (o.upload !== undefined && o.upload !== null) {
    const u = obj(o.upload, `${ctx}.upload`);
    upload = { from: str(u.from, `${ctx}.upload.from`), to: str(u.to, `${ctx}.upload.to`) };
  }
  return {
    id: str(o.id, `${ctx}.id`),
    snippetId: upload !== undefined && o.snippetId === undefined ? '' : str(o.snippetId, `${ctx}.snippetId`),
    upload,
    wslDistro: target === 'wsl' ? optionalStr(o.wslDistro, `${ctx}.wslDistro`) || undefined : undefined,
    label: str(o.label, `${ctx}.label`),
    continueOnError: bool(o.continueOnError, `${ctx}.continueOnError`),
    target,
    position
  };
}

function parseAutomationEdge(raw: unknown, ctx: string): AutomationEdge {
  const o = obj(raw, ctx);
  return { from: str(o.from, `${ctx}.from`), to: str(o.to, `${ctx}.to`) };
}

function parseAutomationParam(raw: unknown, ctx: string): AutomationParam {
  const o = obj(raw, ctx);
  const kind: AutomationParamKind | undefined = o.kind === 'text' ? 'text' : o.kind === 'host' ? 'host' : undefined;
  if (kind === undefined) throw new Error(`${ctx}.kind: must be "text" or "host"`);
  return {
    name: str(o.name, `${ctx}.name`),
    kind,
    label: optionalStr(o.label, `${ctx}.label`),
    default: optionalStr(o.default, `${ctx}.default`)
  };
}

function parseAutomation(raw: unknown, ctx: string): Automation {
  const o = obj(raw, ctx);
  return {
    name: str(o.name, `${ctx}.name`),
    params: arr(o.params ?? [], `${ctx}.params`).map((p, i) => parseAutomationParam(p, `${ctx}.params[${i}]`)),
    nodes: arr(o.nodes ?? [], `${ctx}.nodes`).map((n, i) => parseAutomationNode(n, `${ctx}.nodes[${i}]`)),
    edges: arr(o.edges ?? [], `${ctx}.edges`).map((e, i) => parseAutomationEdge(e, `${ctx}.edges[${i}]`)),
    startLinks:
      o.startLinks === undefined
        ? undefined
        : arr(o.startLinks, `${ctx}.startLinks`).map((s, i) => str(s, `${ctx}.startLinks[${i}]`))
  };
}

/** Parses+validates a file's already-`JSON.parse`d contents into a `Bundle`, or throws
 *  a descriptive `Error`. */
export function parseBundle(raw: unknown): Bundle {
  const o = obj(raw, 'file');
  // 'omnyssh-*' is what this app called itself before the rename; files exported then
  // still import, they just come back out under the current name.
  if (o.kind === 'better-ssh-client-snippet' || o.kind === 'omnyssh-snippet') {
    return {
      kind: 'better-ssh-client-snippet',
      version: num(o.version, 'file.version'),
      snippet: parseSnippet(o.snippet, 'file.snippet')
    };
  }
  if (o.kind === 'better-ssh-client-automation' || o.kind === 'omnyssh-automation') {
    return {
      kind: 'better-ssh-client-automation',
      version: num(o.version, 'file.version'),
      automation: parseAutomation(o.automation, 'file.automation'),
      snippets: arr(o.snippets, 'file.snippets').map((a, i) => parseSnippet(a, `file.snippets[${i}]`))
    };
  }
  throw new Error('not a BetterSshClient snippet/automation file');
}

export interface ImportResult {
  kind: 'snippet' | 'automation';
  name: string;
}

/** `base` if it's not already in `taken`, else `"base (2)"`, `"base (3)"`, … — used for
 *  an Automation's name (the on-disk primary key; see `upsertAutomation`) so importing one never
 *  silently overwrites an existing automation of the same name. */
function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base} (${i})`)) i += 1;
  return `${base} (${i})`;
}

/** Adds the bundled Snippet to the library under a fresh id. `Snippet.id` is a
 *  local implementation detail, not a stable identity across machines (see
 *  `upsertSnippet`'s doc comment) — reusing the exporting machine's id risks
 *  colliding with an unrelated Snippet the importer already has. Snippet names
 *  don't have to be unique (also `upsertSnippet`), so unlike an Automation's name, nothing
 *  here needs renaming. */
export function mergeSnippetBundle(
  bundle: SnippetBundle,
  snippets: Snippet[]
): { snippets: Snippet[]; result: ImportResult } {
  const imported: Snippet = { ...bundle.snippet, id: randomUUID() };
  return { snippets: [...snippets, imported], result: { kind: 'snippet', name: imported.name } };
}

/** Adds every bundled Snippet under a fresh id, remaps the Automation's node
 *  `snippetId`s through that mapping, and renames the Automation if its name collides
 *  with one the importer already has (see `uniqueName`). */
export function mergeAutomationBundle(
  bundle: AutomationBundle,
  snippets: Snippet[],
  automations: Automation[]
): { snippets: Snippet[]; automations: Automation[]; result: ImportResult } {
  const idMap = new Map<string, string>();
  const importedSnippets = bundle.snippets.map((a) => {
    const id = randomUUID();
    idMap.set(a.id, id);
    return { ...a, id };
  });
  const name = uniqueName(bundle.automation.name, new Set(automations.map((f) => f.name)));
  const importedAutomation: Automation = {
    ...bundle.automation,
    name,
    nodes: bundle.automation.nodes.map((n) => ({ ...n, snippetId: idMap.get(n.snippetId) ?? n.snippetId }))
  };
  return {
    snippets: [...snippets, ...importedSnippets],
    automations: [...automations, importedAutomation],
    result: { kind: 'automation', name }
  };
}
