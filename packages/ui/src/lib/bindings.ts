import type { OmnysshBridge } from './electron';

// Hand-written replacement for the tauri-specta-generated bindings.ts. Keeps
// the exact same exported shape (command signatures, `Result<T, E>` wrapper,
// per-event `.listen()`/`.once()`, and DTO types) so `ipc/commands.ts`,
// `ipc/subscribe.ts`, `ipc/router.ts`, and every store/screen that imports
// from here needs no changes beyond the IPC transport swapped in below.

/** user-defined commands **/

export const commands = {
  async listHosts(): Promise<Result<HostDto[], CommandError>> {
    return call('list_hosts');
  },
  async reloadHosts(): Promise<Result<null, CommandError>> {
    return call('reload_hosts');
  },
  async saveHost(input: HostInputDto): Promise<Result<null, CommandError>> {
    return call('save_host', input);
  },
  async deleteHost(name: string): Promise<Result<null, CommandError>> {
    return call('delete_host', name);
  },
  async listSnippets(): Promise<Result<SnippetDto[], CommandError>> {
    return call('list_snippets');
  },
  async saveSnippet(snippet: SnippetDto): Promise<Result<null, CommandError>> {
    return call('save_snippet', snippet);
  },
  async deleteSnippet(name: string): Promise<Result<null, CommandError>> {
    return call('delete_snippet', name);
  },
  async executeSnippet(
    snippetName: string,
    hostNames: string[],
    params: Partial<{ [key in string]: string }>
  ): Promise<Result<null, CommandError>> {
    return call('execute_snippet', snippetName, hostNames, params);
  },
  async terminalOpen(
    hostName: string,
    cols: number,
    rows: number,
    onOutput: Channel<TerminalBytes>
  ): Promise<Result<number, CommandError>> {
    try {
      const sessionId = (await invoke('terminal_open', hostName, cols, rows)) as number;
      onOutput.attach(`terminal-output-${sessionId}`);
      return { status: 'ok', data: sessionId };
    } catch (e) {
      if (e instanceof Error) throw e;
      return { status: 'error', error: e as CommandError };
    }
  },
  async terminalWrite(sessionId: number, data: number[]): Promise<Result<null, CommandError>> {
    return call('terminal_write', sessionId, data);
  },
  async terminalResize(sessionId: number, cols: number, rows: number): Promise<Result<null, CommandError>> {
    return call('terminal_resize', sessionId, cols, rows);
  },
  async terminalClose(sessionId: number): Promise<Result<null, CommandError>> {
    return call('terminal_close', sessionId);
  },
  async sftpOpen(hostName: string): Promise<Result<number, CommandError>> {
    return call('sftp_open', hostName);
  },
  async sftpList(sessionId: number, path: string): Promise<Result<null, CommandError>> {
    return call('sftp_list', sessionId, path);
  },
  async sftpUpload(sessionId: number, local: string, remote: string): Promise<Result<null, CommandError>> {
    return call('sftp_upload', sessionId, local, remote);
  },
  async sftpDownload(sessionId: number, local: string, remote: string): Promise<Result<null, CommandError>> {
    return call('sftp_download', sessionId, local, remote);
  },
  async sftpMkdir(sessionId: number, path: string): Promise<Result<null, CommandError>> {
    return call('sftp_mkdir', sessionId, path);
  },
  async sftpRename(sessionId: number, from: string, to: string): Promise<Result<null, CommandError>> {
    return call('sftp_rename', sessionId, from, to);
  },
  async sftpDelete(sessionId: number, path: string): Promise<Result<null, CommandError>> {
    return call('sftp_delete', sessionId, path);
  },
  async sftpPreview(sessionId: number, path: string): Promise<Result<null, CommandError>> {
    return call('sftp_preview', sessionId, path);
  },
  async sftpClose(sessionId: number): Promise<Result<null, CommandError>> {
    return call('sftp_close', sessionId);
  },
  async listLocalDir(path: string): Promise<Result<FileEntryDto[], CommandError>> {
    return call('list_local_dir', path);
  },
  async previewLocalFile(path: string): Promise<Result<string, CommandError>> {
    return call('preview_local_file', path);
  },
  async startKeySetup(hostName: string): Promise<Result<null, CommandError>> {
    return call('start_key_setup', hostName);
  },
  async refreshMetrics(): Promise<Result<null, CommandError>> {
    return call('refresh_metrics');
  },
  async checkUpdate(): Promise<Result<UpdateInfoDto | null, CommandError>> {
    return call('check_update');
  },
  async installUpdate(): Promise<Result<null, CommandError>> {
    return call('install_update');
  },
  async loadUpdateConfig(): Promise<Result<UpdateConfigDto, CommandError>> {
    return call('load_update_config');
  },
  async saveUpdateConfig(config: UpdateConfigDto): Promise<Result<null, CommandError>> {
    return call('save_update_config', config);
  }
};

/** user-defined events **/

