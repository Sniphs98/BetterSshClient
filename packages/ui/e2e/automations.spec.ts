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
    // Every export_* call, recorded for assertions — real Electron shows a native save
    // dialog here, which Playwright can't drive, so the test instead checks the right
    // channel/id or name reached the (stubbed) IPC boundary.
    const exportCalls: Array<{ channel: string; args: unknown[] }> = [];
    win.__exportCalls = exportCalls;

    function fire(channel: string, payload: unknown): void {
      for (const cb of listeners[channel] ?? []) cb(payload);
    }

    win.omnyssh = {
      invoke: (channel: string, ...rawArgs: unknown[]) => {
        // Real Electron sends every arg across the renderer/main IPC boundary via the
        // structured-clone algorithm, which throws "An object could not be cloned" on
        // anything that isn't plain data — a Svelte 5 $state proxy included (the exact
        // bug this line exists to catch: FlowEditor once handed `save_flow` a node's
        // still-proxied `position` object). Cloning here reproduces that check, since
        // this test runs in a real Chromium page with the same structuredClone.
        const args = rawArgs.map((a) => structuredClone(a));
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
          case 'export_automation':
          case 'export_flow':
            exportCalls.push({ channel, args });
            return Promise.resolve(`/fake/path/${String(args[0])}.json`);
          case 'import_bundle': {
            // Simulates the user picking a file that bundles one new Automation —
            // the real merge/parse logic is covered by bundle.test.ts on the electron
            // side; this just exercises the renderer's "refresh after import" wiring.
            const id = `imported-${state.automations.length + 1}`;
            state.automations.push({ id, name: 'Imported', kind: 'local', command: 'echo imported', timeoutSecs: 300 });
            return Promise.resolve({ kind: 'automation', name: 'Imported' });
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
  // Flows is the default, primary view — the Automation library is reached via the
  // secondary "Manage automations" link.
  await expect(page.getByRole('heading', { name: 'Flows' })).toBeVisible();
  await page.getByRole('button', { name: 'Manage automations' }).click();
  await expect(page.getByRole('heading', { name: 'Automation library' })).toBeVisible();

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

  // Back to Flows: wire Build -> Deploy -> Notify, so Deploy's failure skips Notify.
  await page.getByRole('button', { name: 'Back to Flows' }).click();
  await page.getByRole('button', { name: 'New flow' }).first().click();

  // "New flow" replaces the whole content area with the canvas — not a dialog.
  await expect(page.getByRole('heading', { name: 'Flows' })).toHaveCount(0);
  await page.getByLabel('Flow name').fill('release');

  async function addNode(automationName: string): Promise<void> {
    await page.getByRole('button', { name: 'Add an automation to this flow' }).click();
    const picker = page.getByRole('dialog', { name: 'Pick an automation' });
    await expect(picker).toBeVisible();
    await picker.getByRole('button', { name: new RegExp(automationName) }).click();
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
  await expect(page.getByRole('heading', { name: 'Flows' })).toBeVisible();
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

  // A node's underlying Automation (its command, kind, timeout — not just this node's
  // label/wiring) is editable from inside the flow itself: an edit button on the node,
  // and double-clicking its automation-name row, both reuse the library's own form.
  await page.getByText('release', { exact: true }).click();
  const notifyNode = page.locator('.svelte-flow__node', { hasText: 'Notify · local' });
  await notifyNode.getByRole('button', { name: 'Edit Notify' }).click();
  const editAutomation = page.getByRole('dialog', { name: 'Edit automation' });
  await expect(editAutomation).toBeVisible();
  await editAutomation.getByLabel('Name').fill('Notify v2');
  await editAutomation.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const renamedNode = page.locator('.svelte-flow__node', { hasText: 'Notify v2 · local' });
  await expect(renamedNode).toBeVisible();

  await renamedNode.getByTitle('Double-click to edit Notify v2').dblclick();
  const reopened = page.getByRole('dialog', { name: 'Edit automation' });
  await expect(reopened).toBeVisible();
  await reopened.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('connecting the Start node to an automation node is a cosmetic link — dashed, not a dependency, and it survives a reopen', async ({
  page
}) => {
  await boot(page);

  await page.getByRole('button', { name: 'Automations', exact: true }).click();
  await page.getByRole('button', { name: 'Manage automations' }).click();
  await page.getByRole('button', { name: 'New automation' }).first().click();
  const editor = page.getByRole('dialog', { name: 'New automation' });
  await editor.getByLabel('Name').fill('Build');
  await editor.getByLabel('Command').fill('echo build-ok');
  await editor.getByRole('button', { name: 'Add automation' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.getByRole('button', { name: 'Back to Flows' }).click();
  await page.getByRole('button', { name: 'New flow' }).first().click();
  await page.getByLabel('Flow name').fill('cosmetic-link');
  await page.getByRole('button', { name: 'Add an automation to this flow' }).click();
  await page.getByRole('dialog', { name: 'Pick an automation' }).getByRole('button', { name: /Build/ }).click();

  // The Start node has one source handle (no target) — connecting it to Build's target
  // handle draws a "params flow in from here" line, purely visual.
  const startNode = page.locator('.svelte-flow__node', { hasText: 'Start' });
  const buildNode = page.locator('.svelte-flow__node', { hasText: 'Build · local' });
  await startNode.locator('.svelte-flow__handle.source').click();
  await buildNode.locator('.svelte-flow__handle.target').click();
  await expect(page.locator('.svelte-flow__edge')).toHaveCount(1);
  await expect(page.locator('.svelte-flow__edge-path')).toHaveAttribute('style', /stroke-dasharray/);

  await page.getByRole('button', { name: 'Create flow' }).click();
  await expect(page.getByRole('heading', { name: 'Flows' })).toBeVisible();

  // Not a real dependency: saving didn't get rejected by validateFlow (which would
  // reject any edge naming the Start node, since it isn't a FlowNode), and running the
  // flow still succeeds — the link never reached the engine as a FlowEdge.
  await page.getByRole('button', { name: 'Run cosmetic-link' }).click();
  const progress = page.getByRole('dialog', { name: 'Flow run' });
  await expect(progress).toBeVisible();
  await expect(progress.locator('li', { hasText: 'Build' })).toContainText('success');
  await progress.getByRole('button', { name: 'Done' }).click();

  // Reopening the flow still shows the dashed line — it round-trips through
  // FlowDto.startLinks rather than being lost on every save/reload.
  await page.getByText('cosmetic-link', { exact: true }).click();
  await expect(page.locator('.svelte-flow__edge')).toHaveCount(1);
  await expect(page.locator('.svelte-flow__edge-path')).toHaveAttribute('style', /stroke-dasharray/);
});

test('a remote automation has no host of its own — the flow asks for one at run time', async ({ page }) => {
  await boot(page);

  await page.getByRole('button', { name: 'Automations', exact: true }).click();
  await page.getByRole('button', { name: 'Manage automations' }).click();

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
  await page.getByRole('button', { name: 'Back to Flows' }).click();
  await page.getByRole('button', { name: 'New flow' }).first().click();
  await page.getByLabel('Flow name').fill('deploy-anywhere');

  // Parameters live on the graph's permanent "Start" node now, not a toolbar — the
  // dashed "Add parameter" button adds one immediately (a placeholder name, focused
  // and selected) rather than opening a draft form to separately confirm.
  await page.getByRole('button', { name: 'Add parameter' }).click();
  await expect(page.getByLabel('Parameter 1 name')).toHaveValue('param');
  await page.getByLabel('Parameter 1 name').fill('host');
  await page.getByRole('combobox', { name: 'Parameter 1 kind' }).selectOption('host');

  // Existing params are editable in place, not just add-or-delete — rename it, then
  // rename it back (the run stub below keys its fake paramValues on the literal name
  // "host", so this proves the edit round-trips rather than leaving it renamed).
  await page.getByLabel('Parameter 1 name').fill('target');
  await expect(page.getByLabel('Parameter 1 name')).toHaveValue('target');
  await page.getByLabel('Parameter 1 name').fill('host');
  await expect(page.getByLabel('Parameter 1 name')).toHaveValue('host');

  await page.getByRole('button', { name: 'Add an automation to this flow' }).click();
  await page.getByRole('dialog', { name: 'Pick an automation' }).getByRole('button', { name: /Deploy/ }).click();

  await page.getByRole('button', { name: 'Create flow' }).click();
  await expect(page.getByRole('heading', { name: 'Flows' })).toBeVisible();

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

test('the "+" menu can create a brand new automation inline and drops it straight onto the canvas', async ({
  page
}) => {
  await boot(page);

  await page.getByRole('button', { name: 'Automations', exact: true }).click();
  await page.getByRole('button', { name: 'New flow' }).first().click();
  await page.getByLabel('Flow name').fill('inline-create');

  // No automations exist yet — "New automation…" is offered anyway, pinned first, not
  // just once the library is populated. This reuses the same centered picker overlay
  // as the SFTP/Terminal spawners' "pick a host" (⌘K's own component, in a third mode).
  await page.getByRole('button', { name: 'Add an automation to this flow' }).click();
  const picker = page.getByRole('dialog', { name: 'Pick an automation' });
  await expect(picker).toBeVisible();
  await expect(picker.locator('ul li').first()).toHaveText('New automation…');
  await picker.getByRole('button', { name: 'New automation…' }).click();

  const automationEditor = page.getByRole('dialog', { name: 'New automation' });
  await expect(automationEditor).toBeVisible();
  await automationEditor.getByLabel('Name').fill('Provision');
  await automationEditor.getByLabel('Command').fill('echo provisioned');
  await automationEditor.getByRole('button', { name: 'Add automation' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // The new Automation landed both in the library and as a node on this canvas —
  // no need to reopen the "+" menu and pick it a second time.
  await expect(page.locator('.svelte-flow__node', { hasText: 'Provision · local' })).toBeVisible();

  await page.getByRole('button', { name: 'Create flow' }).click();
  await expect(page.getByRole('heading', { name: 'Flows' })).toBeVisible();
  await page.getByRole('button', { name: 'Manage automations' }).click();
  await expect(page.getByText('Provision', { exact: true })).toBeVisible();
});

test('dragging a connection out to empty canvas space offers the automation picker and wires the new node', async ({
  page
}) => {
  await boot(page);

  await page.getByRole('button', { name: 'Automations', exact: true }).click();
  await page.getByRole('button', { name: 'Manage automations' }).click();
  await page.getByRole('button', { name: 'New automation' }).first().click();
  const editor = page.getByRole('dialog', { name: 'New automation' });
  await editor.getByLabel('Name').fill('Build');
  await editor.getByLabel('Command').fill('echo build-ok');
  await editor.getByRole('button', { name: 'Add automation' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.getByRole('button', { name: 'Back to Flows' }).click();
  await page.getByRole('button', { name: 'New flow' }).first().click();
  await page.getByLabel('Flow name').fill('drag-to-empty');
  await page.getByRole('button', { name: 'Add an automation to this flow' }).click();
  await page.getByRole('dialog', { name: 'Pick an automation' }).getByRole('button', { name: /Build/ }).click();
  // `fitView` only fits whatever nodes existed when the canvas first mounted (just
  // Start) — the node just added via the menu sits well outside that viewport until
  // re-fit, which a raw mouse drag (unlike `.click()`) won't auto-scroll to reach.
  await page.getByRole('button', { name: 'Fit View' }).click();

  const buildNode = page.locator('.svelte-flow__node', { hasText: 'Build · local' });
  const handle = buildNode.locator('.svelte-flow__handle.source');
  const handleBox = await handle.boundingBox();
  const paneBox = await page.locator('.svelte-flow__pane').boundingBox();
  if (!handleBox || !paneBox) throw new Error('handle or pane not found');

  // A real drag (mouse down + move + up), not click-to-connect (which only completes
  // on a second handle, never on empty space) — dropping well clear of the node grid,
  // near the pane's bottom-right corner.
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  const dropX = paneBox.x + paneBox.width - 40;
  const dropY = paneBox.y + paneBox.height - 40;
  await page.mouse.move(dropX, dropY, { steps: 10 });
  await page.mouse.up();

  const picker = page.getByRole('dialog', { name: 'Pick an automation' });
  await expect(picker).toBeVisible();
  await expect(picker.locator('ul li').first()).toHaveText('New automation…');
  await picker.getByRole('button', { name: /Build/ }).click();

  // A second "Build" node, wired from the first one by a real dependency edge — this
  // is the one case where a drag-to-empty connection IS a real FlowEdge (source is an
  // automation node, not Start).
  await expect(page.locator('.svelte-flow__node', { hasText: 'Build · local' })).toHaveCount(2);
  await expect(page.locator('.svelte-flow__edge')).toHaveCount(1);
  await expect(page.locator('.svelte-flow__edge-path')).not.toHaveAttribute('style', /stroke-dasharray/);
});

test('export and import — sharing an automation or flow as a file', async ({ page }) => {
  await boot(page);

  await page.getByRole('button', { name: 'Automations', exact: true }).click();
  await page.getByRole('button', { name: 'Manage automations' }).click();
  await page.getByRole('button', { name: 'New automation' }).first().click();
  const editor = page.getByRole('dialog', { name: 'New automation' });
  await editor.getByLabel('Name').fill('Build');
  await editor.getByLabel('Command').fill('echo build-ok');
  await editor.getByRole('button', { name: 'Add automation' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Exporting an automation prompts a native save dialog (stubbed here) — the id it
  // was asked to export is what matters, not the file it would have written.
  await page.getByRole('button', { name: 'Export Build' }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __exportCalls: unknown[] }).__exportCalls.length))
    .toBe(1);
  const firstCall = await page.evaluate(
    () => (window as unknown as { __exportCalls: Array<{ channel: string; args: unknown[] }> }).__exportCalls[0]
  );
  expect(firstCall.channel).toBe('export_automation');

  // Wire a flow using it, then export the flow the same way.
  await page.getByRole('button', { name: 'Back to Flows' }).click();
  await page.getByRole('button', { name: 'New flow' }).first().click();
  await page.getByLabel('Flow name').fill('release');
  await page.getByRole('button', { name: 'Add an automation to this flow' }).click();
  await page.getByRole('dialog', { name: 'Pick an automation' }).getByRole('button', { name: /Build/ }).click();
  await page.getByRole('button', { name: 'Create flow' }).click();
  await expect(page.getByRole('heading', { name: 'Flows' })).toBeVisible();

  await page.getByRole('button', { name: 'Export release' }).click();
  const calls = await page.evaluate(
    () => (window as unknown as { __exportCalls: Array<{ channel: string; args: unknown[] }> }).__exportCalls
  );
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual({ channel: 'export_flow', args: ['release'] });

  // Importing adds whatever the (stubbed) file picker returned straight to the
  // library — no second click needed to place it, unlike picking from a list.
  await page.getByRole('button', { name: 'Manage automations' }).click();
  await expect(page.getByText('Imported', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Import…' }).click();
  await expect(page.getByText('Imported', { exact: true })).toBeVisible();
});
