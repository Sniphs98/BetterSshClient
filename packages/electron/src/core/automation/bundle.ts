import { randomUUID } from 'node:crypto';
import type { Snippet, NodeTarget, Automation, AutomationEdge, AutomationNode, AutomationParam, AutomationParamKind } from './types.js';
import { parseGitHubStep } from './githubStep.js';
import { paramKind, parseIfBranch, parseIfCondition } from './ifCondition.js';
import { arr, bool, num, obj, optionalStr, str, uniqueName } from '../config/bundleFields.js';

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
  kind: 'remoty-snippet';
  version: number;
  snippet: Snippet;
}

export interface AutomationBundle {
  kind: 'remoty-automation';
  version: number;
  automation: Automation;
  snippets: Snippet[];
}

/** Everything at once — every automation and the whole snippet library (snippets no
 *  automation uses included), to move a whole setup to another machine or person. */
export interface LibraryBundle {
  kind: 'remoty-library';
  version: number;
  automations: Automation[];
  snippets: Snippet[];
}

export type Bundle = SnippetBundle | AutomationBundle | LibraryBundle;

export function buildSnippetBundle(snippet: Snippet): SnippetBundle {
  return { kind: 'remoty-snippet', version: BUNDLE_VERSION, snippet };
}

/** Gathers exactly the Snippets `automation` actually references, in node order and
 *  deduplicated — never the whole library. Throws if a node's `snippetId` doesn't
 *  resolve; `save_automation` always validates this first so an automation reached through normal
 *  use can't be in that state, but a hand-edited automations.toml could be. */
export function buildAutomationBundle(automation: Automation, snippetsById: Map<string, Snippet>): AutomationBundle {
  const seen = new Set<string>();
  const snippets: Snippet[] = [];
  for (const node of automation.nodes) {
    if (node.upload !== undefined || node.github !== undefined || node.condition !== undefined || seen.has(node.snippetId)) continue;
    const snippet = snippetsById.get(node.snippetId);
    if (snippet === undefined) {
      throw new Error(`automation "${automation.name}" references an unknown snippet`);
    }
    seen.add(node.snippetId);
    snippets.push(snippet);
  }
  return { kind: 'remoty-automation', version: BUNDLE_VERSION, automation, snippets };
}

export function buildLibraryBundle(automations: Automation[], snippets: Snippet[]): LibraryBundle {
  return { kind: 'remoty-library', version: BUNDLE_VERSION, automations, snippets };
}

// ---------------------------------------------------------------------------
// Parsing an imported file's already-`JSON.parse`d contents — every field is checked
// explicitly (see core/config/bundleFields.ts), the same discipline
// core/config/automations.ts's *FromToml functions apply to a hand-edited TOML.
// ---------------------------------------------------------------------------

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
    if (u.source === 'wsl') {
      upload.source = 'wsl';
      const distro = optionalStr(u.wslDistro, `${ctx}.upload.wslDistro`);
      if (distro) upload.wslDistro = distro;
    }
  }
  const github = o.github === undefined || o.github === null ? undefined : parseGitHubStep(o.github, `${ctx}.github`);
  const condition = o.condition === undefined || o.condition === null ? undefined : parseIfCondition(o.condition, `${ctx}.condition`);
  return {
    id: str(o.id, `${ctx}.id`),
    snippetId:
      (upload !== undefined || github !== undefined || condition !== undefined) && o.snippetId === undefined
        ? ''
        : str(o.snippetId, `${ctx}.snippetId`),
    upload,
    github,
    condition,
    wslDistro: target === 'wsl' ? optionalStr(o.wslDistro, `${ctx}.wslDistro`) || undefined : undefined,
    label: str(o.label, `${ctx}.label`),
    continueOnError: bool(o.continueOnError, `${ctx}.continueOnError`),
    target,
    position
  };
}

function parseAutomationEdge(raw: unknown, ctx: string): AutomationEdge {
  const o = obj(raw, ctx);
  const branch = parseIfBranch(o.branch, `${ctx}.branch`);
  const edge: AutomationEdge = { from: str(o.from, `${ctx}.from`), to: str(o.to, `${ctx}.to`) };
  return branch === undefined ? edge : { ...edge, branch };
}

function parseAutomationParam(raw: unknown, ctx: string): AutomationParam {
  const o = obj(raw, ctx);
  const kind: AutomationParamKind | undefined = paramKind(o.kind);
  if (kind === undefined) throw new Error(`${ctx}.kind: must be "text", "host" or "fixed"`);
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

const NAMES = ['remoty', 'better-ssh-client', 'omnyssh'];

function isKind(kind: unknown, what: 'snippet' | 'automation' | 'library'): boolean {
  return NAMES.some((name) => kind === `${name}-${what}`);
}

/** Parses+validates a file's already-`JSON.parse`d contents into a `Bundle`, or throws
 *  a descriptive `Error`. */
export function parseBundle(raw: unknown): Bundle {
  const o = obj(raw, 'file');
  // 'better-ssh-client-*' and 'omnyssh-*' are what this app called itself before; files
  // exported then still import, they just come back out under the current name.
  if (isKind(o.kind, 'snippet')) {
    return {
      kind: 'remoty-snippet',
      version: num(o.version, 'file.version'),
      snippet: parseSnippet(o.snippet, 'file.snippet')
    };
  }
  if (isKind(o.kind, 'automation')) {
    return {
      kind: 'remoty-automation',
      version: num(o.version, 'file.version'),
      automation: parseAutomation(o.automation, 'file.automation'),
      snippets: arr(o.snippets, 'file.snippets').map((a, i) => parseSnippet(a, `file.snippets[${i}]`))
    };
  }
  if (isKind(o.kind, 'library')) {
    return {
      kind: 'remoty-library',
      version: num(o.version, 'file.version'),
      automations: arr(o.automations, 'file.automations').map((f, i) => parseAutomation(f, `file.automations[${i}]`)),
      snippets: arr(o.snippets, 'file.snippets').map((a, i) => parseSnippet(a, `file.snippets[${i}]`))
    };
  }
  throw new Error('not a Remoty snippet/automation file');
}

export interface ImportResult {
  kind: 'snippet' | 'automation' | 'library';
  /** The snippet's or automation's name — for a library, what it held ("3 automations, 5 snippets"). */
  name: string;
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

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** Adds every bundled Snippet and Automation, as `mergeAutomationBundle` does for one:
 *  fresh snippet ids with every node remapped to them, and an automation renamed when its
 *  name is already taken — here or by one imported before it from the same file. */
export function mergeLibraryBundle(
  bundle: LibraryBundle,
  snippets: Snippet[],
  automations: Automation[]
): { snippets: Snippet[]; automations: Automation[]; result: ImportResult } {
  const idMap = new Map<string, string>();
  const importedSnippets = bundle.snippets.map((a) => {
    const id = randomUUID();
    idMap.set(a.id, id);
    return { ...a, id };
  });
  const taken = new Set(automations.map((f) => f.name));
  const importedAutomations = bundle.automations.map((f) => {
    const name = uniqueName(f.name, taken);
    taken.add(name);
    return { ...f, name, nodes: f.nodes.map((n) => ({ ...n, snippetId: idMap.get(n.snippetId) ?? n.snippetId })) };
  });
  return {
    snippets: [...snippets, ...importedSnippets],
    automations: [...automations, ...importedAutomations],
    result: {
      kind: 'library',
      name: `${plural(importedAutomations.length, 'automation')}, ${plural(importedSnippets.length, 'snippet')}`
    }
  };
}
