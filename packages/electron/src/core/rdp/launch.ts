import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

import type { RdpSettings, RemoteDesktopConnection } from '../config/remoteDesktop.js';
import { removeCredential, stageCredential, type StageOutcome } from './windowsCredentials.js';
import { maximizeWhenConnected } from './windowsWindow.js';

/**
 * Launches an RDP connection via the OS's native client, as its own external window —
 * no in-app protocol rendering (see the feature's plan doc for why: no lightweight
 * pure-JS RDP client exists, and bundling Apache Guacamole's `guacd` daemon would be a
 * real per-OS packaging burden disproportionate to what was asked for).
 *
 * The password never goes on a command line: on Windows it is staged in the credential
 * store (`windowsCredentials.ts`), FreeRDP reads it from stdin.
 */

export interface RdpLaunchResult {
  /** What actually happened. `'file'` means a `.rdp` profile was written but nothing
   *  has opened it yet — the caller (`ipc/rdp.ts`) hands it to `shell.openPath`, since
   *  that's an Electron API `core/` doesn't import. */
  opened: 'mstsc' | 'xfreerdp' | 'file';
  filePath?: string;
  /** Windows only: whether the password was staged, or a credential the user saved
   *  themselves for this host was left to be used instead. */
  credential?: StageOutcome;
  /** The started client, for a caller that ties something (an SSH tunnel) to its
   *  lifetime. Absent for `'file'`. */
  child?: ChildProcess;
  /** Windows only: mstsc opened a `.rdp` file, so Windows shows its security prompt,
   *  where drives and clipboard must be ticked to be shared (see `needsRdpFile`). */
  redirectionPrompt?: boolean;
}

/**
 * Whether mstsc has to be given a `.rdp` file rather than just an address.
 *
 * Since Windows' April 2026 update (CVE-2026-26151), every unsigned `.rdp` file opens a
 * security prompt in which drives, clipboard and the like are all switched off until
 * ticked, each time — whatever the file asks for. A connection started with
 * `mstsc /v:` counts as typed in by hand and gets neither the prompt nor the
 * restriction; it uses mstsc's own defaults (clipboard on, drives off, sound here).
 * So the file is only used for what `/v:` can't express: local drives, the clipboard
 * off, sound elsewhere, resizing with the window — and a username to prefill when
 * there's no password to stage with it. Verified against a real Windows, see docker/windows-rdp-target.
 */
export function needsRdpFile(connection: Pick<RemoteDesktopConnection, 'username' | 'password'> & RdpSettings): boolean {
  return (
    Boolean(connection.drives) ||
    connection.clipboard === false ||
    (connection.audio !== undefined && connection.audio !== 'local') ||
    Boolean(connection.dynamicResolution) ||
    Boolean(connection.username && !connection.password)
  );
}

/** `mstsc` arguments for a connection without a `.rdp` file. */
export function mstscArgs(connection: Pick<RemoteDesktopConnection, 'hostname' | 'port'> & RdpSettings): string[] {
  // mstsc splits its own command line: a hostname must not carry further switches.
  if (!/^[A-Za-z0-9.\-:[\]]+$/.test(connection.hostname)) {
    throw new Error(`'${connection.hostname}' is not a valid hostname or IP address`);
  }
  const args = [`/v:${connection.hostname}:${connection.port}`];
  if (connection.display === 'fullscreen') args.push('/f');
  if ((connection.display === 'window' || connection.display === 'fit') && connection.width && connection.height) {
    args.push(`/w:${connection.width}`, `/h:${connection.height}`);
  }
  if (connection.multiMonitor) args.push('/multimon');
  return args;
}

/** Height of a window's title bar at 96 dpi (`SM_CYCAPTION`). A maximised window
 *  pushes its borders off screen, so its client area is the work area less this. */
const CAPTION_PX = 23;

