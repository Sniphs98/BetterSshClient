import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CREDENTIAL_COMMENT,
  createCredentialStore,
  credentialTarget,
  removeCredential,
  removeCredentialsOnQuit,
  setCredentialStore,
  stageCredential,
  type RdpCredentialStore
} from './index.js';
import {
  CRED_TYPE_GENERIC,
  credentialTypes,
  loadWindowsCredentialApi,
  type CredentialApi,
  type StoredCredential
} from './windowsCredentialStore.js';

/** An in-memory stand-in for the Win32 credential store. */
function fakeApi(initial: StoredCredential[] = []) {
  const creds = new Map<string, StoredCredential & { user?: string; password?: string }>();
  for (const c of initial) creds.set(c.target, c);
  const written: Buffer[] = [];
  const api: CredentialApi = {
    read: vi.fn((target: string) => creds.get(target) ?? null),
    write: vi.fn((target: string, user: string, password: Buffer, comment: string) => {
      written.push(password);
      creds.set(target, { target, type: CRED_TYPE_GENERIC, comment, user, password: password.toString('utf16le') });
    }),
    delete: vi.fn((target: string) => creds.delete(target)),
    enumerate: vi.fn((filter: string) => [...creds.values()].filter((c) => c.target.startsWith(filter.replace(/\*$/, ''))))
  };
  return { api, creds, written };
}

const foreign: StoredCredential = { target: 'TERMSRV/10.0.0.5', type: CRED_TYPE_GENERIC, comment: 'saved by the user' };
const ours = (host: string): StoredCredential => ({ target: credentialTarget(host), type: CRED_TYPE_GENERIC, comment: CREDENTIAL_COMMENT });

describe('createCredentialStore', () => {
  it('writes a TERMSRV credential with our marker, and wipes the password buffer', async () => {
    const { api, creds, written } = fakeApi();
    const store = createCredentialStore(api);

    expect(await store.write('TERMSRV/10.0.0.5', 'CORP\\admin', 'p@ss')).toBe('staged');

    expect(creds.get('TERMSRV/10.0.0.5')).toMatchObject({ comment: CREDENTIAL_COMMENT, user: 'CORP\\admin', password: 'p@ss' });
    expect(written[0].every((b) => b === 0)).toBe(true);
  });

  it('never overwrites a credential the user saved themselves', async () => {
    const { api, creds } = fakeApi([foreign]);
    expect(await createCredentialStore(api).write('TERMSRV/10.0.0.5', 'admin', 'x')).toBe('kept-existing');
    expect(api.write).not.toHaveBeenCalled();
    expect(creds.get('TERMSRV/10.0.0.5')).toEqual(foreign);
  });

  it('replaces one of its own', async () => {
    const { api } = fakeApi([ours('10.0.0.5')]);
    expect(await createCredentialStore(api).write('TERMSRV/10.0.0.5', 'admin', 'x')).toBe('staged');
  });

  it('removes exactly its own credential', async () => {
    const { api, creds } = fakeApi([ours('10.0.0.5'), ours('10.0.0.6')]);
    await createCredentialStore(api).remove('TERMSRV/10.0.0.5');
    expect([...creds.keys()]).toEqual(['TERMSRV/10.0.0.6']);
  });

  it('never removes a foreign credential', async () => {
    const { api, creds } = fakeApi([foreign]);
    const store = createCredentialStore(api);
    await store.remove('TERMSRV/10.0.0.5');
    store.removeSync('TERMSRV/10.0.0.5');
    expect(api.delete).not.toHaveBeenCalled();
    expect(creds.has('TERMSRV/10.0.0.5')).toBe(true);
  });

  it('refuses a password over the 2560-byte blob limit before touching the store', async () => {
    const { api } = fakeApi();
    const store = createCredentialStore(api);
    const error = await store.write('TERMSRV/h', 'u', 'ä'.repeat(1281)).catch((e: Error) => e);
    expect((error as Error).message).toMatch(/too long/);
    expect((error as Error).message).not.toContain('ää');
    expect(api.read).not.toHaveBeenCalled();
    expect(await store.write('TERMSRV/h', 'u', 'ä'.repeat(1280))).toBe('staged');
  });

  it('writes nothing when the existing credential cannot be read', async () => {
    const { api } = fakeApi();
    vi.mocked(api.read).mockImplementation(() => {
      throw new Error('CredReadW failed (error 5)');
    });
    await expect(createCredentialStore(api).write('TERMSRV/h', 'u', 'p')).rejects.toThrow('error 5');
    expect(api.write).not.toHaveBeenCalled();
  });

  it('refuses targets outside TERMSRV/, and wildcards', async () => {
    const store = createCredentialStore(fakeApi().api);
    await expect(store.write('git:https://github.com', 'u', 'p')).rejects.toThrow();
    await expect(store.remove('TERMSRV/*')).rejects.toThrow();
  });

  it('cleans up only credentials carrying its marker', async () => {
    const other = { target: 'git:https://github.com', type: CRED_TYPE_GENERIC, comment: CREDENTIAL_COMMENT };
    const domain = { target: 'TERMSRV/dc', type: 2, comment: CREDENTIAL_COMMENT };
    const { api, creds } = fakeApi([foreign, ours('a'), ours('b'), other, domain]);

    expect(await createCredentialStore(api).cleanupOwned()).toBe(2);

    expect([...creds.keys()].sort()).toEqual(['TERMSRV/10.0.0.5', 'TERMSRV/dc', 'git:https://github.com']);
  });
});

