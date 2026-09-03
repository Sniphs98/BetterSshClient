import { expect, test, type Page } from '@playwright/test';

// Automations CRUD + execute (mirrors snippets.spec.ts). e2e runs against the static
// SPA; Tauri is absent, so we stub `__TAURI_INTERNALS__` at the boundary. The stub is
// stateful: save/delete mutate an in-memory list that `list_automations` reads back,
// and `execute_automation` delivers one `automation-step-started` + one
// `automation-step-result` per step through the same listener the app registers.
const HOSTS = [
  { name: 'web-1', hostname: 'web-1.example.com', user: 'deploy', port: 22, tags: ['prod'], source: 'manual', hasKey: true }
];

const AUTOMATIONS = [
  {
    name: 'local-echo',
    steps: [{ kind: 'local', command: 'echo hi', continueOnError: false, timeoutSecs: 300 }]
  },
  {
    name: 'deploy-image',
    host: 'web-1',
    steps: [
      { kind: 'local', command: 'docker save {{tag}} -o image.tar', continueOnError: false, timeoutSecs: 300 },
      { kind: 'upload', localPath: 'image.tar', remotePath: '/srv/deploy/image.tar', continueOnError: false, timeoutSecs: 300 }
    ],
    params: ['tag']
  }
];

async function boot(page: Page, automationsFixture = AUTOMATIONS): Promise<void> {
  await page.addInitScript(
    ({ hosts, automations }) => {
      let cbid = 0;
      const listeners: Record<string, number[]> = {};
      const state: { automations: Array<Record<string, unknown>> } = { automations: [...automations] };
      const win = window as unknown as Record<string, unknown>;

      function fire(event: string, payload: unknown): void {
        for (const id of listeners[event] ?? []) {
          const cb = win[`__cb${id}`] as ((e: unknown) => void) | undefined;
          cb?.({ event, id, payload });
        }
      }

      (win as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
        invoke: (cmd: string, args: Record<string, unknown>) => {
          switch (cmd) {
            case 'list_hosts':
              return Promise.resolve(hosts);
            case 'list_automations':
              return Promise.resolve([...state.automations]);
            case 'save_automation': {
              const a = args.automation as { name: string };
              const i = state.automations.findIndex((x) => (x as { name: string }).name === a.name);
              if (i >= 0) state.automations[i] = a;
              else state.automations.push(a);
              return Promise.resolve(null);
            }
            case 'delete_automation':
              state.automations = state.automations.filter(
                (x) => (x as { name: string }).name !== args.name
              );
              return Promise.resolve(null);
            case 'execute_automation': {
              const { automationName } = args as { automationName: string };
              const automation = state.automations.find(
                (x) => (x as { name: string }).name === automationName
              ) as { steps: Array<Record<string, unknown>> } | undefined;
              const steps = automation?.steps ?? [];
              setTimeout(() => {
                steps.forEach((_step, stepIndex) => {
                  fire('automation-step-started', { automationName, stepIndex, totalSteps: steps.length });
                  fire('automation-step-result', {
                    automationName,
                    stepIndex,
                    ok: true,
                    output: `output from step ${stepIndex}`
                  });
                });
              }, 0);
              return Promise.resolve(null);
            }
            case 'plugin:event|listen': {
              const { event, handler } = args as { event: string; handler: number };
              (listeners[event] ||= []).push(handler);
              return Promise.resolve(cbid);
            }
            default:
              return Promise.resolve(null);
          }
        },
        transformCallback: (cb: unknown) => {
          const id = ++cbid;
          win[`__cb${id}`] = cb;
          return id;
        }
      };
    },
    { hosts: HOSTS, automations: automationsFixture }
  );
  await page.goto('/');
  // The status-bar total confirms the app booted and `list_hosts` resolved.
  await expect(page.getByText('1 host', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Automations', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Automations' })).toBeVisible();
}

test('lists the saved automations', async ({ page }) => {
  await boot(page);
  await expect(page.getByText('local-echo', { exact: true })).toBeVisible();
  await expect(page.getByText('deploy-image', { exact: true })).toBeVisible();
  await expect(page.getByText('2 steps')).toBeVisible();
});

test('runs a local-only automation and shows per-step results in order', async ({ page }) => {
  await boot(page);

  await page.getByRole('button', { name: 'Run local-echo' }).click();
  const runner = page.getByRole('dialog', { name: 'Run automation' });
  await expect(runner).toBeVisible();
  await expect(runner.getByText('Local-only')).toBeVisible();

  await runner.getByRole('button', { name: 'Run', exact: true }).click();

  const results = page.getByRole('dialog', { name: 'Automation results' });
  await expect(results).toBeVisible();
  await expect(results.getByText('output from step 0')).toBeVisible();
});

test('prompts for declared params before executing a host automation', async ({ page }) => {
  await boot(page);

  await page.getByRole('button', { name: 'Run deploy-image' }).click();
  const runner = page.getByRole('dialog', { name: 'Run automation' });
  await expect(runner).toBeVisible();

  const param = runner.getByRole('textbox');
  await expect(param).toBeVisible();
  await param.fill('myimage:latest');

  await runner.getByRole('button', { name: 'Run', exact: true }).click();

  const results = page.getByRole('dialog', { name: 'Automation results' });
  await expect(results.getByText('output from step 0')).toBeVisible();
  await expect(results.getByText('output from step 1')).toBeVisible();
});

test('adds an automation with steps and it appears in the list', async ({ page }) => {
  await boot(page);

  await page.getByRole('button', { name: 'New automation' }).click();
  const editor = page.getByRole('dialog', { name: 'New automation' });
  await expect(editor).toBeVisible();

  await editor.getByLabel('Name', { exact: true }).fill('greet');
  await editor.getByLabel('Steps', { exact: true }).fill('local: echo hi');
  await editor.getByRole('button', { name: 'Add automation' }).click();

  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('greet', { exact: true })).toBeVisible();
});

test('rejects a remote step with no host set', async ({ page }) => {
  await boot(page);

  await page.getByRole('button', { name: 'New automation' }).click();
  const editor = page.getByRole('dialog', { name: 'New automation' });
  await editor.getByLabel('Name', { exact: true }).fill('needs-host');
  await editor.getByLabel('Steps', { exact: true }).fill('remote: echo hi');
  await editor.getByRole('button', { name: 'Add automation' }).click();

  await expect(editor).toBeVisible();
  await expect(editor.getByText(/set a Host/)).toBeVisible();
});

test('deletes an automation after confirmation', async ({ page }) => {
  await boot(page);
  await expect(page.getByText('local-echo', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Delete local-echo' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete automation' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Delete', exact: true }).click();

  await expect(page.getByText('local-echo', { exact: true })).toHaveCount(0);
});

test('rejects a new automation whose name already exists', async ({ page }) => {
  await boot(page);

  await page.getByRole('button', { name: 'New automation' }).click();
  const editor = page.getByRole('dialog', { name: 'New automation' });
  await editor.getByLabel('Name', { exact: true }).fill('local-echo');
  await editor.getByLabel('Steps', { exact: true }).fill('local: whoami');
  await editor.getByRole('button', { name: 'Add automation' }).click();

  await expect(editor).toBeVisible();
  await expect(editor.getByText('An automation named "local-echo" already exists')).toBeVisible();
});
