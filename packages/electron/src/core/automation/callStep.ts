import type { AutomationCall } from './types.js';

/**
 * Reads a node's `call` (run another automation) from a parsed `automations.toml` table
 * or an imported bundle — either may be hand-edited, so every field is checked, and a
 * bad one throws naming where (`ctx`). Shared by core/config/automations.ts and
 * bundle.ts, like githubStep.ts.
 */
export function parseAutomationCall(raw: unknown, ctx: string): AutomationCall {
  if (typeof raw !== 'object' || raw === null) throw new Error(`${ctx}: expected a table`);
  const o = raw as Record<string, unknown>;
  if (typeof o.automation !== 'string') throw new Error(`${ctx}.automation: expected a string`);
  const params: Record<string, string> = {};
  if (o.params !== undefined && o.params !== null) {
    if (typeof o.params !== 'object') throw new Error(`${ctx}.params: expected a table`);
    for (const [name, value] of Object.entries(o.params as Record<string, unknown>)) {
      if (typeof value !== 'string') throw new Error(`${ctx}.params.${name}: expected a string`);
      params[name] = value;
    }
  }
  return { automation: o.automation, params };
}
