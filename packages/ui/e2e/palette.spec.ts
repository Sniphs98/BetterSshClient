import { expect, test, type Page } from '@playwright/test';

// The ⌘K palette and the host-picker (tech-gui.md §2, Stage 1.3). e2e runs against the
// static SPA with the Electron preload bridge absent, so we install a `window.omnyssh`
// stub to feed `list_hosts` fixtures into the store — the same seam electron.d.ts reserves
// for mocking IPC at the boundary.
const HOSTS = [
  {
    name: 'web-1',
    hostname: 'web-1.example.com',
    user: 'deploy',
    port: 22,
    tags: ['prod'],
    source: 'manual',
    hasKey: true
  },
  {
    name: 'db-1',
    hostname: 'db-1.example.com',
    user: 'root',
    port: 22,
    tags: [],
    source: 'manual',
    hasKey: false
  }
];

async function bootWithHosts(page: Page): Promise<void> {
  await page.addInitScript((hosts) => {
    (window as unknown as { omnyssh: unknown }).omnyssh = {
      invoke: (channel: string) => (channel === 'list_hosts' ? Promise.resolve(hosts) : Promise.resolve(null)),
      on: () => () => {},
      settings: { get: () => Promise.resolve(undefined), set: () => Promise.resolve() },
      openExternal: () => Promise.resolve(),
      homeDir: () => Promise.resolve('/home/user'),
      getPathForFile: () => ''
    };
  }, HOSTS);
  await page.goto('/');
  // The status-bar total confirms `list_hosts` resolved into the store.
  await expect(page.getByText('2 hosts')).toBeVisible();
}

test('⌘K navigator jumps to a host by opening a session', async ({ page }) => {
  await bootWithHosts(page);

  await page.keyboard.press('Control+k');
  const dialog = page.getByRole('dialog', { name: 'Command palette' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox')).toBeFocused();

  await page.keyboard.type('web');
  await page.keyboard.press('Enter');

  await expect(page.getByRole('dialog')).toHaveCount(0);
  const row = page.getByRole('button', { name: 'web-1 · terminal', exact: true });
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('aria-current', 'true');
});

test('⌘K toggles the navigator open and closed', async ({ page }) => {
  await bootWithHosts(page);

  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();

  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('a spawner opens the host-picker and spawns a session for the chosen host', async ({
  page
}) => {
  await bootWithHosts(page);

  await page.getByRole('button', { name: 'Terminal' }).click();
  const picker = page.getByRole('dialog', { name: 'Pick a host' });
  await expect(picker).toBeVisible();

  await picker.getByRole('button', { name: /db-1/ }).click();

  await expect(page.getByRole('dialog')).toHaveCount(0);
  const row = page.getByRole('button', { name: 'db-1 · terminal', exact: true });
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('aria-current', 'true');
});