describe('staging for a launch', () => {
  const originalPlatform = process.platform;
  const originalAppData = process.env.APPDATA;
  let configRoot: string;
  let api: ReturnType<typeof fakeApi>['api'];
  let creds: ReturnType<typeof fakeApi>['creds'];
  const marker = (): string => join(configRoot, 'remoty', 'rdp-staged-credentials');

  beforeEach(async () => {
    configRoot = await mkdtemp(join(tmpdir(), 'remoty-cred-'));
    process.env.APPDATA = configRoot;
    process.env.XDG_CONFIG_HOME = configRoot;
    // So the marker file lands under APPDATA, i.e. configRoot, on every OS.
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    ({ api, creds } = fakeApi([foreign]));
    setCredentialStore(createCredentialStore(api));
  });

  afterEach(async () => {
    setCredentialStore(null);
    Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    process.env.APPDATA = originalAppData;
    delete process.env.XDG_CONFIG_HOME;
    await rm(configRoot, { recursive: true, force: true });
  });

  it('stages, then removes the same credential and its marker file', async () => {
    expect(await stageCredential('host1', 'admin', 'secret')).toBe('staged');
    expect(creds.get('TERMSRV/host1')?.comment).toBe(CREDENTIAL_COMMENT);
    expect(existsSync(marker())).toBe(true);

    await removeCredential('host1');
    expect(creds.has('TERMSRV/host1')).toBe(false);
    expect(creds.has('TERMSRV/10.0.0.5')).toBe(true);
    expect(existsSync(marker())).toBe(false);
  });

  it('cleans up leftovers before the first launch only if an earlier run left them', async () => {
    await stageCredential('host1', 'admin', 'secret');
    expect(api.enumerate).not.toHaveBeenCalled();

    // A new process (no in-memory state) after a crash: the marker is still there.
    creds.set('TERMSRV/old', ours('old'));
    setCredentialStore(createCredentialStore(api));
    await stageCredential('host2', 'admin', 'secret');

    expect(api.enumerate).toHaveBeenCalledTimes(1);
    expect(creds.has('TERMSRV/old')).toBe(false);
    expect(creds.has('TERMSRV/10.0.0.5')).toBe(true);
    expect(creds.has('TERMSRV/host2')).toBe(true);
  });

  it('on quit removes only its own pending credentials', () => {
    creds.set('TERMSRV/host1', ours('host1'));
    removeCredentialsOnQuit(['host1', '10.0.0.5']);
    expect(creds.has('TERMSRV/host1')).toBe(false);
    expect(creds.has('TERMSRV/10.0.0.5')).toBe(true);
  });

  it('a failing store neither throws on quit nor carries the password in its error', async () => {
    const failing: RdpCredentialStore = {
      write: () => Promise.reject(new Error('CredWriteW failed (error 5)')),
      remove: () => Promise.reject(new Error('CredReadW failed (error 5)')),
      removeSync: () => {
        throw new Error('CredReadW failed (error 5)');
      },
      cleanupOwned: () => Promise.reject(new Error('nope'))
    };
    setCredentialStore(failing);
    const error = await stageCredential('host1', 'admin', 'top-secret').catch((e: Error) => e);
    expect(String((error as Error).message)).not.toContain('top-secret');
    expect(() => removeCredentialsOnQuit(['host1'])).not.toThrow();
  });
});

