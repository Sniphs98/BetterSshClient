import type { IpcMain } from 'electron';

import { loadHosts, saveHosts } from '../core/config/hosts.js';
import type { Host } from '../core/ssh/client.js';
import { ALL_STEPS, setupKeyForHost, stepDescription, stepIndex, type KeySetupStep } from '../core/ssh/keySetup.js';
import { SshSession } from '../core/ssh/session.js';
import { toCommandError } from '../dto.js';
import type { GuiState } from '../state/guiState.js';

/**
 * Auto SSH key-setup command. Ported from
 * crates/omnyssh-gui/src/commands/keysetup.rs. Fire-and-forget: the flow
 * runs in the background and reports via `key-setup-*` events. One run at
 * a time (`GuiState.tryBeginKeySetup`), so two runs never race a
 * `hosts.toml` write.
 */
export function registerKeySetupIpc(ipcMain: IpcMain, state: GuiState): void {
  ipcMain.handle('start_key_setup', (_event, hostName: string, disablePasswordAuth: boolean) => {
    const host = state.hostByName(hostName);
    if (host === undefined) throw toCommandError(new Error(`unknown host '${hostName}'`));
    try {
      state.tryBeginKeySetup(hostName);
    } catch (err) {
      throw toCommandError(err);
    }
    void runKeySetup(state, host, disablePasswordAuth);
  });
}

async function runKeySetup(state: GuiState, host: Host, disablePasswordAuth: boolean): Promise<void> {
  try {
    let passwordSession: SshSession;
    try {
      passwordSession = await SshSession.connect(host);
    } catch (e) {
      state.emit('key-setup-failed', { hostName: host.name, error: `Connection failed: ${(e as Error).message}` });
      return;
    }

    try {
      const result = await setupKeyForHost(host, passwordSession, disablePasswordAuth, (step: KeySetupStep) => {
        state.emit('key-setup-progress', {
          hostName: host.name,
          step: { index: stepIndex(step), total: ALL_STEPS.length, description: stepDescription(step) }
        });
      });

      // Key generated, copied, and verified either way — the card should show
      // `hasKey`. Whether password auth actually got disabled is `machine
      // .passwordDisabled` itself now, not inferred from the terminal state
      // (a user who declined to disable it also ends in `success`). Persist
      // BEFORE emitting so a following `reload_hosts` observes the write.
      await persistKey(host.name, result.keyPath, result.passwordDisabled);
      state.emit('key-setup-complete', { hostName: host.name, keyPath: result.keyPath });
    } catch (e) {
      state.emit('key-setup-failed', { hostName: host.name, error: (e as Error).message });
    } finally {
      passwordSession.disconnect();
    }
  } finally {
    state.endKeySetup();
  }
}

/** Writes the generated key onto the manual host in `hosts.toml`: sets
 *  `identityFile` + `keySetupDate`, and — only when password auth was
 *  actually disabled — marks `passwordAuthDisabled` and drops the stored
 *  password (key auth supersedes it). Only manual hosts live in
 *  `hosts.toml`, so an SSH-config name is a no-op. */
async function persistKey(hostName: string, keyPath: string, passwordDisabled: boolean): Promise<void> {
  const hosts = await loadHosts();
  const host = hosts.find((h) => h.name === hostName);
  if (host === undefined) return;
  host.identityFile = keyPath;
  host.keySetupDate = new Date().toISOString();
  if (passwordDisabled) {
    host.passwordAuthDisabled = true;
    host.password = undefined;
  }
  await saveHosts(hosts);
}
