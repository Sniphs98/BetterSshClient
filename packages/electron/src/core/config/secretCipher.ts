/**
 * OS-backed encryption for a Host's stored password — `hosts.toml` used to hold it in
 * plaintext (a security review flagged this: readable by anything with filesystem
 * access to the config directory, and the file's own `chmod 600` hardening is skipped
 * entirely on Windows, this app's primary platform).
 *
 * `core/` stays Electron-agnostic (nothing under it imports `'electron'`, so it stays
 * testable under plain vitest without an Electron runtime) — `main.ts` installs the
 * real implementation once at startup, backed by Electron's `safeStorage` (Windows
 * DPAPI / macOS Keychain / Linux libsecret, tied to the OS user account), via
 * `setSecretCipher`. Everything that needs to encrypt/decrypt a password calls
 * `getSecretCipher()` instead of importing `'electron'` itself. Left at the inert
 * default in any test that never calls `setSecretCipher` — the same plaintext
 * behavior `hosts.toml` always had, so no test needs to know this module exists
 * unless it's specifically exercising the encrypted path.
 */

export interface SecretCipher {
  /** Whether `encrypt`/`decrypt` will actually work right now — Electron's
   *  `safeStorage` can report this `false` on a Linux setup with no keyring
   *  backend, in which case a password is left as plaintext rather than refusing
   *  to save the host at all. */
  available: boolean;
  encrypt: (plainText: string) => Buffer;
  decrypt: (ciphertext: Buffer) => string;
}

const inert: SecretCipher = {
  available: false,
  encrypt: () => {
    throw new Error('encryption unavailable');
  },
  decrypt: () => {
    throw new Error('decryption unavailable');
  }
};

let current: SecretCipher = inert;

/** Installs the cipher `core/config/hosts.ts` uses from here on — called exactly
 *  once, by `main.ts` right after `app.whenReady()`, before any host is loaded or
 *  saved. */
export function setSecretCipher(cipher: SecretCipher): void {
  current = cipher;
}

export function getSecretCipher(): SecretCipher {
  return current;
}
