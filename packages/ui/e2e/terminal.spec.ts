import { expect, test, type Page } from '@playwright/test';

// Terminal streaming vertical (tech-gui.md §3.1). e2e runs against the static SPA with
// the Electron preload bridge absent, so we install a `window.bsshClient` stub at the
// boundary (electron.d.ts). `terminal_open` streams a prompt through the per-session
// `terminal-output-<id>` channel the real `Channel.attach()` subscribes to right after
// `terminal_open` resolves (proving raw output renders); `terminal_write` echoes a canned
// line on Enter (proving input round-trips). The host-first path (a Dashboard card's
// `sh`, no picker) is the load-bearing automation the stage requires.
const HOSTS = [
  { name: 'web-1', hostname: 'web-1.example.com', user: 'deploy', port: 22, tags: ['prod'], source: 'manual', hasKey: true },
  { name: 'db-1', hostname: 'db-1.example.com', user: 'root', port: 22, tags: [], source: 'manual', hasKey: false }
];

async function boot(
  page: Page,
  opts: { webOneDefaultPath?: string; webOneStartupCommand?: string; gpu?: boolean } = {}
): Promise<void> {
  await page.addInitScript(
    ({ hosts, webOneDefaultPath, webOneStartupCommand, gpu }) => {
      const win = window as unknown as Record<string, unknown>;
      // These tests read terminal text back from xterm's DOM renderer; with GPU
      // rendering on, it is drawn into a canvas instead.
      localStorage.setItem('better-ssh-client-terminal-gpu', String(gpu));
      const seededHosts = hosts.map((h) =>
        h.name === 'web-1'
          ? {
              ...h,
              ...(webOneDefaultPath ? { defaultPath: webOneDefaultPath } : {}),
              ...(webOneStartupCommand ? { startupCommand: webOneStartupCommand } : {})
            }
          : h
      );
      const listeners: Record<string, Array<(payload: unknown) => void>> = {};
      let nextSession = 0;
      let terminalWriteBuffer = '';
      const terminalCommands: string[] = [];
      win.__terminalCommands = terminalCommands;
      win.__localOpened = [];
      const terminalWrites = { text: '' };
      win.__terminalWrites = terminalWrites;
      const terminalResizes: Array<{ cols: number; rows: number }> = [];
      win.__terminalResizes = terminalResizes;

      function fire(channel: string, payload: unknown): void {
        for (const cb of listeners[channel] ?? []) cb(payload);
      }
      function sendToTerminal(sessionId: number, text: string): void {
        // The real path delivers an ArrayBuffer; mirror that so xterm's Uint8Array wrap works.
        fire(`terminal-output-${sessionId}`, new TextEncoder().encode(text).buffer);
      }

      // Lets a test push arbitrary output (escape sequences included) at the terminal.
      win.__sendToTerminal = sendToTerminal;

      // Lets a test simulate the remote shell exiting for a given backend session id.
      win.__fireTerminalExited = (sessionId: number) => fire('terminal-exited', { sessionId });

      win.bsshClient = {
        invoke: (channel: string, ...args: unknown[]) => {
          switch (channel) {
            case 'list_hosts':
              return Promise.resolve(seededHosts);
            case 'reload_hosts':
              return Promise.resolve(null);
            // Local terminals: the shells "found" on this machine, and opening one.
            case 'terminal_profiles':
              return Promise.resolve([
                { id: 'pwsh', label: 'PowerShell', kind: 'powershell' },
                { id: 'wsl:Ubuntu', label: 'Ubuntu (WSL)', kind: 'wsl' }
              ]);
            case 'terminal_open_local': {
              const sid = ++nextSession;
              (win.__localOpened as unknown[]).push(args[0]);
              setTimeout(() => sendToTerminal(sid, `local-${String(args[0])}> `), 0);
              return Promise.resolve(sid);
            }
            case 'terminal_open': {
              const sid = ++nextSession;
              // A shell prompt proves the streamed output renders + flips status to connected.
              setTimeout(() => sendToTerminal(sid, 'better-ssh-client-ready> '), 0);
              return Promise.resolve(sid);
            }
            case 'terminal_write': {
              const [sessionId, data] = args as [number, number[]];
              // Track whole lines written (splitting on \n) so a test can assert an
              // autocd command was sent, same idea as the Enter-triggered echo below.
              terminalWrites.text += String.fromCharCode(...data);
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
            case 'terminal_resize': {
              const [, cols, rows] = args as [number, number, number];
              terminalResizes.push({ cols, rows });
              return Promise.resolve(null);
            }
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
    {
      hosts: HOSTS,
      webOneDefaultPath: opts.webOneDefaultPath,
      webOneStartupCommand: opts.webOneStartupCommand,
      gpu: opts.gpu ?? false
    }
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
  await expect(page.locator('.xterm-rows')).toContainText('better-ssh-client-ready');

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
  await expect(page.locator('.xterm-rows')).toContainText('better-ssh-client-ready');

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
  await expect(page.locator('.xterm-rows')).toContainText('better-ssh-client-ready');
});

test('Local terminal offers the shells on this computer and opens one without a host', async ({ page }) => {
  await boot(page);

  await page.getByRole('button', { name: /Local terminal/ }).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem')).toHaveText(['PowerShell', 'Ubuntu (WSL)']);
  await menu.getByRole('menuitem', { name: 'Ubuntu (WSL)' }).click();

  // A tab named after the shell, marked local, streaming like any terminal.
  await expect(page.getByRole('button', { name: 'Ubuntu (WSL) · local terminal', exact: true })).toBeVisible();
  await expect(page.locator('.xterm-rows')).toContainText('local-wsl:Ubuntu>');
  expect(await page.evaluate(() => (window as unknown as { __localOpened: string[] }).__localOpened)).toEqual(['wsl:Ubuntu']);

  // Typing reaches it; no host's default path or startup command is sent first.
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('uname');
  await page.keyboard.press('Enter');
  await expect(page.locator('.xterm-rows')).toContainText('RESULT-OK');
  expect(await page.evaluate(() => (window as unknown as { __terminalCommands: string[] }).__terminalCommands)).toEqual([]);
});

test('toggling the theme re-themes a live terminal (§5.1)', async ({ page }) => {
  await boot(page);
  await page.getByTitle('sh on web-1').click();
  await expect(page.locator('.xterm-rows')).toContainText('better-ssh-client-ready');

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

test('right-click opens a Copy/Paste menu by default, and pastes directly once switched', async ({
  page,
  context
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await boot(page);
  await page.evaluate(() => navigator.clipboard.writeText('echo from-clipboard'));

  await page.getByTitle('sh on web-1').click();
  await expect(page.locator('.xterm-rows')).toContainText('better-ssh-client-ready');

  // Default: a menu, so the actions are discoverable without knowing the chord.
  await page.locator('.xterm-screen').click({ button: 'right' });
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: 'Paste' })).toBeVisible();
  // Copy is offered but inert with nothing selected.
  await expect(menu.getByRole('menuitem', { name: 'Copy' })).toBeDisabled();
  await menu.getByRole('menuitem', { name: 'Paste' }).click();
  // The stub doesn't echo, so assert on what actually reached the pty.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __terminalWrites: { text: string } }).__terminalWrites.text))
    .toContain('echo from-clipboard');

  // Switching the setting to "Paste" makes a right-click paste with no menu at all.
  await page.getByLabel('Settings').click();
  await page.getByRole('button', { name: 'Paste', exact: true }).click();
  await page.getByRole('button', { name: 'web-1 · terminal', exact: true }).click();

  await page.evaluate(() => navigator.clipboard.writeText('second-paste'));
  await page.locator('.xterm-screen').click({ button: 'right' });
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __terminalWrites: { text: string } }).__terminalWrites.text))
    .toContain('second-paste');
});

// --- Everyday terminal behaviour -------------------------------------------------
//
// These guard the things a shell needs that the app could plausibly steal: the control
// keys (an app-level menu accelerator or a global chord swallows them before the page
// sees them — that is exactly what Electron's default menu used to do), the line-editing
// keys, and resize. `__terminalWrites` is everything that reached the pty, so each test
// asserts on the actual bytes rather than on echoed output the stub doesn't produce.

/** Everything written to the pty so far. */
function ptyWrites(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as { __terminalWrites: { text: string } }).__terminalWrites.text);
}

