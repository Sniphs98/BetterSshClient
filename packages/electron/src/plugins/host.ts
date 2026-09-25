import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { BrowserWindow, ipcMain, session, type IpcMainInvokeEvent } from 'electron';

import { isAllowedRequest, type Permission, type PluginManifest } from '../core/plugins/manifest.js';
import { SshSession } from '../core/ssh/session.js';
import type { GuiState } from '../state/guiState.js';

/**
 * Runs code plugins in a sandbox and answers their API calls.
 *
 * Each running plugin gets a hidden BrowserWindow of its own:
 *
 * - Chromium's renderer sandbox, context isolation and no Node.js — the plugin
 *   can't touch files, processes, or the app's internals;
 * - its own in-memory session (`plugin:<id>`), so it shares no storage or
 *   cookies with the app or other plugins;
 * - every network request cancelled unless it is HTTPS to a hostname the
 *   plugin declared (`network:<host>`), no navigation, no popups, and every
 *   browser permission (camera, notifications, clipboard …) denied.
 *
 * All it can do is call the `bssh` API (`pluginPreload.ts`), and each call is
 * checked here against the permissions the user granted.
 */

export interface PluginCommand {
  pluginId: string;
  pluginName: string;
  commandId: string;
  title: string;
  needsHost: boolean;
}

interface Running {
  manifest: PluginManifest;
  win: BrowserWindow;
}

export interface PluginHostEvents {
  commandsChanged(commands: PluginCommand[]): void;
  showText(pluginName: string, title: string, text: string): void;
}

const COMMAND_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_COMMAND_LENGTH = 10_000;
const MAX_TEXT_LENGTH = 200_000;
const EXEC_TIMEOUT_MS = 60_000;
const COMMAND_TIMEOUT_MS = 5 * 60_000;

export class PluginHost {
  private readonly running = new Map<string, Running>();
  /** webContents id → plugin id: how an API call is traced back to its plugin. */
  private readonly byWebContents = new Map<number, string>();
  private commands: PluginCommand[] = [];
  private readonly pendingRuns = new Map<string, (error: string | null) => void>();

  constructor(
    private readonly state: GuiState,
    private readonly preloadPath: string,
    private readonly events: PluginHostEvents
  ) {
    ipcMain.handle('plugin:api', (event, method: string, ...args: unknown[]) => this.handleApi(event, method, args));
    ipcMain.on('plugin:command-done', (_event, runId: string, error: string | null) => {
      this.pendingRuns.get(runId)?.(error);
      this.pendingRuns.delete(runId);
    });
  }

  isRunning(id: string): boolean {
    return this.running.has(id);
  }

  listCommands(): PluginCommand[] {
    return [...this.commands];
  }

