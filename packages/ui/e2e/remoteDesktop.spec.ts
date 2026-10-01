import { expect, test, type Page } from '@playwright/test';

// Remote Desktop (RDP only this round — see the feature plan): a new sidebar area,
// reached via the top SSH/Remote Desktop switch, that manages RDP connection profiles
// and launches them via the OS's native client. e2e runs against the static SPA with
// the Electron preload bridge absent, so we install a `window.remoty` stub;
// `rdp_launch` just records the call (the real OS-process spawn is covered by
// core/rdp/launch.test.ts on the electron side).
type Rec = Record<string, unknown>;

const HOSTS = [
  { name: 'bastion', hostname: 'bastion.example.com', user: 'ops', port: 22, tags: [], source: 'manual', hasKey: true }
];

/** `launch`: what `rdp_launch` answers — a result, or `{ error }` to reject with. */
/** `connections`: the profiles saved at start. */
async function boot(page: Page, opts: { launch?: Rec; connections?: Rec[] } = {}): Promise<void> {
  await page.addInitScript(({ hosts, launch, connections }) => {
    const win = window as unknown as Record<string, unknown>;
    const listeners: Record<string, Array<(payload: unknown) => void>> = {};
    const state: { connections: Rec[] } = { connections: (connections ?? []).map((c) => ({ ...c })) };
    // What the import/export channels were called with.
    win.__bundleCalls = [] as unknown[][];
    const rdpLaunchCalls: string[] = [];
    win.__rdpLaunchCalls = rdpLaunchCalls;
    win.__rdpConnections = state;
    win.__rdpTyped = [];

    win.remoty = {
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
          case 'rdp_embedded_open': {
            // A profile without a stored password: the viewer asks first. With what's
            // typed, there's no gateway behind the stub — the viewer has to say so.
            const typed = args[1] as { username: string; password: string } | undefined;
            if (!typed) return Promise.resolve({ kind: 'credentials', username: 'admin' });
            (win.__rdpTyped as unknown[]).push(typed);
            return Promise.reject({ message: 'could not reach 10.0.0.5:3389: connect ECONNREFUSED' });
          }
          case 'rdp_embedded_status':
            return Promise.resolve({});
          case 'export_rdp_profiles':
            (win.__bundleCalls as unknown[][]).push([channel, ...args]);
            return Promise.resolve('/home/user/office-pc.remoty-rdp-profiles.json');
          case 'preview_rdp_profiles_import':
            // A file with one profile whose name is taken here, tunnelled through a host
            // the file carries, and one that's new.
            return Promise.resolve({
              token: 't1',
              fileName: 'team.remoty-rdp-profiles.json',
              profiles: [
                { key: 'profile-0', name: 'office-pc', detail: 'admin@10.0.0.7:3389 via jump', conflict: true, suggestedName: 'office-pc (2)', defaultAction: 'rename', onePassword: true, references: ['op://IT/x/password'], passwordOmitted: false, keyOmitted: false, usedBy: [] },
                { key: 'profile-1', name: 'ts01', detail: 'ts01:3389', conflict: false, suggestedName: 'ts01', defaultAction: 'rename', onePassword: false, references: [], passwordOmitted: true, keyOmitted: false, usedBy: [] }
              ],
              hosts: [
                { key: 'jump', name: 'jump', detail: 'ops@jump.example.com:22', conflict: false, suggestedName: 'jump', defaultAction: 'rename', onePassword: false, references: [], passwordOmitted: false, keyOmitted: true, usedBy: ['office-pc'] }
              ],
              missingTunnelHosts: []
            });
          case 'apply_connection_import': {
            (win.__bundleCalls as unknown[][]).push([channel, ...args]);
            const decisions = args[1] as { profiles: Record<string, { action: string; name?: string }> };
            const first = decisions.profiles['profile-0'];
            state.connections.push(
              { id: 'n1', name: first.action === 'rename' ? first.name : 'office-pc', protocol: 'rdp', hostname: '10.0.0.7', port: 3389, username: 'admin', viaHost: 'jump', passwordRef: 'op://IT/office/password', hasPassword: false },
              { id: 'n2', name: 'ts01', protocol: 'rdp', hostname: 'ts01', port: 3389, hasPassword: false }
            );
            return Promise.resolve({ hosts: 1, profiles: 2 });
          }
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
  }, { hosts: HOSTS, launch: opts.launch, connections: opts.connections });
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
  await editor.getByLabel('Username', { exact: true }).fill('admin');
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

test('address, user and password can each come from 1Password, switched per field', async ({ page }) => {
  await boot(page);
  await page.getByRole('button', { name: 'Switch to Remote Desktop' }).click();
  await page.getByRole('button', { name: 'New connection' }).first().click();
  const editor = page.getByRole('dialog', { name: 'New RDP connection' });
  await editor.getByLabel('Name', { exact: true }).fill('office-pc');

  // Switched on, a field wants a reference.
  await editor.getByRole('button', { name: 'Hostname from 1Password' }).click();
  await expect(editor.getByRole('button', { name: 'Hostname from 1Password' })).toHaveAttribute('aria-pressed', 'true');
  await editor.getByLabel('Hostname / IP').fill('10.0.0.5');
  await editor.getByRole('button', { name: 'Add connection' }).click();
  await expect(editor.getByText('Hostname / IP: 1Password reference must look like op://vault/item/field')).toBeVisible();
  await editor.getByLabel('Hostname / IP').fill('op://Servers/office-pc/hostname');

  // The password's switch swaps the password box for a reference box.
  await editor.getByRole('button', { name: 'Password from 1Password' }).click();
  await expect(editor.getByLabel('Password', { exact: true })).toHaveAttribute('placeholder', 'op://Servers/office-pc/password');
  await editor.getByLabel('Password', { exact: true }).fill('op://Servers/office-pc/password');
  await editor.getByLabel('Username', { exact: true }).fill('admin');
  await editor.getByRole('button', { name: 'Add connection' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  const saved = await page.evaluate(() => (window as unknown as { __rdpConnections: { connections: Rec[] } }).__rdpConnections.connections[0]);
  expect(saved).toMatchObject({ hostname: 'op://Servers/office-pc/hostname', username: 'admin', passwordRef: 'op://Servers/office-pc/password' });
  // The tile names the item instead of the whole reference, and says what comes from 1Password.
  await expect(page.getByText('admin@‹office-pc›:3389')).toBeVisible();
  await expect(page.getByTitle('Address and password read from 1Password when connecting')).toBeVisible();

  // Reopened, the switches are as saved; switching the password back drops its reference.
  await page.getByRole('button', { name: 'Edit office-pc' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit RDP connection' });
  await expect(edit.getByRole('button', { name: 'Hostname from 1Password' })).toHaveAttribute('aria-pressed', 'true');
  await expect(edit.getByRole('button', { name: 'Username from 1Password' })).toHaveAttribute('aria-pressed', 'false');
  await edit.getByRole('button', { name: 'Password from 1Password' }).click();
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const resaved = await page.evaluate(() => (window as unknown as { __rdpConnections: { connections: Rec[] } }).__rdpConnections.connections[0]);
  expect(resaved.passwordRef).toBeUndefined();
  await expect(page.getByTitle('Address read from 1Password when connecting')).toBeVisible();

  // Port and domain too; everything from the one item shows as just that item.
  await page.getByRole('button', { name: 'Edit office-pc' }).click();
  const again = page.getByRole('dialog', { name: 'Edit RDP connection' });
  await again.getByRole('button', { name: 'Port from 1Password' }).click();
  await again.getByLabel('Port', { exact: true }).fill('op://Servers/office-pc/port');
  await again.getByRole('button', { name: 'Domain from 1Password' }).click();
  await again.getByLabel('Domain', { exact: true }).fill('op://Servers/office-pc/domain');
  await again.getByRole('button', { name: 'Username from 1Password' }).click();
  await again.getByLabel('Username', { exact: true }).fill('op://Servers/office-pc/username');
  await again.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const all = await page.evaluate(() => (window as unknown as { __rdpConnections: { connections: Rec[] } }).__rdpConnections.connections[0]);
  expect(all).toMatchObject({ port: 3389, portRef: 'op://Servers/office-pc/port', domain: 'op://Servers/office-pc/domain' });
  await expect(page.getByText('‹office-pc›', { exact: true })).toBeVisible();
  await expect(page.getByTitle('Address, port, user and domain read from 1Password when connecting')).toBeVisible();
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
  await editor.getByRole('combobox', { name: 'Connect' }).selectOption('bastion');
  await expect(editor.getByText('Hostname and port are as seen from bastion.')).toBeVisible();

  // Display & devices sits next to the connection fields, always open.
  const settings = editor.getByRole('region', { name: 'Display & devices' });
  const name = editor.getByLabel('Name', { exact: true });
  expect((await settings.boundingBox())!.x).toBeGreaterThan((await name.boundingBox())!.x + 200);
  await editor.getByRole('combobox', { name: 'Display' }).selectOption('window');
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
  await expect(edit.getByRole('combobox', { name: 'Connect' })).toHaveValue('bastion');
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
  // A session row in the sidebar; no stored password, so the tab asks for one.
  await expect(page.getByRole('button', { name: 'office-pc · rdp' })).toBeVisible();
  await expect(page.getByText('Sign in to office-pc')).toBeVisible();
  await expect(page.getByLabel('Username')).toHaveValue('admin');
  await page.getByLabel('Password').fill('s3cret');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { __rdpTyped: unknown[] }).__rdpTyped)).toEqual([
    { username: 'admin', password: 's3cret', domain: '' }
  ]);
  // …and then says what went wrong.
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

test('reopened in Remote Desktop mode, the app shows Remote Desktop, not the SSH dashboard', async ({ page }) => {
  // What the switch remembers from the last run.
  await page.addInitScript(() => localStorage.setItem('remoty-sidebar-mode', 'remoteDesktop'));
  await boot(page);
  await expect(page.getByRole('heading', { name: 'Remote Desktop' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Switch to SSH' })).toBeVisible();
});

test('profiles export to a file, and an import settles a taken name first', async ({ page }) => {
  await boot(page, { connections: [{ id: 'c1', name: 'office-pc', protocol: 'rdp', hostname: '10.0.0.5', port: 3389, hasPassword: true }] });
  await page.getByRole('button', { name: 'Switch to Remote Desktop' }).click();

  // Export: one profile from its card, then every profile from the toolbar.
  await page.getByRole('button', { name: 'Export office-pc' }).click();
  await page.getByRole('button', { name: 'Export all' }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __bundleCalls: unknown[][] }).__bundleCalls))
    .toEqual([
      ['export_rdp_profiles', ['c1']],
      ['export_rdp_profiles', ['c1'], 'rdp-profiles']
    ]);

  // Import: the dialog lists the file's profiles and the SSH host they tunnel through.
  await page.getByRole('button', { name: 'Import…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Import remote desktop profiles' });
  await expect(dialog.getByText('team.remoty-rdp-profiles.json')).toBeVisible();
  await expect(dialog.getByText('SSH hosts the profiles tunnel through')).toBeVisible();
  await expect(dialog.getByText('1Password', { exact: true })).toBeVisible();
  // A reference sends that item's value to the host, so each one is shown to check.
  await expect(dialog.getByText('op://IT/x/password')).toBeVisible();
  await expect(dialog.getByText(/Only import files from people you trust/)).toBeVisible();
  await expect(dialog.getByText('enter the password after importing')).toBeVisible();
  await expect(dialog.getByText('used by office-pc')).toBeVisible();

  // The taken name: rename is preselected with a free name; a taken one is refused.
  const newName = dialog.getByLabel('New name for office-pc');
  await expect(newName).toHaveValue('office-pc (2)');
  await newName.fill('office-pc');
  await expect(dialog.getByRole('alert')).toContainText('different name');
  await expect(dialog.getByRole('button', { name: 'Import', exact: true })).toBeDisabled();
  await newName.fill('office-pc (team)');
  await dialog.getByRole('button', { name: 'Import', exact: true }).click();

  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('Imported 2 profiles and 1 SSH host.')).toBeVisible();
  await expect(page.getByText('office-pc (team)', { exact: true })).toBeVisible();
  const apply = await page.evaluate(() =>
    (window as unknown as { __bundleCalls: unknown[][] }).__bundleCalls.find((c) => c[0] === 'apply_connection_import')
  );
  expect(apply).toEqual([
    'apply_connection_import',
    't1',
    { hosts: {}, profiles: { 'profile-0': { action: 'rename', name: 'office-pc (team)' } } }
  ]);

  // Switching to overwrite sends that instead.
  await page.getByRole('button', { name: 'Import…' }).click();
  const again = page.getByRole('dialog', { name: 'Import remote desktop profiles' });
  await again.getByRole('radio', { name: 'Overwrite' }).first().click();
  await expect(again.getByText('replaces the one here; its saved password is kept').first()).toBeVisible();
});
