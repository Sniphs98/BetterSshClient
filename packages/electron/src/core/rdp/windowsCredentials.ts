import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { appConfigDir } from '../config/platform.js';

/**
 * The Windows credential store side of an RDP launch. `mstsc` has no way to take a
 * password on its command line or in a `.rdp` file it honours, but it reads a
 * `TERMSRV/<host>` credential from the user's store — so one is put there just
 * before `mstsc` starts and taken out again as soon as it has been read.
 *
 * Unlike `cmdkey /pass:…`, the password never appears on any command line: a small
 * PowerShell script calls `CredWriteW` directly and reads its input from stdin. The
 * credential is also only kept for this logon session (`CRED_PERSIST_SESSION`), and
 * it carries a marker comment, so that:
 *  - a credential the user saved themselves is never overwritten or deleted, and
 *  - if the app dies before cleaning up, the next start (`sweepStagedCredentials`)
 *    removes whatever is left — and at worst a sign-out does.
 */

/** Marks a credential as staged by this app; nothing else is ever touched. */
export const CREDENTIAL_COMMENT = 'Staged by BetterSshClient for one Remote Desktop launch';

/** Exists while a staged credential might still be in the store, so a start after a
 *  crash knows to sweep — without paying for a PowerShell run on every start. */
function markerPath(): string {
  return join(appConfigDir(), 'rdp-staged-credentials');
}

export function credentialTarget(hostname: string): string {
  return `TERMSRV/${hostname}`;
}

const INTEROP = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BsshCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredWriteW(ref CREDENTIAL credential, int flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredReadW(string target, int type, int flags, out IntPtr credential);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredDeleteW(string target, int type, int flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CredEnumerateW(string filter, int flags, out int count, out IntPtr credentials);
  [DllImport("advapi32.dll")]
  public static extern void CredFree(IntPtr buffer);

  const int GENERIC = 1;

  static string CommentOf(IntPtr p) {
    return ((CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL))).Comment;
  }

  // "absent", "ours" or "foreign" — only "ours" may be replaced or deleted.
  public static string Owner(string target, string marker) {
    IntPtr p;
    if (!CredReadW(target, GENERIC, 0, out p)) return "absent";
    try { return CommentOf(p) == marker ? "ours" : "foreign"; } finally { CredFree(p); }
  }

  public static void Write(string target, string user, string password, string marker) {
    byte[] blob = System.Text.Encoding.Unicode.GetBytes(password);
    IntPtr mem = Marshal.AllocHGlobal(blob.Length);
    try {
      Marshal.Copy(blob, 0, mem, blob.Length);
      CREDENTIAL c = new CREDENTIAL();
      c.Type = GENERIC; c.TargetName = target; c.Comment = marker; c.UserName = user;
      c.CredentialBlobSize = blob.Length; c.CredentialBlob = mem;
      c.Persist = 1; // CRED_PERSIST_SESSION: gone at sign-out even if never deleted
      if (!CredWriteW(ref c, 0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    } finally {
      for (int i = 0; i < blob.Length; i++) Marshal.WriteByte(mem, i, 0);
      Marshal.FreeHGlobal(mem);
    }
  }

  public static void DeleteIfOurs(string target, string marker) {
    if (Owner(target, marker) == "ours") CredDeleteW(target, GENERIC, 0);
  }

  public static int Sweep(string marker) {
    int count; IntPtr list; int removed = 0;
    if (!CredEnumerateW("TERMSRV/*", 0, out count, out list)) return 0;
    try {
      for (int i = 0; i < count; i++) {
        IntPtr p = Marshal.ReadIntPtr(list, i * IntPtr.Size);
        CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
        if (c.Type == GENERIC && c.Comment == marker && CredDeleteW(c.TargetName, GENERIC, 0)) removed++;
      }
    } finally { CredFree(list); }
    return removed;
  }
}
'@
`;

/** Runs one credential operation. Its input (which may hold the password) goes in on
 *  stdin as base64 JSON; only the fixed script is on the command line. */
export type CredentialRunner = (script: string, input: string) => Promise<string>;

const runPowerShell: CredentialRunner = (script, input) =>
  new Promise((resolve, reject) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim().split(/\r?\n/)[0] || `PowerShell exited with code ${code}`));
    });
    child.stdin.end(input + '\n');
  });

let runner: CredentialRunner = runPowerShell;

/** Swaps the PowerShell runner out, for tests. */
export function setCredentialRunner(next: CredentialRunner | null): void {
  runner = next ?? runPowerShell;
}

function script(body: string): string {
  return (
    "$ErrorActionPreference = 'Stop'\n" +
    INTEROP +
    '$in = [Console]::In.ReadLine() | ForEach-Object { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($_)) } | ConvertFrom-Json\n' +
    body
  );
}

function encodeInput(input: Record<string, string>): string {
  return Buffer.from(JSON.stringify({ ...input, marker: CREDENTIAL_COMMENT }), 'utf8').toString('base64');
}

export type StageOutcome =
  /** Ours is in the store now; delete it with `removeCredential` once read. */
  | 'staged'
  /** The user has their own credential for this target; left alone, and `mstsc` uses it. */
  | 'kept-existing';

/** Puts `password` into the store as `TERMSRV/<hostname>` for `user`. */
export async function stageCredential(hostname: string, user: string, password: string): Promise<StageOutcome> {
  const target = credentialTarget(hostname);
  await mkdir(appConfigDir(), { recursive: true });
  await writeFile(markerPath(), '', 'utf-8');
  const out = await runner(
    script(
      'if ([BsshCred]::Owner($in.target, $in.marker) -eq "foreign") { "kept-existing" }\n' +
        'else { [BsshCred]::Write($in.target, $in.user, $in.password, $in.marker); "staged" }\n'
    ),
    encodeInput({ target, user, password })
  );
  return out.endsWith('kept-existing') ? 'kept-existing' : 'staged';
}

/** Deletes the staged credential for `hostname` — only if it is still ours. */
export async function removeCredential(hostname: string): Promise<void> {
  await runner(
    script('[BsshCred]::DeleteIfOurs($in.target, $in.marker)\n'),
    encodeInput({ target: credentialTarget(hostname) })
  );
}

/** Deletes every credential this app staged and didn't get to remove — after a crash,
 *  or a quit while `mstsc` was still starting. A no-op (no PowerShell) unless a
 *  launch left the marker behind. Returns how many were removed. */
export async function sweepStagedCredentials(): Promise<number> {
  if (process.platform !== 'win32' || !existsSync(markerPath())) return 0;
  const out = await runner(script('[BsshCred]::Sweep($in.marker)\n'), encodeInput({}));
  await rm(markerPath(), { force: true });
  return Number.parseInt(out, 10) || 0;
}

/** Synchronous last-chance cleanup for `before-quit`, where async work may not finish:
 *  `cmdkey /delete` for each target still pending. It can't check the marker comment,
 *  so it is only called with targets this process itself staged and hasn't removed. */
export function removeCredentialsOnQuit(hostnames: Iterable<string>): void {
  for (const hostname of hostnames) {
    execFile('cmdkey', [`/delete:${credentialTarget(hostname)}`], { windowsHide: true }, () => {});
  }
}
