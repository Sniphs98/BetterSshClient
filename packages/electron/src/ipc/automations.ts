import { dialog, type IpcMain } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';

import { loadAutomations, saveAutomations } from '../core/config/automations.js';
import { loadFlows, saveFlows } from '../core/config/flows.js';
import { runLocalCommand } from '../core/automation/localExec.js';
import { missingParamValues, runFlow, validateFlow, type RunFlowDeps } from '../core/automation/engine.js';
import {
  buildAutomationBundle,
  buildFlowBundle,
  mergeAutomationBundle,
  mergeFlowBundle,
  parseBundle
} from '../core/automation/bundle.js';
import type { Automation, Flow } from '../core/automation/types.js';
import { SshSession } from '../core/ssh/session.js';
import { automationFromDto, flowFromDto, nodeResultToDto, toCommandError } from '../dto.js';
import type { AutomationDto, FlowDto, ImportResultDto } from '../dto.js';
import type { GuiState } from '../state/guiState.js';

/**
 * Automation/Flow commands: CRUD for the reusable Automation library and for Flows,
 * plus `run_flow` (fire-and-forget, streaming progress via `automation-*` events —
 * same shape as `ipc/keysetup.ts`'s `start_key_setup`, but keyed per flow name rather
 * than a single global slot, since two different flows have no reason to serialize).
 */

/** Upserts `input` into the Automation library by id (the renderer mints
 *  `crypto.randomUUID()` for a new one). Exported for unit testing without `ipcMain`. */
export function upsertAutomation(automations: Automation[], input: AutomationDto): void {
  const automation = automationFromDto(input);
  const i = automations.findIndex((a) => a.id === automation.id);
  if (i !== -1) automations[i] = automation;
  else automations.push(automation);
}

/** Removes the automation named `id`, or throws if any Flow's node still references
 *  it — deleting it out from under a Flow would silently break that Flow the next
 *  time it runs, so this blocks instead (naming the flow(s) in the error). */
export function removeAutomation(automations: Automation[], flows: Flow[], id: string): void {
  const referencing = flows.filter((f) => f.nodes.some((n) => n.automationId === id));
  if (referencing.length > 0) {
    const names = referencing.map((f) => `'${f.name}'`).join(', ');
    throw new Error(`cannot delete: still used by flow${referencing.length > 1 ? 's' : ''} ${names}`);
  }
  const i = automations.findIndex((a) => a.id === id);
  if (i !== -1) automations.splice(i, 1);
}

/** Upserts `input` into the Flow list by name. Exported for unit testing. */
export function upsertFlow(flows: Flow[], input: FlowDto): void {
  const flow = flowFromDto(input);
  const i = flows.findIndex((f) => f.name === flow.name);
  if (i !== -1) flows[i] = flow;
  else flows.push(flow);
}

export function removeFlow(flows: Flow[], name: string): void {
  const i = flows.findIndex((f) => f.name === name);
  if (i !== -1) flows.splice(i, 1);
}

/** A safe default filename for a save dialog: strips characters Windows/macOS/Linux
 *  filesystems all reject, so an Automation/Flow name with, say, a `/` in it doesn't
 *  blow up `dialog.showSaveDialog`'s `defaultPath`. */
function sanitizeFileName(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, '_').trim() || 'untitled';
}

