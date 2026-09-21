import type { SecretCipher } from './secretCipher.js';

/**
 * Field-agnostic encrypt/decrypt for a single string secret stored inline in a TOML
 * config file (a host's password, a remote-desktop connection's password, …).
 * Extracted out of `core/config/hosts.ts`, which was the first caller — kept its exact
 * prefix and fallback behavior so `hosts.toml` round-trips identically.
 */

// This prefix on the on-disk string is what tells `decryptSecret` a value is
// ciphertext rather than a legacy (or encryption-unavailable) plaintext secret, so it
// knows whether to run it through the cipher at all.
export const ENCRYPTED_PREFIX = 'enc:v1:';

/** Encrypts `value` when a cipher is actually available, leaving it as plaintext
 *  otherwise (e.g. no OS keyring on this Linux setup) — better to keep working than to
 *  refuse to save the record at all. */
export function encryptSecret(value: string | undefined, cipher: SecretCipher): string | undefined {
  if (value === undefined || !cipher.available) return value;
  return ENCRYPTED_PREFIX + cipher.encrypt(value).toString('base64');
}

/** The inverse of `encryptSecret`. A value without the prefix is either a
 *  never-encrypted legacy secret (a config file from before this existed) or one saved
 *  while encryption was unavailable — both already plaintext, nothing to do. A value
 *  that fails to decrypt (the OS key changed, or this file was copied to a different
 *  user/machine) drops just that one secret rather than failing the whole file to load
 *  — the user simply re-enters it. */
export function decryptSecret(value: string | undefined, cipher: SecretCipher): string | undefined {
  if (value === undefined || !value.startsWith(ENCRYPTED_PREFIX)) return value;
  const ciphertext = Buffer.from(value.slice(ENCRYPTED_PREFIX.length), 'base64');
  try {
    return cipher.decrypt(ciphertext);
  } catch {
    return undefined;
  }
}
