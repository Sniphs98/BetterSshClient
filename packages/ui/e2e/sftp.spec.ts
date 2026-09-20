import { expect, test, type Page } from '@playwright/test';

// SFTP dual-pane vertical (tech-gui.md §3.2). e2e runs against the static SPA with the
// Electron preload bridge absent, so we install a `window.omnyssh` stub at the boundary
// (electron.d.ts). The stub owns an in-memory local + remote filesystem: `list_local_dir`
// returns directly, `sftp_*` commands fire the stamped `sftp-*` events the per-session
// forwarder would emit, and a transfer holds at a progress tick until
// `__completeTransfer()` fires its op-done — so the live progress bar is deterministically
// observable. Both spawn paths (a card's `files`, and the SFTP spawner via the host
// picker) are load-bearing for the stage.
const HOSTS = [
  { name: 'web-1', hostname: 'web-1.example.com', user: 'deploy', port: 22, tags: ['prod'], source: 'manual', hasKey: true },
  { name: 'db-1', hostname: 'db-1.example.com', user: 'root', port: 22, tags: [], source: 'manual', hasKey: false }
];

async function boot(page: Page, opts: { webOneDefaultPath?: string } = {}): Promise<void> {
  await page.addInitScript(
    ({ hosts, webOneDefaultPath }) => {
      const win = window as unknown as Record<string, unknown>;
      const seededHosts = webOneDefaultPath
        ? hosts.map((h) => (h.name === 'web-1' ? { ...h, defaultPath: webOneDefaultPath } : h))
        : hosts;
      const listeners: Record<string, Array<(payload: unknown) => void>> = {};
      let nextSession = 0;
      let nextTransfer = 0;
      let nextTerminal = 0;
      let terminalWriteBuffer = '';
      const terminalCommands: string[] = [];
      win.__terminalCommands = terminalCommands;
      // A pending transfer holds until the test fires its op-done, so the progress bar
      // is observable mid-flight (the core is sequential — one transfer at a time).
      const completions: Array<() => void> = [];

      type Entry = { name: string; path: string; size: number; isDir: boolean };
      const local: Record<string, Entry[]> = {
        '/home/user': [
          { name: 'notes.txt', path: '/home/user/notes.txt', size: 24, isDir: false },
          { name: 'work', path: '/home/user/work', size: 0, isDir: true }
        ]
      };
      const remote: Record<string, Entry[]> = {
        '/': [
          { name: 'config.yml', path: '/config.yml', size: 64, isDir: false },
          { name: 'var', path: '/var', size: 0, isDir: true },
          { name: 'app.log', path: '/app.log', size: 12, isDir: false },
          { name: 'photo.png', path: '/photo.png', size: 2048, isDir: false }
        ],
        '/var/www': [{ name: 'index.html', path: '/var/www/index.html', size: 10, isDir: false }]
      };
      const remoteContents: Record<string, string> = { '/config.yml': 'key: value\n' };

      function parentOf(p: string): string {
        const i = p.lastIndexOf('/');
        return i <= 0 ? '/' : p.slice(0, i);
      }
      function baseName(p: string): string {
        return p.slice(p.lastIndexOf('/') + 1);
      }
      function withParent(path: string, entries: Entry[]): Entry[] {
        if (path === '/') return entries;
        return [{ name: '..', path: parentOf(path), size: 0, isDir: true }, ...entries];
      }
      function addFile(fs: Record<string, Entry[]>, dir: string, name: string): void {
        const list = (fs[dir] ||= []);
        if (!list.some((e) => e.name === name)) {
          list.push({ name, path: dir === '/' ? `/${name}` : `${dir}/${name}`, size: 8, isDir: false });
        }
      }

      function fire(channel: string, payload: unknown): void {
        for (const cb of listeners[channel] ?? []) cb(payload);
      }

      // Fire the oldest still-pending transfer's op-done (deterministic completion).
      win.__completeTransfer = () => completions.shift()?.();

      win.omnyssh = {
        invoke: (channel: string, ...args: unknown[]) => {
          switch (channel) {
            case 'list_hosts':
              return Promise.resolve(seededHosts);
            case 'reload_hosts':
              return Promise.resolve(null);
            case 'list_local_dir': {
              const path = args[0] as string;
              return Promise.resolve(withParent(path, local[path] ?? []));
            }
            case 'sftp_open': {
              const sid = ++nextSession;
              const hostName = args[0] as string;
              setTimeout(() => fire('sftp-connected', { sessionId: sid, hostName }), 0);
              return Promise.resolve(sid);
            }
            case 'sftp_list': {
              const [sessionId, path] = args as [number, string];
              setTimeout(
                () => fire('sftp-dir-listed', { sessionId, path, entries: withParent(path, remote[path] ?? []) }),
                0
              );
              return Promise.resolve(null);
            }
            case 'sftp_upload': {
              const [sessionId, , dest] = args as [number, string, string];
              const tid = ++nextTransfer;
              setTimeout(() => fire('transfer-progress', { sessionId, transferId: tid, done: 4, total: 8 }), 0);
              completions.push(() => {
                addFile(remote, parentOf(dest), baseName(dest));
                fire('sftp-op-done', { sessionId, ok: true });
              });
              return Promise.resolve(null);
            }
            case 'sftp_download': {
              const [sessionId, dest] = args as [number, string, string];
              const tid = ++nextTransfer;
              setTimeout(() => fire('transfer-progress', { sessionId, transferId: tid, done: 2, total: 8 }), 0);
              completions.push(() => {
                addFile(local, parentOf(dest), baseName(dest));
                fire('sftp-op-done', { sessionId, ok: true });
              });
              return Promise.resolve(null);
            }
            case 'sftp_delete': {
              const [sessionId, path] = args as [number, string];
              const dir = parentOf(path);
              remote[dir] = (remote[dir] ?? []).filter((e) => e.path !== path);
              setTimeout(() => fire('sftp-op-done', { sessionId, ok: true }), 0);
              return Promise.resolve(null);
            }
            case 'sftp_rename': {
              const [sessionId, from, to] = args as [number, string, string];
              const e = (remote[parentOf(from)] ?? []).find((x) => x.path === from);
              if (e) {
                e.path = to;
                e.name = baseName(to);
              }
              setTimeout(() => fire('sftp-op-done', { sessionId, ok: true }), 0);
              return Promise.resolve(null);
            }
            case 'sftp_mkdir': {
              const [sessionId, path] = args as [number, string];
              const dir = parentOf(path);
              const list = (remote[dir] ||= []);
              const name = baseName(path);
              if (!list.some((e) => e.name === name)) list.push({ name, path, size: 0, isDir: true });
              setTimeout(() => fire('sftp-op-done', { sessionId, ok: true }), 0);
              return Promise.resolve(null);
            }
            case 'sftp_read_file': {
              const [, path] = args as [number, string];
              return Promise.resolve(remoteContents[path] ?? '');
            }
            case 'sftp_preview': {
              const [sessionId, path] = args as [number, string];
              setTimeout(() => fire('file-preview', { sessionId, path, content: remoteContents[path] ?? '' }), 0);
              return Promise.resolve(null);
            }
            case 'sftp_write_file': {
              const [, path, content] = args as [number, string, string];
              remoteContents[path] = content;
              win.__lastWrittenPath = path;
              win.__lastWrittenContent = content;
              return Promise.resolve(null);
            }
            case 'sftp_close':
              return Promise.resolve(null);
            // A minimal Flow library — just enough for the "Run flow with this file"
            // context menu item (SftpView.svelte) to have something file-eligible (a
            // `'text'` param) to list and prefill. No `run_flow`/`automation-*` stub:
            // the feature under test is the prefill, not a full run.
            case 'list_flows':
              return Promise.resolve([
                { name: 'unzip', params: [{ name: 'archive', kind: 'text' }], nodes: [], edges: [] }
              ]);
            case 'terminal_open': {
              const sid = ++nextTerminal;
              return Promise.resolve(sid);
            }
            case 'terminal_write': {
              const [, data] = args as [number, number[]];
              terminalWriteBuffer += String.fromCharCode(...data);
              const lines = terminalWriteBuffer.split('\n');
              terminalWriteBuffer = lines.pop() ?? '';
              terminalCommands.push(...lines);
              return Promise.resolve(null);
            }
            case 'terminal_resize':
            case 'terminal_close':
              return Promise.resolve(null);
            default:
              return Promise.resolve(null);
          }
        },
        on: (channel: string, cb: (payload: unknown) => void) => {
          (listeners[channel] ||= []).push(cb);
          return () => {
            listeners[channel] = (listeners[channel] ?? []).filter((x) => x !== cb);
          };
        },
        settings: { get: () => Promise.resolve(undefined), set: () => Promise.resolve() },
        openExternal: () => Promise.resolve(),
        homeDir: () => Promise.resolve('/home/user'),
        getPathForFile: () => ''
      };
    },
    { hosts: HOSTS, webOneDefaultPath: opts.webOneDefaultPath }
  );

  await page.goto('/');
  await expect(page.getByText('2 hosts')).toBeVisible();
}

