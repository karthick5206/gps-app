# Keeps VeeTrax running. Run by the "VeeTrax watchdog" scheduled task at logon and every 5 minutes.
# - PM2 has no processes (after boot / crash)   -> restore the saved list (pm2 resurrect)
# - a process is "errored" (PM2 gave up on it)  -> restart it
# A process you stopped on purpose (`pm2 stop <name>`, status "stopped") is left alone.
# PM2 itself restarts crashed processes; cloudflared reconnects by itself after an internet outage.
$ErrorActionPreference = 'Continue'
$env:Path = "C:\Program Files\nodejs;$env:APPDATA\npm;$env:Path"
$root = Resolve-Path "$PSScriptRoot\..\.."
$log = Join-Path $root 'apps\api\var\logs\watchdog.log'

function Log($msg) {
  New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null
  Add-Content -Path $log -Value "$(Get-Date -Format s) $msg"
}

# "name status" per PM2 process (parsed in node: PowerShell 5.1 chokes on pm2's JSON).
function Get-Pm2State {
  pm2 jlist 2>$null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{for(const p of JSON.parse(s.replace(/^﻿/,'')))console.log(p.name+' '+p.pm2_env.status)}catch{}})"
}

$state = @(Get-Pm2State)
if ($state.Count -eq 0) {
  Log 'no PM2 processes, resurrecting saved list'
  pm2 resurrect 2>&1 | Out-Null
  Start-Sleep 10
  $state = @(Get-Pm2State)
}
foreach ($line in $state) {
  $name, $status = $line -split ' '
  if ($status -eq 'errored') {
    Log "$name errored, restarting"
    pm2 restart $name 2>&1 | Out-Null
  }
}
