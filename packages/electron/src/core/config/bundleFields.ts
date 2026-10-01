/**
 * Field checks for the export/import files (`core/automation/bundle.ts`,
 * `sshHostBundle.ts`, `rdpProfileBundle.ts`). An imported file might be hand-edited,
 * from a future app version, or not a Remoty file at all, so every field is checked
 * explicitly and a bad one throws a descriptive `Error` naming where it sits.
 */

export function str(v: unknown, ctx: string): string {
  if (typeof v !== 'string') throw new Error(`${ctx}: expected a string`);
  return v;
}

export function optionalStr(v: unknown, ctx: string): string | undefined {
  return v === undefined ? undefined : str(v, ctx);
}

export function num(v: unknown, ctx: string): number {
  if (typeof v !== 'number') throw new Error(`${ctx}: expected a number`);
  return v;
}

export function bool(v: unknown, ctx: string): boolean {
  if (typeof v !== 'boolean') throw new Error(`${ctx}: expected a boolean`);
  return v;
}

export function optionalBool(v: unknown, ctx: string): boolean | undefined {
  return v === undefined ? undefined : bool(v, ctx);
}

export function obj(v: unknown, ctx: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null) throw new Error(`${ctx}: expected an object`);
  return v as Record<string, unknown>;
}

export function arr(v: unknown, ctx: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`${ctx}: expected an array`);
  return v;
}

/** A TCP port: a whole number from 1 to 65535. */
export function port(v: unknown, ctx: string): number {
  const n = num(v, ctx);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${ctx}: must be a port from 1 to 65535`);
  return n;
}

/** `base` if it's not already in `taken`, else `"base (2)"`, `"base (3)"`, … — so an
 *  import never silently takes a name something already has. */
export function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base} (${i})`)) i += 1;
  return `${base} (${i})`;
}