test('host-first: a card’s files opens SFTP and browses both sides', async ({ page }) => {
  await boot(page);

  // Host-first spawn — a Dashboard card's `files`, no picker (tech-gui.md §2, §3.2).
  await page.getByTitle('files on web-1').click();

  await expect(page.getByRole('button', { name: 'web-1 · sftp', exact: true })).toBeVisible();
  const localPane = page.getByRole('region', { name: 'Local' });
  const remotePane = page.getByRole('region', { name: 'web-1' });

  // Both panes list their own filesystem, from distinct commands (local direct, remote event).
  await expect(localPane.getByText('notes.txt')).toBeVisible();
  await expect(remotePane.getByText('config.yml')).toBeVisible();
});

test('round-trip: upload a local file to the remote, then download a remote file', async ({
  page
}) => {
  await boot(page);
  await page.getByTitle('files on web-1').click();

  const localPane = page.getByRole('region', { name: 'Local' });
  const remotePane = page.getByRole('region', { name: 'web-1' });
  await expect(localPane.getByText('notes.txt')).toBeVisible();
  await expect(remotePane.getByText('config.yml')).toBeVisible();

  // Upload: mark the local file, click Upload — the live progress bar shows mid-flight.
  await localPane.getByRole('checkbox', { name: 'Mark notes.txt' }).click();
  await page.getByRole('button', { name: 'Upload' }).click();
  await expect(page.getByLabel('transfer progress')).toBeVisible();

  // Complete it: op-done drains the batch, the remote pane re-lists with the new file.
  await page.evaluate(() => (window as unknown as { __completeTransfer: () => void }).__completeTransfer());
  await expect(remotePane.getByText('notes.txt')).toBeVisible();
  await expect(page.getByLabel('transfer progress')).toHaveCount(0);

  // Download: mark a remote file, click Download, complete — the local pane re-lists it.
  await remotePane.getByRole('checkbox', { name: 'Mark config.yml' }).click();
  await page.getByRole('button', { name: 'Download' }).click();
  await expect(page.getByLabel('transfer progress')).toBeVisible();
  await page.evaluate(() => (window as unknown as { __completeTransfer: () => void }).__completeTransfer());
  await expect(localPane.getByText('config.yml')).toBeVisible();
});

