# VeeTrax watchdog for the Windows production server (NSSM services). Run every minute by the scheduled task that
# install-reliability.ps1 registers. Docs: docs/reliability/recovery-and-alerts.md
#
# What it does
#   - veetracer-* service not running      -> alert, then Start-Service (at most 3 starts per service per hour;
#                                             NSSM itself restarts crashed node processes, this catches a service that
#                                             NSSM gave up on or that was stopped by something else)
#   - Valkey VM health (-ValkeyHealthUrl)  -> alert when unreachable / down / degraded (memory, AOF, RDB, backup age)
#   - cache service not running            -> alert ONLY. It is never started or restarted from here: restarting
#                                             Memurai Developer Edition to get around its 10-day licence shutdown is
#                                             not allowed (see docs/reliability/cache-assessment.md)
#   - GET /api/health/ready 503            -> alert (database or cache unusable)
#   - GET /api/health/tracking CRITICAL    -> alert (pipeline stalled, positions refused, lag, nothing persisted)
#   - gateway /health degraded / failing   -> alert (positions spooling to disk / being refused)
#   - every alert is repeated at most every 30 min while it lasts, and a "resolved" alert is sent when it clears
#   - maintenance: create C:\apps\veetracer\maintenance.flag to suppress starts and alerts (deploys create/remove it)
#
# Alerts go through the app's own mail (and optional SMS) provider: node dist\monitoring\alert-cli.js, plus the
# Windows Application event log (source "VeeTrax").
param(
  [string]$AppDir = 'C:\apps\veetracer\app',
  [string]$LogDir = 'C:\apps\veetracer\logs',
  [string]$CacheService = 'Memurai',
  [int]$ApiPort = 4100,
  [int]$GatewayHealthPort = 4121,
  [int]$CooldownMin = 30,
  # Health endpoint of the Valkey VM (ops/valkey, port 9121), e.g. http://10.0.0.5:9121/health; empty = not checked.
  [string]$ValkeyHealthUrl = '',
  [int]$MaxStartsPerHour = 3
)
$ErrorActionPreference = 'Continue'
$services = 'veetracer-api', 'veetracer-gateway', 'veetracer-processor', 'veetracer-notifier', 'veetracer-summarizer'
$stateFile = Join-Path $LogDir 'watchdog-state.json'
$logFile = Join-Path $LogDir 'watchdog.log'
$maintenance = Join-Path (Split-Path $AppDir) 'maintenance.flag'
New-Item -ItemType Directory -Force $LogDir | Out-Null

function Log([string]$msg) { Add-Content -Path $logFile -Value "$(Get-Date -Format s) $msg" }

if (Test-Path $maintenance) { Log 'maintenance.flag present: checks skipped'; return }

# ---- state (alerts sent, service starts) -------------------------------------------------------------------------
$state = @{ alerts = @{}; starts = @{} }
if (Test-Path $stateFile) {
  try {
    $raw = Get-Content $stateFile -Raw | ConvertFrom-Json
    foreach ($p in $raw.alerts.PSObject.Properties) { $state.alerts[$p.Name] = [string]$p.Value }
    foreach ($p in $raw.starts.PSObject.Properties) { $state.starts[$p.Name] = @($p.Value | ForEach-Object { [string]$_ }) }
  } catch { Log "state file unreadable, starting fresh: $($_.Exception.Message)" }
}
$now = Get-Date
$active = @{}   # key -> message, for the issues seen in this run

function Send-Alert([string]$subject, [string]$body, [string]$level = 'Error') {
  Log "ALERT $subject | $body"
  try {
    if (-not [System.Diagnostics.EventLog]::SourceExists('VeeTrax')) { New-EventLog -LogName Application -Source 'VeeTrax' }
    $type = if ($level -eq 'Information') { 'Information' } else { 'Error' }
    Write-EventLog -LogName Application -Source 'VeeTrax' -EntryType $type -EventId 4100 -Message "$subject`r`n$body"
  } catch { Log "event log write failed: $($_.Exception.Message)" }
  $cli = Join-Path $AppDir 'apps\api\dist\monitoring\alert-cli.js'
  if (Test-Path $cli) {
    Push-Location (Join-Path $AppDir 'apps\api')
    $out = & node $cli --subject $subject --body $body 2>&1
    Pop-Location
    Log "alert-cli: $($out -join ' ')"
  } else { Log "alert-cli not found at $cli (build the API)" }
}

function Raise([string]$key, [string]$subject, [string]$body) {
  $active[$key] = $subject
  $last = $state.alerts[$key]
  if ($last -and ($now - [datetime]$last).TotalMinutes -lt $CooldownMin) { return }
  $state.alerts[$key] = $now.ToString('o')
  Send-Alert $subject $body
}

function Get-Json([string]$url) {
  try {
    $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 8
    return @{ code = [int]$r.StatusCode; body = ($r.Content | ConvertFrom-Json) }
  } catch {
    $resp = $_.Exception.Response
    if ($resp) {
      $code = [int]$resp.StatusCode
      # PowerShell 5.1 has already read the error body into ErrorDetails; the response stream is at its end.
      $text = if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $_.ErrorDetails.Message } else { $null }
      if (-not $text) {
        try { $s = $resp.GetResponseStream(); if ($s.CanSeek) { $s.Position = 0 }; $text = (New-Object IO.StreamReader($s)).ReadToEnd() } catch { $text = $null }
      }
      try { $body = $text | ConvertFrom-Json } catch { $body = $null }
      return @{ code = $code; body = $body }
    }
    return @{ code = 0; body = $null; error = $_.Exception.Message }
  }
}