async function openTerminal(page: Page): Promise<void> {
  await boot(page);
  await page.getByTitle('sh on web-1').click();
  await expect(page.locator('.xterm-rows')).toContainText('better-ssh-client-ready');
  await page.locator('.xterm-helper-textarea').focus();
  // Ignore the autocd/prompt traffic that precedes what each test presses.
  await page.evaluate(() => {
    (window as unknown as { __terminalWrites: { text: string } }).__terminalWrites.text = '';
  });
}

test('the shell control keys reach the shell, not the app', async ({ page }) => {
  await openTerminal(page);

  // Ctrl+C interrupt, Ctrl+Z suspend, Ctrl+D end-of-file — the three that matter most,
  // and the three Electron's default Edit menu used to eat.
  await page.keyboard.press('Control+c');
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+d');

  await expect.poll(() => ptyWrites(page)).toContain('\x03');
  const writes = await ptyWrites(page);
  expect(writes).toContain('\x1a');
  expect(writes).toContain('\x04');
});

test('readline line-editing keys reach the shell', async ({ page }) => {
  await openTerminal(page);

  await page.keyboard.press('Control+a'); // start of line
  await page.keyboard.press('Control+e'); // end of line
  await page.keyboard.press('Control+u'); // kill line
  await page.keyboard.press('Control+w'); // kill previous word

  await expect.poll(() => ptyWrites(page)).toContain('\x01');
  const writes = await ptyWrites(page);
  expect(writes).toContain('\x05');
  expect(writes).toContain('\x15');
  expect(writes).toContain('\x17');
});

