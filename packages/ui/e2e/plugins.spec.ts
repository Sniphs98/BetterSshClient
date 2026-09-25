import { expect, test, type Page } from '@playwright/test';

// The Plugins page. The Electron bridge is stubbed (electron.d.ts): `list_plugins` serves
// one installed, switched-off plugin; switching it on "starts" it, which registers a
// command (`plugin-commands-changed`); running that command records its arguments and
// answers with `plugin-show-text`, the way a real plugin's `bssh.ui.showText` would.
const HOSTS = [{ name: 'web-1', hostname: 'web-1.example.com', user: 'deploy', port: 22, tags: [], source: 'manual', hasKey: true }];

async function boot(page: Page): Promise<void> {
  await page.addInitScript((hosts) => {
    const win = window as unknown as Record<string, unknown>;
    const listeners: Record<string, Array<(payload: unknown) => void>> = {};
    const fire = (channel: string, payload: unknown): void => {
      for (const cb of listeners[channel] ?? []) cb(payload);
    };
    const plugin = {
      id: 'docker-containers',
      name: 'Docker containers',
      version: '1.0.0',
      description: 'Lists the Docker containers on a host.',
      permissions: [{ id: 'hosts:exec', description: 'Run commands on your hosts' }],
      enabled: false,
      running: false,
      hasDocs: true
    };
    const command = {
      pluginId: 'docker-containers',
      pluginName: 'Docker containers',
      commandId: 'containers',
      title: 'Docker: containers on host…',
      needsHost: true
    };
    win.bsshClient = {
      invoke: (channel: string, ...args: unknown[]) => {
        switch (channel) {
          case 'list_hosts':
            return Promise.resolve(hosts);
          case 'reload_hosts':
            setTimeout(() => fire('hosts-loaded', hosts), 0);
            return Promise.resolve(null);
          case 'list_plugins':
            return Promise.resolve([{ ...plugin }]);
          case 'read_plugin_docs':
            return Promise.resolve(
              '# Docker containers\n\nLists **containers**. See [the docs](https://docs.docker.com/).\n\n' +
                '<script>window.__pwned = true</script>\n\n<img src="https://track.example/p.gif" onerror="window.__pwned = true">'
            );
          case 'list_plugin_commands':
            return Promise.resolve(plugin.running ? [command] : []);
          case 'set_plugin_enabled':
            plugin.enabled = args[1] as boolean;
            plugin.running = plugin.enabled;
            setTimeout(() => fire('plugin-commands-changed', { commands: plugin.running ? [command] : [] }), 0);
            return Promise.resolve([{ ...plugin }]);
          case 'run_plugin_command':
            win.__ran = args;
            setTimeout(
              () => fire('plugin-show-text', { pluginName: 'Docker containers', title: `Docker containers on ${String(args[2])}`, text: 'NAME   IMAGE\nweb    nginx' }),
              0
            );
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
      openExternal: (url: string) => {
        win.__opened = url;
        return Promise.resolve();
      },
      homeDir: () => Promise.resolve('/home/user'),
      getPathForFile: () => ''
    };
  }, HOSTS);
  await page.goto('/');
  await expect(page.getByText('web-1', { exact: true })).toBeVisible();
}

test('the puzzle button opens the Plugins page with a card per plugin', async ({ page }) => {
  await boot(page);
  await page.getByRole('button', { name: 'Plugins', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Plugins' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Docker containers' })).toBeVisible();
  await expect(page.getByText('Run commands on your hosts')).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Enable Docker containers' })).toHaveAttribute('aria-checked', 'false');
});

test('switching a plugin on shows its command, which runs on a picked host', async ({ page }) => {
  await boot(page);
  await page.getByRole('button', { name: 'Plugins', exact: true }).click();
  await page.getByRole('switch', { name: 'Enable Docker containers' }).click();
  await expect(page.getByRole('switch', { name: 'Enable Docker containers' })).toHaveAttribute('aria-checked', 'true');

  await page.getByRole('button', { name: 'Docker: containers on host…' }).click();
  await page.getByRole('button', { name: /web-1/ }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Docker containers on web-1')).toBeVisible();
  await expect(dialog.getByText('From the plugin “Docker containers”')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { __ran: unknown[] }).__ran)).toEqual([
    'docker-containers',
    'containers',
    'web-1'
  ]);
});

test("a plugin's README opens as docs, rendered but defused", async ({ page }) => {
  await boot(page);
  await page.getByRole('button', { name: 'Plugins', exact: true }).click();
  await page.getByRole('button', { name: 'Docs for Docker containers' }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Docker containers' })).toBeVisible();
  await expect(dialog.locator('strong')).toHaveText('containers');
  // Neither the script nor the image's handler ran, and no image was put in the page.
  expect(await page.evaluate(() => (window as unknown as { __pwned?: boolean }).__pwned)).toBeUndefined();
  await expect(dialog.locator('img, script')).toHaveCount(0);

  // A link goes to the system browser, not into the app window.
  await dialog.getByRole('link', { name: 'the docs' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __opened?: string }).__opened)).toBe('https://docs.docker.com/');
  await expect(page.getByRole('heading', { name: 'Plugins' })).toBeVisible();
});
