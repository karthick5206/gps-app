# Production rollout: release 1.6 and the Memurai → Valkey cut-over

Target: `server-mintplus-windows` (Windows Server 2016, NSSM services `veetracer-*`, app at `C:\apps\veetracer\app`), currently on release 1.5 (`b73547c`, tag `v1.5.0`) with Memurai Developer Edition.

**Nothing in this document has been run on production.** Each step needs the owner's go-ahead. Nothing has been bought or provisioned, and no production setting has been changed.

## 1. Pre-flight (read-only checks on the server)

1. Memurai version and persistence: `memurai-cli INFO server` and `memurai-cli CONFIG GET appendonly` / `save`.
   - 4.x is end of life on 30 Nov 2026.
   - `appendonly no` means unprocessed positions are lost on a Memurai restart. The 1.6 spool covers the outage itself, not data lost inside Memurai.
2. Free disk on `C:` for the spool. Its cap is 1 GB by default; `GATEWAY_SPOOL_MAX_MB` changes it.
3. Port `4121` is free on 127.0.0.1 (`netstat -ano | findstr :4121`). Otherwise set `GATEWAY_HEALTH_PORT` in `.env`.
4. `SYSTEM_ALERT_EMAILS` is set in `C:\apps\veetracer\app\apps\api\.env`, so the watchdog has a recipient even while PostgreSQL is down. Optionally add `SYSTEM_ALERT_SMS` and `SYSTEM_ALERT_SMS_DLT_TEMPLATE_ID`, which needs a DLT-registered template.
5. The current queue state, for the record: `memurai-cli XINFO GROUPS vt:positions`.

## 2. Deploy release 1.6 (on the existing Memurai)

There is no database migration and no `.env` change is required; all new settings have defaults.

1. Merge `feature/production-cache-reliability` into the release branch after review. Build the bundle as usual (`git bundle create gps-app.bundle <branch>`).
2. Run `powershell -ExecutionPolicy Bypass -File ops\deploy\windows\deploy-release.ps1 -Branch <branch>`.
   - Services stop, then the build, `prisma migrate deploy` (nothing new) and the seed run as before.
   - The script now writes `C:\apps\veetracer\maintenance.flag` during the deploy and removes it afterwards.
   - **Gate:** `GET /api/health` must return 200. That now means the API, PostgreSQL **and** Memurai are usable. If Memurai is stopped at that moment the gate reports `HTTP 503 (database or cache not ready)`. Start Memurai, or finish the cut-over in §4, then re-check.
   - The script also prints `/api/health/tracking`. It is often `CRITICAL`/`WARN` for a minute or two while devices reconnect.
3. On the server, run `powershell -ExecutionPolicy Bypass -File ops\deploy\windows\install-reliability.ps1 -DryRun`, review the output, then run it without `-DryRun`.
   - This sets the NSSM restart, throttle and stop policy and the SCM failure actions.
   - It registers the "VeeTrax watchdog" task, which runs every minute.
   - The Memurai service is left without automatic restarts.
4. Verify:
   - `curl http://localhost:4100/api/health/live` returns 200.
   - `/api/health` returns 200.
   - `/api/health/tracking` reports `OK`.
   - `curl http://127.0.0.1:4121/health` reports `"status":"ok"`.
   - System Health shows the gateway spool in `direct` mode.
   - `C:\apps\veetracer\logs\watchdog.log` gains a line per minute only when there is something to report.
5. Optional fire drill in a quiet hour: stop the Memurai service for one minute.
   - Expect `/api/health` 503, the gateway `degraded` with spool entries growing, alert e-mails (System Health plus the watchdog "Cache service … Stopped"), and no device disconnects.
   - Start Memurai again. Expect the spool to drain within seconds, "resolved" e-mails, and on the History page no gap for that minute.

### Rolling back release 1.6

1. Check the spool is empty: `curl http://127.0.0.1:4121/health`, then look at `spool.pendingEntries`, which must be 0. Release 1.5 does not read the spool, so anything still in it would not be replayed until 1.6 is back.
2. Run `deploy-release.ps1 -Rollback`. It checks out the saved commit and rebuilds; there is no database change to undo.
3. Optionally remove the watchdog task (`Unregister-ScheduledTask 'VeeTrax watchdog'`). The NSSM settings can stay; they are generic.
4. After the rollback:
   - `/api/health` returns `{ok:true}` unconditionally again.
   - Stream entries written by 1.6 carry an extra `mid` field, which 1.5 ignores.

## 3. Prepare the Valkey VM (no production impact)

1. Provision a Linux VM with 2 GB RAM and 1–2 vCPU, ideally at Mintplus in the same data centre with a private network (see [cache-assessment.md §5–§7](cache-assessment.md)). Install Valkey 9.1.x.
2. Settings in `/etc/valkey/valkey.conf`:
   ```
   bind <private-ip> 127.0.0.1
   protected-mode yes
   requirepass <long random secret>      # or an ACL user for the app
   appendonly yes
   appendfsync everysec
   maxmemory 1gb
   maxmemory-policy noeviction
   # public network only: tls-port 6380, port 0, tls-cert-file/tls-key-file/tls-ca-cert-file
   ```
   Allow the port in the firewall from the Windows server's IP only. Run it under systemd with `Restart=on-failure`; this is legitimate for a licensed or free cache.
3. From the Windows server, measure latency (`valkey-cli -h <ip> -a … --latency`).
4. Optionally, point a staging copy of the app at it and run `scripts/chaos/chaos-run.ts` there (see [test-evidence.md](test-evidence.md)).
5. Back it up by copying the AOF directory off-box nightly, or rely on the app tolerating an empty restart (§2.7 of the assessment).