export function registerAutomationsIpc(ipcMain: IpcMain, state: GuiState): void {
  ipcMain.handle('list_automations', async () => {
    try {
      return await loadAutomations();
    } catch (err) {
      throw toCommandError(err);
    }
  });

  ipcMain.handle('save_automation', async (_event, input: AutomationDto) => {
    try {
      const automations = await loadAutomations();
      upsertAutomation(automations, input);
      await saveAutomations(automations);
    } catch (err) {
      throw toCommandError(err);
    }
  });

  ipcMain.handle('delete_automation', async (_event, id: string) => {
    try {
      const [automations, flows] = await Promise.all([loadAutomations(), loadFlows()]);
      removeAutomation(automations, flows, id);
      await saveAutomations(automations);
    } catch (err) {
      throw toCommandError(err);
    }
  });

  ipcMain.handle('list_flows', async () => {
    try {
      return await loadFlows();
    } catch (err) {
      throw toCommandError(err);
    }
  });

  ipcMain.handle('save_flow', async (_event, input: FlowDto) => {
    try {
      const [flows, automations] = await Promise.all([loadFlows(), loadAutomations()]);
      const flow = flowFromDto(input);
      const problems = validateFlow(flow, new Map(automations.map((a) => [a.id, a])));
      if (problems.length > 0) throw new Error(problems.join('; '));
      upsertFlow(flows, input);
      await saveFlows(flows);
    } catch (err) {
      throw toCommandError(err);
    }
  });

  ipcMain.handle('delete_flow', async (_event, name: string) => {
    try {
      const flows = await loadFlows();
      removeFlow(flows, name);
      await saveFlows(flows);
    } catch (err) {
      throw toCommandError(err);
    }
  });

  // Export/import (tech-request: sharing an Automation or Flow between people or
  // machines as a portable file — see core/automation/bundle.ts). Every handler here
  // returns `null` when the user cancels the native dialog rather than throwing, since
  // a cancel isn't a failure.

  ipcMain.handle('export_automation', async (_event, id: string): Promise<string | null> => {
    try {
      const automations = await loadAutomations();
      const automation = automations.find((a) => a.id === id);
      if (automation === undefined) throw new Error('automation no longer exists');
      const bundle = buildAutomationBundle(automation);
      const { canceled, filePath } = await dialog.showSaveDialog({
        title: 'Export automation',
        defaultPath: `${sanitizeFileName(automation.name)}.omnyssh-automation.json`,
        filters: [{ name: 'OmnySSH automation', extensions: ['json'] }]
      });
      if (canceled || !filePath) return null;
      await writeFile(filePath, JSON.stringify(bundle, null, 2), 'utf-8');
      return filePath;
    } catch (err) {
      throw toCommandError(err);
    }
  });

  ipcMain.handle('export_flow', async (_event, name: string): Promise<string | null> => {
    try {
      const [flows, automations] = await Promise.all([loadFlows(), loadAutomations()]);
      const flow = flows.find((f) => f.name === name);
      if (flow === undefined) throw new Error('flow no longer exists');
      const bundle = buildFlowBundle(flow, new Map(automations.map((a) => [a.id, a])));
      const { canceled, filePath } = await dialog.showSaveDialog({
        title: 'Export flow',
        defaultPath: `${sanitizeFileName(flow.name)}.omnyssh-flow.json`,
        filters: [{ name: 'OmnySSH flow', extensions: ['json'] }]
      });
      if (canceled || !filePath) return null;
      await writeFile(filePath, JSON.stringify(bundle, null, 2), 'utf-8');
      return filePath;
    } catch (err) {
      throw toCommandError(err);
    }
  });

  ipcMain.handle('import_bundle', async (): Promise<ImportResultDto | null> => {
    try {
      const { canceled, filePaths } = await dialog.showOpenDialog({
        title: 'Import automation or flow',
        filters: [{ name: 'OmnySSH automation/flow', extensions: ['json'] }],
        properties: ['openFile']
      });
      if (canceled || filePaths.length === 0) return null;

      const content = await readFile(filePaths[0], 'utf-8');
      let raw: unknown;
      try {
        raw = JSON.parse(content);
      } catch {
        throw new Error('not a valid JSON file');
      }
      const bundle = parseBundle(raw);

      const [automations, flows] = await Promise.all([loadAutomations(), loadFlows()]);
      if (bundle.kind === 'omnyssh-automation') {
        const merged = mergeAutomationBundle(bundle, automations);
        await saveAutomations(merged.automations);
        return merged.result;
      }
      const merged = mergeFlowBundle(bundle, automations, flows);
      await saveAutomations(merged.automations);
      await saveFlows(merged.flows);
      return merged.result;
    } catch (err) {
      throw toCommandError(err);
    }
  });

  ipcMain.handle('run_flow', (_event, name: string, paramValues: Record<string, string>) => {
    try {
      state.tryBeginFlowRun(name);
    } catch (err) {
      throw toCommandError(err);
    }
    void executeFlowRun(state, name, paramValues);
  });
}

async function executeFlowRun(state: GuiState, flowName: string, paramValues: Record<string, string>): Promise<void> {
  try {
    let flow: Flow | undefined;
    let automations: Automation[];
    try {
      const [flows, loadedAutomations] = await Promise.all([loadFlows(), loadAutomations()]);
      flow = flows.find((f) => f.name === flowName);
      automations = loadedAutomations;
    } catch (err) {
      state.emit('automation-flow-failed', { flowName, error: (err as Error).message });
      return;
    }
    if (flow === undefined) {
      state.emit('automation-flow-failed', { flowName, error: `flow '${flowName}' no longer exists` });
      return;
    }

    const automationsById = new Map(automations.map((a) => [a.id, a]));
    const problems = validateFlow(flow, automationsById);
    if (problems.length > 0) {
      state.emit('automation-flow-failed', { flowName, error: problems.join('; ') });
      return;
    }
    const missing = missingParamValues(flow, paramValues);
    if (missing.length > 0) {
      state.emit('automation-flow-failed', { flowName, error: `missing value for: ${missing.join(', ')}` });
      return;
    }

    state.emit('automation-flow-started', { flowName });
    const deps: RunFlowDeps = {
      runLocal: runLocalCommand,
      connectHost: async (hostName) => {
        const host = state.hostByName(hostName);
        if (host === undefined) throw new Error(`unknown host '${hostName}'`);
        const session = await SshSession.connect(host);
        return {
          runShell: (cmd, timeoutMs) => session.runShell(cmd, timeoutMs),
          disconnect: () => session.disconnect()
        };
      }
    };

    try {
      const results = await runFlow(flow, automationsById, paramValues, deps, (event) => {
        if (event.kind === 'nodeStarted') {
          state.emit('automation-node-started', { flowName, nodeId: event.nodeId, label: event.label });
        } else {
          state.emit('automation-node-result', { flowName, ...nodeResultToDto(event.result) });
        }
      });
      state.emit('automation-flow-completed', { flowName, results: results.map(nodeResultToDto) });
    } catch (err) {
      state.emit('automation-flow-failed', { flowName, error: (err as Error).message });
    }
  } finally {
    state.endFlowRun(flowName);
  }
}
