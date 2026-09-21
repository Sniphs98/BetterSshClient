// Thin typed wrappers over the generated command bindings (tech-gui.md §3.5).
// Components call these, never `invoke` directly.

import { commands, type Channel } from '$lib/bindings';
import type {
  SnippetDto,
  FileEntryDto,
  AutomationDto,
  HostDto,
  HostInputDto,
  ImportResultDto,
  RemoteDesktopConnectionDto,
  RemoteDesktopConnectionInputDto,
  TerminalBytes,
  UpdateConfigDto,
  UpdateInfoDto
} from '$lib/bindings';

export async function listHosts(): Promise<HostDto[]> {
  const res = await commands.listHosts();
  if (res.status === 'error') throw new Error(res.error.message);
  return res.data;
}

/** Reload hosts from disk and (re)start the pollers; broadcasts `hosts-loaded`. */
export async function reloadHosts(): Promise<void> {
  const res = await commands.reloadHosts();
  if (res.status === 'error') throw new Error(res.error.message);
}

/** Add or edit a manual host in `hosts.toml`. Call `reloadHosts` after to refresh. */
export async function saveHost(input: HostInputDto): Promise<void> {
  const res = await commands.saveHost(input);
  if (res.status === 'error') throw new Error(res.error.message);
}

/** Delete a manual host by name. A missing / SSH-config name is a no-op success. */
export async function deleteHost(name: string): Promise<void> {
  const res = await commands.deleteHost(name);
  if (res.status === 'error') throw new Error(res.error.message);
}

/** Open a terminal for `hostName`, streaming raw output into `onOutput`; returns the
 *  public session id used by the write/resize/close wrappers (tech-gui.md §3.3/§4.2). */
export async function terminalOpen(
  hostName: string,
  cols: number,
  rows: number,
  onOutput: Channel<TerminalBytes>
): Promise<number> {
  const res = await commands.terminalOpen(hostName, cols, rows, onOutput);
  if (res.status === 'error') throw new Error(res.error.message);
  return res.data;
}

/** Send keystrokes (UTF-8 bytes) to a terminal. */
export async function terminalWrite(sessionId: number, data: number[]): Promise<void> {
  const res = await commands.terminalWrite(sessionId, data);
  if (res.status === 'error') throw new Error(res.error.message);
}

/** Reflow a terminal to `cols` x `rows`. */
export async function terminalResize(sessionId: number, cols: number, rows: number): Promise<void> {
  const res = await commands.terminalResize(sessionId, cols, rows);
  if (res.status === 'error') throw new Error(res.error.message);
}

/** Close a terminal and its connection. Idempotent for an already-closed id. */
export async function terminalClose(sessionId: number): Promise<void> {
  const res = await commands.terminalClose(sessionId);
  if (res.status === 'error') throw new Error(res.error.message);
}

/** Open an SFTP session for `hostName`; returns the public session id the sftp_*
 *  wrappers use, and the tab's `sftp-*` events carry (tech-gui.md §3.4/§4.2). */
export async function sftpOpen(hostName: string): Promise<number> {
  const res = await commands.sftpOpen(hostName);
  if (res.status === 'error') throw new Error(res.error.message);
  return res.data;
}

/** List a remote directory; the result arrives as `sftp-dir-listed`. */
export async function sftpList(sessionId: number, path: string): Promise<void> {
  const res = await commands.sftpList(sessionId, path);
  if (res.status === 'error') throw new Error(res.error.message);
}

/** Upload a local file to a remote path; progress arrives as `transfer-progress`. */
export async function sftpUpload(sessionId: number, local: string, remote: string): Promise<void> {
  const res = await commands.sftpUpload(sessionId, local, remote);
  if (res.status === 'error') throw new Error(res.error.message);
}

/** Download a remote file to a local path; progress arrives as `transfer-progress`. */
export async function sftpDownload(
  sessionId: number,
  local: string,
  remote: string
): Promise<void> {
  const res = await commands.sftpDownload(sessionId, local, remote);
  if (res.status === 'error') throw new Error(res.error.message);
}

/** Create a remote directory; completion arrives as `sftp-op-done`. */
export async function sftpMkdir(sessionId: number, path: string): Promise<void> {
  const res = await commands.sftpMkdir(sessionId, path);
  if (res.status === 'error') throw new Error(res.error.message);
}

/** Rename / move a remote path; completion arrives as `sftp-op-done`. */
export async function sftpRename(sessionId: number, from: string, to: string): Promise<void> {
  const res = await commands.sftpRename(sessionId, from, to);
  if (res.status === 'error') throw new Error(res.error.message);
}

