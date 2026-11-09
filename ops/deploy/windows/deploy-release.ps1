# Deploys a release (default: main) to 166.0.242.121, or takes it back. Put gps-app.bundle (git bundle create gps-app.bundle main) next to this script.
#   Deploy:   powershell -ExecutionPolicy Bypass -File ops\deploy\windows\deploy-release.ps1 [-Branch main]
#   Rollback: powershell -ExecutionPolicy Bypass -File ops\deploy\windows\deploy-release.ps1 -Rollback
# Touches only the veetracer-* services and C:\apps\veetracer. No .env, Caddy or firewall changes.
# Tracking pauses while the services are down for the build; devices reconnect and phones upload what they queued.
# -Branch: the branch inside the bundle to deploy (default main), e.g. -Branch feature/soft-delete.
param([switch]$Rollback, [pscredential]$Credential, [string]$Branch = 'main')
$cred = $Credential
if (-not $cred) {
  $pw = Read-Host -AsSecureString "166.0.242.121 Administrator password"
  $cred = New-Object System.Management.Automation.PSCredential ('Administrator', $pw)
}
$s = New-PSSession -ComputerName 166.0.242.121 -Credential $cred
if (-not $Rollback) {
  Copy-Item -ToSession $s -Path (Join-Path $PSScriptRoot 'gps-app.bundle') -Destination C:\apps\veetracer\gps-app.bundle -Force
}
Invoke-Command -Session $s -ArgumentList $Rollback.IsPresent, $Branch -ScriptBlock {
  param($rollback, $branch)
  $ErrorActionPreference = 'Continue'
  $services = 'veetracer-api', 'veetracer-gateway', 'veetracer-processor', 'veetracer-notifier', 'veetracer-summarizer'
  $mark = 'C:\apps\veetracer\pre-attendance-commit.txt'
  Set-Location C:\apps\veetracer\app

  # Decide the target before anything stops, so a problem here leaves the live app untouched.
  $before = (git rev-parse HEAD).Trim()
  if ($rollback) {
    if (-not (Test-Path $mark)) { 'STOP: no saved commit to go back to; nothing changed'; return }
    $target = (Get-Content $mark -Raw).Trim()
  } else {
    if ((git status --porcelain --untracked-files=no | Measure-Object).Count -gt 0) { 'STOP: the server copy has local changes; nothing changed'; git status --short --untracked-files=no; return }
    cmd /c "git fetch -q ..\gps-app.bundle $branch 2>&1"
    $target = (git rev-parse FETCH_HEAD).Trim()
    cmd /c "git merge-base --is-ancestor $before $target"
    if ($LASTEXITCODE -ne 0) { "STOP: the server is on $before, which is not part of this branch; nothing changed"; return }
    if (-not (Test-Path $mark)) { Set-Content -Path $mark -Value $before -Encoding ASCII }
  }
  "code: $before -> $target"

  function Stop-Vt([string]$n) {
    $svc = Get-CimInstance Win32_Service -Filter "Name='$n'"
    if (-not $svc -or $svc.State -eq 'Stopped') { return "$n already stopped" }
    Stop-Service $n -NoWait -ErrorAction SilentlyContinue
    for ($i = 0; $i -lt 20 -and (Get-Service $n).Status -ne 'Stopped'; $i++) { Start-Sleep 1 }
    if ((Get-Service $n).Status -ne 'Stopped') {
      $svc = Get-CimInstance Win32_Service -Filter "Name='$n'"
      Get-CimInstance Win32_Process -Filter "ParentProcessId=$($svc.ProcessId)" | Where-Object Name -eq 'node.exe' | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
      if ($svc.ProcessId -gt 0) { Stop-Process -Id $svc.ProcessId -Force -ErrorAction SilentlyContinue }
      Start-Sleep 2
    }
    "$n -> $((Get-Service $n).Status)"
  }
  # The watchdog (install-reliability.ps1) neither alerts nor starts services while this flag exists.
  $flag = 'C:\apps\veetracer\maintenance.flag'
  Set-Content -Path $flag -Value "deploy $(Get-Date -Format s)"
  foreach ($n in $services) { if (Get-Service $n -ErrorAction SilentlyContinue) { Stop-Vt $n } }

  if ($rollback) { cmd /c "git checkout -q --detach $target 2>&1" } else { cmd /c "git merge --ff-only -q $target 2>&1" }
  "now on: $(git log -1 --format='%h %s')"

  $log = 'C:\apps\veetracer\logs\deploy.log'
  "=== attendance deploy (rollback=$rollback) $(Get-Date -Format s)" | Set-Content $log
  $steps = @(
    @('npm ci', 'npm ci --no-audit --no-fund'),
    @('shared', 'npm run build:shared'),
    @('web', 'npm run build -w @veetracer/web'),
    @('prisma generate', 'cd apps\api && npx prisma generate'),
    @('api', 'cd apps\api && npm run build')
  )
  # Going back leaves the database as it is: the new columns and tables are ignored by the older code.
  if (-not $rollback) {
    $steps += , @('migrate', 'cd apps\api && npx prisma migrate deploy')
    $steps += , @('seed', 'cd apps\api && npm run db:seed')
  }
  $ok = $true
  foreach ($st in $steps) {
    cmd /c "$($st[1]) >> $log 2>&1"
    "$($st[0]): exit $LASTEXITCODE"
    if ($LASTEXITCODE -ne 0) { Get-Content $log -Tail 20; $ok = $false; break }
  }
  foreach ($n in $services) { if (Get-Service $n -ErrorAction SilentlyContinue) { Start-Service $n -ErrorAction SilentlyContinue; "$n -> $((Get-Service $n).Status)" } }
  if (-not $ok) { 'BUILD FAILED: see above. Run this script with -Rollback to go back.' }

  # The first start after a rebuild can take about 90 s.
  # Since release 1.6 /api/health is readiness: 200 only when the API answers AND PostgreSQL and the cache are usable
  # (503 otherwise), so this gate also fails while the cache is down. /api/health/live is the old "process is up" check.
  $up = $false
  $why = 'no answer'
  for ($i = 0; $i -lt 36 -and -not $up; $i++) {
    Start-Sleep 5
    try { Invoke-WebRequest http://localhost:4100/api/health -UseBasicParsing -TimeoutSec 5 | Out-Null; $up = $true }
    catch { if ($_.Exception.Response) { $why = "HTTP $([int]$_.Exception.Response.StatusCode) (database or cache not ready)" } }
  }
  "api health: $(if ($up) { 'OK (database and cache ready)' } else { "not ready after 3 min: $why (check C:\apps\veetracer\logs)" })"
  try { $t = Invoke-WebRequest http://localhost:4100/api/health/tracking -UseBasicParsing -TimeoutSec 10; "tracking: $(($t.Content | ConvertFrom-Json).status)" }
  catch { "tracking: not OK yet (HTTP $(if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { '-' })); devices reconnect within minutes, check /api/health/tracking again" }
  Remove-Item $flag -ErrorAction SilentlyContinue
}
Remove-PSSession $s
