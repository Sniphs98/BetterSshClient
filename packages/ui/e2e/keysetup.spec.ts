import { expect, test, type Page } from '@playwright/test';

// Auto SSH-key setup (tech-gui.md §4.2). e2e runs against the static SPA with the
// Electron preload bridge absent, so we install a `window.omnyssh` stub at the boundary
// (electron.d.ts). `start_key_setup` is faked: it streams `key-setup-progress` events and
// then `key-setup-complete`, flipping the host's hasKey/passwordAuthDisabled so the
// follow-up `reload_hosts` replays a keyed host — exactly how the real backend drives the
// panel and refreshes the card.
const HOSTS = [
  { name: 'pw-host', hostname: 'pw.example.com', user: 'root', port: 22, tags: [], source: 'manual', hasKey: false }
];

async function boot(page: Page): Promise<void> {
  await page.addInitScript(
    ({ hosts }) => {
      const listeners: Record<string, Array<(payload: unknown) => void>> = {};
      const state: { hosts: Array<Record<string, unknown>> } = { hosts: hosts.map((h) => ({ ...h })) };

      function fire(channel: string, payload: unknown): void {
        for (const cb of listeners[channel] ?? []) cb(payload);
      }

      (window as unknown as { omnyssh: unknown }).omnyssh = {
        invoke: (channel: string, ...args: unknown[]) => {
          switch (channel) {
            case 'list_hosts':
              return Promise.resolve([...state.hosts]);
            case 'reload_hosts':
              setTimeout(() => fire('hosts-loaded', [...state.hosts]), 0);
              return Promise.resolve(null);
            case 'start_key_setup': {
              const name = args[0] as string;
              const step = (index: number, description: string) =>
                fire('key-setup-progress', { hostName: name, step: { index, total: 6, description } });
              setTimeout(() => step(1, 'Generating Ed25519 key pair'), 40);
              setTimeout(() => step(3, 'Verifying key authentication'), 120);
              setTimeout(() => {
                // The real backend persists the key before emitting complete; mirror
                // that so the panel's reload shows a keyed host.
                const h = state.hosts.find((x) => (x as { name: string }).name === name);
                if (h) {
                  h.hasKey = true;
                  h.passwordAuthDisabled = true;
                }
                fire('key-setup-complete', { hostName: name, keyPath: `/home/me/.ssh/omnyssh_${name}_ed25519` });
              }, 400);
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
    },
    { hosts: HOSTS }
  );
  await page.goto('/');
  await expect(page.getByText('pw-host', { exact: true })).toBeVisible();
}

test('prompts key setup, streams progress, then reflects key auth on the card', async ({ page }) => {
  await boot(page);

  // A password host with no key offers the host-first "Set up key" action (§4.2).
  await page.getByRole('button', { name: 'Set up an SSH key for pw-host' }).click();

  const dialog = page.getByRole('dialog', { name: 'Key setup' });
  await expect(dialog).toBeVisible();

  // A step streams in while the flow runs.
  await expect(dialog.getByText('Verifying key authentication')).toBeVisible();

  // Completion shows the generated key path.
  await expect(dialog.getByText('Key authentication configured')).toBeVisible();
  await expect(dialog.getByText(/omnyssh_pw-host_ed25519/)).toBeVisible();

  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // The reload flipped hasKey/passwordAuthDisabled: the card now reads key-only and no
  // longer offers key setup.
  await expect(page.getByText('key-only')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Set up an SSH key for pw-host' })).toHaveCount(0);
});
