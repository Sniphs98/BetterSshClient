import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { RemoteDesktopConnection } from '../config/remoteDesktop.js';

const execFileAsync = promisify(execFile);

/**
 * Launches an RDP connection via the OS's native client, as its own external window —
 * no in-app protocol rendering (see the feature's plan doc for why: no lightweight
 * pure-JS RDP client exists, and bundling Apache Guacamole's `guacd` daemon would be a
 * real per-OS packaging burden disproportionate to what was asked for).
 *
 * Uses the same `execFileAsync`/`windowsHide` conventions as `core/ssh/keySetup.ts`.
 */

export interface RdpLaunchResult {
  /** What actually happened. `'file'` means a `.rdp` profile was written but nothing
   *  has opened it yet — the caller (`ipc/rdp.ts`) hands it to `shell.openPath`, since
   *  that's an Electron API `core/` doesn't import. */
  opened: 'mstsc' | 'xfreerdp' | 'file';
  filePath?: string;
}

/** Builds a minimal `.rdp` profile's contents. Never includes a password — on Windows
 *  it's staged into the credential store via `cmdkey` instead (see `launchWindows`);
 *  everywhere else there is no safe place to put it in this file, so a fallback-opened
 *  `.rdp` simply prompts for it. */
export function buildRdpFileContent(
  connection: Pick<RemoteDesktopConnection, 'hostname' | 'port' | 'username' | 'domain'>
): string {
  const lines = [`full address:s:${connection.hostname}:${connection.port}`];
  if (connection.username) {
    const user = connection.domain ? `${connection.domain}\\${connection.username}` : connection.username;
    lines.push(`username:s:${user}`);
  }
  return lines.join('\n') + '\n';
}

/** Pure OS-branch selection, factored out of `launchRdp` so it's testable without
 *  mocking `child_process` or the real `process.platform`. */
export function selectRdpStrategy(platform: NodeJS.Platform, xfreerdpAvailable: boolean): 'mstsc' | 'xfreerdp' | 'file' {
  if (platform === 'win32') return 'mstsc';
  return xfreerdpAvailable ? 'xfreerdp' : 'file';
}

async function commandExists(cmd: string): Promise<boolean> {
  try {
    await execFileAsync(cmd, ['--version'], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
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

async function launchWindows(connection: RemoteDesktopConnection): Promise<RdpLaunchResult> {
  const target = `TERMSRV/${connection.hostname}`;
  if (connection.username && connection.password) {
    const user = connection.domain ? `${connection.domain}\\${connection.username}` : connection.username;
    // Best-effort: a failed `cmdkey` still lets `mstsc` open and prompt for the
    // password manually rather than blocking the connection entirely.
    await execFileAsync('cmdkey', [`/generic:${target}`, `/user:${user}`, `/pass:${connection.password}`], {
      windowsHide: true
    }).catch(() => {});
  }
  const filePath = await writeRdpFile(connection);
  const child = spawn('mstsc.exe', [filePath], { detached: true, windowsHide: true });
  child.unref();
  child.once('exit', () => {
    void execFileAsync('cmdkey', [`/delete:${target}`], { windowsHide: true }).catch(() => {});
    void rm(filePath, { force: true }).catch(() => {});
  });
  return { opened: 'mstsc', filePath };
}

async function launchUnix(connection: RemoteDesktopConnection): Promise<RdpLaunchResult> {
  const strategy = selectRdpStrategy(process.platform, await commandExists('xfreerdp'));
  if (strategy === 'xfreerdp') {
    const args = [`/v:${connection.hostname}:${connection.port}`];
    if (connection.username) args.push(`/u:${connection.username}`);
    if (connection.domain) args.push(`/d:${connection.domain}`);
    // Known limitation, not silently accepted: visible in this process's argv via
    // `ps` on this machine. FreeRDP's `/from-stdin` is a documented future refinement.
    if (connection.password) args.push(`/p:${connection.password}`);
    const child = spawn('xfreerdp', args, { detached: true });
    child.unref();
    return { opened: 'xfreerdp' };
  }
  const filePath = await writeRdpFile(connection);
  return { opened: 'file', filePath };
}

export async function launchRdp(connection: RemoteDesktopConnection): Promise<RdpLaunchResult> {
  if (process.platform === 'win32') return launchWindows(connection);
  return launchUnix(connection);
}
