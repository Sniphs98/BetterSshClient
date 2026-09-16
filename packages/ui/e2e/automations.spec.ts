import { expect, test, type Page } from '@playwright/test';

// Automations v2 (graph-based): a reusable Automation library + Flows that wire them
// together with dependency edges. e2e runs against the static SPA with the Electron
// preload bridge absent, so we install a `window.omnyssh` stub. `run_flow` fakes just
// enough of the real engine (core/automation/engine.ts, covered for real by
// engine.test.ts and engine.integration.test.ts) to exercise the UI: it walks
// `flow.nodes` in array order (the test always adds them in dependency order),
// resolves each node's canned outcome from its automation's command, and skips a node
// once any of its listed dependencies didn't succeed and that dependency's own
// continueOnError was left off — the same rule the real engine applies.
type Rec = Record<string, unknown>;

const HOSTS = [
  { name: 'web-1', hostname: 'web-1.example.com', user: 'deploy', port: 22, tags: [], source: 'manual', hasKey: true }
];

async function boot(page: Page): Promise<void> {
  await page.addInitScript((hosts) => {
    const win = window as unknown as Record<string, unknown>;
    const listeners: Record<string, Array<(payload: unknown) => void>> = {};
    const state: { automations: Rec[]; flows: Rec[] } = { automations: [], flows: [] };

    function fire(channel: string, payload: unknown): void {
      for (const cb of listeners[channel] ?? []) cb(payload);
    }

    win.omnyssh = {
      invoke: (channel: string, ...args: unknown[]) => {
        switch (channel) {
          case 'list_hosts':
            return Promise.resolve(hosts);
          case 'reload_hosts':
            return Promise.resolve(null);
          case 'list_automations':
            return Promise.resolve([...state.automations]);
          case 'save_automation': {
            const a = args[0] as Rec & { id: string };
            const i = state.automations.findIndex((x) => x.id === a.id);
            if (i >= 0) state.automations[i] = a;
            else state.automations.push(a);
            return Promise.resolve(null);
          }
          case 'delete_automation': {
            state.automations = state.automations.filter((x) => x.id !== args[0]);
            return Promise.resolve(null);
          }
          case 'list_flows':
            return Promise.resolve([...state.flows]);
          case 'save_flow': {
            const f = args[0] as Rec & { name: string };
            const i = state.flows.findIndex((x) => x.name === f.name);
            if (i >= 0) state.flows[i] = f;
            else state.flows.push(f);
            return Promise.resolve(null);
          }
          case 'delete_flow': {
            state.flows = state.flows.filter((x) => x.name !== args[0]);
            return Promise.resolve(null);
          }
          case 'run_flow': {
            const flowName = args[0] as string;
            const paramValues = (args[1] as Record<string, string>) ?? {};
            const flow = state.flows.find((f) => f.name === flowName) as
              | { nodes: Array<{ id: string; automationId: string; label: string; continueOnError: boolean }>; edges: Array<{ from: string; to: string }> }
              | undefined;
            if (!flow) {
              setTimeout(() => fire('automation-flow-failed', { flowName, error: 'flow not found' }), 0);
              return Promise.resolve(null);
            }
            const automationsById = new Map(state.automations.map((a) => [a.id as string, a]));
            const needsHost = flow.nodes.some((n) => automationsById.get(n.automationId)?.kind === 'remote');
            if (needsHost && !paramValues.host) {
              setTimeout(() => fire('automation-flow-failed', { flowName, error: 'missing host parameter value' }), 0);
              return Promise.resolve(null);
            }
            setTimeout(() => {
              fire('automation-flow-started', { flowName });
              const statusById = new Map<string, string>();
              const results: Rec[] = [];
              for (const node of flow.nodes) {
                const depIds = flow.edges.filter((e) => e.to === node.id).map((e) => e.from);
                const blocked = depIds.some((depId) => {
                  const depStatus = statusById.get(depId);
                  const depNode = flow.nodes.find((n) => n.id === depId);
                  return depStatus !== undefined && depStatus !== 'success' && !depNode?.continueOnError;
                });
                if (blocked) {
                  const result = { nodeId: node.id, label: node.label, status: 'skipped', output: '', durationMs: 0 };
                  statusById.set(node.id, 'skipped');
                  results.push(result);
                  fire('automation-node-result', { flowName, ...result });
                  continue;
                }
                fire('automation-node-started', { flowName, nodeId: node.id, label: node.label });
                const automation = automationsById.get(node.automationId);
                const command = (automation?.command as string) ?? '';
                const ok = !command.includes('exit 1');
                const isRemote = automation?.kind === 'remote';
                const result = {
                  nodeId: node.id,
                  label: node.label,
                  status: ok ? 'success' : 'failed',
                  output: ok ? (isRemote ? `ok on ${paramValues.host}` : 'ok') : '',
                  error: ok ? undefined : 'boom',
                  durationMs: 1
                };
                statusById.set(node.id, result.status);
                results.push(result);
                fire('automation-node-result', { flowName, ...result });
              }
              fire('automation-flow-completed', { flowName, results });
            }, 0);
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
  }, HOSTS);
  await page.goto('/');
}

test('build automations, wire a flow, run it, and see success/failed/skipped per node', async ({ page }) => {
  await boot(page);

  await page.getByRole('button', { name: 'Automations', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Automations' })).toBeVisible();

  async function addAutomation(name: string, command: string): Promise<void> {
    await page.getByRole('button', { name: 'New automation' }).first().click();
    const editor = page.getByRole('dialog', { name: 'New automation' });
    await editor.getByLabel('Name').fill(name);
    await editor.getByLabel('Command').fill(command);
    await editor.getByRole('button', { name: 'Add automation' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  await addAutomation('Build', 'echo build-ok');
  await addAutomation('Deploy', 'exit 1');
  await addAutomation('Notify', 'echo notified');

  await expect(page.getByText('Build', { exact: true })).toBeVisible();
  await expect(page.getByText('Deploy', { exact: true })).toBeVisible();
  await expect(page.getByText('Notify', { exact: true })).toBeVisible();

  // Switch to Flows: wire Build -> Deploy -> Notify, so Deploy's failure skips Notify.
  await page.getByRole('button', { name: 'Flows', exact: true }).click();
  await page.getByRole('button', { name: 'New flow' }).first().click();

  // "New flow" replaces the whole content area with the canvas — not a dialog.
  await expect(page.getByRole('heading', { name: 'Automations' })).toHaveCount(0);
  await page.getByLabel('Flow name').fill('release');

  async function addNode(automationName: string, kind: 'local' | 'remote' = 'local'): Promise<void> {
    await page.getByRole('button', { name: 'Add an automation to this flow' }).click();
    await page.getByRole('menuitem', { name: `${automationName} (${kind})` }).click();
  }
  await addNode('Build');
  await addNode('Deploy');
  await addNode('Notify');
  await expect(page.getByLabel('Label')).toHaveCount(3);

  // Wire the canvas: click a node's source (right) dot, then the dependent node's
  // target (left) dot — svelte-flow's click-to-connect, an alternative to dragging.
  async function connect(fromAutomationName: string, toAutomationName: string): Promise<void> {
    const fromNode = page.locator('.svelte-flow__node', { hasText: fromAutomationName });
    const toNode = page.locator('.svelte-flow__node', { hasText: toAutomationName });
    await fromNode.locator('.svelte-flow__handle.source').click();
    await toNode.locator('.svelte-flow__handle.target').click();
  }
  await connect('Build', 'Deploy');
  await connect('Deploy', 'Notify');
  await expect(page.locator('.svelte-flow__edge')).toHaveCount(2);

  await page.getByRole('button', { name: 'Create flow' }).click();

  // Saving returns to the Flows list (the "back" navigation, same as Cancel).
  await expect(page.getByRole('heading', { name: 'Automations' })).toBeVisible();
  await expect(page.getByText('release', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Run release' }).click();

  const progress = page.getByRole('dialog', { name: 'Flow run' });
  await expect(progress).toBeVisible();
  await expect(progress.getByRole('button', { name: 'Done' })).toBeVisible();

  const row = (label: string) => progress.locator('li', { hasText: label });
  await expect(row('Build')).toContainText('success');
  await expect(row('Deploy')).toContainText('failed');
  await expect(row('Notify')).toContainText('skipped');

  await progress.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('a remote automation has no host of its own — the flow asks for one at run time', async ({ page }) => {
  await boot(page);

  await page.getByRole('button', { name: 'Automations', exact: true }).click();

  await page.getByRole('button', { name: 'New automation' }).first().click();
  const automationEditor = page.getByRole('dialog', { name: 'New automation' });
  await automationEditor.getByLabel('Name').fill('Deploy');
  await automationEditor.getByLabel('Runs').selectOption('remote');
  // No host field should appear on the automation itself.
  await expect(automationEditor.getByText('Host', { exact: true })).toHaveCount(0);
  await automationEditor.getByLabel('Command').fill('echo deployed');
  await automationEditor.getByRole('button', { name: 'Add automation' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Wire a flow with a `host`-kind parameter and one node using the remote automation.
  await page.getByRole('button', { name: 'Flows', exact: true }).click();
  await page.getByRole('button', { name: 'New flow' }).first().click();
  await page.getByLabel('Flow name').fill('deploy-anywhere');

  await page.getByPlaceholder('parameter name').fill('host');
  await page.getByRole('combobox', { name: 'Parameter kind' }).selectOption('host');
  await page.getByRole('button', { name: 'Add parameter' }).click();

  await page.getByRole('button', { name: 'Add an automation to this flow' }).click();
  await page.getByRole('menuitem', { name: 'Deploy (remote)' }).click();

  await page.getByRole('button', { name: 'Create flow' }).click();
  await expect(page.getByRole('heading', { name: 'Automations' })).toBeVisible();

  // Running the flow first asks which host to use.
  await page.getByRole('button', { name: 'Run deploy-anywhere' }).click();
  const runDialog = page.getByRole('dialog', { name: 'Run flow' });
  await expect(runDialog).toBeVisible();
  await runDialog.getByRole('button', { name: 'Choose a host…' }).click();

  const hostPicker = page.getByRole('dialog', { name: 'Pick a host' });
  await expect(hostPicker).toBeVisible();
  await hostPicker.getByRole('button', { name: /web-1/ }).click();

  await runDialog.getByRole('button', { name: 'Run', exact: true }).click();

  const progress = page.getByRole('dialog', { name: 'Flow run' });
  await expect(progress).toBeVisible();
  await expect(progress.getByRole('button', { name: 'Done' })).toBeVisible();
  // Proof the picked host — not something baked into the automation — reached the run.
  await expect(progress.locator('li', { hasText: 'Deploy' })).toContainText('ok on web-1');
});
