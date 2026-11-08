# Updates the VeeTrax website, API and notifier on 166.0.242.121 to the attendance branch.
# Gateway and processor keep running, so devices stay connected and positions keep being saved.
# Run: powershell -ExecutionPolicy Bypass -File "C:\Users\sasva\OneDrive\Desktop\veetracer\update-web-api.ps1"
# For code changes with no new packages or database changes. Asks for the Administrator password.
$pw = Read-Host -AsSecureString "166.0.242.121 Administrator password"
$cred = New-Object System.Management.Automation.PSCredential ('Administrator', $pw)
$s = New-PSSession -ComputerName 166.0.242.121 -Credential $cred
Copy-Item -ToSession $s -Path (Join-Path $PSScriptRoot 'gps-app-attendance.bundle') -Destination C:\apps\veetracer\gps-app-attendance.bundle -Force
Invoke-Command -Session $s -ScriptBlock {
  Set-Location C:\apps\veetracer\app
  $before = (git rev-parse --short HEAD).Trim()
  cmd /c "git fetch -q ..\gps-app-attendance.bundle feature/attendance-shifts 2>&1"
  $t = (git rev-parse FETCH_HEAD).Trim()
  cmd /c "git merge --ff-only -q $t 2>&1"
  if ($LASTEXITCODE -ne 0) { 'STOP: could not update the code; nothing restarted'; return }
  "code: $before -> $(git rev-parse --short HEAD)"
  cmd /c "npm run build:shared >> C:\apps\veetracer\logs\deploy.log 2>&1"
  if ($LASTEXITCODE -ne 0) { 'STOP: shared build failed; nothing restarted'; return }
  cmd /c "npm run build -w @veetracer/web >> C:\apps\veetracer\logs\deploy.log 2>&1"
  if ($LASTEXITCODE -ne 0) { 'STOP: web build failed; nothing restarted'; return }
  "website built: $((Get-Item apps\web\dist\index.html).LastWriteTime)"
  # Compiled in place, not with nest build: that empties dist first, under the gateway and processor that keep running.
  Push-Location apps\api
  cmd /c "npx tsc -p tsconfig.build.json >> C:\apps\veetracer\logs\deploy.log 2>&1"
  $rc = $LASTEXITCODE
  Pop-Location
  if ($rc -ne 0) { 'STOP: API build failed; nothing restarted'; return }
  foreach ($n in 'veetracer-api', 'veetracer-notifier') {
    Stop-Service $n -NoWait -ErrorAction SilentlyContinue
    for ($i = 0; $i -lt 20 -and (Get-Service $n).Status -ne 'Stopped'; $i++) { Start-Sleep 1 }
    if ((Get-Service $n).Status -ne 'Stopped') {
      $svc = Get-CimInstance Win32_Service -Filter "Name='$n'"
      Get-CimInstance Win32_Process -Filter "ParentProcessId=$($svc.ProcessId)" | Where-Object Name -eq 'node.exe' | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
      if ($svc.ProcessId -gt 0) { Stop-Process -Id $svc.ProcessId -Force -ErrorAction SilentlyContinue }
      Start-Sleep 2
    }
    Start-Service $n
  }
  $up = $false
  for ($i = 0; $i -lt 40 -and -not $up; $i++) {
    Start-Sleep 4
    try { Invoke-WebRequest http://localhost:4100/api/health -UseBasicParsing -TimeoutSec 5 | Out-Null; $up = $true } catch {}
  }
  "api health: $(if ($up) { 'OK' } else { 'not responding (check C:\apps\veetracer\logs)' })"
  Get-Service veetracer-* | ForEach-Object { "$($_.Name): $($_.Status)" }
}
Remove-PSSession $s
