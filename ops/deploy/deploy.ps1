# VeeTrax release deployment for a Windows host running PM2 (this PC or server-mintplus-windows).
#
#   powershell -ExecutionPolicy Bypass -File ops\deploy\deploy.ps1 -Tag v1.1.0 [-Root C:\apps\veetracer\app] [-HealthUrl https://gps.mintplus.co.in/api/health]
#   powershell -ExecutionPolicy Bypass -File ops\deploy\deploy.ps1 -Rollback          # back to the previously deployed tag
#
# Steps: preflight -> backup (required; -SkipBackup only with written owner approval) -> record the current tag ->
# checkout the release tag -> npm ci -> build shared/api/web -> prisma migrate deploy -> pm2 reload --update-env ->
# health check -> automatic rollback of CODE if the health check fails (migrations are additive by policy).
# Deploys only tags that exist on origin, never a branch. Nothing here runs unless an operator starts it.
param(
  [string]$Tag,
  [switch]$Rollback,
  [string]$Root = (Resolve-Path "$PSScriptRoot\..\..").Path,
  [string]$HealthUrl = 'http://localhost:4000/api/health',
  [string]$BackupCommand = '',              # e.g. 'wsl -d Ubuntu -u root -e bash /mnt/d/.../ops/backup/veetrax-backup.sh /etc/veetrax/backup.conf' or the server's nightly-backup.ps1 -Mode full
  [switch]$SkipBackup,
  [string[]]$Processes = @('api', 'gateway', 'processor', 'notifier', 'summarizer', 'web')
)
$ErrorActionPreference = 'Stop'
$env:Path = "C:\Program Files\nodejs;$env:APPDATA\npm;$env:Path"
$state = Join-Path $Root 'apps\api\var\release-state.json'
$log = Join-Path $Root 'apps\api\var\logs\deploy.log'
New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null
function Log($m) { $line = "$(Get-Date -Format s) $m"; Write-Host $line; Add-Content -Path $log -Value $line }
function Run($what, [scriptblock]$cmd) { Log ">> $what"; & $cmd; if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw "$what failed (exit $LASTEXITCODE)" } }
function Healthy { for ($i = 0; $i -lt 30; $i++) { try { if ((Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 $HealthUrl).StatusCode -eq 200) { return $true } } catch {} ; Start-Sleep 2 }; return $false }

Set-Location $Root
$prev = if (Test-Path $state) { (Get-Content $state -Raw | ConvertFrom-Json) } else { $null }
if ($Rollback) {
  if (-not $prev -or -not $prev.previous) { throw 'No previous release recorded; roll back manually (see ops/run/README.md).' }
  $Tag = $prev.previous; Log "ROLLBACK requested -> $Tag"
}
if (-not $Tag) { throw 'Specify -Tag vX.Y.Z (or -Rollback).' }

# Preflight
Run 'git fetch --tags' { git fetch --tags --quiet origin }
if (-not (git tag --list $Tag)) { throw "Tag $Tag not found on origin." }
if (git status --porcelain --untracked-files=no) { throw 'Working tree has local changes; refusing to deploy.' }
$envFile = Join-Path $Root 'apps\api\.env'
if (-not (Test-Path $envFile)) { throw 'apps\api\.env missing.' }
$envText = Get-Content $envFile -Raw
if ($envText -match '(?m)^(OTP_DEV_ECHO|MAIL_DEV_ECHO)=true') { throw 'Dev echo enabled in .env; the production API would refuse to start.' }
$current = (git describe --tags --exact-match 2>$null); if (-not $current) { $current = (git rev-parse --short HEAD) }
Log "Deploying $Tag (currently $current) on $env:COMPUTERNAME"

# Backup (required)
if (-not $Rollback) {
  if ($SkipBackup) { Log 'WARNING: backup skipped by operator flag (requires written owner approval).' }
  elseif (-not $BackupCommand) { throw 'Provide -BackupCommand (a fresh verified backup is required before deploying).' }
  else { Run 'backup' { Invoke-Expression $BackupCommand } }
}

# Build
Run "checkout $Tag" { git -c advice.detachedHead=false checkout --quiet $Tag }
try {
  Run 'npm ci' { npm ci --no-audit --no-fund }
  Run 'build shared' { npm run build:shared }
  Run 'build api' { npm run build -w @veetracer/api }
  Run 'build web' { npm run build -w @veetracer/web }
  Push-Location apps\api; try { Run 'prisma migrate deploy' { npx prisma migrate deploy } } finally { Pop-Location }
  Run 'pm2 reload' { pm2 reload @Processes --update-env }
  Run 'pm2 save' { pm2 save }
  if (-not (Healthy)) { throw "Health check failed: $HealthUrl" }
  @{ current = $Tag; previous = $(if ($Rollback) { $null } else { $current }); at = (Get-Date -Format s) } | ConvertTo-Json | Set-Content $state
  Log "OK $Tag deployed and healthy. Monitor: pm2 ls; pm2 logs api --lines 100"
} catch {
  Log "FAILED $($_.Exception.Message)"
  if ($Rollback) { throw }
  Log "Rolling back code to $current"
  git -c advice.detachedHead=false checkout --quiet $current
  npm ci --no-audit --no-fund; npm run build:shared; npm run build -w @veetracer/api; npm run build -w @veetracer/web
  pm2 reload @Processes --update-env
  if (Healthy) { Log "Rolled back to $current (healthy). Migrations from $Tag (additive) remain applied." } else { Log 'ROLLBACK UNHEALTHY: restore from backup (ops/run/README.md).' }
  throw
}
