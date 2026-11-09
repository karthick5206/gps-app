# Runbook: cut-over from Memurai to Valkey

**Decision.** The owner decided on 2026-11-09 that Valkey replaces Memurai. Hosting is a new Mintplus Linux VM in the same data centre as 166.0.242.121; the quote and order are pending with the owner.

**Order.**
1. Release 1.6 (the reliability release, commit `f0b35b8`) is deployed on the existing Memurai first. That deploy is in progress, owner-approved.
2. This cut-over follows, once the VM exists.

Do **not** run anything here until the owner approves the cut-over window.

- **Primary: variant A**, same data centre, private network, no TLS.
- **Option: variant B**, TLS. Use it if the private network is not proven isolated (see the [ops/valkey README](../../ops/valkey/README.md)), or if the VM ends up at another provider.

The two variants differ only in the VM install command, `REDIS_URL`, and the CA file. They are marked **[A]** and **[B]** below.

## 0. Estimated downtime

| What | Variant A | Variant B |
|---|---|---|
| Device ingestion | Each device reconnects once, a few seconds after the gateway restart. No stored-position loss: the gateway spools whenever the cache is unreachable. | same |
| Live map / web UI / mobile API | about 5–10 min (api stopped from step C2 to C9) | about 5–10 min |
| Alert notifications (e-mail / SMS / push) | about 2–5 min (from C6, notifier stopped, to C9). Nothing queued is lost. | same |
| HTTP_JSON data forwarding (customers with a relay target) | positions received between C4 and C9 are not forwarded. The relay group starts at `$` by design, as after any notifier restart. RAW_TCP forwarding runs in the gateway and continues. | same |
| Total window to book | 30 min, quiet hour (for example 02:00–02:30 IST) | 30 min |

Round trip measured in the kit test (`cache-check-cli`, median of 50 PINGs): 0.40 ms over TLS through a local container. On a same-DC private VLAN, expect well under 1 ms with or without TLS.

## A. Pre-flight (a day before; read-only; nothing changes)

On the **Windows server** (PowerShell as Administrator, `cd C:\apps\veetracer\app\apps\api`):

| # | Check | Command | Expected |
|---|---|---|---|
| A1 | Release 1.6 is live | `git -C C:\apps\veetracer\app log -1 --oneline`; `curl.exe -s http://localhost:4100/api/health/tracking` | `f0b35b8` or later; `"status":"OK"` |
| A2 | Memurai version and persistence (for the record and the rollback) | `memurai-cli INFO server \| findstr /i "version"`; `memurai-cli CONFIG GET appendonly` | note the values. 4.x is end of life on 30 Nov 2026. |
| A3 | Gateway health port free and answering | `netstat -ano \| findstr :4121`; `curl.exe -s http://127.0.0.1:4121/health` | only the gateway listens; `"status":"ok"` |
| A4 | Disk for the spool (cap 1 GB) | `Get-PSDrive C` | ≥ 5 GB free |
| A5 | Alert recipients set | `Select-String -Path .env -Pattern '^SYSTEM_ALERT_EMAILS='` | at least one address |
| A6 | Watchdog task present | `Get-ScheduledTask 'VeeTrax watchdog'` | Ready |
| A7 | Backlogs empty (normal operation) | `memurai-cli XINFO GROUPS vt:positions`; `memurai-cli XINFO GROUPS vt:notify` | `lag` around 0, `pending` small |

On the **Valkey VM** (once Mintplus hands it over):

