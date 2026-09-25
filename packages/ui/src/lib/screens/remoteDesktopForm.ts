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
  /** Name of the SSH host to tunnel through; blank connects directly. */
  viaHost: string;
  /** Blank leaves it to the client. */
  display: '' | 'fullscreen' | 'window' | 'fit';
  /** Window size; both blank leaves it to the client. */
  width: string;
  height: string;
  multiMonitor: boolean;
  clipboard: boolean;
  drives: boolean;
  /** Change the remote resolution when the window is resized. */
  dynamicResolution: boolean;
  audio: 'local' | 'remote' | 'off';
}

/** What a new profile starts with — the usual client defaults, spelled out. */
const SETTING_DEFAULTS = {
  display: '',
  width: '',
  height: '',
  multiMonitor: false,
  clipboard: true,
  drives: false,
  dynamicResolution: false,
  audio: 'local'
} as const;

export function emptyForm(): RemoteDesktopFormFields {
  return {
    id: crypto.randomUUID(),
    name: '',
    protocol: 'rdp',
    hostname: '',
    port: '',
    username: '',
    password: '',
    domain: '',
    viaHost: '',
    ...SETTING_DEFAULTS
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
    domain: c.domain ?? '',
    viaHost: c.viaHost ?? '',
    display: c.display ?? SETTING_DEFAULTS.display,
    width: c.width ? String(c.width) : '',
    height: c.height ? String(c.height) : '',
    multiMonitor: c.multiMonitor ?? SETTING_DEFAULTS.multiMonitor,
    clipboard: c.clipboard ?? SETTING_DEFAULTS.clipboard,
    drives: c.drives ?? SETTING_DEFAULTS.drives,
    dynamicResolution: c.dynamicResolution ?? SETTING_DEFAULTS.dynamicResolution,
    audio: c.audio ?? SETTING_DEFAULTS.audio
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
  const viaHost = f.viaHost.trim();

  let width: number | undefined;
  let height: number | undefined;
  if (f.display === 'window' && (f.width.trim() !== '' || f.height.trim() !== '')) {
    const w = Number(f.width.trim());
    const h = Number(f.height.trim());
    const valid = (n: number): boolean => Number.isInteger(n) && n >= 200 && n <= 8192;
    if (!valid(w) || !valid(h)) {
      return { ok: false, error: 'Window size must be a width and a height between 200 and 8192' };
    }
    width = w;
    height = h;
  }

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
      domain: domain || undefined,
      viaHost: viaHost || undefined,
      display: f.display || undefined,
      width,
      height,
      multiMonitor: f.multiMonitor,
      clipboard: f.clipboard,
      drives: f.drives,
      dynamicResolution: f.dynamicResolution,
      audio: f.audio
    }
  };
}

/** Case-insensitive substring filter over name / hostname.
 *  An empty query keeps everything; order is preserved. */
export function filterConnections(list: RemoteDesktopConnectionDto[], query: string): RemoteDesktopConnectionDto[] {
  const q = query.trim().toLowerCase();
  if (!q) return list;
  return list.filter((c) => c.name.toLowerCase().includes(q) || c.hostname.toLowerCase().includes(q));
}

/** The display & device settings of a profile, or of the form being edited, in a few
 *  words each — for the collapsed settings header and the connection tiles. Anything
 *  left to the client isn't mentioned. */
export function describeSettings(s: {
  display?: string | null;
  width?: string | number | null;
  height?: string | number | null;
  multiMonitor?: boolean | null;
  clipboard?: boolean | null;
  drives?: boolean | null;
  dynamicResolution?: boolean | null;
  audio?: string | null;
}): string[] {
  const out: string[] = [];
  if (s.display === 'fullscreen') out.push('Full screen');
  if (s.display === 'window') out.push(s.width && s.height ? `Window ${s.width}×${s.height}` : 'Window');
  if (s.display === 'fit') out.push('Fit to screen');
  if (s.dynamicResolution) out.push('Resizes');
  if (s.multiMonitor) out.push('All monitors');
  if (s.clipboard) out.push('Clipboard');
  if (s.drives) out.push('Drives');
  if (s.audio === 'remote') out.push('Sound on remote');
  if (s.audio === 'off') out.push('No sound');
  return out.length > 0 ? out : ['Client defaults'];
}