test('an inactive tab’s modal never overlays another entity (§2 exactly-one-active)', async ({
  page
}) => {
  await boot(page);
  await page.getByTitle('files on web-1').click();
  await expect(page.getByRole('region', { name: 'web-1', exact: true })).toBeVisible();
  // Return to the Dashboard (a session hides it) to open a second SFTP session.
  await page.getByRole('button', { name: 'Dashboard', exact: true }).click();
  await page.getByTitle('files on db-1').click();
  await expect(page.getByRole('region', { name: 'db-1', exact: true })).toBeVisible();

  // Open db-1's New-folder modal. The modal scrim traps the sidebar, so the ⌘K
  // navigator is the reachable way to switch entity while a modal is open.
  await page.getByRole('button', { name: 'Folder' }).click();
  await expect(page.getByRole('dialog', { name: 'New folder' })).toBeVisible();
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await palette.getByRole('textbox').fill('web-1');
  await page.keyboard.press('Enter');

  // Activating the web-1 session must fully hide db-1's modal — never two at once.
  await expect(page.getByRole('region', { name: 'web-1', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'New folder' })).toHaveCount(0);
});

test('action-first: the SFTP spawner opens the host picker, then a live session', async ({
  page
}) => {
  await boot(page);

  await page.getByRole('button', { name: 'SFTP', exact: true }).click();
  await page.getByRole('dialog').getByText('web-1', { exact: true }).click();

  await expect(page.getByRole('button', { name: 'web-1 · sftp', exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'web-1' }).getByText('config.yml')).toBeVisible();
});