| # | Check | Command | Expected |
|---|---|---|---|
| A8 | OS, size, disk | `lsb_release -d; nproc; free -h; df -h /` | Ubuntu 24.04, 2 vCPU, 2 GB, ≥ 20 GB free |
| A9 | **[A]** private network isolation | the steps in the [ops/valkey README](../../ops/valkey/README.md) §Variant A item 2: ask Mintplus in writing, check the routes, one hop, arp neighbours, nothing reachable from outside | dedicated VLAN, one hop, no unknown neighbours. **Otherwise use [B].** |
| A10 | Install the kit | **[A]** `sudo MODE=private BIND_ADDR=<vm-private-ip> APP_ALLOW_FROM=<windows-private-ip> ADMIN_SSH_FROM=<admin-ip> ./install-valkey.sh` <br> **[B]** `sudo MODE=tls BIND_ADDR=<vm-ip> APP_ALLOW_FROM=166.0.242.121 ADMIN_SSH_FROM=<admin-ip> TLS_SANS="IP:<vm-ip>,DNS:valkey.veetrax.internal" ./install-valkey.sh` | ends with `ping: PONG`, `aof: yes`, `policy: noeviction`, users `admin default health veetrax` |
| A11 | Take the app password off the VM (by hand; never into git or chat) | `sudo cat /etc/valkey/secrets/app.pass`; **[B]** also copy `/etc/valkey/tls/ca.crt` to `C:\apps\veetracer\valkey-ca.crt` | — |
| A12 | Health endpoint | `curl -s http://<vm-ip>:9121/health` (from the Windows server) | `"status": "ok"` |

From the **Windows server**, check the new cache with the app's own connection code. This does not touch `.env`:
```powershell
cd C:\apps\veetracer\app\apps\api
# [A]
node dist\redis\cache-check-cli.js --url "redis://veetrax:<password>@<vm-private-ip>:6379"
# [B]
$env:REDIS_TLS_CA_FILE='C:\apps\veetracer\valkey-ca.crt'; $env:REDIS_TLS_SERVERNAME='valkey.veetrax.internal'
node dist\redis\cache-check-cli.js --url "rediss://veetrax:<password>@<vm-ip>:6380"
```
Every line must read `ok`: PING, server 9.1.x, ACL user `veetrax`, round trip, `aof_enabled=1`, streams, Lua/MULTI/SET GET/LPOP, Pub/Sub. If any check fails, stop and fix it first.

## C. Cut-over (in the booked window)

Each process keeps its existing cache connection until it is restarted. Every stream is drained on Memurai before its consumer moves. This is why nothing is lost.

| # | Action (Windows, PowerShell as Administrator) | Verify |
|---|---|---|
| C1 | `New-Item C:\apps\veetracer\maintenance.flag -Force` (silences the watchdog). Back up `.env`: `Copy-Item C:\apps\veetracer\app\apps\api\.env C:\apps\veetracer\env-before-valkey.bak` | — |
| C2 | `Stop-Service veetracer-api, veetracer-summarizer` | the UI is down from here (announced). The gateway, processor and notifier keep running on Memurai. |
| C3 | Edit `C:\apps\veetracer\app\apps\api\.env`: <br> **[A]** `REDIS_URL=redis://veetrax:<password>@<vm-private-ip>:6379` <br> **[B]** `REDIS_URL=rediss://veetrax:<password>@<vm-ip>:6380`, plus `REDIS_TLS_CA_FILE=C:\apps\veetracer\valkey-ca.crt` and `REDIS_TLS_SERVERNAME=valkey.veetrax.internal` | `node dist\redis\cache-check-cli.js` (no `--url`: reads the new `.env`) shows all ok |
| C4 | `Restart-Service veetracer-gateway` | `curl.exe -s http://127.0.0.1:4121/health` returns `"status":"ok"` with spool `pendingEntries` 0 after about 30 s. If it shows `degraded` / spooling, Valkey is unreachable: fix it. Positions are safe in the spool. |
| C5 | Wait until the processor, still on Memurai, has drained the old stream: `memurai-cli XINFO GROUPS vt:positions`, repeated | `lag` 0 and `pending` 0 for the `processor` group (seconds). |
| C6 | `Stop-Service veetracer-processor`. Then wait for the notifier on Memurai: `memurai-cli XINFO GROUPS vt:notify` and `memurai-cli XINFO GROUPS vt:webhooks`. Then `Stop-Service veetracer-notifier` | `lag` 0 and `pending` 0 in both before stopping the notifier |
| C7 | Copy the state keys (live map, filter / alert / fuel / IO state, offline command queues, forwarding rules). Existing keys on Valkey are never overwritten. <br> `npx tsx scripts\cache-copy.ts --from redis://127.0.0.1:6379 --to "<new REDIS_URL>" --dry-run`, then the same without `--dry-run` | prints `copied N key(s)`. Optional: skipping it is safe, and vehicles reappear on the next fix. |
| C8 | `Start-Service veetracer-processor` | `/api/health/tracking` cannot be read yet (api stopped). Check the processor log `C:\apps\veetracer\logs\processor*.log` for "Created consumer group processor" and batches. |
| C9 | `Start-Service veetracer-notifier, veetracer-api, veetracer-summarizer` | see V1–V7 |
| C10 | `install-reliability.ps1 -CacheService none -ValkeyHealthUrl http://<vm-ip>:9121/health` (re-registers the watchdog with the Valkey check). Then `Remove-Item C:\apps\veetracer\maintenance.flag` | `Get-ScheduledTask 'VeeTrax watchdog'` |
| C11 | Memurai: `Stop-Service Memurai; Set-Service Memurai -StartupType Disabled`. **Keep it installed for 14 days** (rollback). | — |