// wincred.h's CREDENTIALW as MSVC lays it out on 64-bit Windows.
describe.skipIf(process.arch !== 'x64' && process.arch !== 'arm64')('CREDENTIALW layout', () => {
  it('matches the Win64 sizes and offsets', () => {
    const { koffi, CREDENTIALW } = credentialTypes();
    expect(koffi.sizeof(CREDENTIALW)).toBe(80);
    const offsets = Object.fromEntries(
      ['Flags', 'Type', 'TargetName', 'Comment', 'LastWritten', 'CredentialBlobSize', 'CredentialBlob', 'Persist', 'AttributeCount', 'Attributes', 'TargetAlias', 'UserName'].map(
        (m) => [m, koffi.offsetof(CREDENTIALW, m)]
      )
    );
    expect(offsets).toEqual({
      Flags: 0,
      Type: 4,
      TargetName: 8,
      Comment: 16,
      LastWritten: 24,
      CredentialBlobSize: 32,
      CredentialBlob: 40,
      Persist: 48,
      AttributeCount: 52,
      Attributes: 56,
      TargetAlias: 64,
      UserName: 72
    });
  });
});

// Against the real credential store: runs in the windows-latest CI job. Uses a target
// of its own and removes it again.
describe.skipIf(process.platform !== 'win32')('the real Windows credential store', () => {
  const target = `TERMSRV/remoty-selftest-${process.pid}-${Date.now()}`;

  afterEach(() => {
    const api = loadWindowsCredentialApi();
    api.delete(target);
  });

  it('writes, reads, enumerates and deletes its own credential', async () => {
    const api = loadWindowsCredentialApi();
    const store = createCredentialStore(api);
    expect(api.read(target)).toBeNull();

    expect(await store.write(target, 'CORP\\admin', 'pässwörd €')).toBe('staged');
    expect(api.read(target)).toEqual({ target, type: CRED_TYPE_GENERIC, comment: CREDENTIAL_COMMENT });
    expect(api.enumerate('TERMSRV/remoty-selftest-*').map((c) => c.target)).toContain(target);

    await store.remove(target);
    expect(api.read(target)).toBeNull();
  });

  it('leaves a foreign credential with the same target alone', async () => {
    const api = loadWindowsCredentialApi();
    const store = createCredentialStore(api);
    const secret = Buffer.from('users-own', 'utf16le');
    api.write(target, 'someone', secret, 'vom Benutzer gespeichert – ä€');

    expect(await store.write(target, 'admin', 'x')).toBe('kept-existing');
    await store.remove(target);
    await store.cleanupOwned();

    expect(api.read(target)).toEqual({ target, type: CRED_TYPE_GENERIC, comment: 'vom Benutzer gespeichert – ä€' });
  });

  it('enumerating with no match is no error', () => {
    expect(loadWindowsCredentialApi().enumerate('TERMSRV/remoty-nothing-here-*')).toEqual([]);
  });
});