const EVENT_CHANNELS = {
  error: 'error',
  filePreview: 'file-preview',
  hostStatusChanged: 'host-status-changed',
  hostsLoaded: 'hosts-loaded',
  keySetupComplete: 'key-setup-complete',
  keySetupFailed: 'key-setup-failed',
  keySetupProgress: 'key-setup-progress',
  keySetupRollback: 'key-setup-rollback',
  metricsUpdated: 'metrics-updated',
  servicesDetected: 'services-detected',
  servicesFailed: 'services-failed',
  sftpConnected: 'sftp-connected',
  sftpDirListed: 'sftp-dir-listed',
  sftpDisconnected: 'sftp-disconnected',
  sftpOpDone: 'sftp-op-done',
  snippetResult: 'snippet-result',
  terminalExited: 'terminal-exited',
  transferProgress: 'transfer-progress',
  updateAvailable: 'update-available'
} as const;

type EventMap = {
  error: Error;
  filePreview: FilePreview;
  hostStatusChanged: HostStatusChanged;
  hostsLoaded: HostsLoaded;
  keySetupComplete: KeySetupComplete;
  keySetupFailed: KeySetupFailed;
  keySetupProgress: KeySetupProgress;
  keySetupRollback: KeySetupRollback;
  metricsUpdated: MetricsUpdated;
  servicesDetected: ServicesDetected;
  servicesFailed: ServicesFailed;
  sftpConnected: SftpConnected;
  sftpDirListed: SftpDirListed;
  sftpDisconnected: SftpDisconnected;
  sftpOpDone: SftpOpDone;
  snippetResult: SnippetResult;
  terminalExited: TerminalExited;
  transferProgress: TransferProgress;
  updateAvailable: UpdateAvailable;
};

type EventCallback<T> = (event: { payload: T }) => void;
type UnlistenFn = () => void;

interface EventObj<T> {
  listen: (cb: EventCallback<T>) => Promise<UnlistenFn>;
  once: (cb: EventCallback<T>) => Promise<UnlistenFn>;
}

function makeEvents<T extends Record<string, unknown>>(channels: Record<keyof T, string>): {
  [K in keyof T]: EventObj<T[K]>;
} {
  return new Proxy({} as { [K in keyof T]: EventObj<T[K]> }, {
    get: (_target, prop: string) => {
      const channel = channels[prop as keyof T];
      return {
        listen: async (cb: EventCallback<unknown>): Promise<UnlistenFn> => bridge().on(channel, (payload) => cb({ payload })),
        once: async (cb: EventCallback<unknown>): Promise<UnlistenFn> => {
          const off = bridge().on(channel, (payload) => {
            off();
            cb({ payload });
          });
          return off;
        }
      };
    }
  });
}

export const events = makeEvents<EventMap>(EVENT_CHANNELS);

/** user-defined types **/
export type CommandError = { message: string };
/** Live connection state for a host. Internally tagged so the frontend
 *  consumes a discriminated union keyed on `kind`. */
export type ConnectionStatusDto =
  | { kind: 'unknown' }
  | { kind: 'connecting' }
  | { kind: 'connected' }
  | { kind: 'failed'; message: string };
