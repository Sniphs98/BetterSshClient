import { expect, test, type Page } from '@playwright/test';

// Remote Desktop (RDP only this round — see the feature plan): a new sidebar area,
// reached via the top SSH/Remote Desktop switch, that manages RDP connection profiles
// and launches them via the OS's native client. e2e runs against the static SPA with
// the Electron preload bridge absent, so we install a `window.omnyssh` stub;
// `rdp_launch` just records the call (the real OS-process spawn is covered by
// core/rdp/launch.test.ts on the electron side).
type Rec = Record<string, unknown>;

async function boot(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const win = window as unknown as Record<string, unknown>;
    const listeners: Record<string, Array<(payload: unknown) => void>> = {};
    const state: { connections: Rec[] } = { connections: [] };
    const rdpLaunchCalls: string[] = [];
    win.__rdpLaunchCalls = rdpLaunchCalls;

    win.omnyssh = {
      invoke: (channel: string, ...rawArgs: unknown[]) => {
        const args = rawArgs.map((a) => structuredClone(a));
        switch (channel) {
          case 'list_hosts':
            return Promise.resolve([]);
          case 'reload_hosts':
            return Promise.resolve(null);
          case 'list_remote_desktop_connections':
            return Promise.resolve([...state.connections]);
          case 'save_remote_desktop_connection': {
            const c = args[0] as Rec & { id: string; password?: string };
            const i = state.connections.findIndex((x) => x.id === c.id);
            const hasPassword = c.password !== undefined && c.password !== null
              ? true
              : i >= 0
                ? Boolean((state.connections[i] as Rec).hasPassword)
                : false;
            const stored = { ...c, hasPassword };
            delete (stored as Rec).password;
            if (i >= 0) state.connections[i] = stored;
            else state.connections.push(stored);
            return Promise.resolve(null);
          }
          case 'delete_remote_desktop_connection': {
            state.connections = state.connections.filter((x) => x.id !== args[0]);
            return Promise.resolve(null);
          }
          case 'rdp_launch': {
            rdpLaunchCalls.push(args[0] as string);
            return Promise.resolve(null);
          }
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
  });
  await page.goto('/');
}

test('the top switch swaps the SSH sidebar for the Remote Desktop area', async ({ page }) => {
  await boot(page);

  // SSH mode (default): the existing selectors/spawners are all there.
  await expect(page.getByRole('button', { name: 'Dashboard', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Automations', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'SFTP', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toBeVisible();
  // The switch segments are named "Switch to …", so a plain "Remote Desktop" button
  // can only be the selector row — which doesn't exist yet in SSH mode.
  await expect(page.getByRole('button', { name: 'Remote Desktop', exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: 'Switch to Remote Desktop' }).click();

  // Remote Desktop mode: SSH selectors/spawners are gone, only Remote Desktop remains,
  // and the content area shows the Remote Desktop screen.
  await expect(page.getByRole('button', { name: 'Dashboard', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'SFTP', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Terminal', exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Remote Desktop' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Remote Desktop', exact: true })).toBeVisible();

  // Flipping back to SSH restores the original row set.
  await page.getByRole('button', { name: 'Switch to SSH' }).click();
  await expect(page.getByRole('button', { name: 'Dashboard', exact: true })).toBeVisible();
});

test('create, edit, connect to, and delete an RDP connection', async ({ page }) => {
  await boot(page);
  await page.getByRole('button', { name: 'Switch to Remote Desktop' }).click();
  await expect(page.getByRole('heading', { name: 'Remote Desktop' })).toBeVisible();

  // Two "New connection" buttons while the list is empty (toolbar + empty state),
  // same as the Snippets screen.
  await page.getByRole('button', { name: 'New connection' }).first().click();
  const editor = page.getByRole('dialog', { name: 'New RDP connection' });
  // `exact` — a substring match on "Name" would also hit "Hostname / IP" and "Username".
  await editor.getByLabel('Name', { exact: true }).fill('office-pc');
  await editor.getByLabel('Hostname / IP').fill('10.0.0.5');
  await editor.getByLabel('Username').fill('admin');
  await editor.getByRole('button', { name: 'Add connection' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await expect(page.getByText('office-pc', { exact: true })).toBeVisible();
  await expect(page.getByText('admin@10.0.0.5:3389')).toBeVisible();

  // Connect: fires rdp_launch with this connection's id, no session tab is created.
  await page.getByRole('button', { name: 'Connect to office-pc' }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __rdpLaunchCalls: string[] }).__rdpLaunchCalls.length))
    .toBe(1);

  // Edit: change the hostname, save, see it reflected.
  await page.getByRole('button', { name: 'Edit office-pc' }).click();
  const editEditor = page.getByRole('dialog', { name: 'Edit RDP connection' });
  await editEditor.getByLabel('Hostname / IP').fill('10.0.0.9');
  await editEditor.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('admin@10.0.0.9:3389')).toBeVisible();

  // Delete: confirm dialog, then the card is gone.
  await page.getByRole('button', { name: 'Delete office-pc' }).click();
  await page.getByRole('dialog', { name: 'Delete connection' }).getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByText('office-pc', { exact: true })).toHaveCount(0);
  await expect(page.getByText('No connections yet')).toBeVisible();
});
