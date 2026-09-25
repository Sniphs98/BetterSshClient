import { expect, test, type Page } from '@playwright/test';

// Remote Desktop (RDP only this round — see the feature plan): a new sidebar area,
// reached via the top SSH/Remote Desktop switch, that manages RDP connection profiles
// and launches them via the OS's native client. e2e runs against the static SPA with
// the Electron preload bridge absent, so we install a `window.bsshClient` stub;
// `rdp_launch` just records the call (the real OS-process spawn is covered by
// core/rdp/launch.test.ts on the electron side).
type Rec = Record<string, unknown>;

const HOSTS = [
  { name: 'bastion', hostname: 'bastion.example.com', user: 'ops', port: 22, tags: [], source: 'manual', hasKey: true }
];

/** `launch`: what `rdp_launch` answers — a result, or `{ error }` to reject with. */
async function boot(page: Page, opts: { launch?: Rec } = {}): Promise<void> {
  await page.addInitScript(({ hosts, launch }) => {
    const win = window as unknown as Record<string, unknown>;
    const listeners: Record<string, Array<(payload: unknown) => void>> = {};
    const state: { connections: Rec[] } = { connections: [] };
    const rdpLaunchCalls: string[] = [];
    win.__rdpLaunchCalls = rdpLaunchCalls;
    win.__rdpConnections = state;

    win.bsshClient = {
      invoke: (channel: string, ...rawArgs: unknown[]) => {
        const args = rawArgs.map((a) => structuredClone(a));
        switch (channel) {
          case 'list_hosts':
            return Promise.resolve(hosts);
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
          case 'rdp_embedded_open':
            // No gateway behind the stub: the in-app viewer has to say so and offer the rest.
            return Promise.reject({ message: 'could not reach 10.0.0.5:3389: connect ECONNREFUSED' });
          case 'rdp_embedded_status':
            return Promise.resolve({});
          case 'rdp_launch': {
            rdpLaunchCalls.push(args[0] as string);
            if (launch && 'error' in launch) return Promise.reject({ message: launch.error });
            return Promise.resolve(launch ?? {});
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
  }, { hosts: HOSTS, launch: opts.launch });
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

  // External: fires rdp_launch with this connection's id, no session tab is created.
  await page.getByRole('button', { name: 'Open office-pc in the Remote Desktop app' }).click();
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

test('a connection through an SSH host, with display and device settings', async ({ page }) => {
  await boot(page, {
    launch: { notice: 'Windows already has a saved password for this host, so Remote Desktop uses that one instead of the one stored here.' }
  });
  await page.getByRole('button', { name: 'Switch to Remote Desktop' }).click();
  await page.getByRole('button', { name: 'New connection' }).first().click();
  const editor = page.getByRole('dialog', { name: 'New RDP connection' });
  await editor.getByLabel('Name', { exact: true }).fill('behind-bastion');
  await editor.getByLabel('Hostname / IP').fill('10.20.0.5');
  await editor.getByLabel('Connect').selectOption('bastion');
  await expect(editor.getByText('Hostname and port are as seen from bastion.')).toBeVisible();

  await editor.getByText('Display & devices').click();
  await editor.getByLabel('Display').selectOption('window');
  await editor.getByLabel('Width').fill('1600');
  await editor.getByLabel('Height').fill('90');
  await editor.getByLabel('Sound').selectOption('off');
  await editor.getByRole('switch', { name: 'Share the clipboard' }).click();
  await expect(editor.getByRole('switch', { name: 'Share the clipboard' })).toHaveAttribute('aria-checked', 'false');
  await editor.getByRole('switch', { name: 'Share my drives' }).click();
  await expect(editor.getByText('Window 1600×90 · Drives · No sound')).toBeVisible();
  await editor.screenshot({ path: 'test-results/rdp-editor-settings.png' });

  await editor.getByRole('button', { name: 'Add connection' }).click();
  await expect(editor.getByText('Window size must be a width and a height between 200 and 8192')).toBeVisible();
  await editor.getByLabel('Height').fill('900');
  await editor.getByRole('button', { name: 'Add connection' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  const saved = await page.evaluate(
    () => (window as unknown as { __rdpConnections: { connections: Rec[] } }).__rdpConnections.connections[0]
  );
  expect(saved).toMatchObject({
    viaHost: 'bastion',
    display: 'window',
    width: 1600,
    height: 900,
    audio: 'off',
    clipboard: false,
    drives: true,
    multiMonitor: false
  });
  await expect(page.getByText('via bastion')).toBeVisible();
  await expect(page.getByText('Window 1600×900', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/rdp-tiles.png' });

  // What the launch had to say is shown.
  await page.getByRole('button', { name: 'Open behind-bastion in the Remote Desktop app' }).click();
  await expect(page.getByRole('status')).toContainText('Windows already has a saved password');

  // Reopened, the settings section is open and shows what was saved.
  await page.getByRole('button', { name: 'Edit behind-bastion' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit RDP connection' });
  await expect(edit.getByLabel('Width')).toHaveValue('1600');
  await expect(edit.getByLabel('Connect')).toHaveValue('bastion');
});

test('a launch that fails says why', async ({ page }) => {
  await boot(page, { launch: { error: 'Remote Desktop (mstsc.exe) was not found' } });
  await page.getByRole('button', { name: 'Switch to Remote Desktop' }).click();
  await page.getByRole('button', { name: 'New connection' }).first().click();
  const editor = page.getByRole('dialog', { name: 'New RDP connection' });
  await editor.getByLabel('Name', { exact: true }).fill('office-pc');
  await editor.getByLabel('Hostname / IP').fill('10.0.0.5');
  await editor.getByRole('button', { name: 'Add connection' }).click();

  await page.getByRole('button', { name: 'Open office-pc in the Remote Desktop app' }).click();
  await expect(page.getByText('Remote Desktop (mstsc.exe) was not found')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open office-pc in the Remote Desktop app' })).toBeEnabled();
});

test('Connect opens the remote desktop in a tab, with the external app as the way out', async ({ page }) => {
  await boot(page);
  await page.getByRole('button', { name: 'Switch to Remote Desktop' }).click();
  await page.getByRole('button', { name: 'New connection' }).first().click();
  const editor = page.getByRole('dialog', { name: 'New RDP connection' });
  await editor.getByLabel('Name', { exact: true }).fill('office-pc');
  await editor.getByLabel('Hostname / IP').fill('10.0.0.5');
  await editor.getByRole('button', { name: 'Add connection' }).click();

  await page.getByRole('button', { name: 'Connect to office-pc' }).click();
  // A session row in the sidebar, and the tab saying what went wrong.
  await expect(page.getByRole('button', { name: 'office-pc · rdp' })).toBeVisible();
  await expect(page.getByText('Could not connect')).toBeVisible();
  await expect(page.getByText('Could not reach 10.0.0.5:3389: connect ECONNREFUSED')).toBeVisible();

  // Its fallback is the external app.
  await page.getByRole('button', { name: 'Open in the Remote Desktop app' }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __rdpLaunchCalls: string[] }).__rdpLaunchCalls.length))
    .toBe(1);

  // Connect again goes to the open tab instead of a second one.
  await page.getByRole('button', { name: 'Switch to Remote Desktop' }).click();
  await page.getByRole('button', { name: 'Remote Desktop', exact: true }).click();
  await page.getByRole('button', { name: 'Connect to office-pc' }).click();
  await expect(page.getByRole('button', { name: 'office-pc · rdp' })).toHaveCount(1);
});