/**
 * The remote resolution for `display: 'fit'` on Windows: exactly what mstsc's window
 * shows when maximised above the taskbar — measured against a real Windows at 100 %.
 * `workArea` is in device-independent pixels, as Electron reports it; mstsc counts
 * physical ones. The title bar is rounded up, so at odd scalings the picture is at
 * worst a pixel short of the window rather than a pixel too big for it (scrollbars).
 */
export function fitToWorkArea(workArea: { width: number; height: number }, scaleFactor: number): { width: number; height: number } {
  return {
    width: Math.floor(workArea.width * scaleFactor),
    height: Math.floor(workArea.height * scaleFactor) - Math.ceil(CAPTION_PX * scaleFactor)
  };
}

/**
 * When a staged credential is taken out again. mstsc reads it when it connects —
 * not when it starts: first Windows shows its own warnings about `.rdp` files, and
 * the user may take a while over those (seen against a real Windows, see
 * docker/windows-rdp-target). So the app watches for mstsc's connection to the
 * server and removes the credential `CREDENTIAL_AFTER_CONNECT_MS` after it shows up;
 * mstsc exiting removes it at once, and it never stays longer than
 * `CREDENTIAL_HOLD_MS` in any case.
 */
export const CREDENTIAL_HOLD_MS = 5 * 60_000;
export const CREDENTIAL_AFTER_CONNECT_MS = 5_000;
const CONNECTION_POLL_MS = 1_000;

/** Whether `netstat -ano -p TCP` output shows process `pid` connected (or
 *  connecting) to remote port `port`. Only the columns are read, never the
 *  state, whose name is localised ("ESTABLISHED", "HERGESTELLT", …). */
export function hasConnection(netstat: string, pid: number, port: number): boolean {
  return netstat.split(/\r?\n/).some((line) => {
    const cols = line.trim().split(/\s+/);
    return cols[0] === 'TCP' && cols.length >= 5 && cols[cols.length - 1] === String(pid) && cols[2].endsWith(`:${port}`);
  });
}

export type ConnectionProbe = (pid: number, port: number) => Promise<boolean>;

const netstatProbe: ConnectionProbe = (pid, port) =>
  new Promise((resolve) => {
    execFile('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true, encoding: 'latin1' }, (err, stdout) =>
      resolve(!err && hasConnection(stdout, pid, port))
    );
  });

let connectionProbe: ConnectionProbe = netstatProbe;

/** Swaps the netstat probe out, for tests. */
export function setConnectionProbe(next: ConnectionProbe | null): void {
  connectionProbe = next ?? netstatProbe;
}

/** Hostnames with a staged credential not yet removed, for `before-quit`. */
export const pendingCredentialHosts = new Set<string>();

/** A value going into a `.rdp` line: a newline would start a line of its own, i.e.
 *  inject another setting (say `alternate shell:s:…`). */
function rdpValue(value: string): string {
  return value.replace(/[\r\n]/g, '');
}

/** The `.rdp` profile. Never includes a password — on Windows it's staged into the
 *  credential store instead (see `launchWindows`); everywhere else there is no safe
 *  place to put it in this file, so a fallback-opened `.rdp` prompts for it. */
export function buildRdpFileContent(
  connection: Pick<RemoteDesktopConnection, 'hostname' | 'port' | 'username' | 'domain'> & RdpSettings & { screen?: ScreenSize }
): string {
  const lines = [`full address:s:${rdpValue(connection.hostname)}:${connection.port}`];
  if (connection.username) {
    const user = connection.domain ? `${connection.domain}\\${connection.username}` : connection.username;
    lines.push(`username:s:${rdpValue(user)}`);
  }
  return [...lines, ...rdpSettingLines(connection, connection.screen)].join('\n') + '\n';
}

const flag = (on: boolean): number => (on ? 1 : 0);

/** A window around a `width`×`height` picture, a little in from the top left:
 *  `winposstr:s:0,<SW_SHOWNORMAL>,left,top,right,bottom`. The frame is Windows 11's at
 *  100 % (8 px each side, 31 px title bar with its top border), scaled. */
