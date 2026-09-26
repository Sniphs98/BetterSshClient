import type { RemoteDesktopConnection } from '../config/remoteDesktop.js';
import { readSecretCached, resolvePort, resolveReference } from '../secrets/onePassword.js';

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

/**
 * `connection` with everything that comes from 1Password filled in: the address, user
 * name and domain when they are references (`op://…` in the field itself), the port
 * from `portRef` and the password from `passwordRef`. The result carries no references
 * any more, so whatever launches or tunnels it needs no knowledge of 1Password.
 */
export async function resolveConnection<
  C extends Pick<RemoteDesktopConnection, 'hostname' | 'port' | 'portRef' | 'username' | 'domain' | 'password' | 'passwordRef'>
>(connection: C): Promise<C> {
  // One after the other: the first read may wait for Windows Hello / Touch ID, and
  // the rest then ride on that unlock.
  const hostname = await resolveReference(connection.hostname);
  const port = await resolvePort(connection.portRef, connection.port);
  const username = connection.username ? await resolveReference(connection.username) : connection.username;
  const domain = connection.domain ? await resolveReference(connection.domain) : connection.domain;
  const password = await connectionPassword(connection);
  return { ...connection, hostname, port, portRef: undefined, username, domain, password, passwordRef: undefined };
}
