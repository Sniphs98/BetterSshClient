import { expect, test, type Page } from '@playwright/test';

// Settings + self-update (tech-gui.md §4.3). e2e runs against the static SPA with the
// Electron preload bridge absent, so we install a `window.bsshClient` stub at the boundary
// (electron.d.ts). The stub backs the update config in memory and returns an update from
// `check_update`; `update-available` is fired after `reload_hosts` (which the layout calls
// once its listeners are attached), mirroring the startup check.
const HOSTS = [
  { name: 'web-1', hostname: 'web-1.example.com', user: 'deploy', port: 22, tags: [], source: 'manual', hasKey: true }
];

const UPDATE = {
  version: '2.0.0',
  url: 'https://github.com/timhartmann7/better-ssh-client/releases/tag/v2.0.0',
  tag: 'v2.0.0',
  canSelfUpdate: true
};

async function boot(page: Page, opts: { fireUpdateOnBoot: boolean }): Promise<void> {
  await page.addInitScript(
    ({ hosts, update, fireUpdateOnBoot }) => {
      const listeners: Record<string, Array<(payload: unknown) => void>> = {};
      const state = {
        hosts: hosts.map((h) => ({ ...h })),
        updateConfig: { checkOnStartup: true, skipVersion: '' } as Record<string, unknown>
      };
      const win = window as unknown as Record<string, unknown>;

      function fire(channel: string, payload: unknown): void {
        for (const cb of listeners[channel] ?? []) cb(payload);
      }

      win.bsshClient = {
        invoke: (channel: string, ...args: unknown[]) => {
          switch (channel) {
            case 'list_hosts':
              return Promise.resolve([...state.hosts]);
            case 'reload_hosts':
              setTimeout(() => {
                fire('hosts-loaded', [...state.hosts]);
                if (fireUpdateOnBoot) fire('update-available', { info: update });
              }, 0);
              return Promise.resolve(null);
            case 'refresh_metrics':
              return Promise.resolve(null);
            case 'load_update_config':
              return Promise.resolve({ ...state.updateConfig });
            case 'save_update_config':
              state.updateConfig = { ...(args[0] as Record<string, unknown>) };
              win.__savedUpdateConfig = { ...(args[0] as Record<string, unknown>) };
              return Promise.resolve(null);
            case 'check_update':
              return Promise.resolve({ ...update });
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
    { hosts: HOSTS, update: UPDATE, fireUpdateOnBoot: opts.fireUpdateOnBoot }
  );
  await page.goto('/');
  await expect(page.getByText('web-1', { exact: true })).toBeVisible();
}

test('the footer gear opens Settings; theme, interval, and update prefs work', async ({ page }) => {
  await boot(page, { fireUpdateOnBoot: false });

  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

  // Theme mirrors the sidebar toggle (§5.1): the app boots dark; picking Light flips it.
  // `exact` avoids the sidebar toggle whose label reads "Switch to light theme".
  await page.getByRole('button', { name: 'Light', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

  // Auto-refresh interval is a segmented pref.
  const tenSec = page.getByRole('button', { name: '10s', exact: true });
  await tenSec.click();
  await expect(tenSec).toHaveAttribute('aria-pressed', 'true');

  // Check-on-startup persists via save_update_config (seeded true → toggles false).
  const startupSwitch = page.getByRole('switch', { name: 'Check for updates on startup' });
  await expect(startupSwitch).toHaveAttribute('aria-checked', 'true');
  await startupSwitch.click();
  await expect(startupSwitch).toHaveAttribute('aria-checked', 'false');

  // A manual check surfaces the available version and raises the banner.
  await page.getByRole('button', { name: 'Check now' }).click();
  await expect(page.getByText('Version 2.0.0 is available.')).toBeVisible();
  await expect(page.getByText('Update available — v2.0.0')).toBeVisible();
});

test('startup update-available raises the banner; dismiss hides it', async ({ page }) => {
  await boot(page, { fireUpdateOnBoot: true });

  const banner = page.getByText('Update available — v2.0.0');
  await expect(banner).toBeVisible();

  await page.getByRole('button', { name: 'Dismiss update notice' }).click();
  await expect(banner).toHaveCount(0);
});

test('a settings toggle preserves a skipVersion the banner wrote out-of-band', async ({ page }) => {
  await boot(page, { fireUpdateOnBoot: true });

  // Open Settings first so its config cache is seeded stale (skipVersion: '').
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

  // Now Skip on the banner: it writes skipVersion='2.0.0' to the shared config.
  await page.getByRole('button', { name: 'Skip', exact: true }).click();
  await expect(page.getByText('Update available — v2.0.0')).toHaveCount(0);

  // Flipping check-on-startup must read-modify-write fresh, not clobber the skip.
  const startupSwitch = page.getByRole('switch', { name: 'Check for updates on startup' });
  await startupSwitch.click();
  await expect(startupSwitch).toHaveAttribute('aria-checked', 'false');

  const saved = await page.evaluate(
    () => (window as unknown as { __savedUpdateConfig?: Record<string, unknown> }).__savedUpdateConfig
  );
  expect(saved?.skipVersion).toBe('2.0.0');
  expect(saved?.checkOnStartup).toBe(false);
});