/** Delete a remote file (or empty directory); completion arrives as `sftp-op-done`. */
export async function sftpDelete(sessionId: number, path: string): Promise<void> {
  const res = await commands.sftpDelete(sessionId, path);
  if (res.status === 'error') throw new Error(res.error.message);
}

/** Request a remote file preview; the bytes arrive as `file-preview`. */
export async function sftpPreview(sessionId: number, path: string): Promise<void> {
  const res = await commands.sftpPreview(sessionId, path);
  if (res.status === 'error') throw new Error(res.error.message);
}

/** Read a remote file's full content for the editor (unlike `sftpPreview`, not
 *  truncated) — returns directly rather than riding an event. */
export async function sftpReadFile(sessionId: number, path: string): Promise<string> {
  const res = await commands.sftpReadFile(sessionId, path);
  if (res.status === 'error') throw new Error(res.error.message);
  return res.data;
}

/** Overwrite a remote file's full content from the editor. */
export async function sftpWriteFile(sessionId: number, path: string, content: string): Promise<void> {
  const res = await commands.sftpWriteFile(sessionId, path, content);
  if (res.status === 'error') throw new Error(res.error.message);
}

/** Close an SFTP session and its connection. Idempotent for an already-closed id. */
export async function sftpClose(sessionId: number): Promise<void> {
  const res = await commands.sftpClose(sessionId);
  if (res.status === 'error') throw new Error(res.error.message);
}

/** List a local directory (returns directly — no event). */
export async function listLocalDir(path: string): Promise<FileEntryDto[]> {
  const res = await commands.listLocalDir(path);
  if (res.status === 'error') throw new Error(res.error.message);
  return res.data;
}

/** Read up to 4 KiB of a local file as UTF-8 for preview. */
export async function previewLocalFile(path: string): Promise<string> {
  const res = await commands.previewLocalFile(path);
  if (res.status === 'error') throw new Error(res.error.message);
  return res.data;
}

/** Read a local file's full content for the editor (unlike `previewLocalFile`, not
 *  truncated). */
export async function readLocalFile(path: string): Promise<string> {
  const res = await commands.readLocalFile(path);
  if (res.status === 'error') throw new Error(res.error.message);
  return res.data;
}

/** Overwrite a local file's full content from the editor. */
export async function writeLocalFile(path: string, content: string): Promise<void> {
  const res = await commands.writeLocalFile(path, content);
  if (res.status === 'error') throw new Error(res.error.message);
}

/** Start auto SSH-key setup for a host; progress + the outcome arrive as `key-setup-*`
 *  events (tech-gui.md §4.2). `disablePasswordAuth` is the user's choice, made in the
 *  confirm dialog before this fires — false stops the automation right after key auth is
 *  verified and never touches sshd_config. Fire-and-forget — only an unknown host
 *  rejects here. */
export async function startKeySetup(hostName: string, disablePasswordAuth: boolean): Promise<void> {
  const res = await commands.startKeySetup(hostName, disablePasswordAuth);
  if (res.status === 'error') throw new Error(res.error.message);
}

/** Force an immediate metric poll of every host (tech-gui.md §4.2). */
export async function refreshMetrics(): Promise<void> {
  const res = await commands.refreshMetrics();
  if (res.status === 'error') throw new Error(res.error.message);
}

/** Check GitHub for a newer release; `null` means up to date (tech-gui.md §4.2). */
export async function checkUpdate(): Promise<UpdateInfoDto | null> {
  const res = await commands.checkUpdate();
  if (res.status === 'error') throw new Error(res.error.message);
  return res.data;
}

/** Download and install the latest desktop bundle (tech-gui.md §4.3). Fully wired once
 *  Stage 5 configures the updater endpoints; until then it reports "not available yet". */
export async function installUpdate(): Promise<void> {
  const res = await commands.installUpdate();
  if (res.status === 'error') throw new Error(res.error.message);
}

/** Read the update-checker preferences from the shared config (tech-gui.md §4.3). */
export async function loadUpdateConfig(): Promise<UpdateConfigDto> {
  const res = await commands.loadUpdateConfig();
  if (res.status === 'error') throw new Error(res.error.message);
  return res.data;
}

/** Persist the update-checker preferences to the shared config (tech-gui.md §4.3). */
export async function saveUpdateConfig(config: UpdateConfigDto): Promise<void> {
  const res = await commands.saveUpdateConfig(config);
  if (res.status === 'error') throw new Error(res.error.message);
}

