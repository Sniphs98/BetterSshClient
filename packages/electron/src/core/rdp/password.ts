import type { RemoteDesktopConnection } from '../config/remoteDesktop.js';
import { readSecretCached } from '../secrets/onePassword.js';

/**
 * The password to sign in to `connection` with: read from 1Password when it has a
 * reference (remembered for a few minutes, see `readSecretCached`), else the stored
 * one. Read before anything connects — a Windows Hello or Touch ID prompt for the
 * 1Password CLI can take a while.
 */
export async function connectionPassword(connection: Pick<RemoteDesktopConnection, 'password' | 'passwordRef'>): Promise<string | undefined> {
  if (connection.passwordRef) return readSecretCached(connection.passwordRef);
  return connection.password;
}