function windowPosition(width: number, height: number, scaleFactor: number): string {
  const at = Math.round(80 * scaleFactor);
  const right = at + width + Math.round(16 * scaleFactor);
  const bottom = at + height + Math.round(39 * scaleFactor);
  return `winposstr:s:0,1,${at},${at},${right},${bottom}`;
}

/** The screen mstsc will show on, in physical pixels — known to the caller (Electron's
 *  `screen`), needed for resizing with the window. */
export interface ScreenSize {
  width: number;
  height: number;
  scaleFactor: number;
}

/**
 * The `.rdp` lines for the settings that are set; the rest stay the client's default.
 *
 * Resizing with the window has a catch, found against a real Windows: mstsc never
 * lets its window grow past the resolution the session *started* with. So with a
 * `screen`, a resizing window starts the session at the full screen size, and the
 * window's own starting size goes into `winposstr` instead; mstsc then shrinks the
 * session to the window, grows it back up to the screen, and its maximise button
 * becomes full screen.
 */
export function rdpSettingLines(settings: RdpSettings, screen?: ScreenSize): string[] {
  const lines: string[] = [];
  const resizing = Boolean(settings.dynamicResolution && screen);
  if (settings.display === 'fullscreen') lines.push('screen mode id:i:2');
  if (settings.display === 'window' || settings.display === 'fit') {
    lines.push('screen mode id:i:1');
    if (resizing && screen && settings.display === 'window') {
      lines.push(`desktopwidth:i:${screen.width}`, `desktopheight:i:${screen.height}`);
      if (settings.width && settings.height) lines.push(windowPosition(settings.width, settings.height, screen.scaleFactor));
    } else if (settings.width && settings.height) {
      lines.push(`desktopwidth:i:${settings.width}`, `desktopheight:i:${settings.height}`);
    }
  } else if (resizing && screen && settings.display === undefined) {
    lines.push(`desktopwidth:i:${screen.width}`, `desktopheight:i:${screen.height}`);
  }
  // Follow the window when it's resized, instead of scrollbars.
  if (settings.dynamicResolution !== undefined) lines.push(`dynamic resolution:i:${flag(settings.dynamicResolution)}`);
  if (settings.multiMonitor !== undefined) lines.push(`use multimon:i:${flag(settings.multiMonitor)}`);
  if (settings.clipboard !== undefined) lines.push(`redirectclipboard:i:${flag(settings.clipboard)}`);
  if (settings.drives !== undefined) lines.push(`drivestoredirect:s:${settings.drives ? '*' : ''}`);
  if (settings.audio !== undefined) lines.push(`audiomode:i:${{ local: 0, remote: 1, off: 2 }[settings.audio]}`);
  return lines;
}

/** FreeRDP's clients to look for, best first. FreeRDP 3 packages add a `3` to the
 *  name. On macOS the SDL client comes first: it runs natively, where the X11 one
 *  needs XQuartz. Every one takes the same arguments. */
export function freerdpCommands(platform: NodeJS.Platform): string[] {
  const x11 = ['xfreerdp3', 'xfreerdp'];
  const sdl = ['sdl-freerdp3', 'sdl-freerdp'];
  return platform === 'darwin' ? [...sdl, ...x11] : [...x11, ...sdl];
}

/** Where to look for them: `PATH`, plus — on macOS — where Homebrew and MacPorts
 *  install, since an app started from the Finder or Dock gets a `PATH` without
 *  them and would never find a FreeRDP installed the usual way. */
export function freerdpSearchPath(platform: NodeJS.Platform, path: string | undefined, separator = delimiter): string[] {
  const dirs = (path ?? '').split(separator).filter(Boolean);
  if (platform === 'darwin') {
    for (const dir of ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin']) {
      if (!dirs.includes(dir)) dirs.push(dir);
    }
  }
  return dirs;
}

