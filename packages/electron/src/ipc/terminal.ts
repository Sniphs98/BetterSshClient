import type { IpcMain } from 'electron';

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

  ipcMain.handle('terminal_write', (_event, sessionId: number, data: Uint8Array) => {
    state.pty.write(sessionId, Buffer.from(data));
  });

  ipcMain.handle('terminal_resize', (_event, sessionId: number, cols: number, rows: number) => {
    state.pty.resize(sessionId, cols, rows);
  });

  ipcMain.handle('terminal_close', (_event, sessionId: number) => {
    state.pty.close(sessionId);
  });
}
