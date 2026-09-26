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
  if (!isOnePasswordReference(value)) return value;
  return `‹${value.trim().split('/')[3]}›`;
}
