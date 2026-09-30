import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A small "Updating…" window for the half minute a Windows update takes. Restarting to
 * update closes the app, and the installer then runs silently until the new version
 * opens — 30 s or more with nothing on screen, long enough to think it's broken and
 * start the old one again. So just before quitting the app starts this window as a
 * process of its own (PowerShell with Windows Forms, on every Windows), which stays
 * through the install.
 *
 * It closes when the new version starts: the app leaves a flag file, the new one
 * removes it at startup (`clearUpdateSplash`), and the window watches for that. If
 * the new version never comes up it closes on its own after three minutes.
 */

/** The flag file: there while an update is being installed. */
export function updateFlagPath(dir: string = tmpdir()): string {
  return join(dir, 'remoty-updating');
}

const SCRIPT = String.raw`
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$flag = $env:REMOTY_UPDATE_FLAG
$dark = [System.Drawing.Color]::FromArgb(33, 33, 33)
$muted = [System.Drawing.Color]::FromArgb(174, 183, 194)

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Remoty'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true
$form.ClientSize = New-Object System.Drawing.Size(440, 116)
$form.BackColor = $dark
$form.ForeColor = [System.Drawing.Color]::White
$form.Font = New-Object System.Drawing.Font('Segoe UI', 9.5)
try { $form.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon($env:REMOTY_APP_EXE) } catch {}

$title = New-Object System.Windows.Forms.Label
$title.Text = $(if ($env:REMOTY_UPDATE_VERSION) { "Updating Remoty to v$($env:REMOTY_UPDATE_VERSION)" } else { 'Updating Remoty' }) + [char]0x2026
$title.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 11)
$title.AutoSize = $true
$title.Location = New-Object System.Drawing.Point(20, 16)
$form.Controls.Add($title)

$hint = New-Object System.Windows.Forms.Label
$hint.Text = 'It closes now and opens again by itself in about half a minute.'
$hint.ForeColor = $muted
$hint.AutoSize = $true
$hint.Location = New-Object System.Drawing.Point(20, 44)
$form.Controls.Add($hint)

$bar = New-Object System.Windows.Forms.ProgressBar
$bar.Style = 'Marquee'
$bar.MarqueeAnimationSpeed = 25
$bar.Location = New-Object System.Drawing.Point(20, 80)
$bar.Size = New-Object System.Drawing.Size(400, 10)
$form.Controls.Add($bar)

# A dark title bar, like the app's (Windows 10 20H1 and later; ignored before).
try {
  Add-Type -Namespace Remoty -Name Dwm -MemberDefinition '[DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr h, int a, ref int v, int s);'
  $form.Add_HandleCreated({ $on = 1; [void][Remoty.Dwm]::DwmSetWindowAttribute($form.Handle, 20, [ref]$on, 4) })
} catch {}
# Tell the app it's on screen, so it can quit now.
$form.Add_Shown({ Set-Content -LiteralPath $flag -Value 'shown' -ErrorAction SilentlyContinue })

$start = Get-Date
$appName = [System.IO.Path]::GetFileNameWithoutExtension($env:REMOTY_APP_EXE)
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 500
$timer.Add_Tick({
  # Done when the new version has removed the flag — or, for one from before this
  # window existed, simply when the app runs again (started after this window).
  $relaunched = @(Get-Process -Name $appName -ErrorAction SilentlyContinue | Where-Object { $_.StartTime -gt $start }).Count -gt 0
  if ($relaunched -or -not (Test-Path -LiteralPath $flag) -or ((Get-Date) - $start).TotalSeconds -gt 180) { $form.Close() }
})
$timer.Start()
[void]$form.ShowDialog()
if (Test-Path -LiteralPath $flag) { Remove-Item -LiteralPath $flag -ErrorAction SilentlyContinue }
`;

/** How the window is started: the script as -EncodedCommand, the values it shows and
 *  watches in its environment (never spliced into the script). Pure, for tests.
 *
 *  Through `cmd /c start`: a process spawned detached gets no console, and PowerShell
 *  without one exits at once; spawned attached, it would be killed with the app (Node
 *  keeps its children in a job that closes with it). `start` gives it a console of its
 *  own (minimised, then hidden by -WindowStyle) outside that job. */
export function updateSplashCommand(flag: string, version: string, appExe: string, env: NodeJS.ProcessEnv = process.env) {
  const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
  const powershell = `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand ${encoded}`;
  return {
    file: 'cmd.exe',
    args: ['/d', '/c', `start "" /min ${powershell}`],
    env: { ...env, REMOTY_UPDATE_FLAG: flag, REMOTY_UPDATE_VERSION: version, REMOTY_APP_EXE: appExe }
  };
}

/** Whether the window says it's on screen (it writes "shown" into the flag). */
function splashShown(flag: string): boolean {
  try {
    return readFileSync(flag, 'utf8').trim() === 'shown';
  } catch {
    return false;
  }
}

/** Shows the window (Windows only) and resolves once it's on screen — or after
 *  `waitMs` at most, so a window that never comes up can't hold the update back.
 *  Call right before quitting to install. */
export async function showUpdateSplash(version: string, appExe: string = process.execPath, waitMs = 4000): Promise<void> {
  if (process.platform !== 'win32') return;
  const flag = updateFlagPath();
  try {
    writeFileSync(flag, version);
    const cmd = updateSplashCommand(flag, version, appExe);
    // `cmd` only hands over to `start` and exits; hidden, so no console flashes.
    const child = spawn(cmd.file, cmd.args, { env: cmd.env, detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true });
    child.on('error', () => rmSync(flag, { force: true }));
    child.unref();
  } catch {
    return; // No window then; the update itself goes on.
  }
  const until = Date.now() + waitMs;
  while (Date.now() < until && !splashShown(flag)) await new Promise((r) => setTimeout(r, 100));
}

/** At startup: the update (if one was running) is done — its window can close. */
export function clearUpdateSplash(dir?: string): boolean {
  const flag = updateFlagPath(dir);
  if (!existsSync(flag)) return false;
  rmSync(flag, { force: true });
  return true;
}
