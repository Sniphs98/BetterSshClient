import type { IpcMain } from 'electron';

import { loadSnippets, saveSnippets } from '../core/config/snippets.js';
import type { Snippet } from '../core/config/snippets.js';
import { toCommandError } from '../dto.js';
import type { SnippetDto } from '../dto.js';

/** Snippet commands. Ported from crates/omnyssh-gui/src/commands/snippets.rs
 *  (list/save/delete only — `execute_snippet` needs a live SSH session and
 *  lands with Phase 2's core SSH engine). */

export function registerSnippetsIpc(ipcMain: IpcMain): void {
  ipcMain.handle('list_snippets', async () => {
    try {
      return await loadSnippets();
    } catch (err) {
      throw toCommandError(err);
    }
  });

  ipcMain.handle('save_snippet', async (_event, snippet: SnippetDto) => {
    try {
      const snippets = await loadSnippets();
      const i = snippets.findIndex((s) => s.name === snippet.name);
      const next: Snippet = snippet;
      if (i !== -1) snippets[i] = next;
      else snippets.push(next);
      await saveSnippets(snippets);
    } catch (err) {
      throw toCommandError(err);
    }
  });

  ipcMain.handle('delete_snippet', async (_event, name: string) => {
    try {
      const snippets = await loadSnippets();
      const i = snippets.findIndex((s) => s.name === name);
      if (i !== -1) {
        snippets.splice(i, 1);
        await saveSnippets(snippets);
      }
    } catch (err) {
      throw toCommandError(err);
    }
  });
}
