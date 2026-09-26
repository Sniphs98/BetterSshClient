// The shape of a 1Password secret reference — the same the app's 1Password reader
// (core/secrets/onePassword.ts) accepts: op://vault/item[/section]/field. Shared by
// the host and the remote desktop forms.

const REFERENCE = /^op:\/\/[^/\s]+\/[^/\s]+(\/[^/\s]+){1,2}$/;

export const ONE_PASSWORD_REFERENCE_ERROR = '1Password reference must look like op://vault/item/field';

export function isOnePasswordReference(value: string): boolean {
  return REFERENCE.test(value.trim());
}

/** A field that may be a reference, for tiles and lists: a reference shows as its
 *  1Password item, ‹web-1› — the full op://… is too long and says little there. */
export function displayReference(value: string): string {
  const item = referenceItem(value);
  return item === undefined ? value : `‹${item}›`;
}

function referenceItem(value: string): string | undefined {
  return isOnePasswordReference(value) ? value.trim().split('/')[3] : undefined;
}

/**
 * A tile's `domain\user@host:port` line. Parts read from the same 1Password item as the
 * address are left out — with everything in one item that is just ‹web-1›, rather than
 * ‹web-1›\‹web-1›@‹web-1›:‹web-1›. `host` is the address as it should show (it may be
 * masked for streaming).
 */
export function addressLine(
  a: { hostname: string; port: number; portRef?: string | null; user?: string | null; domain?: string | null },
  host: string
): string {
  const hostItem = referenceItem(a.hostname);
  const shown = (v: string | null | undefined): string | undefined =>
    !v || (hostItem !== undefined && referenceItem(v) === hostItem) ? undefined : displayReference(v);
  const user = shown(a.user);
  const domain = user ? shown(a.domain) : undefined;
  const port = a.portRef ? shown(a.portRef) : String(a.port);
  return `${domain ? `${domain}\\` : ''}${user ? `${user}@` : ''}${host}${port ? `:${port}` : ''}`;
}
