// A "run automation" node's values, kept free of Svelte so it's unit-testable;
// AutomationCallNode.svelte renders them.

import type { AutomationParamDto } from '$lib/bindings';

/** What the called automation asks for when it runs — its fixed variables it sets itself. */
export function askedParams(called: { params: AutomationParamDto[] }): AutomationParamDto[] {
  return called.params.filter((p) => p.kind !== 'fixed');
}

/**
 * The values to hand on, one per parameter the called automation asks for: what's already
 * set stays; a new one is filled in from this automation where it can be — a parameter of
 * the same name, or for its host this automation's host — so the usual case needs no typing.
 * Values for parameters it no longer has are dropped (saving would refuse them).
 */
export function callParamValues(
  called: { params: AutomationParamDto[] },
  own: AutomationParamDto[],
  current: Record<string, string>
): Record<string, string> {
  const ownHost = own.find((p) => p.kind === 'host');
  return Object.fromEntries(
    askedParams(called).map((p) => {
      if (current[p.name] !== undefined) return [p.name, current[p.name]];
      if (own.some((o) => o.name === p.name)) return [p.name, `{{params.${p.name}}}`];
      if (p.kind === 'host' && ownHost) return [p.name, `{{params.${ownHost.name}}}`];
      return [p.name, ''];
    })
  );
}

/** The automations a node in `self` can run: every other one, by name. */
export function callableAutomations(all: Array<{ name: string }>, self: string): string[] {
  return all
    .map((a) => a.name)
    .filter((n) => n !== self.trim())
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}