  async start(manifest: PluginManifest, dir: string): Promise<void> {
    if (this.running.has(manifest.id)) return;
    const code = await readFile(join(dir, manifest.main), 'utf-8');

    const ses = session.fromPartition(`plugin:${manifest.id}`);
    ses.webRequest.onBeforeRequest((details, callback) => {
      const url = details.url;
      callback({ cancel: !(url.startsWith('data:') || isAllowedRequest(url, manifest.permissions)) });
    });
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);

    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: this.preloadPath,
        session: ses,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        spellcheck: false
      }
    });
    const wc = win.webContents;
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (e) => e.preventDefault());
    wc.on('console-message', (_event, _level, message) => console.log(`[plugin ${manifest.id}] ${message}`));

    this.running.set(manifest.id, { manifest, win });
    this.byWebContents.set(wc.id, manifest.id);
    win.on('closed', () => {
      this.byWebContents.delete(wc.id);
      this.running.delete(manifest.id);
      this.dropCommands(manifest.id);
    });

    // A last layer under the network filter: no eval, no remote scripts, and fetch only
    // over HTTPS (which host is the filter's call).
    const csp = "default-src 'none'; connect-src https:; img-src https: data:";
    const page = `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}"><title>plugin</title>`;
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
    try {
      // Runs in the page's main world, where `bssh` is the only way out.
      await wc.executeJavaScript(`(async () => {\n${code}\n})()`, true);
    } catch (e) {
      console.error(`[plugin ${manifest.id}] failed to start:`, e);
      this.stop(manifest.id);
      throw new Error(`plugin failed to start: ${(e as Error).message}`);
    }
  }

  stop(id: string): void {
    const r = this.running.get(id);
    if (!r) return;
    this.running.delete(id);
    this.dropCommands(id);
    if (!r.win.isDestroyed()) r.win.destroy();
  }

  stopAll(): void {
    for (const id of [...this.running.keys()]) this.stop(id);
  }

  /** Runs a plugin command the user picked; resolves once the plugin's handler finished. */
  runCommand(pluginId: string, commandId: string, host?: string): Promise<void> {
    const r = this.running.get(pluginId);
    if (!r || !this.commands.some((c) => c.pluginId === pluginId && c.commandId === commandId)) {
      return Promise.reject(new Error('That plugin command is no longer available.'));
    }
    const runId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRuns.delete(runId);
        reject(new Error('The plugin command did not finish in time.'));
      }, COMMAND_TIMEOUT_MS);
      this.pendingRuns.set(runId, (error) => {
        clearTimeout(timer);
        if (error) reject(new Error(error));
        else resolve();
      });
      r.win.webContents.send('plugin:run-command', runId, commandId, { host });
    });
  }

  private dropCommands(pluginId: string): void {
    const before = this.commands.length;
    this.commands = this.commands.filter((c) => c.pluginId !== pluginId);
    if (this.commands.length !== before) this.events.commandsChanged(this.listCommands());
  }

  private require(manifest: PluginManifest, permission: Permission): void {
    if (!manifest.permissions.includes(permission)) {
      throw new Error(`plugin "${manifest.id}" does not have the "${permission}" permission`);
    }
  }

  private async handleApi(event: IpcMainInvokeEvent, method: string, args: unknown[]): Promise<unknown> {
    const pluginId = this.byWebContents.get(event.sender.id);
    const r = pluginId === undefined ? undefined : this.running.get(pluginId);
    // Only a running plugin's own window may call this API — not the app window, not anything else.
    if (!r) throw new Error('not a plugin');
    const { manifest } = r;

    switch (method) {
      case 'commands.register': {
        const [commandId, title, options] = args as [string, string, { needsHost?: boolean }];
        if (typeof commandId !== 'string' || !COMMAND_ID.test(commandId)) throw new Error('command id must be lowercase letters, digits and dashes');
        if (typeof title !== 'string' || title.trim() === '' || title.length > 120) throw new Error('command title must be 1–120 characters');
        this.commands = [
          ...this.commands.filter((c) => !(c.pluginId === manifest.id && c.commandId === commandId)),
          { pluginId: manifest.id, pluginName: manifest.name, commandId, title: title.trim(), needsHost: options?.needsHost === true }
        ];
        this.events.commandsChanged(this.listCommands());
        return null;
      }

      case 'hosts.list':
        this.require(manifest, 'hosts:read');
        return this.state.getHosts().map((h) => ({ name: h.name, hostname: h.hostname, user: h.user, port: h.port, tags: [...h.tags] }));

      case 'hosts.exec': {
        this.require(manifest, 'hosts:exec');
        const [hostName, command] = args as [string, string];
        if (typeof command !== 'string' || command.trim() === '' || command.length > MAX_COMMAND_LENGTH) throw new Error('invalid command');
        const host = this.state.hostByName(String(hostName));
        if (!host) throw new Error(`unknown host "${String(hostName)}"`);
        console.log(`[plugin ${manifest.id}] exec on ${host.name}: ${command}`);
        const ssh = await SshSession.shared(host);
        try {
          return await ssh.runShell(command, EXEC_TIMEOUT_MS);
        } finally {
          ssh.disconnect();
        }
      }

      case 'ui.showText': {
        const [title, text] = args as [string, string];
        this.events.showText(manifest.name, String(title).slice(0, 200), String(text).slice(0, MAX_TEXT_LENGTH));
        return null;
      }

      case 'log':
        console.log(`[plugin ${manifest.id}]`, String(args[0]).slice(0, 2000));
        return null;

      default:
        throw new Error(`unknown plugin API "${String(method)}"`);
    }
  }
}
