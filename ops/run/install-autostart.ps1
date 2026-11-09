# One-time setup so VeeTrax keeps running unattended. Run in an ADMINISTRATOR PowerShell:
#   powershell -ExecutionPolicy Bypass -File D:\Vibhav\gps-app\ops\run\install-autostart.ps1
# - Scheduled task "VeeTrax watchdog": runs watchdog.ps1 at logon and every 5 minutes (hidden window).
# - Disables sleep / hibernate so the PC never stops serving.
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'watchdog.ps1'
$user = "$env:USERDOMAIN\$env:USERNAME"

$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$script`""
$atLogon = New-ScheduledTaskTrigger -AtLogOn -User $user
$every5 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'VeeTrax watchdog' -Action $action -Trigger $atLogon, $every5 -Settings $settings `
  -Principal $principal -Description 'Keeps VeeTrax (PM2 + Cloudflare tunnel) running' -Force | Out-Null
Write-Host 'Scheduled task "VeeTrax watchdog" registered.'

powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /change standby-timeout-dc 0
powercfg /hibernate off
Write-Host 'Sleep and hibernate disabled.'
