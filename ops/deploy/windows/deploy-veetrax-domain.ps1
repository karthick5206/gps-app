# Adds veetrax.com domains to 166.0.242.121. Run: powershell -ExecutionPolicy Bypass -File deploy-veetrax-domain.ps1
#   app.veetrax.com           -> same site as gps.mintplus.co.in (web + /api + /socket.io)
#   veetrax.com, www          -> redirect to app.veetrax.com (anonymous users land on /login)
#   track.veetrax.com         -> nothing to do here: raw TCP 5023/5027 already listens on the IP
# gps.mintplus.co.in / track.mintplus.co.in keep working. Only Caddy reload + veetracer-api restart.
$pw = Read-Host -AsSecureString "166.0.242.121 Administrator password"
$cred = New-Object System.Management.Automation.PSCredential ('Administrator', $pw)
$s = New-PSSession -ComputerName 166.0.242.121 -Credential $cred
Invoke-Command -Session $s -ScriptBlock {
  $ErrorActionPreference = 'Stop'
  $dir = 'C:\apps\caddy'
  $cf = Join-Path $dir 'Caddyfile'
  # caddy.exe location: from the MintPlusCaddy service (direct, or wrapped by NSSM), else PATH / common dirs
  $caddy = $null
  $svc = Get-CimInstance Win32_Service | Where-Object { $_.Name -like '*caddy*' -or $_.PathName -like '*caddy*' } | Select-Object -First 1
  if ($svc) {
    $exe = if ($svc.PathName -match '^\s*"([^"]+)"') { $Matches[1] } else { ($svc.PathName -split '\s+')[0] }
    if ($exe -like '*caddy*.exe') { $caddy = $exe }
    elseif ($exe -like '*nssm*.exe') { $caddy = ((& $exe get $svc.Name Application) -join '' -replace "`0", '').Trim() }
    "Caddy service: $($svc.Name) ($($svc.PathName))"
  }
  if (-not $caddy -or -not (Test-Path $caddy)) {
    $c = Get-Command caddy.exe -ErrorAction SilentlyContinue
    if ($c) { $caddy = $c.Source }
  }
  if (-not $caddy -or -not (Test-Path $caddy)) {
    $caddy = Get-ChildItem 'C:\apps', 'C:\ProgramData\chocolatey', 'C:\Program Files', 'C:\tools' -Filter caddy*.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
  }
  if (-not $caddy -or -not (Test-Path $caddy)) { throw 'caddy.exe not found; nothing changed' }
  "caddy.exe: $caddy"

  # --- Caddyfile ---
  $orig = [IO.File]::ReadAllText($cf)
  $text = $orig
  if ($text -notmatch 'app\.veetrax\.com') {
    $rx = [regex]'(?m)^(\s*(?:https://)?gps\.mintplus\.co\.in)(\s*(?:,[^{\r\n]*)?)\{'
    if (-not $rx.IsMatch($text)) { throw 'gps.mintplus.co.in site block not found; Caddyfile left unchanged' }
    $text = $rx.Replace($text, '$1, app.veetrax.com$2{', 1)
  }
  if ($text -notmatch '(?m)^\s*veetrax\.com') {
    $text = $text.TrimEnd() + "`r`n`r`nveetrax.com, www.veetrax.com {`r`n`tredir https://app.veetrax.com{uri} permanent`r`n}`r`n"
  }
  if ($text -eq $orig) { 'Caddyfile: already has veetrax entries' } else {
    Copy-Item $cf "$cf.bak-before-veetrax-$(Get-Date -Format yyyyMMddHHmm)"
    [IO.File]::WriteAllText($cf, $text, (New-Object Text.UTF8Encoding $false))
    'Caddyfile: veetrax entries written'
  }
  # pre-veetrax backup to roll back to (this run's, or one left by an earlier run)
  $bak = Get-ChildItem $dir -Filter 'Caddyfile.bak-before-veetrax-*' | Where-Object Name -notlike '*veetracer*' |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
  # caddy logs to stderr: don't let PowerShell treat that as an error, judge by exit code
  $ErrorActionPreference = 'Continue'
  $out = & $caddy validate --config $cf --adapter caddyfile 2>&1 | ForEach-Object { "$_" }
  if ($LASTEXITCODE -ne 0) {
    if ($bak) { Copy-Item $bak $cf -Force }
    $out | Select-Object -Last 10
    throw "caddy validate FAILED; Caddyfile restored from $bak, nothing reloaded"
  }
  'caddy validate: OK'
  $out = & $caddy reload --config $cf --adapter caddyfile 2>&1 | ForEach-Object { "$_" }
  if ($LASTEXITCODE -ne 0) {
    if ($bak) { Copy-Item $bak $cf -Force }
    $out | Select-Object -Last 10
    throw "caddy reload FAILED; Caddyfile restored from $bak (running config unchanged)"
  }
  "caddy reload: OK (rollback copy: $bak)"
  $ErrorActionPreference = 'Stop'

  # --- API .env ---
  $envFile = 'C:\apps\veetracer\app\apps\api\.env'
  $lines = [System.Collections.Generic.List[string]](Get-Content $envFile)
  function Get-Env([string]$k) { foreach ($l in $lines) { if ($l -match "^$k=(.*)$") { return $Matches[1].Trim('"') } }; '' }
  function Set-Env([string]$k, [string]$v) {
    $i = -1; for ($j = 0; $j -lt $lines.Count; $j++) { if ($lines[$j] -match "^$k=") { $i = $j } }
    if ($i -ge 0) { $lines[$i] = "$k=$v" } else { $lines.Add("$k=$v") }
  }
  $origins = @((Get-Env 'CORS_ORIGINS') -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  foreach ($o in 'https://gps.mintplus.co.in', 'https://app.veetrax.com') { if ($origins -notcontains $o) { $origins += $o } }
  $oldWeb = Get-Env 'WEB_URL'
  Set-Env 'CORS_ORIGINS' ($origins -join ',')
  Set-Env 'WEB_URL' 'https://app.veetrax.com'
  Copy-Item $envFile "$envFile.bak-$(Get-Date -Format yyyyMMddHHmm)"
  Set-Content -Path $envFile -Value $lines -Encoding ASCII
  "WEB_URL: $oldWeb -> https://app.veetrax.com"
  "CORS_ORIGINS: $($origins -join ',')"

  # --- restart only veetracer-api (NSSM; first start can take ~90 s) ---
  $n = 'veetracer-api'
  Stop-Service $n -NoWait -ErrorAction SilentlyContinue
  for ($i = 0; $i -lt 20 -and (Get-Service $n).Status -ne 'Stopped'; $i++) { Start-Sleep 1 }
  if ((Get-Service $n).Status -ne 'Stopped') {
    $svc = Get-CimInstance Win32_Service -Filter "Name='$n'"
    Get-CimInstance Win32_Process -Filter "ParentProcessId=$($svc.ProcessId)" | Where-Object Name -eq 'node.exe' | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
    if ($svc.ProcessId -gt 0) { Stop-Process -Id $svc.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep 2
  }
  Start-Service $n
  "$n -> $((Get-Service $n).Status)"
  $ok = $false
  for ($i = 0; $i -lt 30 -and -not $ok; $i++) {
    Start-Sleep 5
    try { Invoke-WebRequest http://localhost:4100/api/health -UseBasicParsing -TimeoutSec 5 | Out-Null; $ok = $true } catch {}
  }
  "api health: $(if ($ok) { 'OK' } else { 'not responding yet (check C:\apps\veetracer\logs)' })"
}
Remove-PSSession $s
