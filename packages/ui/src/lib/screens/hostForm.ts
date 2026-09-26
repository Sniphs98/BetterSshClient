// Pure host form + validation logic (tech-gui.md §4.1, Stage 4.1), kept free of
// Svelte components so it is unit-testable; `HostEditor.svelte` renders it. The
// validation mirrors the TUI's `HostForm::to_host` (crates/omnyssh/src/app/host.rs)
// so both frontends produce the same `hosts.toml` shape and error messages.

import type { HostDto, HostInputDto, MonitorModeDto } from '$lib/bindings';
import { isOnePasswordReference, normalizeReference, ONE_PASSWORD_REFERENCE_ERROR } from './onePasswordRef';

/** The editable form fields — all raw text (tags are comma-separated, port a string). */
export interface HostFormFields {
  name: string;
  hostname: string;
  user: string;
  port: string;
  identityFile: string;
  password: string;
  tags: string;
  notes: string;
  /** The dashboard folder the card sits in; blank means none. */
  folder: string;
  monitoring: MonitorModeDto;
  /** Probe port; blank means "the host's SSH port". Only read for `tcpPort`. */
  monitorPort: string;
  /** Remote directory to land in on connect. Blank means the login default / `/`. */
  defaultPath: string;
  /** Command typed into every new terminal on the host. Blank means none. */
  startupCommand: string;
  /** 1Password reference the password is read from at connect time. Blank means none. */
  passwordRef: string;
  /** 1Password reference the port is read from at connect time. */
  portRef: string;
  /** Per field: read from 1Password when connecting. Hostname and user then hold the
   *  reference themselves; the port's goes in `portRef` (a number on disk) and the
   *  password's in `passwordRef` (the stored password never comes back to the form,
   *  so the two can't share a field). */
  hostnameFrom1P: boolean;
  userFrom1P: boolean;
  portFrom1P: boolean;
  /** The default path from 1Password — the reference in the field itself. */
  defaultPathFrom1P: boolean;
  passwordFrom1P: boolean;
}

export function emptyForm(): HostFormFields {
  // Port pre-seeded to the SSH default; user blank (placeholder shows `root`, the
  // default the validation applies when it is left empty).
  return {
    name: '',
    hostname: '',
    user: '',
    port: '22',
    identityFile: '',
    password: '',
    tags: '',
    notes: '',
    folder: '',
    monitoring: 'ssh',
    monitorPort: '',
    defaultPath: '',
    startupCommand: '',
    passwordRef: '',
    portRef: '',
    hostnameFrom1P: false,
    userFrom1P: false,
    portFrom1P: false,
    defaultPathFrom1P: false,
    passwordFrom1P: false
  };
}

/** Seed the edit form from a `HostDto`. `identityFile`/`password` are intentionally
 *  blank: the DTO omits both (§3.4), so on edit they stay empty and mean "keep the
 *  stored value" — `save_host` preserves them unless the user types a new one. */
export function formFromHost(h: HostDto): HostFormFields {
  return {
    name: h.name,
    hostname: h.hostname,
    user: h.user,
    port: String(h.port),
    identityFile: '',
    password: '',
    tags: h.tags.join(', '),
    notes: h.notes ?? '',
    folder: h.folder ?? '',
    monitoring: h.monitoring,
    monitorPort: h.monitorPort == null ? '' : String(h.monitorPort),
    defaultPath: h.defaultPath ?? '',
    startupCommand: h.startupCommand ?? '',
    passwordRef: h.passwordRef ?? '',
    hostnameFrom1P: isOnePasswordReference(h.hostname),
    userFrom1P: isOnePasswordReference(h.user),
    portRef: h.portRef ?? '',
    portFrom1P: Boolean(h.portRef),
    defaultPathFrom1P: isOnePasswordReference(h.defaultPath ?? ''),
    passwordFrom1P: Boolean(h.passwordRef)
  };
}

