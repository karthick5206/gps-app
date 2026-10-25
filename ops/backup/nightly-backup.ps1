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
param(
  [ValidateSet('auto', 'full', 'diff')][string]$Mode = 'auto',
  # Largest file uploaded to a release; GitHub's limit is 2 GiB per file. Lower only to test splitting.
  [double]$PartMB = 1900
)

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
# Returns @($file) when it fits in one part, else writes <name>.part001, .part002, ... (each <= $partBytes) to $outDir.
function SplitFile([string]$file, [long]$partBytes, [string]$outDir) {
  $len = (Get-Item $file).Length
  if ($len -le $partBytes) { return , @($file) }
  New-Item -ItemType Directory -Force $outDir | Out-Null
  $leaf = Split-Path $file -Leaf
  $buf = New-Object byte[] ([Math]::Min(64MB, $partBytes))
  $parts = @()
  $in = [IO.File]::OpenRead($file)
  try {
    $n = 0
    while ($in.Position -lt $len) {
      $n++
      $p = Join-Path $outDir ('{0}.part{1:D3}' -f $leaf, $n)
      $out = [IO.File]::Create($p)
      try {
        $left = [Math]::Min($partBytes, $len - $in.Position)
        while ($left -gt 0) {
          $r = $in.Read($buf, 0, [int][Math]::Min([long]$buf.Length, $left))
          if ($r -le 0) { throw "short read splitting $leaf" }
          $out.Write($buf, 0, $r)
          $left -= $r
        }
      } finally { $out.Dispose() }
      $parts += $p
    }
  } finally { $in.Dispose() }
  return , $parts
}
# Uploads one release asset, streaming the file (Invoke-RestMethod -InFile would hold a 2 GB part in memory).
function UploadAsset([string]$url, [string]$file, [string]$token) {
  $req = [Net.HttpWebRequest]::Create($url)
  $req.Method = 'POST'
  $req.ContentType = 'application/octet-stream'
  $req.Accept = 'application/vnd.github+json'
  $req.UserAgent = 'veetrax-backup'
  $req.Headers.Add('Authorization', "Bearer $token")
  $req.AllowWriteStreamBuffering = $false
  $req.ContentLength = (Get-Item $file).Length
  $req.Timeout = 3 * 3600 * 1000
  $req.ReadWriteTimeout = 3 * 3600 * 1000
  $in = [IO.File]::OpenRead($file)
  try {
    $out = $req.GetRequestStream()
    try { $in.CopyTo($out, 4MB) } finally { $out.Dispose() }
  } finally { $in.Dispose() }
  try { $resp = $req.GetResponse() } catch [Net.WebException] {
    $body = if ($_.Exception.Response) { (New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())).ReadToEnd() } else { '' }
    throw "upload of $(Split-Path $file -Leaf) failed: $($_.Exception.Message) $body"
  }
  try { return (New-Object IO.StreamReader($resp.GetResponseStream())).ReadToEnd() | ConvertFrom-Json } finally { $resp.Dispose() }
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
    # Not -q: psql prints "COPY <rows>" per table, the exact row counts for the manifest and the log.
    $out = @(& "$pgBin\psql.exe" -v ON_ERROR_STOP=1 -d $dbUrl -f "$work\copy.sql" 2>&1)
    if ($LASTEXITCODE -ne 0) { $out | ForEach-Object { Log "psql copy: $_" }; throw "psql copy failed (exit $LASTEXITCODE)" }
    $counts = @($out | ForEach-Object { if ("$_" -match '^COPY (\d+)$') { [int]$Matches[1] } })
    if ($counts.Count -ne $BIG_TABLES.Count) { throw "psql copy: expected $($BIG_TABLES.Count) COPY results, got: $($out -join ' | ')" }
    $rows = @{}
    for ($i = 0; $i -lt $BIG_TABLES.Count; $i++) { $rows[$BIG_TABLES[$i].name] = $counts[$i] }
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

  # GitHub release files must be under 2 GB: bigger backups go up as <name>.part001, .part002, ... (restore.ps1 joins them).
  $files = SplitFile $enc ([long]($PartMB * 1MB)) (Join-Path $work 'parts')
  $meta.parts = $files.Count

  # Upload as a release (body = JSON metadata, used for pruning and by restore.ps1).
  $relBody = @{ tag_name = $tag; name = "$tag ($kind)"; body = ($meta | ConvertTo-Json -Compress); draft = $false; prerelease = $false } | ConvertTo-Json
  $rel = Invoke-RestMethod -Method Post -Uri "$api/releases" -Headers $gh -ContentType 'application/json' -Body $relBody
  try {
    foreach ($f in $files) {
      $name = Split-Path $f -Leaf
      $asset = UploadAsset "https://uploads.github.com/repos/$($cfg.repo)/releases/$($rel.id)/assets?name=$name" $f $token
      if ($asset.size -ne (Get-Item $f).Length) { throw "upload size mismatch for ${name}: $($asset.size) <> $((Get-Item $f).Length)" }
    }
  } catch {
    # Leave no half-uploaded release behind (it would look like a backup).
    try { Invoke-RestMethod -Method Delete -Uri "$api/releases/$($rel.id)" -Headers $gh | Out-Null; Invoke-RestMethod -Method Delete -Uri "$api/git/refs/tags/$tag" -Headers $gh | Out-Null } catch { }
    throw
  }
  Log "uploaded $tag $([math]::Round($size / 1MB, 2)) MB$(if ($files.Count -gt 1) { " in $($files.Count) parts" })$(if ($kind -eq 'diff') { " (rows since $since`: $(($meta.rows.GetEnumerator() | ForEach-Object { "$($_.Key) $($_.Value)" }) -join ', '))" })"
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
  $prunedTags = @{}
  foreach ($r in $backups) {
    $t = TagTime $r.tag_name
    if ($t -ge $cutoff -or $keptBases[$r.tag_name] -or $r.tag_name -eq $state.lastFullTag -or $r.tag_name -eq $tag) { continue }
    Invoke-RestMethod -Method Delete -Uri "$api/releases/$($r.id)" -Headers $gh | Out-Null
    try { Invoke-RestMethod -Method Delete -Uri "$api/git/refs/tags/$($r.tag_name)" -Headers $gh | Out-Null } catch { }
    Log "pruned $($r.tag_name)"
    $prunedTags[$r.tag_name] = $true
    $pruned++
  }

  # README.md of the repo: the kept backups listed like folders (Full / Differential). A failure here only logs.
  try {
    $kept = @($backups | Where-Object { -not $prunedTags[$_.tag_name] } | Sort-Object { TagTime $_.tag_name } -Descending)
    function Row($r) {
      $meta = try { ConvertFrom-Json $r.body } catch { $null }
      $size = ($r.assets | Measure-Object size -Sum).Sum
      $rows = if ($meta.rows -and -not ($meta.rows.Position -eq 1 -and $meta.rows.RawPacket -eq 1)) { '{0:N0} positions, {1:N0} raw packets' -f $meta.rows.Position, $meta.rows.RawPacket } else { '-' }
      @{ when = (TagTime $r.tag_name).ToString('dd MMM yyyy HH:mm'); name = $r.tag_name; size = ('{0:N2} MB' -f ($size / 1MB)) + $(if (@($r.assets).Count -gt 1) { " ($(@($r.assets).Count) parts)" }); url = $r.html_url; base = $meta.base; rows = $rows }
    }
    $fulls = @($kept | Where-Object { $_.tag_name -like 'full-*' -or $_.tag_name -like 'backup-*' } | ForEach-Object { Row $_ })
    $diffs = @($kept | Where-Object { $_.tag_name -like 'diff-*' } | ForEach-Object { Row $_ })
    $md = @(
      '# VeeTrax database backups', '',
      "Updated automatically after every backup. Last update: $($started.ToString('dd MMM yyyy HH:mm')) (server time, IST). Kept: $keepDays days.", '',
      'Every file is encrypted with age; only the offline key (`C:\VeeTrax-Backup-Key`) can open it. Restore = a **Full** backup + the newest **Differential** based on it (`restore.ps1`).', '',
      "## Full backups ($($fulls.Count))", 'Weekly, Sunday 02:30: the whole database.', '',
      '| Date | Backup | Size |', '|---|---|---|'
    ) + ($fulls | ForEach-Object { "| $($_.when) | [$($_.name)]($($_.url)) | $($_.size) |" }) + @(
      '', "## Differential backups ($($diffs.Count))", 'Every 8 hours (02:30, 10:30, 18:30): all tables except the big location tables, plus the location rows received since its Full backup.', '',
      '| Date | Backup | Size | Location rows since the Full | Based on |', '|---|---|---|---|---|'
    ) + ($diffs | ForEach-Object { "| $($_.when) | [$($_.name)]($($_.url)) | $($_.size) | $($_.rows) | $($_.base) |" })
    $content = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($md -join "`n") + "`n"))
    $sha = try { (Invoke-RestMethod -Uri "$api/contents/README.md" -Headers $gh).sha } catch { $null }
    $put = @{ message = "Backup list after $tag"; content = $content }
    if ($sha) { $put.sha = $sha }
    Invoke-RestMethod -Method Put -Uri "$api/contents/README.md" -Headers $gh -ContentType 'application/json' -Body ($put | ConvertTo-Json) | Out-Null
  } catch { Log "README update failed: $($_.Exception.Message)" }

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
