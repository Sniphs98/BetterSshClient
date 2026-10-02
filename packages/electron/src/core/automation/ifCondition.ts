import type { AutomationParamKind, IfBranch, IfCondition, IfOperator } from './types.js';

/**
 * Reads an If node's `condition`, an edge's `branch` and a parameter's `kind` from a
 * parsed `automations.toml` table or an imported bundle — either may be hand-edited, so
 * every field is checked, and a bad one throws naming where (`ctx`). Shared by
 * core/config/automations.ts and bundle.ts, like githubStep.ts.
 */

const OPERATORS: IfOperator[] = ['equals', 'notEquals', 'contains', 'notContains', 'isEmpty', 'notEmpty'];

export function parseIfCondition(raw: unknown, ctx: string): IfCondition {
  if (typeof raw !== 'object' || raw === null) throw new Error(`${ctx}: expected a table`);
  const o = raw as Record<string, unknown>;
  const text = (key: string): string => {
    if (typeof o[key] !== 'string') throw new Error(`${ctx}.${key}: expected a string`);
    return o[key] as string;
  };
  if (o.kind === 'compare') {
    if (!OPERATORS.includes(o.op as IfOperator)) throw new Error(`${ctx}.op: must be one of ${OPERATORS.join(', ')}`);
    return { kind: 'compare', left: text('left'), op: o.op as IfOperator, right: typeof o.right === 'string' ? o.right : '' };
  }
  if (o.kind === 'command') {
    if (typeof o.timeoutSecs !== 'number' || !(o.timeoutSecs > 0)) throw new Error(`${ctx}.timeoutSecs: expected a positive number`);
    return { kind: 'command', command: text('command'), timeoutSecs: o.timeoutSecs };
  }
  throw new Error(`${ctx}.kind: must be "compare" or "command"`);
}

/** An edge's `branch`: `undefined` when absent, otherwise `yes` or `no`. */
export function parseIfBranch(raw: unknown, ctx: string): IfBranch | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (raw === 'yes' || raw === 'no') return raw;
  throw new Error(`${ctx}: must be "yes" or "no"`);
}

/** A parameter's `kind`, or `undefined` when it isn't one. */
export function paramKind(raw: unknown): AutomationParamKind | undefined {
  return raw === 'text' || raw === 'host' || raw === 'fixed' ? raw : undefined;
}