/** Read the reusable Snippet library. */
export async function listSnippets(): Promise<SnippetDto[]> {
  const res = await commands.listSnippets();
  if (res.status === 'error') throw new Error(res.error.message);
  return res.data;
}

/** Upsert one Snippet by id and persist the whole library. */
export async function saveSnippet(snippet: SnippetDto): Promise<void> {
  const res = await commands.saveSnippet(snippet);
  if (res.status === 'error') throw new Error(res.error.message);
}

/** Delete the snippet named `id`. Rejects if any Automation still references it. */
export async function deleteSnippet(id: string): Promise<void> {
  const res = await commands.deleteSnippet(id);
  if (res.status === 'error') throw new Error(res.error.message);
}

/** Read the saved Automations. */
export async function listAutomations(): Promise<AutomationDto[]> {
  const res = await commands.listAutomations();
  if (res.status === 'error') throw new Error(res.error.message);
  return res.data;
}

/** Upsert one Automation by name and persist. Rejects with the validation problem(s) if the
 *  graph is structurally invalid (unknown snippet, a cycle, a template reference
 *  that isn't a direct dependency, …). */
export async function saveAutomation(automation: AutomationDto): Promise<void> {
  const res = await commands.saveAutomation(automation);
  if (res.status === 'error') throw new Error(res.error.message);
}

/** Delete the automation named `name`. */
export async function deleteAutomation(name: string): Promise<void> {
  const res = await commands.deleteAutomation(name);
  if (res.status === 'error') throw new Error(res.error.message);
}

/** Run an Automation; progress and the outcome arrive as `automation-*` events.
 *  `paramValues` is whatever the "run this automation" prompt collected — a value for every
 *  `AutomationParam` the automation declares, keyed by name (empty object for an automation with none).
 *  Fire-and-forget — only an unknown/already-running automation rejects here; a missing
 *  param value surfaces as `automation-failed`, not a rejection. */
export async function runAutomation(name: string, paramValues: Record<string, string>): Promise<void> {
  const res = await commands.runAutomation(name, paramValues);
  if (res.status === 'error') throw new Error(res.error.message);
}

/** Prompts a native save dialog and writes the snippet to a portable JSON file, for
 *  sharing it with someone else or another machine. Resolves the chosen path, or `null`
 *  if the dialog was canceled. */
export async function exportSnippet(id: string): Promise<string | null> {
  const res = await commands.exportSnippet(id);
  if (res.status === 'error') throw new Error(res.error.message);
  return res.data;
}

/** Same as `exportSnippet`, but for an Automation — the file also bundles every Snippet
 *  the automation's nodes reference, so it's self-contained on a machine that's never seen
 *  them. */
export async function exportAutomation(name: string): Promise<string | null> {
  const res = await commands.exportAutomation(name);
  if (res.status === 'error') throw new Error(res.error.message);
  return res.data;
}

/** Prompts a native open dialog for an exported `.json` file and merges it into the
 *  local library (a fresh id for every imported Snippet; an imported Automation is renamed
 *  on a name collision rather than overwriting the existing one). Resolves what was
 *  added, or `null` if the dialog was canceled. */
export async function importBundle(): Promise<ImportResultDto | null> {
  const res = await commands.importBundle();
  if (res.status === 'error') throw new Error(res.error.message);
  return res.data;
}

/** Read the saved RDP/VNC connection profiles. */
export async function listRemoteDesktopConnections(): Promise<RemoteDesktopConnectionDto[]> {
  const res = await commands.listRemoteDesktopConnections();
  if (res.status === 'error') throw new Error(res.error.message);
  return res.data;
}

/** Upsert one connection by id and persist the whole list. */
export async function saveRemoteDesktopConnection(input: RemoteDesktopConnectionInputDto): Promise<void> {
  const res = await commands.saveRemoteDesktopConnection(input);
  if (res.status === 'error') throw new Error(res.error.message);
}

/** Delete the connection with this id. */
export async function deleteRemoteDesktopConnection(id: string): Promise<void> {
  const res = await commands.deleteRemoteDesktopConnection(id);
  if (res.status === 'error') throw new Error(res.error.message);
}

/** Launches the connection's native RDP client (mstsc/xfreerdp/the OS's registered
 *  .rdp handler) as its own external window. Fire-and-forget — resolves once the
 *  client process has been asked to start, not once the user is actually connected. */
export async function rdpLaunch(connectionId: string): Promise<void> {
  const res = await commands.rdpLaunch(connectionId);
  if (res.status === 'error') throw new Error(res.error.message);
}
