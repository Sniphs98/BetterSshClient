import { dialog, type IpcMain } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';

import { loadSnippets, saveSnippets } from '../core/config/snippets.js';
import { loadAutomations, saveAutomations } from '../core/config/automations.js';
import { runLocalCommand } from '../core/automation/localExec.js';
import { uploadOverSession } from '../core/automation/upload.js';
import { missingParamValues, runAutomation, validateAutomation, type RunAutomationDeps } from '../core/automation/engine.js';
import {
  buildSnippetBundle,
  buildAutomationBundle,
  mergeSnippetBundle,
  mergeAutomationBundle,
  parseBundle
} from '../core/automation/bundle.js';
import type { Snippet, Automation } from '../core/automation/types.js';
import { SshSession } from '../core/ssh/session.js';
import { snippetFromDto, automationFromDto, nodeResultToDto, toCommandError } from '../dto.js';
import type { SnippetDto, AutomationDto, ImportResultDto } from '../dto.js';
import type { GuiState } from '../state/guiState.js';

/**
 * Snippet/Automation commands: CRUD for the reusable Snippet library and for Automations,
 * plus `run_automation` (fire-and-forget, streaming progress via `automation-*` events —
 * same shape as `ipc/keysetup.ts`'s `start_key_setup`, but keyed per automation name rather
 * than a single global slot, since two different automations have no reason to serialize).
 */

/** Upserts `input` into the Snippet library by id (the renderer mints
 *  `crypto.randomUUID()` for a new one). Exported for unit testing without `ipcMain`. */
export function upsertSnippet(snippets: Snippet[], input: SnippetDto): void {
  const snippet = snippetFromDto(input);
  const i = snippets.findIndex((a) => a.id === snippet.id);
  if (i !== -1) snippets[i] = snippet;
  else snippets.push(snippet);
}

/** Removes the snippet named `id`, or throws if any Automation's node still references
 *  it — deleting it out from under an Automation would silently break that Automation the next
 *  time it runs, so this blocks instead (naming the automation(s) in the error). */
export function removeSnippet(snippets: Snippet[], automations: Automation[], id: string): void {
  const referencing = automations.filter((f) => f.nodes.some((n) => n.snippetId === id));
  if (referencing.length > 0) {
    const names = referencing.map((f) => `'${f.name}'`).join(', ');
    throw new Error(`cannot delete: still used by automation${referencing.length > 1 ? 's' : ''} ${names}`);
  }
  const i = snippets.findIndex((a) => a.id === id);
  if (i !== -1) snippets.splice(i, 1);
}

/** Upserts `input` into the Automation list by name. Exported for unit testing. */
export function upsertAutomation(automations: Automation[], input: AutomationDto): void {
  const automation = automationFromDto(input);
  const i = automations.findIndex((f) => f.name === automation.name);
  if (i !== -1) automations[i] = automation;
  else automations.push(automation);
}

export function removeAutomation(automations: Automation[], name: string): void {
  const i = automations.findIndex((f) => f.name === name);
  if (i !== -1) automations.splice(i, 1);
}

/** A safe default filename for a save dialog: strips characters Windows/macOS/Linux
 *  filesystems all reject, so a Snippet/Automation name with, say, a `/` in it doesn't
 *  blow up `dialog.showSaveDialog`'s `defaultPath`. */
function sanitizeFileName(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, '_').trim() || 'untitled';
}

