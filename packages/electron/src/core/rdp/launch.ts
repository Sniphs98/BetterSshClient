import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import type { RemoteDesktopConnection } from '../config/remoteDesktop.js';
import { removeCredential, stageCredential, type StageOutcome } from './windowsCredentials.js';

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
}

/** How long a staged credential stays in the store when `mstsc` keeps running. It
 *  reads it when it connects, which is within a few seconds of starting — this only
 *  leaves room for a slow machine. Exit removes it sooner. */
export const CREDENTIAL_HOLD_MS = 30_000;

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
  connection: Pick<RemoteDesktopConnection, 'hostname' | 'port' | 'username' | 'domain'>
): string {
  const lines = [`full address:s:${rdpValue(connection.hostname)}:${connection.port}`];
  if (connection.username) {
    const user = connection.domain ? `${connection.domain}\\${connection.username}` : connection.username;
    lines.push(`username:s:${rdpValue(user)}`);
  }
  return lines.join('\n') + '\n';
}

/** FreeRDP's X11 client, newest first: FreeRDP 3 packages install it as `xfreerdp3`. */
export const FREERDP_COMMANDS = ['xfreerdp3', 'xfreerdp'] as const;

/** Pure OS-branch selection, factored out of `launchRdp` so it's testable without
 *  mocking `child_process` or the real `process.platform`. */
export function selectRdpStrategy(platform: NodeJS.Platform, xfreerdpAvailable: boolean): 'mstsc' | 'xfreerdp' | 'file' {
  if (platform === 'win32') return 'mstsc';
  return xfreerdpAvailable ? 'xfreerdp' : 'file';
}

/** The FreeRDP arguments for `connection`. The password is not among them: with
 *  `/from-stdin:force` FreeRDP asks for what's missing on stdin before connecting,
 *  and `freerdpStdin` answers. */
export function buildFreerdpArgs(connection: RemoteDesktopConnection): string[] {
  const args = [`/v:${connection.hostname}:${connection.port}`];
  if (connection.username) args.push(`/u:${connection.username}`);
  if (connection.domain) args.push(`/d:${connection.domain}`);
  if (connection.password) args.push('/from-stdin:force');
  return args;
}

/** What to type into FreeRDP's prompts: it asks for the domain when none was given
 *  (answered blank), then the password. */
export function freerdpStdin(connection: RemoteDesktopConnection): string {
  return (connection.domain ? '' : '\n') + `${connection.password ?? ''}\n`;
}

async function findOnPath(cmd: string): Promise<string | undefined> {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
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

async function writeRdpFile(connection: RemoteDesktopConnection): Promise<string> {
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

async function launchWindows(connection: RemoteDesktopConnection): Promise<RdpLaunchResult> {
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

  // Whichever comes first — mstsc exiting or the hold running out — drops the credential.
  let dropped = credential !== 'staged';
  const dropCredential = (): void => {
    if (dropped) return;
    dropped = true;
    clearTimeout(holdTimer);
    void removeCredential(hostname)
      .then(() => pendingCredentialHosts.delete(hostname))
      .catch(() => {});
  };
  const holdTimer = setTimeout(dropCredential, CREDENTIAL_HOLD_MS);
  holdTimer.unref?.();

  let filePath: string | undefined;
  try {
    filePath = await writeRdpFile(connection);
    const child = spawn('mstsc.exe', [filePath], { detached: true, windowsHide: true, stdio: 'ignore' });
    await started(child, 'Remote Desktop (mstsc.exe)');
    child.unref();
    const file = filePath;
    child.once('exit', () => {
      dropCredential();
      void rm(file, { force: true }).catch(() => {});
    });
    return { opened: 'mstsc', filePath, credential, child };
  } catch (err) {
    dropCredential();
    if (filePath) void rm(filePath, { force: true }).catch(() => {});
    throw err;
  }
}

async function launchUnix(connection: RemoteDesktopConnection): Promise<RdpLaunchResult> {
  let freerdp: string | undefined;
  for (const cmd of FREERDP_COMMANDS) {
    freerdp = await findOnPath(cmd);
    if (freerdp) break;
  }
  const strategy = selectRdpStrategy(process.platform, freerdp !== undefined);
  if (strategy === 'xfreerdp' && freerdp) {
    const child = spawn(freerdp, buildFreerdpArgs(connection), {
      detached: true,
      stdio: [connection.password ? 'pipe' : 'ignore', 'ignore', 'ignore']
    });
    await started(child, 'FreeRDP');
    if (connection.password) {
      child.stdin?.on('error', () => {}); // exited before reading: nothing to do
      child.stdin?.end(freerdpStdin(connection));
    }
    child.unref();
    return { opened: 'xfreerdp', child };
  }
  const filePath = await writeRdpFile(connection);
  return { opened: 'file', filePath };
}

export async function launchRdp(connection: RemoteDesktopConnection): Promise<RdpLaunchResult> {
  if (process.platform === 'win32') return launchWindows(connection);
  return launchUnix(connection);
}
