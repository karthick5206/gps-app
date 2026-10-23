# VeeTrax database backup (scheduled task "VeeTrax nightly backup": 02:30, 10:30 and 18:30 daily, runs as SYSTEM).
#
#   FULL  (weekly: Sunday 02:30, or when the last full is 7+ days old / missing): pg_dump of the whole database.
#   DIFF  (every other run, every 8 h): pg_dump of everything EXCEPT the data of the two big insert-only tables
#         ("Position", "RawPacket"), plus their rows received since the last FULL started (CSV). Restore = the FULL
#         + the latest DIFF of that week (restore.ps1 does it).
#
# Every file is encrypted with age (PUBLIC key only; the private key is kept offline by the owner) and uploaded as a
# GitHub Release asset in the private repo. Kept: 100 days (a FULL stays while a kept DIFF still needs it).
# A failure sends an e-mail (ZeptoMail, API .env) to config.alertTo.
#
# Files (C:\apps\veetracer): secrets\github-backup-token.txt, backup\config.json { repo, recipient, alertTo,
# keepDays, keepLocal }, backup\state.json { lastFullTag, lastFullSince }, tools\age\age.exe, logs\backup.log,
# backup\last-status.json.
param([ValidateSet('auto', 'full', 'diff')][string]$Mode = 'auto')

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$root = 'C:\apps\veetracer'
$pgBin = 'C:\Program Files\PostgreSQL\16\bin'
$log = "$root\logs\backup.log"
$envFile = "$root\app\apps\api\.env"
$statePath = "$root\backup\state.json"
$BIG_TABLES = @(@{ name = 'Position'; since = 'serverTime' }, @{ name = 'RawPacket'; since = 'receivedAt' })
function Log([string]$m) { "$(Get-Date -Format s) $m" | Add-Content -Path $log -Encoding utf8 }
function EnvValue([string]$name) {
  $line = (Select-String -Path $envFile -Pattern "^$name=" | Select-Object -First 1).Line
  if ($line) { $line.Substring($name.Length + 1).Trim().Trim('"') } else { $null }
}
function SendAlert([string]$subject, [string]$text) {
  try {
    $to = $cfg.alertTo
    $key = EnvValue 'ZOHO_MAIL_KEY'
    if (-not $to -or -not $key) { return }
    if (-not $key.StartsWith('Zoho-enczapikey ')) { $key = "Zoho-enczapikey $key" }
    $base = EnvValue 'ZOHO_MAIL_URL'; if (-not $base) { $base = 'https://cpaas.zoho.in' }
    $from = EnvValue 'MAIL_FROM'
    $addr = if ($from -match '<([^>]+)>') { $Matches[1] } else { $from }
    $body = @{
      from = @{ address = $addr; name = 'VeeTrax Backup' }
      to = @($to -split '[,;]\s*' | Where-Object { $_ } | ForEach-Object { @{ email_address = @{ address = $_ } } })
      subject = $subject
      textbody = $text
      htmlbody = '<pre style="font-family:monospace">' + [Net.WebUtility]::HtmlEncode($text) + '</pre>'
    } | ConvertTo-Json -Depth 6
    Invoke-RestMethod -Method Post -Uri "$($base.TrimEnd('/'))/v1.1/email" -Headers @{ Authorization = $key; Accept = 'application/json' } -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($body)) | Out-Null
  } catch { Log "alert e-mail failed: $($_.Exception.Message)" }
}
function Run([string]$exe, [string[]]$arguments, [string]$what) {
  & $exe @arguments 2>&1 | ForEach-Object { Log "${what}: $_" }
  if ($LASTEXITCODE -ne 0) { throw "$what failed (exit $LASTEXITCODE)" }
}
# Tag date (UTC-agnostic local stamp) of full-/diff-/backup- releases.
function TagTime([string]$tag) {
  if ($tag -match '(\d{8}-\d{4})$') { [datetime]::ParseExact($Matches[1], 'yyyyMMdd-HHmm', $null) } else { $null }
}

