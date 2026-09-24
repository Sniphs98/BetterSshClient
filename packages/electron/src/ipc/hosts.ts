import type { IpcMain } from 'electron';

import { app } from 'electron';

import { loadAppConfig } from '../core/config/appConfig.js';
import { loadAllHosts, loadHosts, saveHosts } from '../core/config/hosts.js';
import type { Host } from '../core/ssh/client.js';
import { checkUpdate } from '../core/update.js';
import { hostFromInputDto, toCommandError } from '../dto.js';
import type { HostInputDto } from '../dto.js';
import type { GuiState } from '../state/guiState.js';

/**
 * Host commands. Ported from crates/omnyssh-gui/src/commands/hosts.rs.
 */

/**
 * Upsert `input` into the manual host list by name. A new name appends; an
 * existing name is an in-place edit that preserves every field the edit form
 * cannot observe — password, identity file, proxy jump (the outbound
 * `HostDto` omits all three), plus key-setup metadata, the SSH-config rename
 * origin, and a monitoring mode the payload left out. A provided secret still
 * overwrites the old one.
 */
export function upsertHost(hosts: Host[], input: HostInputDto, imported: Host | undefined): void {
  // An omitted monitoring mode means "unchanged", not "back to SSH" — losing it
  // would silently start logging in to a device chosen for reachability only.
  const monitoringGiven = input.monitoring !== undefined;
  const host = hostFromInputDto(input);

  const i = hosts.findIndex((h) => h.name === host.name);
  if (i !== -1) {
    const existing = hosts[i];
    if (!monitoringGiven) {
      host.monitoring = existing.monitoring;
      host.monitorPort = existing.monitorPort;
    }
    host.password = host.password ?? existing.password;
    host.identityFile = host.identityFile ?? existing.identityFile;
    host.proxyJump = host.proxyJump ?? existing.proxyJump;
    host.keySetupDate = existing.keySetupDate;
    host.passwordAuthDisabled = existing.passwordAuthDisabled;
    host.originalSshHost = existing.originalSshHost;
    hosts[i] = host;
  } else {
    // A brand-new host, or the first save of an SSH-config import — only the
    // import has anything to salvage. The form never saw its ProxyJump or
    // identity file, and a copy without the bastion would dial the target
    // address direct.
    if (imported) {
      host.proxyJump = host.proxyJump ?? imported.proxyJump;
      host.identityFile = host.identityFile ?? imported.identityFile;
      // Which ~/.ssh/config entry this copy stands in for — what keeps the
      // import hidden once the copy is renamed, and what another host's
      // ProxyJump alias resolves through.
      host.originalSshHost = host.name;
    }
    hosts.push(host);
  }
}

/** Drops the host named `name` from the manual list. A missing name is a
 *  no-op — the desired end state (absent) already holds. */
export function removeHost(hosts: Host[], name: string): void {
  const idx = hosts.findIndex((h) => h.name === name);
  if (idx !== -1) hosts.splice(idx, 1);
}

async function persist(mutate: (hosts: Host[]) => void): Promise<void> {
  const hosts = await loadHosts();
  mutate(hosts);
  await saveHosts(hosts);
}

export function registerHostsIpc(ipcMain: IpcMain, state: GuiState): void {
  ipcMain.handle('list_hosts', () => state.hostDtos());

  ipcMain.handle('refresh_metrics', () => {
    // No-op before the first `reload_hosts` starts the pollers.
    state.refreshMetrics();
  });

  ipcMain.handle('reload_hosts', async () => {
    // The frontend calls this only after its event bridge is listening, so
    // the one-shot startup update check fires there too — starting it any
    // earlier risks the `update-available` event arriving before anything
    // can receive it.
    if (state.claimUpdateCheck()) void startupUpdateCheck(state);

    try {
      const hosts = await loadAllHosts();
      state.setHosts(hosts);
      state.emit('hosts-loaded', state.hostDtos());
      await state.restartPollers();
    } catch (err) {
      throw toCommandError(err);
    }
  });

  ipcMain.handle('save_host', async (_event, input: HostInputDto) => {
    try {
      const imported = state.hostByName(input.name);
      const importedIfSshConfig = imported && imported.source === 'ssh_config' ? imported : undefined;
      await persist((hosts) => upsertHost(hosts, input, importedIfSshConfig));
    } catch (err) {
      throw toCommandError(err);
    }
  });

  ipcMain.handle('delete_host', async (_event, name: string) => {
    try {
      await persist((hosts) => removeHost(hosts, name));
    } catch (err) {
      throw toCommandError(err);
    }
  });
}

/** Honors `checkOnStartup`/`skipVersion` and emits `update-available` if a
 *  newer, non-skipped release exists. Best-effort — a failed check must
 *  never disrupt startup. */
async function startupUpdateCheck(state: GuiState): Promise<void> {
  try {
    const config = await loadAppConfig();
    if (!config.update.checkOnStartup) return;
    const info = await checkUpdate(app.getVersion());
    if (info === undefined || info.version === config.update.skipVersion) return;
    state.emit('update-available', { info });
  } catch {
    // Never disrupt startup over a failed update check.
  }
}