/** Pure OS-branch selection, factored out of `launchRdp` so it's testable without
 *  mocking `child_process` or the real `process.platform`. */
export function selectRdpStrategy(platform: NodeJS.Platform, xfreerdpAvailable: boolean): 'mstsc' | 'xfreerdp' | 'file' {
  if (platform === 'win32') return 'mstsc';
  return xfreerdpAvailable ? 'xfreerdp' : 'file';
}

/** Whether FreeRDP gets the password on stdin: only with a username too — without
 *  one it would ask for that first, and the user types both anyway. */
export function passesPasswordOnStdin(connection: RemoteDesktopConnection): boolean {
  return Boolean(connection.username && connection.password);
}

/** The FreeRDP arguments for `connection`. The password is not among them: with
 *  `/from-stdin:force` FreeRDP asks for what's missing on stdin before connecting,
 *  and `freerdpStdin` answers. */
export function buildFreerdpArgs(connection: RemoteDesktopConnection): string[] {
  const args = [`/v:${connection.hostname}:${connection.port}`];
  if (connection.username) args.push(`/u:${connection.username}`);
  if (connection.domain) args.push(`/d:${connection.domain}`);
  if (passesPasswordOnStdin(connection)) args.push('/from-stdin:force');
  return [...args, ...freerdpSettingArgs(connection)];
}

/** FreeRDP's spelling of the same settings as `rdpSettingLines`. */
export function freerdpSettingArgs(settings: RdpSettings): string[] {
  const args: string[] = [];
  if (settings.display === 'fullscreen') args.push('/f');
  if (settings.display === 'window' && settings.width && settings.height) {
    args.push(`/size:${settings.width}x${settings.height}`);
  }
  // FreeRDP knows the screen's work area itself.
  if (settings.display === 'fit') args.push('/workarea');
  if (settings.dynamicResolution) args.push('/dynamic-resolution');
  if (settings.multiMonitor) args.push('/multimon');
  if (settings.clipboard !== undefined) args.push(settings.clipboard ? '+clipboard' : '-clipboard');
  if (settings.drives) args.push('/drives');
  if (settings.audio === 'local') args.push('/sound');
  if (settings.audio === 'remote') args.push('/audio-mode:1');
  if (settings.audio === 'off') args.push('/audio-mode:2');
  return args;
}

/** What to type into FreeRDP's prompt. With the username (and domain, if any) on
 *  the command line, the password is all FreeRDP 2 and 3 ask for — checked against a
 *  real Windows, see docker/windows-rdp-target. */
export function freerdpStdin(connection: RemoteDesktopConnection): string {
  return `${connection.password ?? ''}\n`;
}

async function findIn(dirs: string[], cmd: string): Promise<string | undefined> {
  for (const dir of dirs) {
    const candidate = join(dir, cmd);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not in this directory
    }
  }
  return undefined;
}

function safeFileName(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, '_').trim() || 'connection';
}

async function writeRdpFile(connection: LaunchTarget): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'better-ssh-client-rdp-'));
  const path = join(dir, `${safeFileName(connection.name)}.rdp`);
  await writeFile(path, buildRdpFileContent(connection), 'utf-8');
  return path;
}

/** Resolves once `child` is running, rejects if it couldn't be started (not
 *  installed, not executable) — so that surfaces as an error, not as nothing. */
function started(child: ChildProcess, what: string): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', (err: NodeJS.ErrnoException) =>
      reject(new Error(err.code === 'ENOENT' ? `${what} was not found` : `Could not start ${what}: ${err.message}`))
    );
  });
}

