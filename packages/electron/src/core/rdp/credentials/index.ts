import { existsSync, rmSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { appConfigDir } from '../../config/platform.js';
import { CRED_MAX_BLOB_BYTES, CRED_TYPE_DOMAIN_PASSWORD, CRED_TYPE_GENERIC, loadWindowsCredentialApi, type CredentialApi } from './windowsCredentialStore.js';

/**
 * The Windows credential store side of an RDP launch. `mstsc` has no way to take a
 * password on its command line or in a `.rdp` file it honours, but it reads a
 * `TERMSRV/<host>` credential from the user's store — so one is put there just
 * before `mstsc` starts and taken out again as soon as it has been read.
 *
 * The store is called directly (`windowsCredentialStore.ts`); the password never
 * appears on a command line or in a file. The credential is only kept for this logon
 * session, and it carries a marker comment, so that:
 *  - a credential the user saved themselves is never overwritten or deleted, and
 *  - if the app dies before cleaning up, the next RDP launch first removes whatever
 *    of ours is left — and at worst a sign-out does.
 * Nothing here runs at app start: the store is first touched by an RDP launch.
 */

/** Marks a credential as staged by this app; nothing else is ever touched. */
export const CREDENTIAL_COMMENT = 'Staged by Remoty for one Remote Desktop launch';

const TARGET_PREFIX = 'TERMSRV/';

export function credentialTarget(hostname: string): string {
  return `${TARGET_PREFIX}${hostname}`;
}

export type StageOutcome =
  /** Ours is in the store now; delete it with `removeCredential` once read. */
  | 'staged'
  /** As `'staged'`, but Windows also has RDP credentials of its own saved for this
   *  target (another type, so untouched) — mstsc may pick those instead. */
  | 'staged-beside-saved'
  /** Someone else's generic credential has this target; writing ours would replace
   *  it, so nothing is written, and `mstsc` uses that one. */
  | 'kept-existing';

/** Whether `outcome` means a credential of ours is in the store. */
export function holdsOurs(outcome: StageOutcome | undefined): boolean {
  return outcome === 'staged' || outcome === 'staged-beside-saved';
}

/** Whether a credential is one this app staged — the only kind it may replace or delete. */
function isOurs(c: { target: string; type: number; comment: string | null }): boolean {
  return c.type === CRED_TYPE_GENERIC && c.target.startsWith(TARGET_PREFIX) && c.comment === CREDENTIAL_COMMENT;
}

function assertTarget(target: string): void {
  if (!target.startsWith(TARGET_PREFIX) || target.length === TARGET_PREFIX.length || target.includes('*')) {
    throw new Error('Not a Remote Desktop credential target');
  }
}

export interface RdpCredentialStore {
  write(target: string, username: string, password: string): Promise<StageOutcome>;
  /** Deletes `target` — only if it is ours. */
  remove(target: string): Promise<void>;
  /** As `remove`, for `before-quit`, where async work may not finish. */
  removeSync(target: string): void;
  /** Deletes every `TERMSRV/*` credential that is ours; returns how many. */
  cleanupOwned(): Promise<number>;
}

export function createCredentialStore(api: CredentialApi): RdpCredentialStore {
  const removeSync = (target: string): void => {
    assertTarget(target);
    const existing = api.read(target);
    if (existing && isOurs(existing)) api.delete(target);
  };
  return {
    async write(target, username, password) {
      assertTarget(target);
      if (Buffer.byteLength(password, 'utf16le') > CRED_MAX_BLOB_BYTES) {
        throw new Error('The password is too long for the Windows credential store');
      }
      // CredWriteW replaces a credential with the same target and type: one that
      // isn't ours is left as it is (and mstsc uses it). A failed read throws, so
      // nothing is written blind. Only generic credentials are ever written.
      const existing = api.read(target);
      if (existing && !isOurs(existing)) return 'kept-existing';
      const savedByWindows = api.read(target, CRED_TYPE_DOMAIN_PASSWORD) !== null;
      const blob = Buffer.from(password, 'utf16le');
      try {
        api.write(target, username, blob, CREDENTIAL_COMMENT);
      } finally {
        blob.fill(0);
      }
      return savedByWindows ? 'staged-beside-saved' : 'staged';
    },
    async remove(target) {
      removeSync(target);
    },
    removeSync,
    async cleanupOwned() {
      let removed = 0;
      for (const c of api.enumerate(`${TARGET_PREFIX}*`)) {
        if (isOurs(c) && api.delete(c.target)) removed++;
      }
      return removed;
    }
  };
}

let store: RdpCredentialStore | undefined;

function currentStore(): RdpCredentialStore {
  store ??= createCredentialStore(loadWindowsCredentialApi());
  return store;
}

/** Swaps the store out, for tests. */
export function setCredentialStore(next: RdpCredentialStore | null): void {
  store = next ?? undefined;
  leftovers = undefined;
}

/** Exists while a staged credential of ours might still be in the store, so a later
 *  run knows to clean up — and every other run never has to look. */
function markerPath(): string {
  return join(appConfigDir(), 'rdp-staged-credentials');
}

/** Hostnames this process staged and hasn't removed yet. */
const staged = new Set<string>();

let leftovers: Promise<void> | undefined;

/** Once per process, before the first launch stages anything: removes what an earlier
 *  run staged and didn't get to remove (a crash, a quit while mstsc was starting). */
function cleanUpLeftovers(): Promise<void> {
  leftovers ??= (async () => {
    if (!existsSync(markerPath())) return;
    try {
      await currentStore().cleanupOwned();
      await rm(markerPath(), { force: true });
    } catch {
      // Left for the next launch to try again; a sign-out clears them anyway.
    }
  })();
  return leftovers;
}

/** Puts `password` into the store as `TERMSRV/<hostname>` for `user`. */
export async function stageCredential(hostname: string, user: string, password: string): Promise<StageOutcome> {
  await cleanUpLeftovers();
  await mkdir(appConfigDir(), { recursive: true });
  await writeFile(markerPath(), '', 'utf-8');
  const outcome = await currentStore().write(credentialTarget(hostname), user, password);
  if (holdsOurs(outcome)) staged.add(hostname);
  else if (staged.size === 0) await rm(markerPath(), { force: true });
  return outcome;
}

/** Deletes the staged credential for `hostname` — only if it is still ours. */
export async function removeCredential(hostname: string): Promise<void> {
  await currentStore().remove(credentialTarget(hostname));
  staged.delete(hostname);
  if (staged.size === 0) await rm(markerPath(), { force: true });
}

/** Synchronous last-chance cleanup for `before-quit`: deletes each of `hostnames`'
 *  credentials, still checking that each is ours. */
export function removeCredentialsOnQuit(hostnames: Iterable<string>): void {
  let failed = false;
  for (const hostname of hostnames) {
    try {
      currentStore().removeSync(credentialTarget(hostname));
      staged.delete(hostname);
    } catch {
      failed = true;
    }
  }
  if (!failed && staged.size === 0) rmSync(markerPath(), { force: true });
}
