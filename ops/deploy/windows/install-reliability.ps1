# Controlled recovery for the VeeTrax NSSM services + the watchdog scheduled task. Run ON the server as Administrator
# after release 1.6 is deployed. Idempotent; -DryRun prints what it would change. Docs: docs/reliability/recovery-and-alerts.md
#
#   powershell -ExecutionPolicy Bypass -File ops\deploy\windows\install-reliability.ps1 -DryRun
#   powershell -ExecutionPolicy Bypass -File ops\deploy\windows\install-reliability.ps1 [-CacheService Memurai]
#
# Per veetracer-* service (NSSM):
#   AppExit Default Restart        restart the node process whenever it exits
#   AppRestartDelay 5000           wait 5 s before restarting (lets ports / connections close)
#   AppThrottle 30000              a process that dies within 30 s of starting is restarted with growing delays
#                                  (NSSM throttling) instead of a tight crash loop
#   AppStopMethodConsole 20000     on stop, Ctrl+C first and wait up to 20 s: the gateway flushes its spool and
#                                  closes cleanly (positions still on disk are replayed at the next start)
#   SCM failure actions            restart after 10 s / 30 s / 60 s if the NSSM wrapper itself dies (reset daily)
# No service is made to depend on the cache service: the gateway must keep running (and spooling) while it is down.
#
# The cache service is NOT given restart actions here. Pass -CacheLicensed only for a cache that may legally run
# unattended in production (Memurai Enterprise, or a Valkey service); never for Memurai Developer Edition.
param(
  [switch]$DryRun,
  [string]$Nssm = '',
  [string]$AppDir = 'C:\apps\veetracer\app',
  [string]$CacheService = 'Memurai',
  [switch]$CacheLicensed,
  [switch]$SkipWatchdog
)
$ErrorActionPreference = 'Stop'
$services = 'veetracer-api', 'veetracer-gateway', 'veetracer-processor', 'veetracer-notifier', 'veetracer-summarizer'

function Run([string]$exe, [string[]]$argv) {
  if ($DryRun) { "DRY-RUN: $exe $($argv -join ' ')"; return }
  & $exe @argv | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "$exe $($argv -join ' ') failed with exit code $LASTEXITCODE" }
  "ok: $exe $($argv -join ' ')"
}

if (-not $Nssm) {
  # The nssm.exe that wraps veetracer-api (ImagePath of the service), else PATH.
  $svc = Get-CimInstance Win32_Service -Filter "Name='veetracer-api'"
  if ($svc -and $svc.PathName -match '^"?([^"]*nssm[^"]*\.exe)') { $Nssm = $Matches[1] }
  elseif (Get-Command nssm.exe -ErrorAction SilentlyContinue) { $Nssm = (Get-Command nssm.exe).Source }
  else { throw 'nssm.exe not found; pass -Nssm <path>' }
}
"nssm: $Nssm"

foreach ($name in $services) {
  if (-not (Get-Service $name -ErrorAction SilentlyContinue)) { "skip $name (not installed)"; continue }
  Run $Nssm @('set', $name, 'AppExit', 'Default', 'Restart')
  Run $Nssm @('set', $name, 'AppRestartDelay', '5000')
  Run $Nssm @('set', $name, 'AppThrottle', '30000')
  Run $Nssm @('set', $name, 'AppStopMethodConsole', '20000')
  Run 'sc.exe' @('failure', $name, 'reset=', '86400', 'actions=', 'restart/10000/restart/30000/restart/60000')
  Run 'sc.exe' @('failureflag', $name, '1')
}

if ($CacheLicensed) {
  if (Get-Service $CacheService -ErrorAction SilentlyContinue) {
    Run 'sc.exe' @('failure', $CacheService, 'reset=', '86400', 'actions=', 'restart/10000/restart/30000/restart/60000')
  } else { "cache service $CacheService not found; nothing set" }
} else {
  "cache service ${CacheService}: left unchanged (no automatic restarts; pass -CacheLicensed for a production-licensed cache)"
}

if (-not $SkipWatchdog) {
  $script = Join-Path $AppDir 'ops\deploy\windows\veetrax-watchdog.ps1'
  $taskArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$script`" -CacheService $CacheService"
  if ($DryRun) {
    "DRY-RUN: register scheduled task 'VeeTrax watchdog' (SYSTEM, every 1 min): powershell.exe $taskArgs"
  } else {
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $taskArgs
    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -StartWhenAvailable
    Register-ScheduledTask -TaskName 'VeeTrax watchdog' -Action $action -Trigger $trigger -Settings $settings -User 'SYSTEM' -RunLevel Highest -Force | Out-Null
    "ok: scheduled task 'VeeTrax watchdog' (every minute)"
  }
}
'done'