## 4. Cut-over with minimal downtime and no position loss

Pick a quiet hour; allow 15 minutes. The trick is to change `REDIS_URL` in the shared `.env` but **restart one service at a time**. Each process keeps its old connection until it is restarted. Stream entries are drained on the old cache before the processor moves.

1. Create `C:\apps\veetracer\maintenance.flag`, so the watchdog stays quiet.
2. Stop `veetracer-api` and `veetracer-summarizer`. Neither holds positions.
   - The customer UI pauses from this point (about 5–10 minutes).
   - Device tracking continues.
   - The notifier keeps running on Memurai, so the alerts the processor still queues there get delivered.
3. Edit `C:\apps\veetracer\app\apps\api\.env` to set `REDIS_URL=redis://:<secret>@<valkey-ip>:6379`, or `rediss://…:6380` with TLS.
4. Restart **only** `veetracer-gateway` with `Restart-Service veetracer-gateway`.
   - NSSM sends Ctrl+C, and the gateway flushes cleanly.
   - Devices reconnect within seconds. The few frames in flight at the instant of the restart are the only exposure, the same as any deploy; see the `gateway-restart` result.
   - New positions now go to Valkey. The stream is created by the first XADD.
   - If Valkey is unreachable, they go to the gateway spool, and the gateway `/health` says so. Fix `REDIS_URL` and restart the gateway again; nothing is lost.
5. Watch the processor, which is still on Memurai, drain the old stream: `memurai-cli XINFO GROUPS vt:positions` until `lag` is 0 and `pending` is 0. That normally takes a few seconds.
6. Stop `veetracer-processor`. Then wait until the notifier, still on Memurai, has emptied its queues: `memurai-cli XINFO GROUPS vt:notify` and `XINFO GROUPS vt:webhooks` both show `lag` 0 and `pending` 0. Then stop `veetracer-notifier`.
7. Copy the state keys (live position, filter, alert, fuel and IO state, offline command queues, forwarding rules). Keys already on the target are not overwritten.
   ```
   cd C:\apps\veetracer\app\apps\api
   npx tsx scripts\cache-copy.ts --from redis://127.0.0.1:6379 --to <new REDIS_URL> --dry-run
   npx tsx scripts\cache-copy.ts --from redis://127.0.0.1:6379 --to <new REDIS_URL>
   ```
   Skipping this step is safe. Vehicles reappear on the live map with their next fix, and alert episodes simply restart.
8. Start `veetracer-processor`.
   - It creates the `processor` group at `0` on the Valkey stream, so every entry the gateway wrote since step 4 is processed.
   - Check that `/api/health/tracking` lag falls to 0.
9. Start `veetracer-api`, `veetracer-notifier` and `veetracer-summarizer`. The notifier creates `vt:notify`/`vt:webhooks` groups on first use.
10. Verify:
    - `/api/health` returns 200 and `/api/health/tracking` reports `OK`.
    - The gateway `/health` reports `ok` with spool `pendingEntries` 0.
    - The live map updates.
    - Send a test command to a non-critical device. Engine stop is **not** a test command.
    - On the System Health page, Valkey shows version 9.1.x and `aofEnabled: true`.
11. Remove `maintenance.flag`. Re-run `install-reliability.ps1 -CacheService <none>` if desired. Stop the Memurai service and set it to **Disabled**, but keep it installed for two weeks as the rollback path.

Expected impact:
- Device ingestion: one gateway restart, with no stored-position loss.
- UI: unavailable for about 5–10 minutes.
- Notifications: paused only between step 6 and step 9. Nothing queued is left behind, because each consumer moves only after its stream on Memurai is empty.

## 5. Rolling back the cut-over

The same procedure in reverse:

1. Set the maintenance flag.
2. Stop api and summarizer.
3. Point `REDIS_URL` at Memurai and start the Memurai service.
4. Restart the gateway.
5. Wait for the processor, still on Valkey, to drain (`valkey-cli XINFO GROUPS vt:positions`).
6. Stop the processor. Wait for the notifier's queues to empty, then stop the notifier.
7. Optionally run `cache-copy.ts --from <valkey> --to redis://127.0.0.1:6379`.
8. Start the processor, then api, notifier and summarizer.

Positions are safe throughout. Either cache's stream is drained before the processor moves, and during any gap the gateway spools.

Memurai Developer Edition will stop itself again within 10 days. The rollback is a stop-gap only, with the alerts in place.

## 6. Open decisions for the owner

1. **Where the Valkey VM runs.** Mintplus same-DC (price to be quoted) or a public cloud in India (₹650–1,700/month, with TLS and internet latency). Otherwise, buy Memurai Enterprise (price to be quoted; insist on 5.x).
2. **SMS for system alerts.** A DLT template must be registered with the SMS provider. Until then, alerts are e-mail plus the Windows event log.
3. **Spool cap.** The default is 1 GB, about 3 million positions, or several hours of full fleet traffic. Raise it if the fleet grows or longer outages must be covered.
4. **Windows Server 2016 end of life (13 Jan 2027).** Plan the OS move. A Linux host for the whole stack would make the cache local again.
5. **`Device.lastSeenAt` time zone (pre-existing, not changed here).** The processor writes this `timestamp` column by casting a `timestamptz`, so PostgreSQL stores it in the server's session time zone. Prisma reads it back as UTC. The "last seen" times shown in the UI are therefore shifted by the server's UTC offset when PostgreSQL's `TimeZone` is not UTC. Check `SHOW TimeZone` on production. If it is not UTC, schedule a fix: `ALTER DATABASE … SET timezone TO 'UTC'` plus a one-off correction, or write `t.at AT TIME ZONE 'UTC'`. This needs its own change and test.