/** A background error surfaced to the user. */
export type Error = { message: string };
/** A file or directory in an SFTP panel listing. */
export type FileEntryDto = { name: string; path: string; size: number; isDir: boolean };
/** Preview bytes for a remote file. Stamped with `sessionId`. */
export type FilePreview = { sessionId: number; path: string; content: string };
/** A host as the frontend sees it — password and private-key material omitted. */
export type HostDto = {
  name: string;
  hostname: string;
  user: string;
  port: number;
  tags: string[];
  notes?: string | null;
  source: HostSourceDto;
  hasKey: boolean;
  passwordAuthDisabled?: boolean | null;
  monitoring: MonitorModeDto;
  monitorPort?: number | null;
};
/** Inbound host form payload for `save_host`. */
export type HostInputDto = {
  name: string;
  hostname: string;
  user: string;
  port: number;
  identityFile?: string | null;
  password?: string | null;
  proxyJump?: string | null;
  tags: string[];
  notes?: string | null;
  monitoring?: MonitorModeDto | null;
  monitorPort?: number | null;
};
/** Host origin. */
export type HostSourceDto = 'sshConfig' | 'manual';
/** A host's connection status changed. */
export type HostStatusChanged = { hostName: string; status: ConnectionStatusDto };
/** Full host list broadcast, emitted by `reload_hosts`. */
export type HostsLoaded = HostDto[];
/** Key setup finished successfully — key auth is configured. */
export type KeySetupComplete = { hostName: string; keyPath: string };
/** Key setup failed before touching the server's auth config. */
export type KeySetupFailed = { hostName: string; error: string };
/** A progress step of an auto key-setup run. */
export type KeySetupProgress = { hostName: string; step: KeySetupStepDto };
/** Key setup rolled the server's sshd config back after a late failure. */
export type KeySetupRollback = { hostName: string; result: string };
/** One step of the auto key-setup flow, for the progress view. */
export type KeySetupStepDto = { index: number; total: number; description: string };
/** A metrics snapshot for a host. */
export type MetricsDto = {
  cpuPercent?: number | null;
  ramPercent?: number | null;
  diskPercent?: number | null;
  uptime?: string | null;
  loadAvg?: string | null;
  osInfo?: string | null;
  topProcesses: ProcessDto[];
  ageSeconds: number;
};
/** A fresh metrics sample for a host. */
export type MetricsUpdated = { hostName: string; metrics: MetricsDto };
/** How a host is watched. `tcpPort` means reachability only — no login, no metrics. */
export type MonitorModeDto = 'ssh' | 'tcpPort';
/** A single process in the "top processes" panel. */
export type ProcessDto = { name: string; cpuPercent: number; memPercent: number };
/** A service detected on a host with its quick-scan metrics. */
export type ServiceDto = { kind: ServiceKindDto; metrics: ServiceMetricDto[] };
/** A service kind detected on a host. */
export type ServiceKindDto = 'docker' | 'nginx' | 'postgresql' | 'redis' | 'nodejs';
/** One quick-scan metric for a detected service. */
export type ServiceMetricDto = { name: string; value: number };
/** Services detected on a host by the discovery quick-scan. */
export type ServicesDetected = { hostName: string; services: ServiceDto[] };
/** Discovery failed for a host. */
export type ServicesFailed = { hostName: string; message: string };
/** An SFTP session connected. */
export type SftpConnected = { sessionId: number; hostName: string };
/** A remote directory listing completed for one SFTP tab. */
export type SftpDirListed = { sessionId: number; path: string; entries: FileEntryDto[] };
/** An SFTP operation reported a failure. */
export type SftpDisconnected = { sessionId: number; reason: string };
/** A mutating SFTP op (upload/download/mkdir/rename/delete) finished. */
export type SftpOpDone = { sessionId: number; ok: boolean; error?: string | null };
/** A saved command snippet as the frontend sees it. */
export type SnippetDto = {
  name: string;
  command: string;
  scope: SnippetScopeDto;
  host?: string | null;
  tags?: string[] | null;
  params?: string[] | null;
};
/** Result of running a snippet on one host. */
export type SnippetResult = { hostName: string; snippetName: string; ok: boolean; output: string };
/** Snippet scope. */
export type SnippetScopeDto = 'global' | 'host';
/** Raw PTY output bytes for a terminal session. */
export type TerminalBytes = number[];
/** A terminal session's remote shell exited or its connection dropped. */
export type TerminalExited = { sessionId: number };
/** Live transfer progress, routed to its owning session. */
export type TransferProgress = TransferProgressDto;
/** Live progress for one SFTP upload/download. */
export type TransferProgressDto = { sessionId: number; transferId: number; done: number; total: number };
/** A newer release was found by the startup check. */
export type UpdateAvailable = { info: UpdateInfoDto };
/** Update-checker preferences. */
export type UpdateConfigDto = { checkOnStartup: boolean; skipVersion: string };
/** A newer release the app can offer. */
export type UpdateInfoDto = { version: string; url: string; tag: string; canSelfUpdate: boolean };

export type Result<T, E> = { status: 'ok'; data: T } | { status: 'error'; error: E };

/** Minimal, Tauri-`Channel`-compatible class for streaming raw terminal bytes:
 *  `new Channel<TerminalBytes>()`, then set `.onmessage`. Internally subscribes
 *  to the per-session `terminal-output-<id>` event once `terminalOpen` resolves
 *  a session id (see `commands.terminalOpen` above). */
export class Channel<T> {
  onmessage: (payload: T) => void = () => {};
  private off: UnlistenFn | undefined;

  /** @internal wired by `commands.terminalOpen`. */
  attach(channel: string): void {
    this.off?.();
    this.off = bridge().on(channel, (payload) => this.onmessage(payload as T));
  }

  /** Stops listening. Not part of the Tauri `Channel` API, but harmless to expose. */
  dispose(): void {
    this.off?.();
    this.off = undefined;
  }
}

/** Errors when `window.omnyssh` isn't present (Vitest, `vite preview` outside
 *  Electron) — every command then rejects with a real `Error`, exactly like
 *  the old bindings did off a Tauri runtime. */
function bridge(): OmnysshBridge {
  if (typeof window === 'undefined' || !window.omnyssh) {
    throw new Error('the Electron bridge (window.omnyssh) is unavailable in this environment');
  }
  return window.omnyssh;
}

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  return bridge().invoke(channel, ...args);
}

async function call<T>(channel: string, ...args: unknown[]): Promise<Result<T, CommandError>> {
  try {
    return { status: 'ok', data: (await invoke(channel, ...args)) as T };
  } catch (e) {
    if (e instanceof Error) throw e;
    return { status: 'error', error: e as CommandError };
  }
}
