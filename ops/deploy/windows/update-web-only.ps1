# Updates only the VeeTrax website on 166.0.242.121 to the attendance branch. No service restarts; tracking keeps running.
# Run: powershell -ExecutionPolicy Bypass -File "C:\Users\sasva\OneDrive\Desktop\veetracer\update-web-only.ps1"
# For web screen changes with no new packages or database changes. Asks for the Administrator password.
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
  if ($LASTEXITCODE -ne 0) { 'STOP: could not update the code; website unchanged'; return }
  "code: $before -> $(git rev-parse --short HEAD)"
  cmd /c "npm run build:shared >> C:\apps\veetracer\logs\deploy.log 2>&1"
  if ($LASTEXITCODE -ne 0) { 'STOP: shared build failed; website unchanged'; return }
  cmd /c "npm run build -w @veetracer/web >> C:\apps\veetracer\logs\deploy.log 2>&1"
  if ($LASTEXITCODE -ne 0) { 'STOP: web build failed (see C:\apps\veetracer\logs\deploy.log)'; return }
  "website built: $((Get-Item apps\web\dist\index.html).LastWriteTime)"
  Get-Service veetracer-* | ForEach-Object { "$($_.Name): $($_.Status)" }
}
Remove-PSSession $s
