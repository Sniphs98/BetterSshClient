/**
 * Plugin manifests (`plugin.json`) and the permissions they ask for.
 *
 * A plugin is a folder in the app's `plugins/` directory holding a
 * `plugin.json` and the JavaScript file it names as `main`. The code runs in a
 * sandboxed, hidden browser window with no Node.js and no network (see
 * `plugins/host.ts`); everything it can do goes through the small `bssh` API,
 * and every API call is checked against the permissions granted here.
 *
 * Kept free of Electron so the validation and permission rules are testable.
 */

/** The plugin API version this app implements. A plugin built for another one is refused. */
export const PLUGIN_API_VERSION = 1;

/**
 * What a plugin may ask for:
 *
 * - `hosts:read`         the host list — names, addresses, users, ports, tags; never passwords or keys
 * - `hosts:exec`         run shell commands on any of the user's hosts
 * - `network:<hostname>` HTTPS requests to that one hostname (e.g. `network:api.github.com`)
 *
 * Registering commands and showing text need no permission: they only ever act
 * when the user picks the command.
 */
export type Permission = 'hosts:read' | 'hosts:exec' | `network:${string}`;

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  /** The script to run, relative to the plugin folder. */
  main: string;
  description?: string;
  permissions: Permission[];
}

export type ManifestResult = { ok: true; manifest: PluginManifest } | { ok: false; error: string };

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
// A plain relative path inside the plugin folder: no absolute paths, no `..`.
const MAIN = /^(?!\/)(?!.*(^|[\\/])\.\.([\\/]|$))[\w./-]+\.m?js$/;
// A single DNS hostname — no scheme, port, path or wildcard.
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function isPermission(value: unknown): value is Permission {
  if (value === 'hosts:read' || value === 'hosts:exec') return true;
  return typeof value === 'string' && value.startsWith('network:') && HOSTNAME.test(value.slice('network:'.length));
}

/** Validates a parsed `plugin.json`. `folderName` must match the id, so one plugin
 *  can't masquerade as another by copying its id. */
export function parseManifest(raw: unknown, folderName: string): ManifestResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error: 'plugin.json is not an object' };
  const m = raw as Record<string, unknown>;

  if (typeof m.id !== 'string' || !ID.test(m.id)) return { ok: false, error: 'id must be lowercase letters, digits and dashes' };
  if (m.id !== folderName) return { ok: false, error: `id "${m.id}" does not match its folder "${folderName}"` };
  if (typeof m.name !== 'string' || m.name.trim() === '') return { ok: false, error: 'name is missing' };
  if (typeof m.version !== 'string' || !VERSION.test(m.version)) return { ok: false, error: 'version must look like 1.0.0' };
  if (m.apiVersion !== PLUGIN_API_VERSION) {
    return { ok: false, error: `built for plugin API ${String(m.apiVersion)}, this app supports ${PLUGIN_API_VERSION}` };
  }
  if (typeof m.main !== 'string' || !MAIN.test(m.main)) return { ok: false, error: 'main must be a .js file inside the plugin folder' };
  if (m.description !== undefined && typeof m.description !== 'string') return { ok: false, error: 'description must be text' };

  const permissions = m.permissions ?? [];
  if (!Array.isArray(permissions)) return { ok: false, error: 'permissions must be a list' };
  const unknown = permissions.find((p) => !isPermission(p));
  if (unknown !== undefined) return { ok: false, error: `unknown permission "${String(unknown)}"` };

  return {
    ok: true,
    manifest: {
      id: m.id,
      name: m.name.trim(),
      version: m.version,
      apiVersion: m.apiVersion,
      main: m.main,
      description: typeof m.description === 'string' ? m.description.trim() || undefined : undefined,
      permissions: [...new Set(permissions as Permission[])]
    }
  };
}

/** Whether every permission the plugin asks for has been granted. A plugin whose
 *  update asks for something new is off again until the user agrees to it. */
export function isFullyGranted(requested: readonly Permission[], granted: readonly Permission[]): boolean {
  return requested.every((p) => granted.includes(p));
}

/** The hostnames a plugin may reach, from its `network:` permissions. */
export function allowedNetworkHosts(permissions: readonly Permission[]): string[] {
  return permissions.filter((p) => p.startsWith('network:')).map((p) => p.slice('network:'.length));
}

/** Whether a request URL is one the plugin may make: HTTPS, to exactly a granted hostname. */
export function isAllowedRequest(url: string, permissions: readonly Permission[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === 'https:' && allowedNetworkHosts(permissions).includes(parsed.hostname.toLowerCase());
}

/** A human description of each permission, for the consent list in Settings. */
export function describePermission(p: Permission): string {
  if (p === 'hosts:read') return 'See your host list (names, addresses, users, ports, tags — no passwords or keys)';
  if (p === 'hosts:exec') return 'Run commands on your hosts';
  return `Connect to ${p.slice('network:'.length)} over HTTPS`;
}
