# Deploys gps-app feature/i18n to 166.0.242.121. Run: powershell -ExecutionPolicy Bypass -File deploy-veetracer.ps1
$cred = Get-Credential -UserName Administrator -Message "166.0.242.121 Administrator password"
$s = New-PSSession -ComputerName 166.0.242.121 -Credential $cred
Copy-Item -ToSession $s -Path (Join-Path $PSScriptRoot 'gps-app.bundle') -Destination C:\apps\veetracer\gps-app.bundle -Force
Invoke-Command -Session $s -ScriptBlock {
  $ErrorActionPreference = 'Continue'
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
  foreach ($n in 'veetracer-api','veetracer-gateway','veetracer-processor','veetracer-notifier','veetracer-summarizer') { if (Get-Service $n -ErrorAction SilentlyContinue) { Stop-Vt $n } }

  Set-Location C:\apps\veetracer\app
  $before = git rev-parse --short HEAD
  cmd /c "git fetch -q ..\gps-app.bundle feature/i18n 2>&1"
  cmd /c "git merge --ff-only -q FETCH_HEAD 2>&1"
  "code: $before -> $(git rev-parse --short HEAD) ($(git log -1 --format=%s))"

  # .env: geocoder, Zoho mail, JT808 (secrets read from secrets.json on the server, never printed)
  $envFile = 'C:\apps\veetracer\app\apps\api\.env'
  $sj = Get-Content C:\apps\veetracer\secrets\secrets.json -Raw | ConvertFrom-Json
  $lines = [System.Collections.Generic.List[string]](Get-Content $envFile)
  function Set-Env([string]$k, [string]$v) {
    $i = -1; for ($j = 0; $j -lt $lines.Count; $j++) { if ($lines[$j] -match "^$k=") { $i = $j } }
    if ($i -ge 0) { $lines[$i] = "$k=$v" } else { $lines.Add("$k=$v") }
  }
  Set-Env 'GEOCODER' 'photon'
  Set-Env 'GEOCODER_URL' 'http://166.0.244.179:2322'
  Set-Env 'JT808_PORT' '6808'
  if ($sj.zohoMailKey) {
    Set-Env 'ZOHO_MAIL_KEY' ([string]$sj.zohoMailKey).Trim()
    Set-Env 'ZOHO_MAIL_URL' $(if ($sj.zohoMailUrl) { [string]$sj.zohoMailUrl } else { 'https://cpaas.zoho.in' })
    Set-Env 'MAIL_FROM' '"VeeTracer <noreply@veetracer.com>"'
    Set-Env 'MAIL_REPLY_TO' 'info@vaidhika.in'
  } else { 'WARNING: zohoMailKey missing in secrets.json' }
  Copy-Item $envFile "$envFile.bak-$(Get-Date -Format yyyyMMddHHmm)"
  Set-Content -Path $envFile -Value $lines -Encoding ASCII
  ".env keys: " + (($lines | ForEach-Object { ($_ -split '=')[0] } | Where-Object { $_ -match '^(GEOCODER|GEOCODER_URL|JT808_PORT|ZOHO_MAIL_KEY|ZOHO_MAIL_URL|MAIL_FROM|MAIL_REPLY_TO)$' }) -join ', ')

  if (-not (Get-NetFirewallRule -DisplayName 'VeeTracer JT808 devices (TCP 6808)' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName 'VeeTracer JT808 devices (TCP 6808)' -Direction Inbound -Protocol TCP -LocalPort 6808 -Action Allow | Out-Null; 'firewall 6808 added'
  }

  $log = 'C:\apps\veetracer\logs\deploy.log'
  "=== deploy $(Get-Date -Format s)" | Set-Content $log
  $steps = @(
    @('npm ci', 'npm ci --no-audit --no-fund'),
    @('shared', 'npm run build:shared'),
    @('web', 'npm run build -w @veetracer/web'),
    @('prisma generate', 'cd apps\api && npx prisma generate'),
    @('api', 'cd apps\api && npm run build'),
    @('migrate', 'cd apps\api && npx prisma migrate deploy'),
    @('seed', 'cd apps\api && npm run db:seed')
  )
  $ok = $true
  foreach ($st in $steps) {
    cmd /c "$($st[1]) >> $log 2>&1"
    "$($st[0]): exit $LASTEXITCODE"
    if ($LASTEXITCODE -ne 0) { Get-Content $log -Tail 20; $ok = $false; break }
  }
  foreach ($n in 'veetracer-api','veetracer-gateway','veetracer-processor','veetracer-notifier','veetracer-summarizer') { if (Get-Service $n -ErrorAction SilentlyContinue) { Start-Service $n -ErrorAction SilentlyContinue; "$n -> $((Get-Service $n).Status)" } }
  if (-not $ok) { 'BUILD FAILED (services restarted on previous build output where possible)' }
}
Remove-PSSession $s