test('click selects a single entry; shift-click ranges; ctrl-click toggles within it', async ({
  page
}) => {
  await boot(page);
  await page.getByTitle('files on web-1').click();
  const remotePane = page.getByRole('region', { name: 'web-1', exact: true });
  await expect(remotePane.getByText('app.log')).toBeVisible();
  const mark = (name: string) => remotePane.getByRole('checkbox', { name: `Mark ${name}` });

  // A plain click selects just that entry.
  await remotePane.getByTitle('config.yml').click();
  await expect(mark('config.yml')).toHaveAttribute('aria-checked', 'true');
  await expect(mark('var')).toHaveAttribute('aria-checked', 'false');
  await expect(mark('app.log')).toHaveAttribute('aria-checked', 'false');

  // Shift-clicking the last entry selects the whole run in between too, not just the
  // two ends — config.yml, var, app.log are contiguous in the listing.
  await remotePane.getByTitle('app.log').click({ modifiers: ['Shift'] });
  await expect(mark('config.yml')).toHaveAttribute('aria-checked', 'true');
  await expect(mark('var')).toHaveAttribute('aria-checked', 'true');
  await expect(mark('app.log')).toHaveAttribute('aria-checked', 'true');

  // Ctrl-click removes just that one entry from the selection, leaving the rest marked.
  await remotePane.getByTitle('var').click({ modifiers: ['Control'] });
  await expect(mark('config.yml')).toHaveAttribute('aria-checked', 'true');
  await expect(mark('var')).toHaveAttribute('aria-checked', 'false');
  await expect(mark('app.log')).toHaveAttribute('aria-checked', 'true');

  // A later plain click elsewhere replaces the whole selection again. A directory would
  // navigate on a plain click instead (tested separately), so this uses a file.
  await remotePane.getByTitle('config.yml').click();
  await expect(mark('config.yml')).toHaveAttribute('aria-checked', 'true');
  await expect(mark('var')).toHaveAttribute('aria-checked', 'false');
  await expect(mark('app.log')).toHaveAttribute('aria-checked', 'false');
});

test('a single click navigates into a folder; on a file it only selects', async ({ page }) => {
  await boot(page);
  await page.getByTitle('files on web-1').click();
  const remotePane = page.getByRole('region', { name: 'web-1', exact: true });
  await expect(remotePane.getByText('config.yml')).toBeVisible();

  // A file click selects it — it must not navigate or open anything.
  await remotePane.getByTitle('config.yml').click();
  await expect(remotePane.getByRole('checkbox', { name: 'Mark config.yml' })).toHaveAttribute(
    'aria-checked',
    'true'
  );
  await expect(remotePane.getByText('var')).toBeVisible();

  // A folder click navigates straight in — no double-click needed.
  await remotePane.getByTitle('var').click();
  await expect(remotePane.getByText('..')).toBeVisible();
  await expect(remotePane.getByText('config.yml')).toHaveCount(0);
});