export function registerAutomationsIpc(ipcMain: IpcMain, state: GuiState): void {
  ipcMain.handle('list_snippets', async () => {
    try {
      return await loadSnippets();
    } catch (err) {
      throw toCommandError(err);
    }
  });

  ipcMain.handle('save_snippet', async (_event, input: SnippetDto) => {
    try {
      const snippets = await loadSnippets();
      upsertSnippet(snippets, input);
      await saveSnippets(snippets);
    } catch (err) {
      throw toCommandError(err);
    }
  });

  ipcMain.handle('delete_snippet', async (_event, id: string) => {
    try {
      const [snippets, automations] = await Promise.all([loadSnippets(), loadAutomations()]);
      removeSnippet(snippets, automations, id);
      await saveSnippets(snippets);
    } catch (err) {
      throw toCommandError(err);
    }
  });

  ipcMain.handle('list_automations', async () => {
    try {
      return await loadAutomations();
    } catch (err) {
      throw toCommandError(err);
    }
  });

  ipcMain.handle('save_automation', async (_event, input: AutomationDto) => {
    try {
      const [automations, snippets] = await Promise.all([loadAutomations(), loadSnippets()]);
      const automation = automationFromDto(input);
      const problems = validateAutomation(automation, new Map(snippets.map((a) => [a.id, a])));
      if (problems.length > 0) throw new Error(problems.join('; '));
      upsertAutomation(automations, input);
      await saveAutomations(automations);
    } catch (err) {
      throw toCommandError(err);
    }
  });

  ipcMain.handle('delete_automation', async (_event, name: string) => {
    try {
      const automations = await loadAutomations();
      removeAutomation(automations, name);
      await saveAutomations(automations);
    } catch (err) {
      throw toCommandError(err);
    }
  });

  // Export/import (tech-request: sharing a Snippet or Automation between people or
  // machines as a portable file — see core/automation/bundle.ts). Every handler here
  // returns `null` when the user cancels the native dialog rather than throwing, since
  // a cancel isn't a failure.

  ipcMain.handle('export_snippet', async (_event, id: string): Promise<string | null> => {
    try {
      const snippets = await loadSnippets();
      const snippet = snippets.find((a) => a.id === id);
      if (snippet === undefined) throw new Error('snippet no longer exists');
      const bundle = buildSnippetBundle(snippet);
      const { canceled, filePath } = await dialog.showSaveDialog({
        title: 'Export snippet',
        defaultPath: `${sanitizeFileName(snippet.name)}.better-ssh-client-snippet.json`,
        filters: [{ name: 'BetterSshClient snippet', extensions: ['json'] }]
      });
      if (canceled || !filePath) return null;
      await writeFile(filePath, JSON.stringify(bundle, null, 2), 'utf-8');
      return filePath;
    } catch (err) {
      throw toCommandError(err);
    }
  });

  ipcMain.handle('export_automation', async (_event, name: string): Promise<string | null> => {
    try {
      const [automations, snippets] = await Promise.all([loadAutomations(), loadSnippets()]);
      const automation = automations.find((f) => f.name === name);
      if (automation === undefined) throw new Error('automation no longer exists');
      const bundle = buildAutomationBundle(automation, new Map(snippets.map((a) => [a.id, a])));
      const { canceled, filePath } = await dialog.showSaveDialog({
        title: 'Export automation',
        defaultPath: `${sanitizeFileName(automation.name)}.better-ssh-client-automation.json`,
        filters: [{ name: 'BetterSshClient automation', extensions: ['json'] }]
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
        title: 'Import snippet or automation',
        filters: [{ name: 'BetterSshClient snippet/automation', extensions: ['json'] }],
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

      const [snippets, automations] = await Promise.all([loadSnippets(), loadAutomations()]);
      if (bundle.kind === 'better-ssh-client-snippet') {
        const merged = mergeSnippetBundle(bundle, snippets);
        await saveSnippets(merged.snippets);
        return merged.result;
      }
      const merged = mergeAutomationBundle(bundle, snippets, automations);
      await saveSnippets(merged.snippets);
      await saveAutomations(merged.automations);
      return merged.result;
    } catch (err) {
      throw toCommandError(err);
    }
  });

  ipcMain.handle('run_automation', (_event, name: string, paramValues: Record<string, string>) => {
    try {
      state.tryBeginAutomationRun(name);
    } catch (err) {
      throw toCommandError(err);
    }
    void executeAutomationRun(state, name, paramValues);
  });
}

async function executeAutomationRun(state: GuiState, automationName: string, paramValues: Record<string, string>): Promise<void> {
  try {
    let automation: Automation | undefined;
    let snippets: Snippet[];
    try {
      const [automations, loadedSnippets] = await Promise.all([loadAutomations(), loadSnippets()]);
      automation = automations.find((f) => f.name === automationName);
      snippets = loadedSnippets;
    } catch (err) {
      state.emit('automation-failed', { automationName, error: (err as Error).message });
      return;
    }
    if (automation === undefined) {
      state.emit('automation-failed', { automationName, error: `automation '${automationName}' no longer exists` });
      return;
    }

    const snippetsById = new Map(snippets.map((a) => [a.id, a]));
    const problems = validateAutomation(automation, snippetsById);
    if (problems.length > 0) {
      state.emit('automation-failed', { automationName, error: problems.join('; ') });
      return;
    }
    const missing = missingParamValues(automation, paramValues);
    if (missing.length > 0) {
      state.emit('automation-failed', { automationName, error: `missing value for: ${missing.join(', ')}` });
      return;
    }

    state.emit('automation-started', { automationName });
    const deps: RunAutomationDeps = {
      runLocal: runLocalCommand,
      connectHost: async (hostName) => {
        const host = state.hostByName(hostName);
        if (host === undefined) throw new Error(`unknown host '${hostName}'`);
        const session = await SshSession.shared(host);
        return {
          runShell: (cmd, timeoutMs) => session.runShell(cmd, timeoutMs),
          // Over the same connection as the commands: one login, one 1Password prompt.
          upload: (from, to) => uploadOverSession(session, hostName, from, to),
          disconnect: () => session.disconnect()
        };
      }
    };

    try {
      const results = await runAutomation(automation, snippetsById, paramValues, deps, (event) => {
        if (event.kind === 'nodeStarted') {
          state.emit('automation-node-started', { automationName, nodeId: event.nodeId, label: event.label });
        } else {
          state.emit('automation-node-result', { automationName, ...nodeResultToDto(event.result) });
        }
      });
      state.emit('automation-completed', { automationName, results: results.map(nodeResultToDto) });
    } catch (err) {
      state.emit('automation-failed', { automationName, error: (err as Error).message });
    }
  } finally {
    state.endAutomationRun(automationName);
  }
}
