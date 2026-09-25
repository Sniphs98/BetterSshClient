import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { shell, type IpcMain } from 'electron';
import Store from 'electron-store';

import { discoverPlugins, pluginsDir, type FoundPlugin } from '../core/plugins/loader.js';
import { describePermission, isFullyGranted, type Permission } from '../core/plugins/manifest.js';
import { toCommandError } from '../dto.js';
import { PluginHost } from '../plugins/host.js';
import type { GuiState } from '../state/guiState.js';

/**
 * Plugin management for the renderer: list the installed plugins, switch one
 * on (which grants exactly the permissions it lists — the user's consent) or
 * off, and run the commands running plugins registered.
 *
 * Consent is stored per plugin as the permission list the user agreed to. A
 * plugin that later asks for more (an update adding `hosts:exec`, say) stays
 * off until the user switches it on again with the new list in front of them.
 */

interface PluginDto {
  id: string;
  name: string;
  version?: string;
  description?: string;
  permissions: { id: Permission; description: string }[];
  enabled: boolean;
  running: boolean;
  error?: string;
}

type ConsentStore = { granted: Record<string, Permission[]> };

let consent: Store<ConsentStore> | undefined;
function consentStore(): Store<ConsentStore> {
  consent ??= new Store<ConsentStore>({ name: 'plugins', defaults: { granted: {} } });
  return consent;
}

function isEnabled(plugin: FoundPlugin): boolean {
  if (!plugin.manifest) return false;
  const granted = consentStore().get('granted')[plugin.manifest.id];
  return granted !== undefined && isFullyGranted(plugin.manifest.permissions, granted);
}

export class PluginManager {
  private found: FoundPlugin[] = [];
  private startErrors = new Map<string, string>();
  readonly host: PluginHost;

  constructor(state: GuiState) {
    this.host = new PluginHost(state, join(__dirname, '..', 'plugins', 'pluginPreload.js'), {
      commandsChanged: (commands) => state.emit('plugin-commands-changed', { commands }),
      showText: (pluginName, title, text) => state.emit('plugin-show-text', { pluginName, title, text })
    });
  }

  /** Re-reads the plugins folder and (re)starts every enabled plugin. */
  async reload(): Promise<void> {
    this.host.stopAll();
    this.startErrors.clear();
    this.found = await discoverPlugins();
    for (const p of this.found) if (p.manifest && isEnabled(p)) await this.startOne(p);
  }

  list(): PluginDto[] {
    return this.found.map((p) => {
      const id = p.manifest?.id ?? p.folder;
      return {
        id,
        name: p.manifest?.name ?? p.folder,
        version: p.manifest?.version,
        description: p.manifest?.description,
        permissions: (p.manifest?.permissions ?? []).map((perm) => ({ id: perm, description: describePermission(perm) })),
        enabled: isEnabled(p),
        running: this.host.isRunning(id),
        error: p.error ?? this.startErrors.get(id)
      };
    });
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const plugin = this.found.find((p) => p.manifest?.id === id);
    if (!plugin?.manifest) throw new Error(`unknown plugin "${id}"`);
    const granted = { ...consentStore().get('granted') };
    if (enabled) {
      granted[id] = [...plugin.manifest.permissions];
      consentStore().set('granted', granted);
      await this.startOne(plugin);
    } else {
      delete granted[id];
      consentStore().set('granted', granted);
      this.host.stop(id);
      this.startErrors.delete(id);
    }
  }

  private async startOne(plugin: FoundPlugin): Promise<void> {
    if (!plugin.manifest) return;
    try {
      await this.host.start(plugin.manifest, plugin.dir);
      this.startErrors.delete(plugin.manifest.id);
    } catch (e) {
      this.startErrors.set(plugin.manifest.id, (e as Error).message);
    }
  }
}

export function registerPluginsIpc(ipcMain: IpcMain, manager: PluginManager): void {
  ipcMain.handle('list_plugins', () => manager.list());

  ipcMain.handle('reload_plugins', async () => {
    try {
      await manager.reload();
      return manager.list();
    } catch (err) {
      throw toCommandError(err);
    }
  });

  ipcMain.handle('set_plugin_enabled', async (_event, id: string, enabled: boolean) => {
    try {
      await manager.setEnabled(String(id), enabled === true);
      return manager.list();
    } catch (err) {
      throw toCommandError(err);
    }
  });

  ipcMain.handle('open_plugins_folder', async () => {
    const dir = pluginsDir();
    await mkdir(dir, { recursive: true });
    await shell.openPath(dir);
  });

  ipcMain.handle('list_plugin_commands', () => manager.host.listCommands());

  ipcMain.handle('run_plugin_command', async (_event, pluginId: string, commandId: string, host?: string) => {
    try {
      await manager.host.runCommand(String(pluginId), String(commandId), host === undefined ? undefined : String(host));
    } catch (err) {
      throw toCommandError(err);
    }
  });
}
