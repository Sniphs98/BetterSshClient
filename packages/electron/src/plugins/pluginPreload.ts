import { contextBridge, ipcRenderer } from 'electron';

/**
 * The whole world a plugin sees: the `bssh` object. Loaded into each plugin's
 * sandboxed window (no Node.js, context-isolated), so the plugin's own code
 * can reach nothing but these functions — and every one of them is a message
 * to the main process, which checks the plugin's permissions before doing
 * anything (`plugins/host.ts`).
 *
 * Plugin API version 1.
 */

type CommandHandler = (context: { host?: string }) => unknown;

const handlers = new Map<string, CommandHandler>();

function call(method: string, ...args: unknown[]): Promise<unknown> {
  return ipcRenderer.invoke('plugin:api', method, ...args);
}

// The user picked one of this plugin's commands.
ipcRenderer.on('plugin:run-command', (_event, runId: string, commandId: string, context: { host?: string }) => {
  const handler = handlers.get(commandId);
  Promise.resolve()
    .then(() => {
      if (!handler) throw new Error(`no handler for command "${commandId}"`);
      return handler(context);
    })
    .then(
      () => ipcRenderer.send('plugin:command-done', runId, null),
      (err: unknown) => ipcRenderer.send('plugin:command-done', runId, err instanceof Error ? err.message : String(err))
    );
});

contextBridge.exposeInMainWorld('bssh', {
  apiVersion: 1,

  commands: {
    /** Adds a command to the app's command palette (Ctrl+K). With `needsHost`, the user
     *  picks a host first and the handler gets it as `context.host`. */
    register(id: string, title: string, options: { needsHost?: boolean } | CommandHandler, handler?: CommandHandler): Promise<unknown> {
      const fn = typeof options === 'function' ? options : handler;
      const opts = typeof options === 'function' ? {} : (options ?? {});
      if (typeof fn !== 'function') return Promise.reject(new Error('commands.register needs a handler function'));
      handlers.set(String(id), fn);
      return call('commands.register', String(id), String(title), { needsHost: opts.needsHost === true });
    }
  },

  hosts: {
    /** The user's hosts, without passwords or keys. Needs `hosts:read`. */
    list: () => call('hosts.list'),
    /** Runs `command` on the named host; resolves `{ output, ok, error? }`. Needs `hosts:exec`. */
    exec: (host: string, command: string) => call('hosts.exec', String(host), String(command))
  },

  ui: {
    /** Shows text in a dialog in the app window. */
    showText: (title: string, text: string) => call('ui.showText', String(title), String(text))
  },

  /** Writes to the app's log, tagged with the plugin id. */
  log: (...parts: unknown[]) => call('log', parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' '))
});