test('history, completion and backspace send their usual sequences', async ({ page }) => {
  await openTerminal(page);

  await page.keyboard.press('ArrowUp'); // previous command
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Tab'); // completion
  await page.keyboard.type('ls');
  await page.keyboard.press('Backspace');

  await expect.poll(() => ptyWrites(page)).toContain('\x1b[A');
  const writes = await ptyWrites(page);
  expect(writes).toContain('\x1b[B');
  expect(writes).toContain('\t');
  expect(writes).toContain('ls');
  expect(writes).toContain('\x7f'); // DEL, which is what a terminal sends for Backspace
});

test('the copy/paste chords are claimed, but plain Ctrl+V still reaches the shell', async ({
  page,
  context
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openTerminal(page);

  // Ctrl+Shift+C/V are the app's, so nothing may leak through to the shell.
  await page.keyboard.press('Control+Shift+c');
  await page.keyboard.press('Control+Shift+v');
  expect(await ptyWrites(page)).toBe('');

  // Plain Ctrl+V is readline's quoted-insert and stays the shell's.
  await page.keyboard.press('Control+v');
  await expect.poll(() => ptyWrites(page)).toContain('\x16');
});

test('resizing the window tells the backend the new size', async ({ page }) => {
  await openTerminal(page);
  await page.evaluate(() => {
    (window as unknown as { __terminalResizes: unknown[] }).__terminalResizes.length = 0;
  });

  await page.setViewportSize({ width: 1100, height: 700 });

  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __terminalResizes: unknown[] }).__terminalResizes.length))
    .toBeGreaterThan(0);
  const [resize] = await page.evaluate(
    () => (window as unknown as { __terminalResizes: Array<{ cols: number; rows: number }> }).__terminalResizes
  );
  expect(resize.cols).toBeGreaterThan(0);
  expect(resize.rows).toBeGreaterThan(0);
});

test('ANSI output renders as styled cells rather than escape codes', async ({ page }) => {
  await boot(page);
  await page.getByTitle('sh on web-1').click();
  await expect(page.locator('.xterm-rows')).toContainText('better-ssh-client-ready');

  await page.evaluate(() => {
    (window as unknown as { __sendToTerminal: (id: number, text: string) => void }).__sendToTerminal(
      1,
      '\u001b[31mRED-TEXT\u001b[0m\r\n'
    );
  });

  const rows = page.locator('.xterm-rows');
  await expect(rows).toContainText('RED-TEXT');
  // The escape bytes must be consumed by the emulator, not printed.
  await expect(rows).not.toContainText('[31m');
});

test("the app's global chords don't hijack keys the shell needs", async ({ page }) => {
  await openTerminal(page);

  // Ctrl+K opens the command palette anywhere else in the app, but in a shell it is
  // kill-to-end-of-line. xterm stops the event before the document-level listener sees
  // it — a regression here (say, moving that listener to the capture phase) would make
  // the palette pop open mid-command instead.
  await page.keyboard.press('Control+k');
  await expect.poll(() => ptyWrites(page)).toContain('\x0b');
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Same for Ctrl+B, which collapses the sidebar elsewhere and moves the cursor back here.
  await page.keyboard.press('Control+b');
  await expect.poll(() => ptyWrites(page)).toContain('\x02');
});

test('with GPU acceleration on, the terminal draws through WebGL', async ({ page }) => {
  await boot(page, { gpu: true });
  await page.getByTitle('sh on web-1').click();
  await expect(page.locator('.xterm')).toBeVisible();
  // The WebGL renderer paints into its own canvas; the DOM renderer has no canvas at all.
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...document.querySelectorAll('.xterm-screen canvas')].some((c) => (c as HTMLCanvasElement).getContext('webgl2') !== null)
      )
    )
    .toBe(true);
});

type CommandsWindow = { __terminalCommands: string[] };

test("a host's startup command runs when its terminal opens, after the cd into its default path", async ({
  page
}) => {
  await boot(page, { webOneDefaultPath: '/var/www', webOneStartupCommand: 'tmux attach || tmux' });
  await page.getByTitle('sh on web-1').click();
  await expect(page.locator('.xterm-rows')).toContainText('better-ssh-client-ready');

  await expect
    .poll(() => page.evaluate(() => (window as unknown as CommandsWindow).__terminalCommands))
    .toEqual(["cd '/var/www'", 'tmux attach || tmux']);
});

test('a host without a startup command runs nothing when its terminal opens', async ({ page }) => {
  await boot(page);
  await page.getByTitle('sh on web-1').click();
  await expect(page.locator('.xterm-rows')).toContainText('better-ssh-client-ready');
  // Give a queued command time to have been sent, then check none was.
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as unknown as CommandsWindow).__terminalCommands)).toEqual([]);
});
