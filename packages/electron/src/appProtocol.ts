import { protocol } from 'electron';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

/**
 * Serves the built SvelteKit SPA (`packages/ui/build`) over a custom
 * `app://` origin instead of a bare `file://` load. `adapter-static`'s
 * output uses root-absolute asset paths (`/_app/...`), which only resolve
 * against a real origin — `file://` has none. A custom scheme also keeps
 * the renderer's origin stable and sandboxable, unlike spinning up a
 * loopback HTTP server.
 *
 * Must be registered (`registerAppScheme`) before `app.whenReady()`; the
 * request handler itself is wired inside `whenReady` (`registerAppProtocolHandler`).
 */

export const APP_SCHEME = 'app';
export const APP_ORIGIN = `${APP_SCHEME}://local`;

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf'
};

export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }
  ]);
}

export function registerAppProtocolHandler(uiBuildDir: string): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    const decoded = decodeURIComponent(url.pathname);
    const relative = decoded === '' || decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
    const filePath = join(uiBuildDir, normalize(relative));

    // Refuse anything that escapes the build directory (e.g. via `..`).
    if (!filePath.startsWith(uiBuildDir + sep) && filePath !== uiBuildDir) {
      return new Response('forbidden', { status: 403 });
    }

    try {
      const data = await readFile(filePath);
      return new Response(data, { headers: { 'content-type': MIME_TYPES[extname(filePath)] ?? 'application/octet-stream' } });
    } catch {
      // SPA fallback: an unknown path is a client-side route, not a 404.
      const indexData = await readFile(join(uiBuildDir, 'index.html'));
      return new Response(indexData, { headers: { 'content-type': 'text/html' } });
    }
  });
}
