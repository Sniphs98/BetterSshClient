import type { GitHubStep } from './types.js';

/**
 * Reads a node's `github` step from a parsed `automations.toml` table or an imported
 * bundle — either may be hand-edited, so every field is checked, and a bad one throws
 * naming where (`ctx`). Shared by core/config/automations.ts and bundle.ts.
 */
export function parseGitHubStep(raw: unknown, ctx: string): GitHubStep {
  if (typeof raw !== 'object' || raw === null) throw new Error(`${ctx}: expected a table`);
  const o = raw as Record<string, unknown>;
  const text = (key: string): string => {
    if (typeof o[key] !== 'string') throw new Error(`${ctx}.${key}: expected a string`);
    return o[key] as string;
  };
  if (o.action === 'runWorkflow') {
    const inputs: Record<string, string> = {};
    if (o.inputs !== undefined) {
      if (typeof o.inputs !== 'object' || o.inputs === null) throw new Error(`${ctx}.inputs: expected a table`);
      for (const [k, v] of Object.entries(o.inputs as Record<string, unknown>)) {
        if (typeof v !== 'string') throw new Error(`${ctx}.inputs.${k}: expected a string`);
        inputs[k] = v;
      }
    }
    return { action: 'runWorkflow', repo: text('repo'), workflow: text('workflow'), ref: text('ref'), inputs };
  }
  if (o.action === 'downloadAsset') {
    return { action: 'downloadAsset', repo: text('repo'), tag: text('tag'), pattern: text('pattern') };
  }
  throw new Error(`${ctx}.action: must be "runWorkflow" or "downloadAsset"`);
}
