/**
 * The Windows credential store, called directly through `advapi32.dll` (via koffi, an
 * FFI with prebuilt Node-API binaries) — no PowerShell, no helper process. Loaded on
 * first use only, and only on Windows: nothing here runs at app start.
 *
 * Only the raw calls live here; which credentials may be touched is decided by the
 * caller (`index.ts`), so that can be tested without Windows.
 */

/** What a credential read from the store says about itself. */
export interface StoredCredential {
  target: string;
  type: number;
  comment: string | null;
}

/** The handful of Win32 credential calls the RDP launch needs. All synchronous: each
 *  is a single quick system call, and `before-quit` needs them without awaiting. */
export interface CredentialApi {
  /** `null` when there is no such credential. */
  read(target: string): StoredCredential | null;
  /** `password` is UTF-16LE; the caller wipes it afterwards. */
  write(target: string, user: string, password: Buffer, comment: string): void;
  delete(target: string): boolean;
  enumerate(filter: string): StoredCredential[];
}

export const CRED_TYPE_GENERIC = 1;
/** Gone at sign-out even if it is never deleted. */
const CRED_PERSIST_SESSION = 1;
const ERROR_NOT_FOUND = 1168;

export function loadWindowsCredentialApi(): CredentialApi {
  const koffi = require('koffi') as typeof import('koffi');
  const advapi32 = koffi.load('advapi32.dll');
  const kernel32 = koffi.load('kernel32.dll');

  const FILETIME = koffi.struct('REMOTY_FILETIME', { dwLowDateTime: 'uint32_t', dwHighDateTime: 'uint32_t' });
  const CREDENTIALW = koffi.struct('REMOTY_CREDENTIALW', {
    Flags: 'uint32_t',
    Type: 'uint32_t',
    TargetName: 'str16',
    Comment: 'str16',
    LastWritten: FILETIME,
    CredentialBlobSize: 'uint32_t',
    CredentialBlob: 'void *',
    Persist: 'uint32_t',
    AttributeCount: 'uint32_t',
    Attributes: 'void *',
    TargetAlias: 'str16',
    UserName: 'str16'
  });

  const CredReadW = advapi32.func('__stdcall', 'CredReadW', 'bool', ['str16', 'uint32_t', 'uint32_t', koffi.out(koffi.pointer('void *'))]);
  const CredWriteW = advapi32.func('__stdcall', 'CredWriteW', 'bool', [koffi.pointer(CREDENTIALW), 'uint32_t']);
  const CredDeleteW = advapi32.func('__stdcall', 'CredDeleteW', 'bool', ['str16', 'uint32_t', 'uint32_t']);
  const CredEnumerateW = advapi32.func('__stdcall', 'CredEnumerateW', 'bool', [
    'str16',
    'uint32_t',
    koffi.out(koffi.pointer('uint32_t')),
    koffi.out(koffi.pointer('void *'))
  ]);
  const CredFree = advapi32.func('__stdcall', 'CredFree', 'void', ['void *']);
  const GetLastError = kernel32.func('__stdcall', 'GetLastError', 'uint32_t', []);

  const describe = (ptr: unknown): StoredCredential => {
    const c = koffi.decode(ptr, CREDENTIALW) as { TargetName: string; Type: number; Comment: string | null };
    return { target: c.TargetName, type: c.Type, comment: c.Comment ?? null };
  };

  return {
    read(target) {
      const out: unknown[] = [null];
      if (!CredReadW(target, CRED_TYPE_GENERIC, 0, out)) {
        const code = GetLastError() as number;
        if (code === ERROR_NOT_FOUND) return null;
        throw new Error(`CredReadW failed (error ${code})`);
      }
      try {
        return describe(out[0]);
      } finally {
        CredFree(out[0]);
      }
    },

    write(target, user, password, comment) {
      const ok = CredWriteW(
        {
          Flags: 0,
          Type: CRED_TYPE_GENERIC,
          TargetName: target,
          Comment: comment,
          LastWritten: { dwLowDateTime: 0, dwHighDateTime: 0 },
          CredentialBlobSize: password.length,
          CredentialBlob: password,
          Persist: CRED_PERSIST_SESSION,
          AttributeCount: 0,
          Attributes: null,
          TargetAlias: null,
          UserName: user
        },
        0
      );
      if (!ok) throw new Error(`CredWriteW failed (error ${GetLastError()})`);
    },

    delete(target) {
      return Boolean(CredDeleteW(target, CRED_TYPE_GENERIC, 0));
    },

    enumerate(filter) {
      const count: number[] = [0];
      const list: unknown[] = [null];
      if (!CredEnumerateW(filter, 0, count, list)) return [];
      try {
        const pointers = koffi.decode(list[0], 'void *', count[0]) as unknown[];
        return pointers.map(describe);
      } finally {
        CredFree(list[0]);
      }
    }
  };
}