### Verification (V1–V7, right after C9)

1. `curl.exe -s http://localhost:4100/api/health` returns HTTP 200 with `"ok":true`; database and cache ok.
2. `curl.exe -s http://localhost:4100/api/health/tracking` reports `"status":"OK"`, `lastPersistedAgeSec` under 60 and `stream.lag` 0. It may show WARN or CRITICAL for 1–2 min while devices reconnect.
3. `curl.exe -s http://127.0.0.1:4121/health` reports `"status":"ok"` with `spool.pendingEntries` 0.
4. On the System Health page (Super Admin), Valkey shows version 9.1.x, `aofEnabled: true`, memory a few %, and all processes OK.
5. The live map moves; one vehicle's History shows no gap over the window.
6. Send a **non-critical** command to a test device (for example a position request): status SENT then ACKED. **Never test with engine stop.**
7. `curl.exe -s http://<vm-ip>:9121/health` reports `"status":"ok"`; the watchdog log has nothing new.

## R. Rollback (any time, including days later)

The same mechanics in reverse. Positions are safe because each stream drains before its consumer moves.

1. `New-Item C:\apps\veetracer\maintenance.flag -Force`
2. `Set-Service Memurai -StartupType Automatic; Start-Service Memurai`
3. `Stop-Service veetracer-api, veetracer-summarizer`
4. Restore the old `.env`: `Copy-Item C:\apps\veetracer\env-before-valkey.bak C:\apps\veetracer\app\apps\api\.env -Force`. For [B], the `REDIS_TLS_*` lines go away with it.
5. `Restart-Service veetracer-gateway`, then check the gateway `/health` reports `ok`.
6. On the VM, wait until Valkey's `vt:positions` is drained: `valkey-cli --user admin --pass "$(sudo cat /etc/valkey/secrets/admin.pass)" XINFO GROUPS vt:positions` shows `lag` 0 and `pending` 0. Add `--tls --cacert /etc/valkey/tls/ca.crt -p 6380` for [B].
7. `Stop-Service veetracer-processor`. Wait for Valkey's `vt:notify` and `vt:webhooks` to drain, then `Stop-Service veetracer-notifier`.
8. Optional: `npx tsx scripts\cache-copy.ts --from "<valkey url>" --to redis://127.0.0.1:6379`
9. `Start-Service veetracer-processor, veetracer-notifier, veetracer-api, veetracer-summarizer`
10. Re-register the watchdog: `install-reliability.ps1 -CacheService Memurai`. Remove the maintenance flag.

Memurai Developer Edition will stop itself again within 10 days and is not licensed for production. A rollback is a stop-gap only, with the alerts in place.

## Afterwards (within a week)

- Confirm the nightly backup ran on the VM: `ls /var/backups/valkey`, and `lastBackupAgeHours` under 24 in `/health`.
- Optional, after owner approval: off-site copy of the newest `dump-*.rdb` (see the [ops/valkey README](../../ops/valkey/README.md) §Backups).
- After 14 days without a rollback: uninstall Memurai and record it in DECISION_LOG.
