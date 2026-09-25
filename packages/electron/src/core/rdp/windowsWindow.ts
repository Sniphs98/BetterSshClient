import { spawn } from 'node:child_process';

/**
 * mstsc opens its session window at whatever size it last had — for `display: 'fit'`
 * that would be a small window with scrollbars around a desktop sized for the whole
 * screen. This waits (in a hidden PowerShell) for the session window of mstsc process
 * `pid` to appear — i.e. until after Windows' prompts and the sign-in — and maximises
 * it. Gives up after five minutes, or when mstsc exits.
 */
export function maximizeWhenConnected(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.reject(new Error(`bad pid ${pid}`));
  const script = String.raw`
Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class BsshWin {
  public delegate bool Cb(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Cb cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  public static IntPtr Session(uint target) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid != target || !IsWindowVisible(h)) return true;
      var c = new StringBuilder(64); GetClassName(h, c, 64);
      if (c.ToString() == "TscShellContainerClass") { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@
for ($i = 0; $i -lt 300; $i++) {
  if (-not (Get-Process -Id ${pid} -ErrorAction SilentlyContinue)) { exit 0 }
  $h = [BsshWin]::Session(${pid})
  if ($h -ne [IntPtr]::Zero) { Start-Sleep -Milliseconds 500; [void][BsshWin]::ShowWindow($h, 3); exit 0 }
  Start-Sleep -Seconds 1
}
`;
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true, stdio: 'ignore' }
    );
    child.unref();
    child.once('error', reject);
    child.once('exit', () => resolve());
  });
}
