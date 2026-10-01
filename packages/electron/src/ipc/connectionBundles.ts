import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { dialog, type IpcMain } from 'electron';

import { loadAllHosts, loadHosts, saveHosts } from '../core/config/hosts.js';
import { loadRemoteDesktopConnections, saveRemoteDesktopConnections } from '../core/config/remoteDesktop.js';
import {
  buildRdpProfilesBundle,
  mergeRdpImport,
  missingTunnelHosts,
  parseRdpProfilesBundle,
  previewRdpImport,
  type RdpProfilesBundle
} from '../core/config/rdpProfileBundle.js';
import {
  buildSshHostsBundle,
  mergeHostImport,
  parseSshHostsBundle,
  previewHostImport,
  type BundledHost
} from '../core/config/sshHostBundle.js';
import type { Host } from '../core/ssh/client.js';
import { toCommandError } from '../dto.js';
import type { ConnectionImportDecisionsDto, ConnectionImportPreviewDto, ConnectionImportResultDto } from '../dto.js';
import type { GuiState } from '../state/guiState.js';
import { reloadHostsState } from './hosts.js';

/**
 * Export/import of SSH hosts and RDP profiles as files (see
 * `core/config/sshHostBundle.ts` and `rdpProfileBundle.ts`).
 *
 * Importing takes two steps, so the user can settle name conflicts first: the
 * preview reads and checks the file and keeps it here under a token; the apply step
 * merges it with the user's decisions. Every dialog handler returns `null` when the
 * user cancels — a cancel isn't a failure.
 */

/** A file read by a preview, waiting for its apply step. */
export type PendingImport = { kind: 'ssh'; hosts: BundledHost[] } | { kind: 'rdp'; bundle: RdpProfilesBundle };

/** The files previewed and not yet applied or discarded. A handful at most: each
 *  preview replaces whatever an abandoned earlier one left. */
export class PendingImports {
  private readonly pending = new Map<string, PendingImport>();

  add(entry: PendingImport): string {
    this.pending.clear();
    const token = randomUUID();
    this.pending.set(token, entry);
    return token;
  }

  get(token: string): PendingImport {
    const entry = this.pending.get(token);
    if (entry === undefined) throw new Error('this import is no longer open; choose the file again');
    return entry;
  }

  discard(token: string): void {
    this.pending.delete(token);
  }
}

/** A safe default filename for a save dialog (see `sanitizeFileName` in ipc/automations.ts). */
function fileStem(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, '_').trim() || 'export';
}

async function saveJson(title: string, defaultName: string, filterName: string, data: unknown): Promise<string | null> {
  const { canceled, filePath } = await dialog.showSaveDialog({
    title,
    defaultPath: defaultName,
    filters: [{ name: filterName, extensions: ['json'] }]
  });
  if (canceled || !filePath) return null;
  await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  return filePath;
}

async function openJson(title: string, filterName: string): Promise<{ raw: unknown; fileName: string } | null> {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title,
    filters: [{ name: filterName, extensions: ['json'] }],
    properties: ['openFile']
  });
  if (canceled || filePaths.length === 0) return null;
  const content = await readFile(filePaths[0], 'utf-8');
  try {
    return { raw: JSON.parse(content), fileName: basename(filePaths[0]) };
  } catch {
    throw new Error('not a valid JSON file');
  }
}

/** Applies a previewed file. Hosts are merged first, so a profile's tunnel host and a
 *  host's ProxyJump follow whatever the hosts were renamed to; both merges are checked
 *  before anything is written, so a bad decision changes nothing. */
export async function applyImport(
  entry: PendingImport,
  decisions: ConnectionImportDecisionsDto
): Promise<ConnectionImportResultDto> {
  const hosts = entry.kind === 'ssh' ? entry.hosts : entry.bundle.tunnelHosts;
  let manual: Host[] | undefined;
  let hostNames = new Map<string, string>();
  if (hosts.length > 0) {
    const [current, all] = await Promise.all([loadHosts(), loadAllHosts()]);
    const merged = mergeHostImport(hosts, decisions.hosts ?? {}, current, all);
    manual = merged.manual;
    hostNames = merged.names;
  }
  const connections =
    entry.kind === 'rdp'
      ? mergeRdpImport(entry.bundle, decisions.profiles ?? {}, await loadRemoteDesktopConnections(), hostNames)
      : undefined;

  if (manual !== undefined) await saveHosts(manual);
  if (connections !== undefined) await saveRemoteDesktopConnections(connections);
  return { hosts: hosts.length, profiles: entry.kind === 'rdp' ? entry.bundle.profiles.length : 0 };
}

