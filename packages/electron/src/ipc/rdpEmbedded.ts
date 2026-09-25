import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import type { IpcMain } from 'electron';

import { loadRemoteDesktopConnections } from '../core/config/remoteDesktop.js';
import { RdpGateway } from '../core/rdp/gateway.js';
import { checkCertificate, forgetCertificate } from '../core/rdp/knownCerts.js';
import { SshSession } from '../core/ssh/session.js';
import { toCommandError, type RdpEmbeddedSessionDto, type RdpEmbeddedStatusDto } from '../dto.js';
import type { GuiState } from '../state/guiState.js';

/**
 * Remote desktop inside the app: the renderer runs IronRDP's web client, which
 * connects through `RdpGateway` on 127.0.0.1. `rdp_embedded_open` registers the
 * session and hands the client what it needs — including the password, which the
 * client needs for CredSSP (NLA) itself. The external client (`rdp_launch`) stays
 * the fallback.
 */

const gateway = new RdpGateway();

interface OpenSession {
  ssh?: SshSession;
  /** What happened during the handshake that the user should hear about. */
  notice?: string;
}
const open = new Map<string, OpenSession>();

function openTcp(host: string, port: number): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    socket.setNoDelay(true);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

export function registerRdpEmbeddedIpc(ipcMain: IpcMain, state: GuiState): void {
  ipcMain.handle('rdp_embedded_open', async (_event, connectionId: string): Promise<RdpEmbeddedSessionDto> => {
    try {
      const connection = (await loadRemoteDesktopConnections()).find((c) => c.id === connectionId);
      if (!connection) throw new Error(`unknown remote desktop connection '${connectionId}'`);
      if (connection.protocol !== 'rdp') throw new Error(`connection '${connection.name}' is not an RDP connection`);
      if (!connection.username || !connection.password) {
        throw new Error('The built-in viewer needs a saved username and password — add them, or open it in the Remote Desktop app.');
      }

      const session: OpenSession = {};
      let ssh: SshSession | undefined;
      if (connection.viaHost) {
        const host = state.hostByName(connection.viaHost);
        if (!host) throw new Error(`SSH host '${connection.viaHost}' to tunnel through no longer exists`);
        try {
          ssh = await SshSession.connect(host);
        } catch (err) {
          throw new Error(`Could not connect to SSH host '${host.name}' for the tunnel: ${(err as Error).message}`);
        }
        session.ssh = ssh;
      }

      // Certificates are remembered per target as the SSH host (if any) sees it.
      const certKey = `${connection.viaHost ? `${connection.viaHost}>` : ''}${connection.hostname}:${connection.port}`;
      const token = gateway.register({
        host: connection.hostname,
        port: connection.port,
        open: () => (ssh ? ssh.forward(connection.hostname, connection.port) : openTcp(connection.hostname, connection.port)),
        async verifyCertificate(chain) {
          if (chain.length === 0) throw new Error('the RDP server presented no certificate');
          const check = await checkCertificate(certKey, chain[0]);
          if (check.status === 'changed') {
            throw new Error(
              `The server's certificate has changed since the last connection (it was ${check.expected.slice(0, 23)}…, ` +
                `now ${check.fingerprint.slice(0, 23)}…). That can mean someone is in between. If you expect the change ` +
                `(the server was reinstalled, say), choose "Trust new certificate" and connect again.`
            );
          }
          if (check.status === 'new') {
            session.notice = `First connection: remembered the server's certificate (SHA-256 ${check.fingerprint.slice(0, 23)}…).`;
          }
        }
      });
      open.set(token, session);

      return {
        token,
        proxyUrl: await gateway.url(),
        // What the client puts in its request; the gateway ignores it for the registered target.
        destination: `${connection.hostname}:${connection.port}`,
        username: connection.username,
        password: connection.password,
        domain: connection.domain
      };
    } catch (err) {
      throw toCommandError(err);
    }
  });

  ipcMain.handle('rdp_embedded_status', (_event, token: string): RdpEmbeddedStatusDto => ({
    failure: gateway.failure(token),
    notice: open.get(token)?.notice
  }));

  ipcMain.handle('rdp_embedded_close', (_event, token: string) => {
    closeSession(token);
  });

  ipcMain.handle('rdp_forget_certificate', async (_event, connectionId: string) => {
    try {
      const connection = (await loadRemoteDesktopConnections()).find((c) => c.id === connectionId);
      if (!connection) throw new Error(`unknown remote desktop connection '${connectionId}'`);
      await forgetCertificate(`${connection.viaHost ? `${connection.viaHost}>` : ''}${connection.hostname}:${connection.port}`);
    } catch (err) {
      throw toCommandError(err);
    }
  });
}

function closeSession(token: string): void {
  gateway.revoke(token);
  open.get(token)?.ssh?.disconnect();
  open.delete(token);
}

/** For `before-quit`. */
export function closeEmbeddedRdp(): void {
  for (const token of [...open.keys()]) closeSession(token);
  gateway.close();
}