function splitCsv(raw: string): string[] {
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

/** A text field as it is saved: trimmed, or as a cleaned-up reference when switched to 1Password. */
function fieldValue(value: string, from1P: boolean): string {
  return from1P ? normalizeReference(value) : value.trim();
}

function referenceError(field: string): string {
  return `${field}: ${ONE_PASSWORD_REFERENCE_ERROR}`;
}

export type HostFormResult = { ok: true; input: HostInputDto } | { ok: false; error: string };

/** Validate + build a `HostInputDto`, or return an error message. Mirrors the TUI's
 *  `to_host`: name and hostname are required; user defaults to `root` and port to `22`
 *  when blank; port must be a 1–65535 integer; identity/password/notes are trimmed and
 *  dropped to `undefined` when empty (so the wire form stays sparse, §4.1). `proxyJump`
 *  is not surfaced by the form (parity with the TUI, which sets it `None`) — `save_host`
 *  preserves any existing value across an edit. */
export function formToInput(f: HostFormFields): HostFormResult {
  const name = f.name.trim();
  if (!name) return { ok: false, error: 'Name cannot be empty' };
  const hostname = fieldValue(f.hostname, f.hostnameFrom1P);
  if (!hostname) return { ok: false, error: 'Hostname / IP cannot be empty' };
  if (f.hostnameFrom1P && !isOnePasswordReference(hostname)) return { ok: false, error: referenceError('Hostname / IP') };
  if (f.userFrom1P && !isOnePasswordReference(f.user)) return { ok: false, error: referenceError('User') };
  const user = fieldValue(f.user, f.userFrom1P) || 'root';

  // From 1Password the port stays the default on disk and is read when connecting.
  const portRef = f.portFrom1P ? normalizeReference(f.portRef) : '';
  if (f.portFrom1P && !isOnePasswordReference(portRef)) return { ok: false, error: referenceError('Port') };
  const portRaw = f.portFrom1P ? '' : f.port.trim();
  let port = 22;
  if (portRaw !== '') {
    // Digits with an optional leading `+`, matching Rust's `u16::parse` (which accepts
    // `+22` but no `-`/decimal/hex/exponent); the range guard covers 0 and overflow.
    if (!/^\+?\d+$/.test(portRaw) || Number(portRaw) < 1 || Number(portRaw) > 65535) {
      return { ok: false, error: `Port must be a number between 1 and 65535, got '${portRaw}'` };
    }
    port = Number(portRaw);
  }

  // Only meaningful for a reachability host; an SSH host never carries a probe port.
  let monitorPort: number | undefined;
  const monitorPortRaw = f.monitorPort.trim();
  if (f.monitoring === 'tcpPort' && monitorPortRaw !== '') {
    if (!/^\+?\d+$/.test(monitorPortRaw) || Number(monitorPortRaw) < 1 || Number(monitorPortRaw) > 65535) {
      return {
        ok: false,
        error: `Probe port must be a number between 1 and 65535, got '${monitorPortRaw}'`
      };
    }
    monitorPort = Number(monitorPortRaw);
  }

  const identityFile = f.identityFile.trim();
  const password = f.password.trim();
  const notes = f.notes.trim();
  const tags = splitCsv(f.tags);
  const defaultPath = fieldValue(f.defaultPath, f.defaultPathFrom1P);
  if (f.defaultPathFrom1P && !isOnePasswordReference(defaultPath)) return { ok: false, error: referenceError('Default path') };
  const startupCommand = f.startupCommand.trim();
  // Switched back to typing, the password's reference is dropped.
  const passwordRef = f.passwordFrom1P ? normalizeReference(f.passwordRef) : '';
  if (f.passwordFrom1P && !isOnePasswordReference(passwordRef)) return { ok: false, error: referenceError('Password') };
  return {
    ok: true,
    input: {
      name,
      hostname,
      user,
      port,
      identityFile: identityFile || undefined,
      password: password || undefined,
      tags,
      notes: notes || undefined,
      folder: f.folder.trim() || undefined,
      monitoring: f.monitoring,
      monitorPort,
      defaultPath: defaultPath || undefined,
      startupCommand: startupCommand || undefined,
      passwordRef: passwordRef || undefined,
      portRef: portRef || undefined
    }
  };
}