export function registerConnectionBundlesIpc(ipcMain: IpcMain, state: GuiState): void {
  const pending = new PendingImports();

  ipcMain.handle('export_ssh_hosts', async (_event, names: string[], label?: string): Promise<string | null> => {
    try {
      const known = await loadAllHosts();
      const selected = names.map((name) => {
        const host = known.find((h) => h.name === name);
        if (host === undefined) throw new Error(`the host "${name}" no longer exists`);
        return host;
      });
      if (selected.length === 0) throw new Error('there are no hosts to export');
      const stem = fileStem(label ?? (selected.length === 1 ? selected[0].name : 'ssh-hosts'));
      return await saveJson('Export SSH hosts', `${stem}.remoty-ssh-hosts.json`, 'Remoty SSH hosts', buildSshHostsBundle(selected, known));
    } catch (err) {
      throw toCommandError(err);
    }
  });

  ipcMain.handle('export_rdp_profiles', async (_event, ids: string[], label?: string): Promise<string | null> => {
    try {
      const [connections, known] = await Promise.all([loadRemoteDesktopConnections(), loadAllHosts()]);
      const selected = ids.map((id) => {
        const connection = connections.find((c) => c.id === id);
        if (connection === undefined) throw new Error('a profile to export no longer exists');
        return connection;
      });
      if (selected.length === 0) throw new Error('there are no profiles to export');
      const stem = fileStem(label ?? (selected.length === 1 ? selected[0].name : 'rdp-profiles'));
      return await saveJson(
        'Export remote desktop profiles',
        `${stem}.remoty-rdp-profiles.json`,
        'Remoty RDP profiles',
        buildRdpProfilesBundle(selected, known)
      );
    } catch (err) {
      throw toCommandError(err);
    }
  });

  ipcMain.handle('preview_ssh_hosts_import', async (): Promise<ConnectionImportPreviewDto | null> => {
    try {
      const file = await openJson('Import SSH hosts', 'Remoty SSH hosts');
      if (file === null) return null;
      const bundle = parseSshHostsBundle(file.raw);
      if (bundle.hosts.length === 0) throw new Error('the file holds no hosts');
      const preview = previewHostImport(bundle.hosts, await loadAllHosts());
      const token = pending.add({ kind: 'ssh', hosts: bundle.hosts });
      return { token, fileName: file.fileName, hosts: preview, profiles: [], missingTunnelHosts: [] };
    } catch (err) {
      throw toCommandError(err);
    }
  });

  ipcMain.handle('preview_rdp_profiles_import', async (): Promise<ConnectionImportPreviewDto | null> => {
    try {
      const file = await openJson('Import remote desktop profiles', 'Remoty RDP profiles');
      if (file === null) return null;
      const bundle = parseRdpProfilesBundle(file.raw);
      if (bundle.profiles.length === 0) throw new Error('the file holds no profiles');
      const [connections, hosts] = await Promise.all([loadRemoteDesktopConnections(), loadAllHosts()]);
      const preview = previewRdpImport(bundle, connections, hosts);
      const token = pending.add({ kind: 'rdp', bundle });
      return {
        token,
        fileName: file.fileName,
        hosts: preview.tunnelHosts,
        profiles: preview.profiles,
        missingTunnelHosts: missingTunnelHosts(bundle, hosts)
      };
    } catch (err) {
      throw toCommandError(err);
    }
  });

  ipcMain.handle(
    'apply_connection_import',
    async (_event, token: string, decisions: ConnectionImportDecisionsDto): Promise<ConnectionImportResultDto> => {
      try {
        // Kept until it succeeds: after a refused decision the dialog stays open to fix it.
        const result = await applyImport(pending.get(token), decisions);
        pending.discard(token);
        if (result.hosts > 0) await reloadHostsState(state);
        return result;
      } catch (err) {
        throw toCommandError(err);
      }
    }
  );

  ipcMain.handle('discard_connection_import', (_event, token: string) => {
    pending.discard(token);
  });
}
