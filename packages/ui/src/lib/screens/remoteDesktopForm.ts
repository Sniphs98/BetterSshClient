// Pure remote-desktop connection form + validation logic, kept free of Svelte
// components so it is unit-testable; `RemoteDesktopEditor.svelte` renders it. Mirrors
// `hostForm.ts`'s shape (closest existing analog: name/hostname/port/user/password).
// Only `'rdp'` is reachable from the UI this round (VNC is a later pass) — the default
// port and the form fields already key off `protocol` so adding a picker later is a
// small diff, not a rewrite.

import type { RemoteDesktopConnectionDto, RemoteDesktopConnectionInputDto, RemoteDesktopProtocolDto } from '$lib/bindings';

export function defaultPort(protocol: RemoteDesktopProtocolDto): number {
  return protocol === 'vnc' ? 5900 : 3389;
}

/** The editable form fields — all raw text; `port` starts blank and means "the
 *  protocol's default" (mirrors `hostForm.ts`'s port field). */
export interface RemoteDesktopFormFields {
  id: string;
  name: string;
  protocol: RemoteDesktopProtocolDto;
  hostname: string;
  port: string;
  username: string;
  password: string;
  domain: string;
}

export function emptyForm(): RemoteDesktopFormFields {
  return {
    id: crypto.randomUUID(),
    name: '',
    protocol: 'rdp',
    hostname: '',
    port: '',
    username: '',
    password: '',
    domain: ''
  };
}

/** Seed the edit form from a `RemoteDesktopConnectionDto`. `password` is intentionally
 *  blank: the DTO omits it (only `hasPassword` travels out), so on edit it stays empty
 *  and means "keep the stored value" — `save_remote_desktop_connection` preserves it
 *  unless the user types a new one. */
export function formFromConnection(c: RemoteDesktopConnectionDto): RemoteDesktopFormFields {
  return {
    id: c.id,
    name: c.name,
    protocol: c.protocol,
    hostname: c.hostname,
    port: String(c.port),
    username: c.username ?? '',
    password: '',
    domain: c.domain ?? ''
  };
}

export type RemoteDesktopFormResult =
  | { ok: true; input: RemoteDesktopConnectionInputDto }
  | { ok: false; error: string };

/** Validate + build a `RemoteDesktopConnectionInputDto`, or return an error message.
 *  Name and hostname are required; port defaults per-protocol when blank and must be a
 *  1–65535 integer; username/password/domain are trimmed and dropped to `undefined`
 *  when empty (so the wire form stays sparse, matching `hostForm.ts`'s convention). */
export function formToInput(f: RemoteDesktopFormFields): RemoteDesktopFormResult {
  const name = f.name.trim();
  if (!name) return { ok: false, error: 'Name cannot be empty' };
  const hostname = f.hostname.trim();
  if (!hostname) return { ok: false, error: 'Hostname / IP cannot be empty' };

  const portRaw = f.port.trim();
  let port = defaultPort(f.protocol);
  if (portRaw !== '') {
    if (!/^\+?\d+$/.test(portRaw) || Number(portRaw) < 1 || Number(portRaw) > 65535) {
      return { ok: false, error: `Port must be a number between 1 and 65535, got '${portRaw}'` };
    }
    port = Number(portRaw);
  }

  const username = f.username.trim();
  const password = f.password.trim();
  const domain = f.domain.trim();
  return {
    ok: true,
    input: {
      id: f.id,
      name,
      protocol: f.protocol,
      hostname,
      port,
      username: username || undefined,
      password: password || undefined,
      domain: domain || undefined
    }
  };
}

/** Case-insensitive substring filter over name / hostname (mirrors `filterSnippets`).
 *  An empty query keeps everything; order is preserved. */
export function filterConnections(list: RemoteDesktopConnectionDto[], query: string): RemoteDesktopConnectionDto[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter((c) => c.name.toLowerCase().includes(q) || c.hostname.toLowerCase().includes(q));
}