test('right-click opens a context menu; Delete asks for confirmation, then removes the entry', async ({
  page
}) => {
  await boot(page);
  await page.getByTitle('files on web-1').click();
  const remotePane = page.getByRole('region', { name: 'web-1', exact: true });
  await expect(remotePane.getByText('app.log')).toBeVisible();

  await remotePane.getByTitle('app.log').click({ button: 'right' });
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  // Right-clicking an unselected entry selects just it, so Rename (single-only) is offered.
  await expect(menu.getByRole('menuitem', { name: 'Rename' })).toBeEnabled();

  await menu.getByRole('menuitem', { name: 'Delete' }).click();
  await expect(page.getByRole('menu')).toHaveCount(0);

  // Deleting is destructive with no undo, so it's confirmed before anything happens.
  const confirm = page.getByRole('dialog', { name: 'Delete' });
  await expect(confirm).toBeVisible();
  await expect(confirm.getByText('“app.log”')).toBeVisible();
  await expect(remotePane.getByText('app.log')).toBeVisible();

  await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(remotePane.getByText('app.log')).toHaveCount(0);
  await expect(remotePane.getByText('config.yml')).toBeVisible();
});

test('cancelling the delete confirmation leaves the entry alone', async ({ page }) => {
  await boot(page);
  await page.getByTitle('files on web-1').click();
  const remotePane = page.getByRole('region', { name: 'web-1', exact: true });
  await expect(remotePane.getByText('app.log')).toBeVisible();

  await remotePane.getByTitle('app.log').click({ button: 'right' });
  await page.getByRole('menu').getByRole('menuitem', { name: 'Delete' }).click();

  const confirm = page.getByRole('dialog', { name: 'Delete' });
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(remotePane.getByText('app.log')).toBeVisible();
});

test('right-click on empty pane space offers New folder without selecting anything', async ({
  page
}) => {
  await boot(page);
  await page.getByTitle('files on web-1').click();
  const remotePane = page.getByRole('region', { name: 'web-1', exact: true });
  await expect(remotePane.getByText('config.yml')).toBeVisible();

  // Right-click the region below the listed rows, not any specific entry. The three
  // short rows don't fill the scrollable pane, so its own bottom edge is always clear.
  const region = page.getByRole('region', { name: 'web-1 file list' });
  const box = await region.boundingBox();
  await region.click({ button: 'right', position: { x: 10, y: (box?.height ?? 200) - 10 } });
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'New folder' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Rename' })).toHaveCount(0);

  await menu.getByRole('menuitem', { name: 'New folder' }).click();
  await expect(page.getByRole('dialog', { name: 'New folder' })).toBeVisible();
});

