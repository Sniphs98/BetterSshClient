import { expect, test, type Page } from '@playwright/test';

// Automations (graph-based): a reusable Snippet library + Automations that wire them
// together with dependency edges. e2e runs against the static SPA with the Electron
// preload bridge absent, so we install a `window.remoty` stub. `run_automation` fakes just
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
    win.__automationState = state;
    // Every export_* call, recorded for assertions — real Electron shows a native save
    // dialog here, which Playwright can't drive, so the test instead checks the right
    // channel/id or name reached the (stubbed) IPC boundary.
    const exportCalls: Array<{ channel: string; args: unknown[] }> = [];
    win.__exportCalls = exportCalls;
    // cancel_automation calls, and what ends the step currently "running" (see run_automation).
    const cancelCalls: string[] = [];
    win.__cancelCalls = cancelCalls;
    let pendingCancel: (() => void) | undefined;

    function fire(channel: string, payload: unknown): void {
      for (const cb of listeners[channel] ?? []) cb(payload);
    }

    win.remoty = {
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
          // GitHub, as the step editor sees it for Enable-Energy-Solutions/Frontend.
          case 'github_repositories':
            return Promise.resolve(['Enable-Energy-Solutions/Frontend', 'Sniphs98/Remoty']);
          case 'github_workflows':
            return Promise.resolve([
              { name: 'Release Frontend', file: 'release.yml' },
              { name: 'Tests', file: 'test.yml' }
            ]);
          case 'github_branches':
            return Promise.resolve(['main', 'feature/login']);
          case 'github_workflow_inputs':
            return Promise.resolve([
              { name: 'release_type', description: 'Release type (major, minor, patch)', type: 'choice', required: true, default: 'patch', options: ['major', 'minor', 'patch'] }
            ]);
          case 'wsl_distros':
            return Promise.resolve(['Ubuntu']);
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
          case 'export_all_automations':
            exportCalls.push({ channel, args });
            return Promise.resolve(`/fake/path/${String(args[0] ?? 'all')}.json`);
          case 'import_bundle': {
            // Simulates the user picking a file that bundles one new Snippet —
            // the real merge/parse logic is covered by bundle.test.ts on the electron
            // side; this just exercises the renderer's "refresh after import" wiring.
            const id = `imported-${state.snippets.length + 1}`;
            state.snippets.push({ id, name: 'Imported', command: 'echo imported', timeoutSecs: 300 });
            return Promise.resolve({ kind: 'snippet', name: 'Imported' });
          }
          case 'cancel_automation': {
            cancelCalls.push(args[0] as string);
            pendingCancel?.();
            pendingCancel = undefined;
            return Promise.resolve(null);
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
                const github = (node as { github?: { action: string } }).github;
                if (github) {
                  // A GitHub step: news while it runs, then the release's tag.
                  fire('automation-node-progress', { automationName, nodeId: node.id, message: 'run #57: https://github.com/Enable-Energy-Solutions/Frontend/actions/runs/4242' });
                  fire('automation-node-progress', { automationName, nodeId: node.id, message: 'build-frontend-docker (2/4 jobs done)' });
                  const result = { nodeId: node.id, label: node.label, status: 'success', output: 'v1.4.2', durationMs: 1 };
                  statusById.set(node.id, 'success');
                  results.push(result);
                  fire('automation-node-result', { automationName, ...result });
                  continue;
                }
                const snippet = snippetsById.get(node.snippetId);
                const command = (snippet?.command as string) ?? '';
                if (command.includes('sleep')) {
                  // Runs until stopped: Stop fails it as canceled and skips the rest.
                  const rest = automation.nodes.slice(automation.nodes.indexOf(node) + 1);
                  pendingCancel = () => {
                    const canceled = { nodeId: node.id, label: node.label, status: 'failed', output: '', error: 'canceled', durationMs: 1 };
                    results.push(canceled);
                    fire('automation-node-result', { automationName, ...canceled });
                    for (const later of rest) {
                      const skipped = { nodeId: later.id, label: later.label, status: 'skipped', output: '', error: 'canceled', durationMs: 0 };
                      results.push(skipped);
                      fire('automation-node-result', { automationName, ...skipped });
                    }
                    fire('automation-completed', { automationName, results });
                  };
                  return;
                }
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

test('an upload step: added from the "+" menu, saved as a node without a snippet, there again on reopen', async ({ page }) => {
  await boot(page);
  await page.getByRole('button', { name: 'Automations', exact: true }).click();
  await page.getByRole('button', { name: 'New automation' }).first().click();
  await page.getByLabel('Automation name').fill('ship-image');

  await page.getByRole('button', { name: 'Add a snippet to this automation' }).click();
  await page.getByRole('dialog', { name: 'Pick a snippet' }).getByRole('button', { name: /Upload a file to the host/ }).click();
  const upload = page.locator('.svelte-flow__node', { hasText: 'Upload a file to the host' });
  await expect(upload.getByLabel('Label')).toHaveValue('upload');
  await upload.getByLabel('From this computer').fill('image.tar.gz');
  await upload.getByLabel('To on the host').fill('/tmp/');

  // An upload always goes to the host, so the automation needs a host parameter first.
  await page.getByRole('button', { name: 'Create automation' }).click();
  await expect(page.getByText('This automation runs something on a host — add a host parameter on the Start node')).toBeVisible();
  await page.getByRole('button', { name: 'Add parameter' }).click();
  await page.getByLabel('Parameter 1 name').fill('host');
  await page.getByRole('combobox', { name: 'Parameter 1 kind' }).selectOption('host');
  await page.getByRole('button', { name: 'Create automation' }).click();
  await expect(page.getByRole('heading', { name: 'Automations' })).toBeVisible();

  const saved = await page.evaluate(
    () => (window as unknown as { __automationState: { automations: Array<{ nodes: unknown[] }> } }).__automationState.automations[0].nodes[0]
  );
  expect(saved).toMatchObject({ snippetId: '', upload: { from: 'image.tar.gz', to: '/tmp/' }, target: 'remote', label: 'upload' });

  await page.getByText('ship-image', { exact: true }).click();
  const reopened = page.locator('.svelte-flow__node', { hasText: 'Upload a file to the host' });
  await expect(reopened.getByLabel('From this computer')).toHaveValue('image.tar.gz');
  await expect(reopened.getByLabel('To on the host')).toHaveValue('/tmp/');
});

test('a running automation can be stopped — from its card or the run panel', async ({ page }) => {
  await boot(page);
  await page.getByRole('button', { name: 'Automations', exact: true }).click();
  await page.getByRole('button', { name: 'Manage snippets' }).click();
  for (const [name, command] of [
    ['Build', 'sleep 600'],
    ['Notify', 'echo notified']
  ]) {
    await page.getByRole('button', { name: 'New snippet' }).first().click();
    const editor = page.getByRole('dialog', { name: 'New snippet' });
    await editor.getByLabel('Name').fill(name);
    await editor.getByLabel('Command').fill(command);
    await editor.getByRole('button', { name: 'Add snippet' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  await page.getByRole('button', { name: 'Back to Automations' }).click();
  await page.getByRole('button', { name: 'New automation' }).first().click();
  await page.getByLabel('Automation name').fill('long-build');
  for (const name of ['Build', 'Notify']) {
    await page.getByRole('button', { name: 'Add a snippet to this automation' }).click();
    await page.getByRole('dialog', { name: 'Pick a snippet' }).getByRole('button', { name: new RegExp(name) }).click();
  }
  await page.getByRole('button', { name: 'Create automation' }).click();
  await expect(page.getByRole('heading', { name: 'Automations' })).toBeVisible();

  // Running: the panel offers Stop, and so does the card once the panel is closed.
  await page.getByRole('button', { name: 'Run long-build' }).click();
  const panel = page.getByRole('dialog', { name: 'Automation run' });
  await expect(panel.getByText('running…')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await page.getByRole('button', { name: 'Stop long-build' }).click();
  expect(await page.evaluate(() => (window as unknown as { __cancelCalls: string[] }).__cancelCalls)).toEqual(['long-build']);
  // The run ends, and its results come up as any finished run's do.
  await expect(panel.getByText('canceled', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('button', { name: 'Run long-build' })).toBeVisible();

  // Again, stopped from the panel this time: the running step reads "canceled", the next one is skipped.
  await page.getByRole('button', { name: 'Run long-build' }).click();
  await expect(panel.getByText('running…')).toBeVisible();
  await panel.getByRole('button', { name: 'Stop' }).click();
  await expect(panel.getByText('canceled', { exact: true })).toBeVisible();
  await expect(panel.getByText('skipped', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Done' })).toBeVisible();
});

test('leaving an automation with unsaved changes asks first: keep editing, discard, or save', async ({ page }) => {
  await boot(page);
  await page.getByRole('button', { name: 'Automations', exact: true }).click();
  await page.getByRole('button', { name: 'New automation' }).first().click();

  // Nothing changed yet: leaving just leaves.
  await page.getByRole('button', { name: 'Back to Automations' }).click();
  await expect(page.getByRole('heading', { name: 'Automations' })).toBeVisible();

  await page.getByRole('button', { name: 'New automation' }).first().click();
  await page.getByLabel('Automation name').fill('ship-image');
  await page.getByRole('button', { name: 'Add a snippet to this automation' }).click();
  await page.getByRole('dialog', { name: 'Pick a snippet' }).getByRole('button', { name: /Upload a file to the host/ }).click();
  await page.getByRole('button', { name: 'Add parameter' }).click();
  await page.getByLabel('Parameter 1 name').fill('host');
  await page.getByRole('combobox', { name: 'Parameter 1 kind' }).selectOption('host');
  const upload = page.locator('.svelte-flow__node', { hasText: 'Upload a file to the host' });
  await upload.getByLabel('From this computer').fill('image.tar.gz');

  // Any way out asks — here the back arrow: "Keep editing" stays, changes intact.
  const prompt = page.getByRole('dialog', { name: 'Unsaved changes' });
  await page.getByRole('button', { name: 'Back to Automations' }).click();
  await expect(prompt).toBeVisible();
  await prompt.getByRole('button', { name: 'Keep editing' }).click();
  await expect(prompt).toHaveCount(0);
  await expect(page.getByLabel('Automation name')).toHaveValue('ship-image');

  // Cancel asks too; "Discard" leaves without saving anything.
  await page.getByRole('button', { name: 'Cancel' }).click();
  await prompt.getByRole('button', { name: 'Discard' }).click();
  await expect(page.getByRole('heading', { name: 'Automations' })).toBeVisible();
  expect(
    await page.evaluate(() => (window as unknown as { __automationState: { automations: unknown[] } }).__automationState.automations.length)
  ).toBe(0);

  // "Save" saves, then goes where the user was headed — here the sidebar's Automations.
  await page.getByRole('button', { name: 'New automation' }).first().click();
  await page.getByLabel('Automation name').fill('ship-image');
  await page.getByRole('button', { name: 'Add a snippet to this automation' }).click();
  await page.getByRole('dialog', { name: 'Pick a snippet' }).getByRole('button', { name: /Upload a file to the host/ }).click();
  await page.getByRole('button', { name: 'Add parameter' }).click();
  await page.getByLabel('Parameter 1 name').fill('host');
  await page.getByRole('combobox', { name: 'Parameter 1 kind' }).selectOption('host');
  await page.getByRole('button', { name: 'Automations', exact: true }).click();
  await prompt.getByRole('button', { name: 'Save' }).click();
  await expect(prompt).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Automations' })).toBeVisible();
  expect(
    await page.evaluate(
      () => (window as unknown as { __automationState: { automations: Array<{ name: string }> } }).__automationState.automations.map((f) => f.name)
    )
  ).toEqual(['ship-image']);
});

test('a node can run in WSL, in a chosen distribution, without needing a host', async ({ page }) => {
  await boot(page);
  await page.getByRole('button', { name: 'Automations', exact: true }).click();
  await page.getByRole('button', { name: 'Manage snippets' }).click();
  await page.getByRole('button', { name: 'New snippet' }).first().click();
  const snippetEditor = page.getByRole('dialog', { name: 'New snippet' });
  await snippetEditor.getByLabel('Name').fill('Save image');
  await snippetEditor.getByLabel('Command').fill('docker save -o image.tar nginx');
  await snippetEditor.getByRole('button', { name: 'Add snippet' }).click();

  await page.getByRole('button', { name: 'Back to Automations' }).click();
  await page.getByRole('button', { name: 'New automation' }).first().click();
  await page.getByLabel('Automation name').fill('in-wsl');
  await page.getByRole('button', { name: 'Add a snippet to this automation' }).click();
  await page.getByRole('dialog', { name: 'Pick a snippet' }).getByRole('button', { name: /Save image/ }).click();

  const node = page.locator('.svelte-flow__node', { hasText: 'Save image' });
  await expect(node.getByLabel('WSL distribution')).toHaveCount(0);
  await node.getByRole('button', { name: 'WSL' }).click();
  await expect(node.getByRole('button', { name: 'WSL' })).toHaveAttribute('aria-pressed', 'true');
  await node.getByLabel('WSL distribution').selectOption('Ubuntu');

  // No host parameter needed: WSL is on this machine.
  await page.getByRole('button', { name: 'Create automation' }).click();
  await expect(page.getByRole('heading', { name: 'Automations' })).toBeVisible();
  const saved = await page.evaluate(
    () => (window as unknown as { __automationState: { automations: Array<{ nodes: unknown[] }> } }).__automationState.automations[0].nodes[0]
  );
  expect(saved).toMatchObject({ target: 'wsl', wslDistro: 'Ubuntu' });

  await page.getByText('in-wsl', { exact: true }).click();
  const reopened = page.locator('.svelte-flow__node', { hasText: 'Save image' });
  await expect(reopened.getByRole('button', { name: 'WSL' })).toHaveAttribute('aria-pressed', 'true');
  await expect(reopened.getByLabel('WSL distribution')).toHaveValue('Ubuntu');
});

test('a GitHub workflow step: picked from the "+" menu, filled from GitHub, run with live progress', async ({ page }) => {
  await boot(page);
  await page.getByRole('button', { name: 'Automations', exact: true }).click();
  await page.getByRole('button', { name: 'New automation' }).first().click();
  await page.getByLabel('Automation name').fill('release-frontend');
  await page.getByRole('button', { name: 'Add parameter' }).click();
  await page.getByLabel('Parameter 1 name').fill('branch');

  await page.getByRole('button', { name: 'Add a snippet to this automation' }).click();
  await page.getByRole('dialog', { name: 'Pick a snippet' }).getByRole('button', { name: /Start a GitHub workflow/ }).click();
  const node = page.locator('.svelte-flow__node', { hasText: 'Start a GitHub workflow' });
  await expect(node.getByLabel('Label')).toHaveValue('release');
  await node.getByLabel('Repository').fill('Enable-Energy-Solutions/Frontend');
  await node.getByLabel('Workflow').fill('release.yml');
  await node.getByLabel('Branch').fill('{{params.branch}}');
  // The workflow's own input appears, its default filled in; its choices are offered.
  await expect(node.getByLabel('Input release_type')).toHaveValue('patch');
  await expect(node.locator('datalist[id$="-in-release_type"] option')).toHaveCount(3);
  await node.getByLabel('Input release_type').fill('minor');

  // No host needed: it runs here.
  await page.getByRole('button', { name: 'Create automation' }).click();
  await expect(page.getByRole('heading', { name: 'Automations' })).toBeVisible();
  const saved = await page.evaluate(
    () => (window as unknown as { __automationState: { automations: Array<{ nodes: unknown[] }> } }).__automationState.automations[0].nodes[0]
  );
  expect(saved).toMatchObject({
    snippetId: '',
    target: 'local',
    label: 'release',
    github: { action: 'runWorkflow', repo: 'Enable-Energy-Solutions/Frontend', workflow: 'release.yml', ref: '{{params.branch}}', inputs: { release_type: 'minor' } }
  });

  // Running it shows GitHub's progress and a link to the run, which stay once done.
  await page.getByRole('button', { name: 'Run release-frontend' }).click();
  const runDialog = page.getByRole('dialog', { name: 'Run automation' });
  await runDialog.getByRole('textbox').first().fill('main');
  await runDialog.getByRole('button', { name: 'Run', exact: true }).click();
  const progress = page.getByRole('dialog', { name: 'Automation run' });
  await expect(progress.getByRole('button', { name: 'Done' })).toBeVisible();
  await expect(progress).toContainText('build-frontend-docker (2/4 jobs done)');
  await expect(progress.getByRole('button', { name: 'https://github.com/Enable-Energy-Solutions/Frontend/actions/runs/4242' })).toBeVisible();
  await expect(progress.locator('pre')).toHaveText('v1.4.2');
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

test('an if node: added from the "+" menu, its "no" way wired by dragging, saved with its condition and its ways out', async ({ page }) => {
  await boot(page);
  await page.getByRole('button', { name: 'Automations', exact: true }).click();
  await page.getByRole('button', { name: 'Manage snippets' }).click();
  await page.getByRole('button', { name: 'New snippet' }).first().click();
  const editor = page.getByRole('dialog', { name: 'New snippet' });
  await editor.getByLabel('Name').fill('Deploy');
  await editor.getByLabel('Command').fill('echo deploy');
  await editor.getByRole('button', { name: 'Add snippet' }).click();
  await page.getByRole('button', { name: 'Back to Automations' }).click();

  await page.getByRole('button', { name: 'New automation' }).first().click();
  await page.getByLabel('Automation name').fill('only-prod');
  await page.getByRole('button', { name: 'Add a snippet to this automation' }).click();
  await page.getByRole('dialog', { name: 'Pick a snippet' }).getByRole('button', { name: /If…/ }).click();
  const ifNode = page.locator('.svelte-flow__node', { hasText: 'If — then one way or the other' });
  await expect(ifNode.getByLabel('Label')).toHaveValue('if');
  await ifNode.getByLabel('Value to check').fill('{{params.env}}');
  await ifNode.getByRole('combobox', { name: 'Comparison' }).selectOption('notEquals');
  await ifNode.getByLabel('Compare with').fill('prod');

  // A variable fixed in the automation: set here, never asked for.
  await page.getByRole('button', { name: 'Add parameter' }).click();
  await page.getByLabel('Parameter 1 name').fill('env');
  await page.getByRole('combobox', { name: 'Parameter 1 kind' }).selectOption('fixed');
  await page.getByLabel('Parameter 1 value').fill('prod');

  await page.getByRole('button', { name: 'Fit View' }).click();
  const noHandle = ifNode.locator('.svelte-flow__handle.source[data-handleid="no"]');
  const handleBox = await noHandle.boundingBox();
  const paneBox = await page.locator('.svelte-flow__pane').boundingBox();
  if (!handleBox || !paneBox) throw new Error('handle or pane not found');
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(paneBox.x + paneBox.width - 40, paneBox.y + paneBox.height - 40, { steps: 10 });
  await page.mouse.up();
  await page.getByRole('dialog', { name: 'Pick a snippet' }).getByRole('button', { name: /Deploy/ }).click();
  await expect(page.locator('.svelte-flow__edge')).toHaveCount(1);
  await expect(page.locator('.svelte-flow__edge-label')).toHaveText('no');

  await page.getByRole('button', { name: 'Create automation' }).click();
  await expect(page.getByRole('heading', { name: 'Automations' })).toBeVisible();
  const saved = await page.evaluate(
    () =>
      (window as unknown as { __automationState: { automations: Array<{ params: unknown[]; nodes: Array<Record<string, unknown>>; edges: unknown[] }> } })
        .__automationState.automations[0]
  );
  expect(saved.params).toEqual([{ name: 'env', kind: 'fixed', default: 'prod' }]);
  expect(saved.nodes[0]).toMatchObject({
    snippetId: '',
    label: 'if',
    target: 'local',
    condition: { kind: 'compare', left: '{{params.env}}', op: 'notEquals', right: 'prod' }
  });
  expect(saved.edges).toEqual([{ from: saved.nodes[0].id, to: saved.nodes[1].id, branch: 'no' }]);

  // Reopened, the way out is still the "no" one.
  await page.getByText('only-prod', { exact: true }).click();
  await expect(page.locator('.svelte-flow__edge-label')).toHaveText('no');
  await expect(page.getByLabel('Parameter 1 value')).toHaveValue('prod');
  await page.getByRole('button', { name: 'Back to Automations' }).click();

  // With only a fixed variable, Run asks for nothing — it just runs.
  await page.getByRole('button', { name: 'Run only-prod' }).click();
  await expect(page.getByRole('dialog', { name: 'Run automation' })).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Automation run' })).toBeVisible();
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

  // Or everything at once: every automation and the whole snippet library.
  await page.getByRole('button', { name: 'Export all…' }).click();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __exportCalls: unknown[] }).__exportCalls.length))
    .toBe(3);
  const allCall = await page.evaluate(
    () => (window as unknown as { __exportCalls: Array<{ channel: string; args: unknown[] }> }).__exportCalls[2]
  );
  expect(allCall).toEqual({ channel: 'export_all_automations', args: [] });

  // Importing adds whatever the (stubbed) file picker returned straight to the
  // library — no second click needed to place it, unlike picking from a list.
  await page.getByRole('button', { name: 'Manage snippets' }).click();
  await expect(page.getByText('Imported', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Import…' }).click();
  await expect(page.getByText('Imported', { exact: true })).toBeVisible();
});

test('a node that runs another automation: picked from the "+" menu, its values handed on, saved', async ({ page }) => {
  await boot(page);
  // An automation to run: on a host, with a tag to build, and a variable of its own.
  await page.evaluate(() =>
    (window as unknown as { __automationState: { automations: unknown[] } }).__automationState.automations.push({
      name: 'release',
      params: [
        { name: 'server', kind: 'host' },
        { name: 'tag', kind: 'text' },
        { name: 'mode', kind: 'fixed', default: 'prod' }
      ],
      nodes: [],
      edges: []
    })
  );
  await page.getByRole('button', { name: 'Automations', exact: true }).click();
  await page.getByRole('button', { name: 'New automation' }).first().click();
  await page.getByLabel('Automation name').fill('ship');
  await page.getByRole('button', { name: 'Add parameter' }).click();
  await page.getByLabel('Parameter 1 name').fill('host');
  await page.getByRole('combobox', { name: 'Parameter 1 kind' }).selectOption('host');

  await page.getByRole('button', { name: 'Add a snippet to this automation' }).click();
  await page.getByRole('dialog', { name: 'Pick a snippet' }).getByRole('button', { name: /Run another automation/ }).click();
  const callNode = page.locator('.svelte-flow__node', { hasText: 'Run another automation' });
  await expect(callNode.getByLabel('Label')).toHaveValue('run');
  // Only other automations to pick from — not this one.
  await expect(callNode.getByRole('combobox', { name: 'Automation to run' }).locator('option')).toHaveText(['Choose…', 'release']);
  await callNode.getByRole('combobox', { name: 'Automation to run' }).selectOption('release');

  // Its host is handed on from this automation's; the tag is ours to give; its fixed variable isn't asked.
  await expect(callNode.getByLabel('Value for server')).toHaveValue('{{params.host}}');
  await expect(callNode.getByLabel('Value for mode')).toHaveCount(0);
  await callNode.getByLabel('Value for tag').fill('v1.2');
  await page.getByRole('button', { name: 'Fit View' }).click();
  await page.screenshot({ path: 'test-results/call-node.png' });

  await page.getByRole('button', { name: 'Create automation' }).click();
  await expect(page.getByRole('heading', { name: 'Automations' })).toBeVisible();
  const saved = await page.evaluate(
    () =>
      (window as unknown as { __automationState: { automations: Array<{ name: string; nodes: Array<Record<string, unknown>> }> } })
        .__automationState.automations.find((a) => a.name === 'ship')
  );
  expect(saved?.nodes[0]).toMatchObject({
    snippetId: '',
    label: 'run',
    target: 'local',
    call: { automation: 'release', params: { server: '{{params.host}}', tag: 'v1.2' } }
  });
});
