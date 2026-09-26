import type { SshSession } from '../ssh/session.js';
import { checkUploadSource, localUploadPath } from './localExec.js';

/**
 * An upload node's transfer: the local file `from` (see `localUploadPath`) to `to` on
 * the host, over an SFTP channel on the automation's own connection to it — the same
 * login, 1Password prompt and host key check as the commands around it.
 */
export async function uploadOverSession(session: SshSession, hostName: string, from: string, to: string): Promise<void> {
  const local = localUploadPath(from);
  await checkUploadSource(local);
  const sftp = await session.openSftp();
  try {
    await new Promise<void>((resolve, reject) =>
      sftp.fastPut(local, to, (err) => (err ? reject(new Error(`could not write ${to} on ${hostName}: ${err.message}`)) : resolve()))
    );
  } finally {
    sftp.end();
  }
}
