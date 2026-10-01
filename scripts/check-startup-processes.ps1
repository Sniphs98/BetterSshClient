<#
.SYNOPSIS
  Development check (Windows): starts Remoty and fails if, while it starts up, any
  process is created with -EncodedCommand or -ExecutionPolicy Bypass on its command line.

.EXAMPLE
  powershell -NoProfile -File scripts\check-startup-processes.ps1 -App "$env:LOCALAPPDATA\Programs\Remoty\Remoty.exe"

  Test the installed build, not only the dev build. Close Remoty before running it.
#>
param(
  [Parameter(Mandatory = $true)][string]$App,
  [int]$Seconds = 20
)

$ErrorActionPreference = 'Stop'
# -EncodedCommand and its abbreviations (-e, -ec, -enc, ...), and -ExecutionPolicy/-ep Bypass.
$suspicious = '(?i)\s[-/](e|ec|en|enc|encodedcommand)\s|\s[-/](ep|executionpolicy)\s+bypass'
$found = New-Object System.Collections.ArrayList

# Process creation events, polled by WMI every half second (no admin rights needed).
$query = "SELECT * FROM __InstanceCreationEvent WITHIN 0.5 WHERE TargetInstance ISA 'Win32_Process'"
Register-CimIndicationEvent -Query $query -SourceIdentifier RemotyStartupCheck | Out-Null
try {
  $app = Start-Process -FilePath $App -PassThru
  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    $evt = Wait-Event -SourceIdentifier RemotyStartupCheck -Timeout 1
    if (-not $evt) { continue }
    $process = $evt.SourceEventArgs.NewEvent.TargetInstance
    Remove-Event -EventIdentifier $evt.EventIdentifier
    if ($process.Name -match '^(powershell|pwsh)\.exe$' -and $process.CommandLine -match $suspicious) {
      # The name and flags only: the rest of the command line may hold anything.
      [void]$found.Add("$($process.Name) (pid $($process.ProcessId), parent $($process.ParentProcessId))")
    }
  }
} finally {
  Unregister-Event -SourceIdentifier RemotyStartupCheck -ErrorAction SilentlyContinue
  if ($app -and -not $app.HasExited) { Stop-Process -Id $app.Id -ErrorAction SilentlyContinue }
}

if ($found.Count -gt 0) {
  Write-Host "FAIL: processes started with -EncodedCommand / -ExecutionPolicy Bypass during startup:"
  $found | ForEach-Object { Write-Host "  $_" }
  exit 1
}
Write-Host "OK: no process with -EncodedCommand / -ExecutionPolicy Bypass in the first $Seconds s."
