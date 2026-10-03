import type { SshSession } from '../ssh/session.js';
import { throttleProgress } from '../ssh/sftp.js';
import { checkUploadSource, localUploadPath } from './localExec.js';

/**
 * An upload node's transfer: the local file `from` (see `localUploadPath`) to `to` on
 * the host, over an SFTP channel on the automation's own connection to it — the same
 * login, 1Password prompt and host key check as the commands around it.
 */
export async function uploadOverSession(
  session: SshSession,
  hostName: string,
  from: string,
  to: string,
  signal?: AbortSignal,
  /** Bytes sent so far of the file's size, a couple of times a second at most. */
  onProgress?: (done: number, total: number) => void
): Promise<void> {
  const local = localUploadPath(from);
  await checkUploadSource(local);
  const sftp = await session.openSftp();
  // Canceled: ending the SFTP channel stops the transfer mid-file.
  const onAbort = (): void => sftp.end();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal?.aborted) throw new Error('canceled');
    const report = onProgress ? throttleProgress(onProgress, 500) : undefined;
    await new Promise<void>((resolve, reject) =>
      sftp.fastPut(
        local,
        to,
        { step: (done, _chunk, total) => report?.(done, total) },
        (err) => (err ? reject(new Error(`could not write ${to} on ${hostName}: ${err.message}`)) : resolve())
      )
    );
  } finally {
    signal?.removeEventListener('abort', onAbort);
    sftp.end();
  }
}
