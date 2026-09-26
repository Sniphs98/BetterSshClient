import type { IpcMain } from 'electron';

import { listLocalDir, previewLocalFile, readLocalFile, writeLocalFile, SftpManager } from '../core/ssh/sftp.js';
import { resolveReference } from '../core/secrets/onePassword.js';
import { toCommandError } from '../dto.js';
import type { GuiState } from '../state/guiState.js';

/**
 * SFTP session commands. Ported from crates/omnyssh-gui/src/commands/sftp.rs.
 * Unlike the Rust source's channel-forwarder indirection (needed there to
 * bridge a background task back across an `mpsc` channel), each handler
 * here already has its `sessionId` in scope and emits the outbound event
 * directly once its operation settles.
 */
export function registerSftpIpc(ipcMain: IpcMain, state: GuiState): void {
  // The mutating commands take the renderer's `opId` and echo it on their
  // `sftp-op-done`/`transfer-progress`: the renderer runs a batch's ops side by
  // side, so their events finish in any order and the id is what ties each one
  // back to its op.
  ipcMain.handle('sftp_open', async (_event, hostName: string) => {
    const host = state.hostByName(hostName);
    if (host === undefined) throw toCommandError(new Error(`unknown host '${hostName}'`));
    try {
      const manager = await SftpManager.connect(host);
      const id = state.allocateSessionId();
      state.registerSftp(id, manager);
      state.emit('sftp-connected', { sessionId: id, hostName });
      return id;
    } catch (err) {
      throw toCommandError(err);
    }
  });

  // Where the browser opens: the host's default path, read from 1Password when it is
  // a reference; null when it has none.
  ipcMain.handle('sftp_default_path', async (_event, hostName: string): Promise<string | null> => {
    const host = state.hostByName(hostName);
    if (host === undefined) throw toCommandError(new Error(`unknown host '${hostName}'`));
    try {
      return host.defaultPath ? await resolveReference(host.defaultPath) : null;
    } catch (err) {
      throw toCommandError(err);
    }
  });

  ipcMain.handle('sftp_list',(_event, sessionId: number, path: string) => {
    const manager = state.getSftp(sessionId);
    if (manager === undefined) return;
    manager
      .listDir(path)
      .then((entries) => state.emit('sftp-dir-listed', { sessionId, path, entries }))
      .catch((err: Error) => state.emit('sftp-disconnected', { sessionId, reason: `ListDir failed: ${err.message}` }));
  });

  ipcMain.handle('sftp_upload', (_event, sessionId: number, local: string, remote: string, opId?: number) => {
    const manager = state.getSftp(sessionId);
    if (manager === undefined) return;
    const transferId = state.allocateTransferId();
    manager
      .upload(local, remote, (done, total) => state.emit('transfer-progress', { sessionId, transferId, opId, done, total }))
      .then(() => state.emit('sftp-op-done', { sessionId, opId, ok: true }))
      .catch((err: Error) => state.emit('sftp-op-done', { sessionId, opId, ok: false, error: err.message }));
  });

  ipcMain.handle('sftp_download', (_event, sessionId: number, local: string, remote: string, opId?: number) => {
    const manager = state.getSftp(sessionId);
    if (manager === undefined) return;
    const transferId = state.allocateTransferId();
    manager
      .download(remote, local, (done, total) => state.emit('transfer-progress', { sessionId, transferId, opId, done, total }))
      .then(() => state.emit('sftp-op-done', { sessionId, opId, ok: true }))
      .catch((err: Error) => state.emit('sftp-op-done', { sessionId, opId, ok: false, error: err.message }));
  });

  ipcMain.handle('sftp_mkdir', (_event, sessionId: number, path: string, opId?: number) => {
    const manager = state.getSftp(sessionId);
    if (manager === undefined) return;
    manager
      .mkdir(path)
      .then(() => state.emit('sftp-op-done', { sessionId, opId, ok: true }))
      .catch((err: Error) => state.emit('sftp-op-done', { sessionId, opId, ok: false, error: err.message }));
  });

  ipcMain.handle('sftp_rename', (_event, sessionId: number, from: string, to: string, opId?: number) => {
    const manager = state.getSftp(sessionId);
    if (manager === undefined) return;
    manager
      .rename(from, to)
      .then(() => state.emit('sftp-op-done', { sessionId, opId, ok: true }))
      .catch((err: Error) => state.emit('sftp-op-done', { sessionId, opId, ok: false, error: err.message }));
  });

  ipcMain.handle('sftp_delete', (_event, sessionId: number, path: string, opId?: number) => {
    const manager = state.getSftp(sessionId);
    if (manager === undefined) return;
    manager
      .delete(path)
      .then(() => state.emit('sftp-op-done', { sessionId, opId, ok: true }))
      .catch((err: Error) => state.emit('sftp-op-done', { sessionId, opId, ok: false, error: err.message }));
  });

  ipcMain.handle('sftp_read_file', async (_event, sessionId: number, path: string) => {
    const manager = state.getSftp(sessionId);
    if (manager === undefined) throw toCommandError(new Error('SFTP session is no longer open'));
    try {
      return await manager.readFile(path);
    } catch (err) {
      throw toCommandError(err);
    }
  });

  // Unlike the other mutating sftp_* commands, this resolves/rejects its call directly
  // rather than firing a fire-and-forget `sftp-op-done` — the editor already knows what
  // it wrote and needs to know synchronously whether the save succeeded, and it re-lists
  // the pane itself afterward rather than riding the pending-op refresh queue.
  ipcMain.handle('sftp_write_file', async (_event, sessionId: number, path: string, content: string) => {
    const manager = state.getSftp(sessionId);
    if (manager === undefined) throw toCommandError(new Error('SFTP session is no longer open'));
    try {
      await manager.writeFile(path, content);
    } catch (err) {
      throw toCommandError(err);
    }
  });

  ipcMain.handle('sftp_preview', (_event, sessionId: number, path: string) => {
    const manager = state.getSftp(sessionId);
    if (manager === undefined) return;
    manager
      .readPreview(path)
      .then((content) => state.emit('file-preview', { sessionId, path, content }))
      .catch(() => {
        // Mirrors the Rust source: a preview failure is silently dropped
        // (`if let Ok(content) = ...`), not surfaced as an error event.
      });
  });

  ipcMain.handle('sftp_close', (_event, sessionId: number) => {
    state.closeSftp(sessionId);
  });

  ipcMain.handle('list_local_dir', async (_event, path: string) => {
    try {
      return await listLocalDir(path);
    } catch (err) {
      throw toCommandError(err);
    }
  });

  ipcMain.handle('preview_local_file', async (_event, path: string) => {
    try {
      return await previewLocalFile(path);
    } catch (err) {
      throw toCommandError(err);
    }
  });

  ipcMain.handle('read_local_file', async (_event, path: string) => {
    try {
      return await readLocalFile(path);
    } catch (err) {
      throw toCommandError(err);
    }
  });

  ipcMain.handle('write_local_file', async (_event, path: string, content: string) => {
    try {
      await writeLocalFile(path, content);
    } catch (err) {
      throw toCommandError(err);
    }
  });
}