test('"Run flow with this file" prefills the clicked file\'s path and this host', async ({ page }) => {
  await boot(page);
  await page.getByTitle('files on web-1').click();
  const remotePane = page.getByRole('region', { name: 'web-1', exact: true });
  await expect(remotePane.getByText('app.log')).toBeVisible();

  await remotePane.getByTitle('app.log').click({ button: 'right' });
  const menu = page.getByRole('menu');
  await menu.getByRole('menuitem', { name: 'Run flow with this file…' }).click();

  // Fetching the flow library is async, so the first menu closes and a second one opens
  // once it resolves — listing every flow with a `'text'` param to hold the file's path.
  const flowMenu = page.getByRole('menu');
  await expect(flowMenu).toBeVisible();
  await flowMenu.getByRole('menuitem', { name: 'unzip' }).click();

  const runDialog = page.getByRole('dialog', { name: 'Run flow' });
  await expect(runDialog).toBeVisible();
  await expect(runDialog.getByRole('textbox')).toHaveValue('/app.log');

  await runDialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('"Run flow with this file" is disabled for a directory', async ({ page }) => {
  await boot(page);
  await page.getByTitle('files on web-1').click();
  const remotePane = page.getByRole('region', { name: 'web-1', exact: true });
  await expect(remotePane.getByText('var')).toBeVisible();

  await remotePane.getByTitle('var').click({ button: 'right' });
  await expect(page.getByRole('menu').getByRole('menuitem', { name: 'Run flow with this file…' })).toBeDisabled();
});

test("a host's default path opens the remote pane there instead of the server root", async ({
  page
}) => {
  await boot(page, { webOneDefaultPath: '/var/www' });
  await page.getByTitle('files on web-1').click();

  const remotePane = page.getByRole('region', { name: 'web-1', exact: true });
  await expect(remotePane.getByText('index.html')).toBeVisible();
  await expect(remotePane.getByText('config.yml')).toHaveCount(0);
});

test('editing a text file opens Monaco, and Save writes the content back', async ({ page }) => {
  await boot(page);
  await page.getByTitle('files on web-1').click();
  const remotePane = page.getByRole('region', { name: 'web-1', exact: true });
  await expect(remotePane.getByText('config.yml')).toBeVisible();

  await remotePane.getByTitle('config.yml').click({ button: 'right' });
  const menu = page.getByRole('menu');
  await menu.getByRole('menuitem', { name: 'Open' }).click();

  const editorDialog = page.getByRole('dialog', { name: 'Edit /config.yml' });
  await expect(editorDialog).toBeVisible();
  // Monaco is dynamically imported and boots a real worker — give it real time.
  await expect(editorDialog.locator('.monaco-editor')).toBeVisible({ timeout: 15_000 });

  // Click the rendered text surface, not Monaco's hidden EditContext input target (it
  // has no visible box of its own) — exactly what a real user clicks, which focuses the
  // input as a side effect.
  await editorDialog.locator('.monaco-editor .view-lines').click();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('key: changed');

  const saveButton = editorDialog.getByRole('button', { name: 'Save' });
  await expect(saveButton).toBeEnabled();
  await saveButton.click();
  await expect(editorDialog).toHaveCount(0);

  const written = await page.evaluate(
    () => (window as unknown as { __lastWrittenPath?: string; __lastWrittenContent?: string }).__lastWrittenContent
  );
  expect(written).toBe('key: changed');
});

test('hiding local files leaves only the remote pane, and can be undone', async ({ page }) => {
  await boot(page);
  await page.getByTitle('files on web-1').click();
  await expect(page.getByRole('region', { name: 'Local', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Hide local files' }).click();
  await expect(page.getByRole('region', { name: 'Local', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'web-1', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Show local files' }).click();
  await expect(page.getByRole('region', { name: 'Local', exact: true })).toBeVisible();
});

test('the terminal drawer opens cd\'d into the current remote directory, and closes', async ({ page }) => {
  await boot(page);
  await page.getByTitle('files on web-1').click();
  const remotePane = page.getByRole('region', { name: 'web-1' });
  await expect(remotePane.getByText('config.yml')).toBeVisible();

  await page.getByRole('button', { name: 'Open a terminal here' }).click();
  // xterm is dynamically imported — give it real time to mount.
  await expect(page.locator('.xterm')).toBeVisible({ timeout: 15_000 });

  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __terminalCommands: string[] }).__terminalCommands))
    .toEqual(["cd '/'"]);

  await page.getByRole('button', { name: 'Close terminal' }).click();
  await expect(page.locator('.xterm')).toHaveCount(0);
});

test('navigating the remote pane while the terminal is open does not restart the shell', async ({ page }) => {
  await boot(page);
  await page.getByTitle('files on web-1').click();
  const remotePane = page.getByRole('region', { name: 'web-1' });

  await page.getByRole('button', { name: 'Open a terminal here' }).click();
  await expect(page.locator('.xterm')).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __terminalCommands: string[] }).__terminalCommands))
    .toEqual(["cd '/'"]);

  // Navigate the remote pane to a different directory while the drawer is open.
  await remotePane.getByText('var', { exact: true }).dblclick();
  await expect(remotePane.getByText('..', { exact: true })).toBeVisible();

  // The drawer stayed mounted (one xterm instance, no remount) and never sent a second cd.
  await expect(page.locator('.xterm')).toHaveCount(1);
  const commands = await page.evaluate(() => (window as unknown as { __terminalCommands: string[] }).__terminalCommands);
  expect(commands).toEqual(["cd '/'"]);
});

test('Open falls back to a read-only preview for a binary file the editor refuses', async ({ page }) => {
  await boot(page);
  await page.getByTitle('files on web-1').click();
  const remotePane = page.getByRole('region', { name: 'web-1', exact: true });
  await expect(remotePane.getByText('photo.png')).toBeVisible();

  await remotePane.getByTitle('photo.png').click({ button: 'right' });
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: 'Open' })).toBeEnabled();
  await menu.getByRole('menuitem', { name: 'Open' }).click();

  await expect(page.getByRole('dialog', { name: 'File preview' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Edit /photo.png' })).toHaveCount(0);
});
