# VeeTrax backup restore: rebuilds a database from a FULL backup, optionally plus the latest DIFF made after it.
#
#   .\restore.ps1 -Full full-20261026-0230.dump.age [-Diff diff-20261028-1830.zip.age] -Target "postgresql://user:pass@host:5432/newdb"
#
# - Download the files from GitHub (veetrax/dailydbbackup → Releases). A DIFF's release text names its base FULL.
# - The target database must exist and be EMPTY (create it first, e.g. CREATE DATABASE veetrax_restore;).
# - Needs: this folder's age.exe and veetrax-backup-key.txt (private key), PostgreSQL client tools (-PgBin).
#
# FULL only : pg_restore of the whole dump.
# FULL+DIFF : 1) the DIFF's base dump (all tables; small ones with their data at DIFF time, Position / RawPacket empty)
#             2) Position / RawPacket data from the FULL
#             3) Position / RawPacket rows received since the FULL (CSV in the DIFF), duplicates skipped.
param(
  [Parameter(Mandatory)][string]$Full,
  [string]$Diff,
  [Parameter(Mandatory)][string]$Target,
  [string]$Key,
  [string]$Age,
  [string]$PgBin
)
$ErrorActionPreference = 'Stop'
# Defaults: the key and age.exe next to this script, the newest local PostgreSQL client tools.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Key) { $Key = Join-Path $here 'veetrax-backup-key.txt' }
if (-not $Age) { $Age = Join-Path $here 'age.exe' }
if (-not $PgBin) { $PgBin = (Get-ChildItem 'C:\Program Files\PostgreSQL\*\bin\pg_restore.exe' -ErrorAction SilentlyContinue | Sort-Object FullName | Select-Object -Last 1).DirectoryName }
function Run([string]$exe, [string[]]$arguments) {
  & $exe @arguments
  if ($LASTEXITCODE -ne 0) { throw "$(Split-Path $exe -Leaf) failed (exit $LASTEXITCODE)" }
}
function Decrypt([string]$file, [string]$out) {
  if ($file -like '*.age') { Run $Age @('-d', '-i', $Key, '-o', $out, $file); return $out }
  return $file
}

$work = Join-Path ([IO.Path]::GetTempPath()) "veetrax-restore-$(Get-Date -Format yyyyMMddHHmmss)"
New-Item -ItemType Directory -Force $work | Out-Null
try {
  $fullDump = Decrypt (Resolve-Path $Full).Path (Join-Path $work 'full.dump')
  if (-not $Diff) {
    Write-Host 'Restoring FULL backup...'
    Run "$PgBin\pg_restore.exe" @('--no-owner', '--no-privileges', '-d', $Target, $fullDump)
  } else {
    $zip = Decrypt (Resolve-Path $Diff).Path (Join-Path $work 'diff.zip')
    $dir = Join-Path $work 'diff'
    Expand-Archive -Path $zip -DestinationPath $dir
    $manifest = Get-Content "$dir\manifest.json" -Raw | ConvertFrom-Json
    Write-Host "DIFF of $($manifest.at), base $($manifest.base), rows since $($manifest.since)"
    Write-Host '1/3 schema + small tables (from the DIFF)...'
    Run "$PgBin\pg_restore.exe" @('--no-owner', '--no-privileges', '-d', $Target, "$dir\base.dump")
    Write-Host '2/3 Position / RawPacket from the FULL...'
    Run "$PgBin\pg_restore.exe" @('--no-owner', '--no-privileges', '--data-only', '-t', 'Position', '-t', 'RawPacket', '-d', $Target, $fullDump)
    Write-Host '3/3 rows received since the FULL...'
    $pos = ("$dir\Position.csv" -replace '\\', '/')
    $raw = ("$dir\RawPacket.csv" -replace '\\', '/')
    @"
CREATE TEMP TABLE stage_pos (LIKE public."Position");
\copy stage_pos FROM '$pos' WITH (FORMAT csv)
INSERT INTO public."Position" SELECT * FROM stage_pos ON CONFLICT DO NOTHING;
CREATE TEMP TABLE stage_raw (LIKE public."RawPacket");
\copy stage_raw FROM '$raw' WITH (FORMAT csv)
INSERT INTO public."RawPacket" SELECT * FROM stage_raw ON CONFLICT DO NOTHING;
SELECT setval(pg_get_serial_sequence('public."RawPacket"', 'id'), GREATEST((SELECT max(id) FROM public."RawPacket"), 1));
"@ | Set-Content -Path "$work\merge.sql" -Encoding ascii
    Run "$PgBin\psql.exe" @('-v', 'ON_ERROR_STOP=1', '-q', '-d', $Target, '-f', "$work\merge.sql")
  }
  Write-Host 'Restore complete.'
} finally {
  # The decrypted files hold customer data: never leave them behind.
  Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
