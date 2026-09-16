import { expect, test, type Page } from '@playwright/test';

// Terminal streaming vertical (tech-gui.md §3.1). e2e runs against the static SPA with
// the Electron preload bridge absent, so we install a `window.omnyssh` stub at the
// boundary (electron.d.ts). `terminal_open` streams a prompt through the per-session
// `terminal-output-<id>` channel the real `Channel.attach()` subscribes to right after
// `terminal_open` resolves (proving raw output renders); `terminal_write` echoes a canned
// line on Enter (proving input round-trips). The host-first path (a Dashboard card's
// `sh`, no picker) is the load-bearing flow the stage requires.
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
      let terminalWriteBuffer = '';
      const terminalCommands: string[] = [];
      win.__terminalCommands = terminalCommands;

      function fire(channel: string, payload: unknown): void {
        for (const cb of listeners[channel] ?? []) cb(payload);
      }
      function sendToTerminal(sessionId: number, text: string): void {
        // The real path delivers an ArrayBuffer; mirror that so xterm's Uint8Array wrap works.
        fire(`terminal-output-${sessionId}`, new TextEncoder().encode(text).buffer);
      }

      // Lets a test simulate the remote shell exiting for a given backend session id.
      win.__fireTerminalExited = (sessionId: number) => fire('terminal-exited', { sessionId });

      win.omnyssh = {
        invoke: (channel: string, ...args: unknown[]) => {
          switch (channel) {
            case 'list_hosts':
              return Promise.resolve(seededHosts);
            case 'reload_hosts':
              return Promise.resolve(null);
            case 'terminal_open': {
              const sid = ++nextSession;
              // A shell prompt proves the streamed output renders + flips status to connected.
              setTimeout(() => sendToTerminal(sid, 'omnyssh-ready> '), 0);
              return Promise.resolve(sid);
            }
            case 'terminal_write': {
              const [sessionId, data] = args as [number, number[]];
              // Track whole lines written (splitting on \n) so a test can assert an
              // autocd command was sent, same idea as the Enter-triggered echo below.
              terminalWriteBuffer += String.fromCharCode(...data);
              const lines = terminalWriteBuffer.split('\n');
              terminalWriteBuffer = lines.pop() ?? '';
              terminalCommands.push(...lines);
              // Echo a canned result once Enter (\r == 13) arrives, so output is assertable.
              if (data.includes(13)) {
                setTimeout(() => sendToTerminal(sessionId, '\r\nRESULT-OK\r\n'), 0);
              }
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
  // The status-bar total confirms the app booted and `list_hosts` resolved.
  await expect(page.getByText('2 hosts')).toBeVisible();
}

test('host-first: spawn a terminal from a card, run a command, see output, then close', async ({
  page
}) => {
  await boot(page);

  // Host-first spawn — a Dashboard card's `sh`, no picker (tech-gui.md §2, §3.1).
  await page.getByTitle('sh on web-1').click();

  // The tab row appears and the terminal renders the streamed prompt.
  await expect(page.getByRole('button', { name: 'web-1 · terminal', exact: true })).toBeVisible();
  await expect(page.locator('.xterm')).toBeVisible();
  await expect(page.locator('.xterm-rows')).toContainText('omnyssh-ready');

  // Run a command: focus the terminal input, type, press Enter -> canned output streams back.
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('hi');
  await page.keyboard.press('Enter');
  await expect(page.locator('.xterm-rows')).toContainText('RESULT-OK');

  // Closing the tab tears the terminal down.
  await page.getByRole('button', { name: 'Close web-1', exact: true }).click();
  await expect(page.locator('.xterm')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'web-1 · terminal', exact: true })).toHaveCount(0);
});

test("a host's default path is cd'd into automatically when its terminal opens", async ({ page }) => {
  await boot(page, { webOneDefaultPath: '/var/www' });
  await page.getByTitle('sh on web-1').click();
  await expect(page.locator('.xterm-rows')).toContainText('omnyssh-ready');

  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __terminalCommands: string[] }).__terminalCommands))
    .toEqual(["cd '/var/www'"]);
});

test('action-first: the Terminal spawner opens the host picker, then a live terminal', async ({
  page
}) => {
  await boot(page);

  // Action-first spawn — the sidebar Terminal spawner opens the host picker (§2).
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await page.getByRole('dialog').getByText('web-1', { exact: true }).click();

  await expect(page.getByRole('button', { name: 'web-1 · terminal', exact: true })).toBeVisible();
  await expect(page.locator('.xterm-rows')).toContainText('omnyssh-ready');
});

test('toggling the theme re-themes a live terminal (§5.1)', async ({ page }) => {
  await boot(page);
  await page.getByTitle('sh on web-1').click();
  await expect(page.locator('.xterm-rows')).toContainText('omnyssh-ready');

  // xterm paints its scrollable viewport inline with theme.background; find that
  // element's computed colour rather than assume a class (robust across versions).
  const paintedBg = () =>
    page.evaluate(() => {
      const root = document.querySelector('.xterm');
      const els = root ? Array.from(root.querySelectorAll<HTMLElement>('*')) : [];
      const painted = els.find((el) => el.style.backgroundColor);
      return painted ? getComputedStyle(painted).backgroundColor : '';
    });

  // App defaults to dark → the dark surface (#212121).
  await expect.poll(paintedBg).toBe('rgb(33, 33, 33)');

  // The #1 theme-regression guard: flipping the store re-themes the OPEN terminal.
  await page.getByTitle('Switch to light theme').click();
  await expect.poll(paintedBg).toBe('rgb(255, 255, 255)');
});

test('a remote exit (terminal-exited) tears the tab down', async ({ page }) => {
  await boot(page);
  await page.getByTitle('sh on web-1').click();
  await expect(page.getByRole('button', { name: 'web-1 · terminal', exact: true })).toBeVisible();
  await expect(page.locator('.xterm')).toBeVisible();

  // The remote shell exits: the backend emits terminal-exited for session id 1.
  await page.evaluate(() => {
    (window as unknown as { __fireTerminalExited: (id: number) => void }).__fireTerminalExited(1);
  });

  await expect(page.getByRole('button', { name: 'web-1 · terminal', exact: true })).toHaveCount(0);
  await expect(page.locator('.xterm')).toHaveCount(0);
});
