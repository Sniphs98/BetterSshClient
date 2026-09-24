import type { BrowserWindow } from 'electron';

import { loadAppConfig } from '../core/config/appConfig.js';
import type { Host } from '../core/ssh/client.js';
import { PollManager } from '../core/ssh/pool.js';
import { PtyManager } from '../core/ssh/pty.js';
import { invalidateSharedConnections } from '../core/ssh/session.js';
import type { SftpManager } from '../core/ssh/sftp.js';
import { connectionStatusToDto, hostToDto, metricsToDto, serviceToDto } from '../dto.js';
import type { HostDto } from '../dto.js';
import type { CoreEvent } from '../event.js';
import { SessionRegistry } from './sessionRegistry.js';

const DEFAULT_POLL_INTERVAL_MS = 30_000;

/**
 * Main-process singleton holding the in-memory host cache, the background
 * poller pool, the terminal/SFTP session tables, and the window to
 * broadcast events on. Mirrors the invariants `GuiState` (state.rs) keeps
 * on the Tauri side.
 */
export class GuiState {
  private hosts: Host[] = [];
  private readonly getWindow: () => BrowserWindow | undefined;
  private readonly pollManager = new PollManager();
  private readonly sessionRegistry = new SessionRegistry();
  private readonly sftpSessions = new Map<number, SftpManager>();
  private nextTransferId = 1;
  /** Single-slot guard: the host a key-setup run is in flight for, if any. */
  private keySetupHost: string | undefined;
  /** Automation names currently running — keyed per automation (unlike key setup's single global
   *  slot, which exists specifically to protect a `hosts.toml` write race). Two
   *  different automations have no reason to serialize; only the same automation twice at once is
   *  nonsensical (confusing interleaved progress events on one automation's run). */
  private readonly runningAutomations = new Set<string>();
  private updateCheckClaimed = false;
  readonly pty: PtyManager;

  constructor(getWindow: () => BrowserWindow | undefined) {
    this.getWindow = getWindow;
    this.pty = new PtyManager((sessionId, data) => {
      this.getWindow()?.webContents.send(`terminal-output-${sessionId}`, data);
    });
  }

  /** Allocates a session id from the id space shared by terminal and SFTP
   *  sessions, so they never collide. */
  allocateSessionId(): number {
    return this.sessionRegistry.allocate();
  }

  allocateTransferId(): number {
    return this.nextTransferId++;
  }

  registerSftp(id: number, manager: SftpManager): void {
    this.sftpSessions.set(id, manager);
  }

  getSftp(id: number): SftpManager | undefined {
    return this.sftpSessions.get(id);
  }

  /** Disconnects and forgets an SFTP session. Idempotent for an unknown id. */
  closeSftp(id: number): void {
    this.sftpSessions.get(id)?.disconnect();
    this.sftpSessions.delete(id);
  }

  /** Claims the single key-setup slot for `hostName`, or throws if a run is
   *  already in flight (for any host) — two runs must never race a
   *  `hosts.toml` write. */
  tryBeginKeySetup(hostName: string): void {
    if (this.keySetupHost !== undefined) {
      throw new Error(`key setup already running for '${this.keySetupHost}'`);
    }
    this.keySetupHost = hostName;
  }

  /** Releases the key-setup slot. Safe to call unconditionally. */
  endKeySetup(): void {
    this.keySetupHost = undefined;
  }

  /** Claims the run slot for `automationName`, or throws if that same automation is already
   *  running. */
  tryBeginAutomationRun(automationName: string): void {
    if (this.runningAutomations.has(automationName)) {
      throw new Error(`automation '${automationName}' is already running`);
    }
    this.runningAutomations.add(automationName);
  }

  /** Releases the run slot for `automationName`. Safe to call unconditionally. */
  endAutomationRun(automationName: string): void {
    this.runningAutomations.delete(automationName);
  }

  /** One-shot latch: `true` only the first time it's called, so the startup
   *  update check fires exactly once regardless of how many times
   *  `reload_hosts` runs. */
  claimUpdateCheck(): boolean {
    if (this.updateCheckClaimed) return false;
    this.updateCheckClaimed = true;
    return true;
  }

  setHosts(hosts: Host[]): void {
    this.hosts = hosts;
    // A reload can change a jump host's settings, which the connection key
    // can't see; start later sessions on fresh connections.
    invalidateSharedConnections();
  }

  getHosts(): Host[] {
    return this.hosts;
  }

  hostByName(name: string): Host | undefined {
    return this.hosts.find((h) => h.name === name);
  }

  hostDtos(): HostDto[] {
    return this.hosts.map(hostToDto);
  }

  /** Stops the current pollers (if any) and starts a fresh one per host,
   *  using the configured refresh interval. Mirrors `reload_hosts`
   *  restarting the poll pool after every reload. */
  async restartPollers(): Promise<void> {
    this.pollManager.shutdown();
    const config = await loadAppConfig().catch(() => undefined);
    const intervalMs = config !== undefined ? config.general.refreshInterval * 1000 : DEFAULT_POLL_INTERVAL_MS;
    this.pollManager.start(this.hosts, (event) => this.dispatch(event), intervalMs);
  }

  /** Triggers an immediate poll of every host. No-op before pollers start. */
  refreshMetrics(): void {
    this.pollManager.refreshAll();
  }

  /** Closes every poller, terminal, and SFTP session. Called on app quit. */
  shutdown(): void {
    this.pollManager.shutdown();
    this.pty.shutdown();
    for (const manager of this.sftpSessions.values()) manager.disconnect();
    this.sftpSessions.clear();
  }

  /** Sends a typed event to the renderer, if the window still exists. */
  emit(channel: string, payload: unknown): void {
    this.getWindow()?.webContents.send(channel, payload);
  }

  /** Maps a `CoreEvent` from the SSH engine to its outbound IPC event.
   *  Public so callers outside the poller loop (e.g. `PtyManager.open`'s
   *  connect-failure path) can route through the same mapping. */
  emitCoreEvent(event: CoreEvent): void {
    this.dispatch(event);
  }

  private dispatch(event: CoreEvent): void {
    switch (event.type) {
      case 'hostStatusChanged':
        this.emit('host-status-changed', { hostName: event.hostName, status: connectionStatusToDto(event.status) });
        break;
      case 'metricsUpdate':
        this.emit('metrics-updated', { hostName: event.hostName, metrics: metricsToDto(event.metrics) });
        break;
      case 'discoveryQuickScanDone':
        this.emit('services-detected', { hostName: event.hostName, services: event.services.map(serviceToDto) });
        break;
      case 'discoveryFailed':
        this.emit('services-failed', { hostName: event.hostName, message: event.message });
        break;
      case 'error':
        this.emit('error', { message: event.message });
        break;
      case 'ptyExited':
        this.emit('terminal-exited', { sessionId: event.sessionId });
        break;
    }
  }
}
