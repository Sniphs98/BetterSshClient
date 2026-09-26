import type { IpcMain } from 'electron';

import { listTerminalProfiles } from '../core/local/profiles.js';
import { toCommandError } from '../dto.js';
import type { GuiState } from '../state/guiState.js';

/**
 * Terminal (PTY) commands. Ported from
 * crates/omnyssh-gui/src/commands/terminal.rs. Raw output streams to the
 * renderer over a per-session `terminal-output-<id>` event (wired in
 * `GuiState`'s `PtyManager` constructor) rather than riding the command
 * response — see `packages/ui/src/lib/bindings.ts`'s `Channel` class.
 */
export function registerTerminalIpc(ipcMain: IpcMain, state: GuiState): void {
  ipcMain.handle('terminal_open', async (_event, hostName: string, cols: number, rows: number) => {
    const host = state.hostByName(hostName);
    if (host === undefined) throw toCommandError(new Error(`unknown host: ${hostName}`));
    try {
      const id = state.allocateSessionId();
      return await state.pty.open(id, host, cols, rows, (e) => state.emitCoreEvent(e));
    } catch (err) {
      throw toCommandError(err);
    }
  });

  // The shells a local tab can open on this machine (see core/local/profiles.ts).
  ipcMain.handle('terminal_profiles', async () => {
    try {
      return (await listTerminalProfiles()).map(({ id, label, kind }) => ({ id, label, kind }));
    } catch (err) {
      throw toCommandError(err);
    }
  });

  ipcMain.handle('terminal_open_local', async (_event, profileId: string, cols: number, rows: number) => {
    try {
      const id = state.allocateSessionId();
      return await state.localPty.open(id, profileId, cols, rows, (e) => state.emitCoreEvent(e));
    } catch (err) {
      throw toCommandError(err);
    }
  });

  // Write, resize and close serve both kinds of tab: ids come from one space, so the
  // manager that has the id answers.
  ipcMain.handle('terminal_write', (_event, sessionId: number, data: Uint8Array) => {
    if (state.localPty.has(sessionId)) state.localPty.write(sessionId, Buffer.from(data));
    else state.pty.write(sessionId, Buffer.from(data));
  });

  ipcMain.handle('terminal_resize', (_event, sessionId: number, cols: number, rows: number) => {
    if (state.localPty.has(sessionId)) state.localPty.resize(sessionId, cols, rows);
    else state.pty.resize(sessionId, cols, rows);
  });

  ipcMain.handle('terminal_close', (_event, sessionId: number) => {
    if (state.localPty.has(sessionId)) state.localPty.close(sessionId);
    else state.pty.close(sessionId);
  });
}