# A process is expected to answer when its service runs (or, on a machine without the service, always).
function Test-Expected([string]$name) {
  $s = Get-Service $name -ErrorAction SilentlyContinue
  return (-not $s) -or $s.Status -eq 'Running'
}

# ---- services ----------------------------------------------------------------------------------------------------
foreach ($name in $services) {
  $svc = Get-Service $name -ErrorAction SilentlyContinue
  if (-not $svc) { continue }
  if ($svc.Status -eq 'Running') { continue }
  $recent = @($state.starts[$name] | Where-Object { $_ -and ($now - [datetime]$_).TotalMinutes -lt 60 })
  if ($recent.Count -ge $MaxStartsPerHour) {
    Raise "svc:$name" "$name is $($svc.Status) (watchdog gave up)" "$name was started $($recent.Count) times in the last hour and is $($svc.Status) again. Not starting it again; check $LogDir."
    $state.starts[$name] = $recent
    continue
  }
  Raise "svc:$name" "$name is $($svc.Status)" "$name was found $($svc.Status) at $($now.ToString('s')). The watchdog is starting it (start $($recent.Count + 1) of $MaxStartsPerHour this hour)."
  try { Start-Service $name -ErrorAction Stop; Log "started $name" } catch { Log "start $name failed: $($_.Exception.Message)" }
  $state.starts[$name] = @($recent + $now.ToString('o'))
}

# ---- cache (alert only, never restarted here) --------------------------------------------------------------------
$cache = Get-Service $CacheService -ErrorAction SilentlyContinue
if ($cache -and $cache.Status -ne 'Running') {
  Raise 'cache:service' "Cache service $CacheService is $($cache.Status)" "The cache service $CacheService is $($cache.Status). The gateway keeps devices connected and spools positions to disk; they are replayed when the cache is back. The watchdog does not restart the cache: investigate (Memurai Developer Edition stops itself after 10 days and may not be used in production)."
}

# ---- Valkey VM (when configured) ---------------------------------------------------------------------------------
if ($ValkeyHealthUrl) {
  $vk = Get-Json $ValkeyHealthUrl
  if ($vk.code -eq 0) {
    Raise 'valkey:unreachable' 'Valkey VM health endpoint not answering' "$ValkeyHealthUrl did not answer ($($vk.error)). The VM, its network or the valkey-health service is down; the gateway spools positions meanwhile."
  } elseif ($vk.body.status -eq 'down') {
    Raise 'valkey:down' 'Valkey is down on its VM' (($vk.body.reasons) -join "`n")
  } elseif ($vk.body.status -eq 'degraded') {
    Raise 'valkey:degraded' 'Valkey degraded' (($vk.body.reasons) -join "`n")
  }
}

# ---- API readiness and tracking ----------------------------------------------------------------------------------
$ready = Get-Json "http://127.0.0.1:$ApiPort/api/health/ready"
if ($ready.code -eq 0) {
  if (Test-Expected 'veetracer-api') { Raise 'api:down' 'API not answering' "GET /api/health/ready did not answer: $($ready.error)" }
} elseif ($ready.code -ne 200) {
  $db = $ready.body.checks.database; $c = $ready.body.checks.cache
  Raise 'api:ready' 'API not ready (database or cache unusable)' "database ok=$($db.ok) $($db.error); cache ok=$($c.ok) $($c.error)"
}
$tracking = Get-Json "http://127.0.0.1:$ApiPort/api/health/tracking"
if ($tracking.body -and $tracking.body.status -eq 'CRITICAL') {
  $msgs = ($tracking.body.issues | Where-Object { $_.severity -eq 'CRITICAL' } | ForEach-Object { "- $($_.message)" }) -join "`n"
  Raise 'tracking:critical' 'GPS tracking pipeline CRITICAL' $msgs
}

# ---- gateway local health (works while the cache is down) --------------------------------------------------------
if (Test-Expected 'veetracer-gateway') {
  $gw = Get-Json "http://127.0.0.1:$GatewayHealthPort/health"
  if ($gw.code -eq 0) {
    Raise 'gateway:down' 'Gateway health endpoint not answering' "http://127.0.0.1:$GatewayHealthPort/health did not answer: $($gw.error)"
  } elseif ($gw.body.status -eq 'failing') {
    Raise 'gateway:failing' 'Gateway is refusing positions' (($gw.body.reasons) -join "`n")
  } elseif ($gw.body.status -eq 'degraded') {
    Raise 'gateway:degraded' "Gateway spooling positions to disk ($($gw.body.spool.pendingEntries) pending)" (($gw.body.reasons) -join "`n")
  }
}

# ---- resolved ----------------------------------------------------------------------------------------------------
foreach ($key in @($state.alerts.Keys)) {
  if ($active.ContainsKey($key)) { continue }
  Send-Alert "Resolved: $key" "The condition '$key' is no longer present ($($now.ToString('s')))." 'Information'
  $state.alerts.Remove($key)
}

$state | ConvertTo-Json -Depth 4 | Set-Content -Path $stateFile -Encoding UTF8