$cfg = Get-Content "$root\backup\config.json" -Raw | ConvertFrom-Json
$keepDays = if ($cfg.keepDays) { [int]$cfg.keepDays } else { 100 }
$keepLocal = if ($cfg.keepLocal) { [int]$cfg.keepLocal } else { 6 }
$state = if (Test-Path $statePath) { Get-Content $statePath -Raw | ConvertFrom-Json } else { $null }
$started = Get-Date
$stamp = $started.ToString('yyyyMMdd-HHmm')
$work = Join-Path $root "backups\work-$stamp"
$status = $null
try {
  $token = (Get-Content "$root\secrets\github-backup-token.txt" -Raw).Trim()
  $gh = @{ Authorization = "Bearer $token"; Accept = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28'; 'User-Agent' = 'veetrax-backup' }
  $api = "https://api.github.com/repos/$($cfg.repo)"
  $dbUrl = EnvValue 'DATABASE_URL'

  # Which kind: FULL on Sunday's first run, when forced, or when there is no recent FULL to build a DIFF on.
  $lastFullAt = if ($state -and $state.lastFullTag) { TagTime $state.lastFullTag } else { $null }
  $kind = $Mode
  if ($kind -eq 'auto') {
    $sundayFirst = $started.DayOfWeek -eq 'Sunday' -and $started.Hour -lt 6 -and (-not $lastFullAt -or $lastFullAt.Date -ne $started.Date)
    $kind = if (-not $lastFullAt -or ($started - $lastFullAt).TotalDays -ge 7 -or $sundayFirst) { 'full' } else { 'diff' }
  }
  if ($kind -eq 'diff' -and -not $lastFullAt) { throw 'No FULL backup to base a DIFF on; run with -Mode full first' }
  Log "start $stamp $kind"
  New-Item -ItemType Directory -Force $work | Out-Null

  if ($kind -eq 'full') {
    # Rows received from this moment on go into the following DIFFs (overlap with the dump is merged on restore).
    $since = $started.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    $plain = Join-Path $work "full-$stamp.dump"
    Run "$pgBin\pg_dump.exe" @('--format=custom', "--file=$plain", '-d', $dbUrl) 'pg_dump'
    $tag = "full-$stamp"
    $meta = @{ kind = 'full'; since = $since; at = $started.ToString('o') }
  } else {
    $since = $state.lastFullSince
    $dir = Join-Path $work 'diff'
    New-Item -ItemType Directory -Force $dir | Out-Null
    # Windows PowerShell 5.1 drops bare double quotes in native-command arguments: escape them as \" so pg_dump sees
    # the quoted (case-sensitive) table name; unquoted it would fold to lower case and match nothing.
    $exclude = $BIG_TABLES | ForEach-Object { "--exclude-table-data=public.\`"$($_.name)\`"" }
    Run "$pgBin\pg_dump.exe" (@('--format=custom', "--file=$dir\base.dump") + $exclude + @('-d', $dbUrl)) 'pg_dump base'
    $copySql = ($BIG_TABLES | ForEach-Object {
        $csv = ("$dir\$($_.name).csv" -replace '\\', '/')
        "\copy (SELECT * FROM public.`"$($_.name)`" WHERE `"$($_.since)`" >= '$since'::timestamptz) TO '$csv' WITH (FORMAT csv)"
      }) -join "`n"
    Set-Content -Path "$work\copy.sql" -Value $copySql -Encoding ascii
    Run "$pgBin\psql.exe" @('-v', 'ON_ERROR_STOP=1', '-q', '-d', $dbUrl, '-f', "$work\copy.sql") 'psql copy'
    $rows = @{}
    foreach ($t in $BIG_TABLES) { $rows[$t.name] = @(Get-Content "$dir\$($t.name).csv" -ReadCount 0).Count }
    @{ kind = 'diff'; base = $state.lastFullTag; since = $since; at = $started.ToString('o'); rows = $rows } | ConvertTo-Json | Set-Content "$dir\manifest.json" -Encoding utf8
    $plain = Join-Path $work "diff-$stamp.zip"
    Compress-Archive -Path "$dir\*" -DestinationPath $plain -CompressionLevel Optimal
    $tag = "diff-$stamp"
    $meta = @{ kind = 'diff'; base = $state.lastFullTag; since = $since; at = $started.ToString('o'); rows = $rows }
  }

  # Encrypt; only the encrypted file leaves the server.
  $enc = Join-Path "$root\backups" ((Split-Path $plain -Leaf) + '.age')
  Run "$root\tools\age\age.exe" @('-r', $cfg.recipient, '-o', $enc, $plain) 'age'
  $size = (Get-Item $enc).Length

  # Upload as a release (body = JSON metadata, used for pruning and by restore.ps1).
  $relBody = @{ tag_name = $tag; name = "$tag ($kind)"; body = ($meta | ConvertTo-Json -Compress); draft = $false; prerelease = $false } | ConvertTo-Json
  $rel = Invoke-RestMethod -Method Post -Uri "$api/releases" -Headers $gh -ContentType 'application/json' -Body $relBody
  $asset = Invoke-RestMethod -Method Post -Uri "https://uploads.github.com/repos/$($cfg.repo)/releases/$($rel.id)/assets?name=$(Split-Path $enc -Leaf)" -Headers $gh -ContentType 'application/octet-stream' -InFile $enc
  if ($asset.size -ne $size) { throw "upload size mismatch: $($asset.size) <> $size" }
  Log "uploaded $tag $([math]::Round($size / 1MB, 2)) MB$(if ($kind -eq 'diff') { " (rows since $since`: $(($meta.rows.GetEnumerator() | ForEach-Object { "$($_.Key) $($_.Value)" }) -join ', '))" })"
  if ($kind -eq 'full') { @{ lastFullTag = $tag; lastFullSince = $since } | ConvertTo-Json | Set-Content $statePath -Encoding utf8 }

  # Prune GitHub: older than keepDays, except a FULL that a kept DIFF is based on.
  $all = @()
  for ($page = 1; $page -le 20; $page++) {
    $batch = Invoke-RestMethod -Uri "$api/releases?per_page=100&page=$page" -Headers $gh
    if (-not $batch -or $batch.Count -eq 0) { break }
    $all += $batch
  }
  $cutoff = $started.AddDays(-$keepDays)
  $backups = @($all | Where-Object { $_.tag_name -match '^(full|diff|backup)-\d{8}-\d{4}$' })
  $keptBases = @{}
  foreach ($r in $backups) {
    if ($r.tag_name -like 'diff-*' -and (TagTime $r.tag_name) -ge $cutoff) {
      try { $keptBases[(ConvertFrom-Json $r.body).base] = $true } catch { }
    }
  }
  $pruned = 0
  foreach ($r in $backups) {
    $t = TagTime $r.tag_name
    if ($t -ge $cutoff -or $keptBases[$r.tag_name] -or $r.tag_name -eq $state.lastFullTag -or $r.tag_name -eq $tag) { continue }
    Invoke-RestMethod -Method Delete -Uri "$api/releases/$($r.id)" -Headers $gh | Out-Null
    try { Invoke-RestMethod -Method Delete -Uri "$api/git/refs/tags/$($r.tag_name)" -Headers $gh | Out-Null } catch { }
    Log "pruned $($r.tag_name)"
    $pruned++
  }

  # Local copies: the newest keepLocal encrypted files.
  Get-ChildItem "$root\backups\*.age" | Where-Object { $_.Name -match '^(nightly|full|diff)-' } | Sort-Object LastWriteTime -Descending | Select-Object -Skip $keepLocal | Remove-Item -Force

  $status = @{ ok = $true; kind = $kind; at = $started.ToString('o'); tag = $tag; sizeBytes = $size; onGitHub = $backups.Count - $pruned }
  Log "done in $([int]((Get-Date) - $started).TotalSeconds) s; $($status.onGitHub) backups on GitHub"
} catch {
  $msg = $_.Exception.Message
  Log "FAILED: $msg"
  $status = @{ ok = $false; at = $started.ToString('o'); error = $msg }
  SendAlert "VeeTrax backup FAILED ($stamp)" "The database backup failed on $env:COMPUTERNAME at $($started.ToString('s')).`n`nError: $msg`n`nLog: $log"
} finally {
  if (Test-Path $work) { Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue }
}
$status | ConvertTo-Json | Set-Content "$root\backup\last-status.json" -Encoding utf8
if ($status.ok) { exit 0 } else { exit 1 }
