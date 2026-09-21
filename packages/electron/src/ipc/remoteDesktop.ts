import type { IpcMain } from 'electron';

import { loadRemoteDesktopConnections, saveRemoteDesktopConnections } from '../core/config/remoteDesktop.js';
import type { RemoteDesktopConnection } from '../core/config/remoteDesktop.js';
import { remoteDesktopConnectionFromInputDto, remoteDesktopConnectionToDto, toCommandError } from '../dto.js';
import type { RemoteDesktopConnectionDto, RemoteDesktopConnectionInputDto } from '../dto.js';

/**
 * Remote-desktop connection-profile CRUD. Mirrors `ipc/snippets.ts`'s shape, but
 * upserts by `id` (like Automations) rather than by name, since a connection's name is
 * just a label, not its on-disk key.
 */

/** Upserts `input` into the connection list by id. A blank `password` on an edit means
 *  "keep the stored one" (mirrors `upsertHost`'s `password = host.password ?? existing.password`)
 *  — the DTO never hands the form a real password to re-submit unchanged. */
export function upsertRemoteDesktopConnection(
  connections: RemoteDesktopConnection[],
  input: RemoteDesktopConnectionInputDto
): void {
  const connection = remoteDesktopConnectionFromInputDto(input);
  const i = connections.findIndex((c) => c.id === connection.id);
  if (i !== -1) {
    connection.password = connection.password ?? connections[i].password;
    connections[i] = connection;
  } else {
    connections.push(connection);
  }
}

export function removeRemoteDesktopConnection(connections: RemoteDesktopConnection[], id: string): void {
  const i = connections.findIndex((c) => c.id === id);
  if (i !== -1) connections.splice(i, 1);
}

export function registerRemoteDesktopIpc(ipcMain: IpcMain): void {
  ipcMain.handle('list_remote_desktop_connections', async (): Promise<RemoteDesktopConnectionDto[]> => {
    try {
      const connections = await loadRemoteDesktopConnections();
      return connections.map(remoteDesktopConnectionToDto);
    } catch (err) {
      throw toCommandError(err);
    }
  });

  ipcMain.handle('save_remote_desktop_connection', async (_event, input: RemoteDesktopConnectionInputDto) => {
    try {
      const connections = await loadRemoteDesktopConnections();
      upsertRemoteDesktopConnection(connections, input);
      await saveRemoteDesktopConnections(connections);
    } catch (err) {
      throw toCommandError(err);
    }
  });

  ipcMain.handle('delete_remote_desktop_connection', async (_event, id: string) => {
    try {
      const connections = await loadRemoteDesktopConnections();
      removeRemoteDesktopConnection(connections, id);
      await saveRemoteDesktopConnections(connections);
    } catch (err) {
      throw toCommandError(err);
    }
  });
}
