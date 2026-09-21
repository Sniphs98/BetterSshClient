import { expect, test, type Page } from '@playwright/test';

// Automations (graph-based): a reusable Snippet library + Automations that wire them
// together with dependency edges. e2e runs against the static SPA with the Electron
// preload bridge absent, so we install a `window.omnyssh` stub. `run_automation` fakes just
// enough of the real engine (core/automation/engine.ts, covered for real by
// engine.test.ts and engine.integration.test.ts) to exercise the UI: it walks
// `automation.nodes` in array order (the test always adds them in dependency order),
// resolves each node's canned outcome from its snippet's command, and skips a node
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
    const state: { snippets: Rec[]; automations: Rec[] } = { snippets: [], automations: [] };
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
        // bug this line exists to catch: AutomationEditor once handed `save_automation` a node's
        // still-proxied `position` object). Cloning here reproduces that check, since
        // this test runs in a real Chromium page with the same structuredClone.
        const args = rawArgs.map((a) => structuredClone(a));
        switch (channel) {
          case 'list_hosts':
            return Promise.resolve(hosts);
          case 'reload_hosts':
            return Promise.resolve(null);
          case 'list_snippets':
            return Promise.resolve([...state.snippets]);
          case 'save_snippet': {
            const a = args[0] as Rec & { id: string };
            const i = state.snippets.findIndex((x) => x.id === a.id);
            if (i >= 0) state.snippets[i] = a;
            else state.snippets.push(a);
            return Promise.resolve(null);
          }
          case 'delete_snippet': {
            state.snippets = state.snippets.filter((x) => x.id !== args[0]);
            return Promise.resolve(null);
          }
          case 'list_automations':
            return Promise.resolve([...state.automations]);
          case 'save_automation': {
            const f = args[0] as Rec & { name: string };
            const i = state.automations.findIndex((x) => x.name === f.name);
            if (i >= 0) state.automations[i] = f;
            else state.automations.push(f);
            return Promise.resolve(null);
          }
          case 'delete_automation': {
            state.automations = state.automations.filter((x) => x.name !== args[0]);
            return Promise.resolve(null);
          }
          case 'export_snippet':
          case 'export_automation':
            exportCalls.push({ channel, args });
            return Promise.resolve(`/fake/path/${String(args[0])}.json`);
          case 'import_bundle': {
            // Simulates the user picking a file that bundles one new Snippet —
            // the real merge/parse logic is covered by bundle.test.ts on the electron
            // side; this just exercises the renderer's "refresh after import" wiring.
            const id = `imported-${state.snippets.length + 1}`;
            state.snippets.push({ id, name: 'Imported', command: 'echo imported', timeoutSecs: 300 });
            return Promise.resolve({ kind: 'snippet', name: 'Imported' });
          }
          case 'run_automation': {
            const automationName = args[0] as string;
            const paramValues = (args[1] as Record<string, string>) ?? {};
            const automation = state.automations.find((f) => f.name === automationName) as
              | { nodes: Array<{ id: string; snippetId: string; label: string; continueOnError: boolean; target: string }>; edges: Array<{ from: string; to: string }> }
              | undefined;
            if (!automation) {
              setTimeout(() => fire('automation-failed', { automationName, error: 'automation not found' }), 0);
              return Promise.resolve(null);
            }
            const snippetsById = new Map(state.snippets.map((a) => [a.id as string, a]));
            const needsHost = automation.nodes.some((n) => n.target === 'remote');
            if (needsHost && !paramValues.host) {
              setTimeout(() => fire('automation-failed', { automationName, error: 'missing host parameter value' }), 0);
              return Promise.resolve(null);
            }
            setTimeout(() => {
              fire('automation-started', { automationName });
              const statusById = new Map<string, string>();
              const results: Rec[] = [];
              for (const node of automation.nodes) {
                const depIds = automation.edges.filter((e) => e.to === node.id).map((e) => e.from);
                const blocked = depIds.some((depId) => {
                  const depStatus = statusById.get(depId);
                  const depNode = automation.nodes.find((n) => n.id === depId);
                  return depStatus !== undefined && depStatus !== 'success' && !depNode?.continueOnError;
                });
                if (blocked) {
                  const result = { nodeId: node.id, label: node.label, status: 'skipped', output: '', durationMs: 0 };
                  statusById.set(node.id, 'skipped');
                  results.push(result);
                  fire('automation-node-result', { automationName, ...result });
                  continue;
                }
                fire('automation-node-started', { automationName, nodeId: node.id, label: node.label });
                const snippet = snippetsById.get(node.snippetId);
                const command = (snippet?.command as string) ?? '';
                const ok = !command.includes('exit 1');
                const isRemote = node.target === 'remote';
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
                fire('automation-node-result', { automationName, ...result });
              }
              fire('automation-completed', { automationName, results });
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

test('the sidebar has separate Automations and Snippets entries into the same screen', async ({ page }) => {
  await boot(page);

  await page.getByRole('button', { name: 'Snippets', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Snippet library' })).toBeVisible();
  // The highlight follows the open tab, not just the active screen.
  await expect(page.getByRole('button', { name: 'Snippets', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('button', { name: 'Automations', exact: true })).not.toHaveAttribute('aria-current', 'page');

  await page.getByRole('button', { name: 'Automations', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Automations' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Automations', exact: true })).toHaveAttribute('aria-current', 'page');

  // The in-screen link and the sidebar entry are two paths to the same view, so the
  // sidebar highlight has to follow a tab flip that happened inside the screen.
  await page.getByRole('button', { name: 'Manage snippets' }).click();
  await expect(page.getByRole('button', { name: 'Snippets', exact: true })).toHaveAttribute('aria-current', 'page');
});

test('build snippets, wire an automation, run it, and see success/failed/skipped per node', async ({ page }) => {
  await boot(page);

  await page.getByRole('button', { name: 'Automations', exact: true }).click();
  // Automations is the default, primary view — the Snippet library is reached via the
  // secondary "Manage snippets" link.
  await expect(page.getByRole('heading', { name: 'Automations' })).toBeVisible();
  await page.getByRole('button', { name: 'Manage snippets' }).click();
  await expect(page.getByRole('heading', { name: 'Snippet library' })).toBeVisible();

  async function addSnippet(name: string, command: string): Promise<void> {
    await page.getByRole('button', { name: 'New snippet' }).first().click();
    const editor = page.getByRole('dialog', { name: 'New snippet' });
    await editor.getByLabel('Name').fill(name);
    await editor.getByLabel('Command').fill(command);
    await editor.getByRole('button', { name: 'Add snippet' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  await addSnippet('Build', 'echo build-ok');
  await addSnippet('Deploy', 'exit 1');
  await addSnippet('Notify', 'echo notified');

  await expect(page.getByText('Build', { exact: true })).toBeVisible();
  await expect(page.getByText('Deploy', { exact: true })).toBeVisible();
  await expect(page.getByText('Notify', { exact: true })).toBeVisible();

  // Back to Automations: wire Build -> Deploy -> Notify, so Deploy's failure skips Notify.
  await page.getByRole('button', { name: 'Back to Automations' }).click();
  await page.getByRole('button', { name: 'New automation' }).first().click();

  // "New automation" replaces the whole content area with the canvas — not a dialog.
  await expect(page.getByRole('heading', { name: 'Automations' })).toHaveCount(0);
  await page.getByLabel('Automation name').fill('release');

  async function addNode(snippetName: string): Promise<void> {
    await page.getByRole('button', { name: 'Add a snippet to this automation' }).click();
    const picker = page.getByRole('dialog', { name: 'Pick a snippet' });
    await expect(picker).toBeVisible();
    await picker.getByRole('button', { name: new RegExp(snippetName) }).click();
  }
  await addNode('Build');
  await addNode('Deploy');
  await addNode('Notify');
  await expect(page.getByLabel('Label')).toHaveCount(3);

  // Wire the canvas: click a node's source (right) dot, then the dependent node's
  // target (left) dot — svelte-flow's click-to-connect, an alternative to dragging.
  async function connect(fromSnippetName: string, toSnippetName: string): Promise<void> {
    const fromNode = page.locator('.svelte-flow__node', { hasText: fromSnippetName });
    const toNode = page.locator('.svelte-flow__node', { hasText: toSnippetName });
    await fromNode.locator('.svelte-flow__handle.source').click();
    await toNode.locator('.svelte-flow__handle.target').click();
  }
  await connect('Build', 'Deploy');
  await connect('Deploy', 'Notify');
  await expect(page.locator('.svelte-flow__edge')).toHaveCount(2);

  await page.getByRole('button', { name: 'Create automation' }).click();

  // Saving returns to the Automations list (the "back" navigation, same as Cancel).
  await expect(page.getByRole('heading', { name: 'Automations' })).toBeVisible();
  await expect(page.getByText('release', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Run release' }).click();

  const progress = page.getByRole('dialog', { name: 'Automation run' });
  await expect(progress).toBeVisible();
  await expect(progress.getByRole('button', { name: 'Done' })).toBeVisible();

  const row = (label: string) => progress.locator('li', { hasText: label });
  await expect(row('Build')).toContainText('success');
  await expect(row('Deploy')).toContainText('failed');
  await expect(row('Notify')).toContainText('skipped');

  await progress.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // A node's underlying Snippet (its command and timeout — not just this node's
  // label/wiring) is editable from inside the automation itself: an edit button on the node,
  // and double-clicking its snippet-name row, both reuse the library's own form.
  await page.getByText('release', { exact: true }).click();
  const notifyNode = page.locator('.svelte-flow__node', { hasText: 'Notify' });
  await notifyNode.getByRole('button', { name: 'Edit Notify' }).click();
  const editSnippet = page.getByRole('dialog', { name: 'Edit snippet' });
  await expect(editSnippet).toBeVisible();
  await editSnippet.getByLabel('Name').fill('Notify v2');
  await editSnippet.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const renamedNode = page.locator('.svelte-flow__node', { hasText: 'Notify v2' });
  await expect(renamedNode).toBeVisible();

  await renamedNode.getByTitle('Double-click to edit Notify v2').dblclick();
  const reopened = page.getByRole('dialog', { name: 'Edit snippet' });
  await expect(reopened).toBeVisible();
  await reopened.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('connecting the Start node to a snippet node is a cosmetic link — dashed, not a dependency, and it survives a reopen', async ({
  page
}) => {
  await boot(page);

  await page.getByRole('button', { name: 'Automations', exact: true }).click();
  await page.getByRole('button', { name: 'Manage snippets' }).click();
  await page.getByRole('button', { name: 'New snippet' }).first().click();
  const editor = page.getByRole('dialog', { name: 'New snippet' });
  await editor.getByLabel('Name').fill('Build');
  await editor.getByLabel('Command').fill('echo build-ok');
  await editor.getByRole('button', { name: 'Add snippet' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.getByRole('button', { name: 'Back to Automations' }).click();
  await page.getByRole('button', { name: 'New automation' }).first().click();
  await page.getByLabel('Automation name').fill('cosmetic-link');
  await page.getByRole('button', { name: 'Add a snippet to this automation' }).click();
  await page.getByRole('dialog', { name: 'Pick a snippet' }).getByRole('button', { name: /Build/ }).click();

  // The Start node has one source handle (no target) — connecting it to Build's target
  // handle draws a "params automation in from here" line, purely visual.
  const startNode = page.locator('.svelte-flow__node', { hasText: 'Start' });
  const buildNode = page.locator('.svelte-flow__node', { hasText: 'Build' });
  await startNode.locator('.svelte-flow__handle.source').click();
  await buildNode.locator('.svelte-flow__handle.target').click();
  await expect(page.locator('.svelte-flow__edge')).toHaveCount(1);
  await expect(page.locator('.svelte-flow__edge-path')).toHaveAttribute('style', /stroke-dasharray/);

  await page.getByRole('button', { name: 'Create automation' }).click();
  await expect(page.getByRole('heading', { name: 'Automations' })).toBeVisible();

  // Not a real dependency: saving didn't get rejected by validateAutomation (which would
  // reject any edge naming the Start node, since it isn't an AutomationNode), and running the
  // automation still succeeds — the link never reached the engine as an AutomationEdge.
  await page.getByRole('button', { name: 'Run cosmetic-link' }).click();
  const progress = page.getByRole('dialog', { name: 'Automation run' });
  await expect(progress).toBeVisible();
  await expect(progress.locator('li', { hasText: 'Build' })).toContainText('success');
  await progress.getByRole('button', { name: 'Done' }).click();

  // Reopening the automation still shows the dashed line — it round-trips through
  // AutomationDto.startLinks rather than being lost on every save/reload.
  await page.getByText('cosmetic-link', { exact: true }).click();
  await expect(page.locator('.svelte-flow__edge')).toHaveCount(1);
  await expect(page.locator('.svelte-flow__edge-path')).toHaveAttribute('style', /stroke-dasharray/);
});

test('a node set to run on a host carries no host itself — the automation asks for one at run time', async ({ page }) => {
  await boot(page);

  await page.getByRole('button', { name: 'Automations', exact: true }).click();
  await page.getByRole('button', { name: 'Manage snippets' }).click();

  await page.getByRole('button', { name: 'New snippet' }).first().click();
  const snippetEditor = page.getByRole('dialog', { name: 'New snippet' });
  await snippetEditor.getByLabel('Name').fill('Deploy');
  // Neither a host nor a local/remote choice belongs on the snippet any more — both
  // are the placing node's concern.
  await expect(snippetEditor.getByText('Host', { exact: true })).toHaveCount(0);
  await expect(snippetEditor.getByLabel('Runs')).toHaveCount(0);
  await snippetEditor.getByLabel('Command').fill('echo deployed');
  await snippetEditor.getByRole('button', { name: 'Add snippet' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Wire an automation with a `host`-kind parameter and one node using the remote snippet.
  await page.getByRole('button', { name: 'Back to Automations' }).click();
  await page.getByRole('button', { name: 'New automation' }).first().click();
  await page.getByLabel('Automation name').fill('deploy-anywhere');

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

  await page.getByRole('button', { name: 'Add a snippet to this automation' }).click();
  await page.getByRole('dialog', { name: 'Pick a snippet' }).getByRole('button', { name: /Deploy/ }).click();

  // A node runs locally until it's flipped — where it runs is the node's call now,
  // so this is what makes the automation need the host parameter at all.
  const deployNode = page.locator('.svelte-flow__node', { hasText: 'Deploy' });
  await expect(deployNode.getByRole('button', { name: 'local' })).toHaveAttribute('aria-pressed', 'true');
  await deployNode.getByRole('button', { name: 'on host' }).click();
  await expect(deployNode.getByRole('button', { name: 'on host' })).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('button', { name: 'Create automation' }).click();
  await expect(page.getByRole('heading', { name: 'Automations' })).toBeVisible();

  // Running the automation first asks which host to use.
  await page.getByRole('button', { name: 'Run deploy-anywhere' }).click();
  const runDialog = page.getByRole('dialog', { name: 'Run automation' });
  await expect(runDialog).toBeVisible();
  await runDialog.getByRole('button', { name: 'Choose a host…' }).click();

  const hostPicker = page.getByRole('dialog', { name: 'Pick a host' });
  await expect(hostPicker).toBeVisible();
  await hostPicker.getByRole('button', { name: /web-1/ }).click();

  await runDialog.getByRole('button', { name: 'Run', exact: true }).click();

  const progress = page.getByRole('dialog', { name: 'Automation run' });
  await expect(progress).toBeVisible();
  await expect(progress.getByRole('button', { name: 'Done' })).toBeVisible();
  // Proof the picked host — not something baked into the snippet — reached the run.
  await expect(progress.locator('li', { hasText: 'Deploy' })).toContainText('ok on web-1');
});

test('the "+" menu can create a brand new snippet inline and drops it straight onto the canvas', async ({
  page
}) => {
  await boot(page);

  await page.getByRole('button', { name: 'Automations', exact: true }).click();
  await page.getByRole('button', { name: 'New automation' }).first().click();
  await page.getByLabel('Automation name').fill('inline-create');

  // No snippets exist yet — "New snippet…" is offered anyway, pinned first, not
  // just once the library is populated. This reuses the same centered picker overlay
  // as the SFTP/Terminal spawners' "pick a host" (⌘K's own component, in a third mode).
  await page.getByRole('button', { name: 'Add a snippet to this automation' }).click();
  const picker = page.getByRole('dialog', { name: 'Pick a snippet' });
  await expect(picker).toBeVisible();
  await expect(picker.locator('ul li').first()).toHaveText('New snippet…');
  await picker.getByRole('button', { name: 'New snippet…' }).click();

  const snippetEditor = page.getByRole('dialog', { name: 'New snippet' });
  await expect(snippetEditor).toBeVisible();
  await snippetEditor.getByLabel('Name').fill('Provision');
  await snippetEditor.getByLabel('Command').fill('echo provisioned');
  await snippetEditor.getByRole('button', { name: 'Add snippet' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // The new Snippet landed both in the library and as a node on this canvas —
  // no need to reopen the "+" menu and pick it a second time.
  await expect(page.locator('.svelte-flow__node', { hasText: 'Provision' })).toBeVisible();

  await page.getByRole('button', { name: 'Create automation' }).click();
  await expect(page.getByRole('heading', { name: 'Automations' })).toBeVisible();
  await page.getByRole('button', { name: 'Manage snippets' }).click();
  await expect(page.getByText('Provision', { exact: true })).toBeVisible();
});

test('dragging a connection out to empty canvas space offers the snippet picker and wires the new node', async ({
  page
}) => {
  await boot(page);

  await page.getByRole('button', { name: 'Automations', exact: true }).click();
  await page.getByRole('button', { name: 'Manage snippets' }).click();
  await page.getByRole('button', { name: 'New snippet' }).first().click();
  const editor = page.getByRole('dialog', { name: 'New snippet' });
  await editor.getByLabel('Name').fill('Build');
  await editor.getByLabel('Command').fill('echo build-ok');
  await editor.getByRole('button', { name: 'Add snippet' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.getByRole('button', { name: 'Back to Automations' }).click();
  await page.getByRole('button', { name: 'New automation' }).first().click();
  await page.getByLabel('Automation name').fill('drag-to-empty');
  await page.getByRole('button', { name: 'Add a snippet to this automation' }).click();
  await page.getByRole('dialog', { name: 'Pick a snippet' }).getByRole('button', { name: /Build/ }).click();
  // `fitView` only fits whatever nodes existed when the canvas first mounted (just
  // Start) — the node just added via the menu sits well outside that viewport until
  // re-fit, which a raw mouse drag (unlike `.click()`) won't auto-scroll to reach.
  await page.getByRole('button', { name: 'Fit View' }).click();

  const buildNode = page.locator('.svelte-flow__node', { hasText: 'Build' });
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

  const picker = page.getByRole('dialog', { name: 'Pick a snippet' });
  await expect(picker).toBeVisible();
  await expect(picker.locator('ul li').first()).toHaveText('New snippet…');
  await picker.getByRole('button', { name: /Build/ }).click();

  // A second "Build" node, wired from the first one by a real dependency edge — this
  // is the one case where a drag-to-empty connection IS a real AutomationEdge (source is an
  // snippet node, not Start).
  await expect(page.locator('.svelte-flow__node', { hasText: 'Build' })).toHaveCount(2);
  await expect(page.locator('.svelte-flow__edge')).toHaveCount(1);
  await expect(page.locator('.svelte-flow__edge-path')).not.toHaveAttribute('style', /stroke-dasharray/);
});

test('export and import — sharing a snippet or automation as a file', async ({ page }) => {
  await boot(page);

  await page.getByRole('button', { name: 'Automations', exact: true }).click();
  await page.getByRole('button', { name: 'Manage snippets' }).click();
  await page.getByRole('button', { name: 'New snippet' }).first().click();
  const editor = page.getByRole('dialog', { name: 'New snippet' });
  await editor.getByLabel('Name').fill('Build');
  await editor.getByLabel('Command').fill('echo build-ok');
  await editor.getByRole('button', { name: 'Add snippet' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // Exporting a snippet prompts a native save dialog (stubbed here) — the id it
  // was asked to export is what matters, not the file it would have written.
  await page.getByRole('button', { name: 'Export Build' }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __exportCalls: unknown[] }).__exportCalls.length))
    .toBe(1);
  const firstCall = await page.evaluate(
    () => (window as unknown as { __exportCalls: Array<{ channel: string; args: unknown[] }> }).__exportCalls[0]
  );
  expect(firstCall.channel).toBe('export_snippet');

  // Wire an automation using it, then export the automation the same way.
  await page.getByRole('button', { name: 'Back to Automations' }).click();
  await page.getByRole('button', { name: 'New automation' }).first().click();
  await page.getByLabel('Automation name').fill('release');
  await page.getByRole('button', { name: 'Add a snippet to this automation' }).click();
  await page.getByRole('dialog', { name: 'Pick a snippet' }).getByRole('button', { name: /Build/ }).click();
  await page.getByRole('button', { name: 'Create automation' }).click();
  await expect(page.getByRole('heading', { name: 'Automations' })).toBeVisible();

  await page.getByRole('button', { name: 'Export release' }).click();
  const calls = await page.evaluate(
    () => (window as unknown as { __exportCalls: Array<{ channel: string; args: unknown[] }> }).__exportCalls
  );
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual({ channel: 'export_automation', args: ['release'] });

  // Importing adds whatever the (stubbed) file picker returned straight to the
  // library — no second click needed to place it, unlike picking from a list.
  await page.getByRole('button', { name: 'Manage snippets' }).click();
  await expect(page.getByText('Imported', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Import…' }).click();
  await expect(page.getByText('Imported', { exact: true })).toBeVisible();
});