async function launchWindows(connection: LaunchTarget): Promise<RdpLaunchResult> {
  const { hostname } = connection;
  let credential: StageOutcome | undefined;
  if (connection.username && connection.password) {
    const user = connection.domain ? `${connection.domain}\\${connection.username}` : connection.username;
    try {
      credential = await stageCredential(hostname, user, connection.password);
    } catch (err) {
      throw new Error(`Could not hand the password to Remote Desktop: ${(err as Error).message}`);
    }
    if (credential === 'staged') pendingCredentialHosts.add(hostname);
  }

  // Whichever comes first — mstsc having connected, mstsc exiting, or the hold
  // running out — drops the credential.
  let dropped = credential !== 'staged';
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  const dropCredential = (): void => {
    if (dropped) return;
    dropped = true;
    clearTimeout(holdTimer);
    clearTimeout(pollTimer);
    void removeCredential(hostname)
      .then(() => pendingCredentialHosts.delete(hostname))
      .catch(() => {});
  };
  const holdTimer = setTimeout(dropCredential, CREDENTIAL_HOLD_MS);
  holdTimer.unref?.();

  const watchForConnection = (pid: number): void => {
    const poll = async (): Promise<void> => {
      if (dropped) return;
      if (await connectionProbe(pid, connection.port)) {
        pollTimer = setTimeout(dropCredential, CREDENTIAL_AFTER_CONNECT_MS);
      } else if (!dropped) {
        pollTimer = setTimeout(() => void poll(), CONNECTION_POLL_MS);
      }
      pollTimer?.unref?.();
    };
    void poll();
  };

  let filePath: string | undefined;
  try {
    const viaFile = needsRdpFile(connection);
    if (viaFile) filePath = await writeRdpFile(connection);
    // Never `windowsHide`: Windows hands that on as SW_HIDE to mstsc's first window,
    // and without a screen mode in the profile mstsc keeps it — a session that runs,
    // connected, with no window anywhere.
    const child = spawn('mstsc.exe', filePath ? [filePath] : mstscArgs(connection), { detached: true, stdio: 'ignore' });
    await started(child, 'Remote Desktop (mstsc.exe)');
    child.unref();
    const file = filePath;
    child.once('exit', () => {
      dropCredential();
      if (file) void rm(dirname(file), { recursive: true, force: true }).catch(() => {});
    });
    if (!dropped && child.pid !== undefined) watchForConnection(child.pid);
    // mstsc opens its window at the size it last had; 'fit' means filling the screen.
    if (connection.display === 'fit' && child.pid !== undefined) void maximizeWhenConnected(child.pid).catch(() => {});
    return { opened: 'mstsc', filePath, credential, child, redirectionPrompt: viaFile };
  } catch (err) {
    dropCredential();
    if (filePath) void rm(dirname(filePath), { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

async function launchUnix(connection: RemoteDesktopConnection): Promise<RdpLaunchResult> {
  const dirs = freerdpSearchPath(process.platform, process.env.PATH);
  let freerdp: string | undefined;
  for (const cmd of freerdpCommands(process.platform)) {
    freerdp = await findIn(dirs, cmd);
    if (freerdp) break;
  }
  const strategy = selectRdpStrategy(process.platform, freerdp !== undefined);
  if (strategy === 'xfreerdp' && freerdp) {
    const child = spawn(freerdp, buildFreerdpArgs(connection), {
      detached: true,
      stdio: [passesPasswordOnStdin(connection) ? 'pipe' : 'ignore', 'ignore', 'ignore']
    });
    await started(child, 'FreeRDP');
    if (passesPasswordOnStdin(connection)) {
      child.stdin?.on('error', () => {}); // exited before reading: nothing to do
      child.stdin?.end(freerdpStdin(connection));
    }
    child.unref();
    return { opened: 'xfreerdp', child };
  }
  const filePath = await writeRdpFile(connection);
  return { opened: 'file', filePath };
}

/** A connection as launched: plus the screen, where the caller knows it (Windows). */
export type LaunchTarget = RemoteDesktopConnection & { screen?: ScreenSize };

export async function launchRdp(connection: LaunchTarget): Promise<RdpLaunchResult> {
  if (process.platform === 'win32') return launchWindows(connection);
  return launchUnix(connection);
}
