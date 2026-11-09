# GPS ingestion reliability (release 1.6)

This document covers how positions flow, what used to be lost when the cache was down, and what changed (durable spool, ACK semantics, dedupe, health endpoints, recovery and alerts). Branch `feature/production-cache-reliability`.

## 1. The path of a position

```
device ──TCP──▶ gateway ──XADD──▶ vt:positions (cache) ──XREADGROUP──▶ processor ──INSERT (1 tx)──▶ PostgreSQL
                   │                                                      └─ XACK only after the commit
                   └─(cache unavailable)─▶ local spool (fsync) ──replay──▶ vt:positions
```

- The gateway decodes frames into `NormalizedPosition`s and XADDs them to `vt:positions`, capped by `MAXLEN ~ 2,000,000`.
- The processor reads with a consumer group. It writes positions, raw packets and alerts in **one** transaction, and XACKs only after the commit.
  - If the database is down, the batch stays pending and is retried with backoff of 1–30 s.
  - If the processor crashes, `XAUTOCLAIM` re-delivers after 30 s.
- `Position` has the primary key `(deviceId, fixTime)`, and the insert is `ON CONFLICT DO NOTHING`, so the same fix written twice is one row.

## 2. What happened before release 1.6 when the cache was down

| Protocol / frame | Device ACK on this frame? | Release 1.5 behaviour on a failed XADD | Result |
|---|---|---|---|
| Teltonika AVL records | yes | ACK withheld, connection closed | the device resends: **safe** |
| JT808 0x0200 location | yes (0x8001) | ACK withheld | the device retries per JT/T 808: mostly safe |
| GT06 alarm 0x16/0x26 | yes | ACK withheld | the device resends: safe |
| **GT06 location 0x12 / 0x22 / 0xA0** (the bulk of the fleet) | **no** (Concox never ACKs location packets) | counted in `enqueueFailures`, nothing else | **silently lost** |
| AIS-140 location | depends on the variant | ACK withheld if there is one | lost for variants without an ACK |

In addition:
- **Hidden loss on recovery.** The gateway's ioredis connection kept failed XADDs in its offline queue and applied them late, after the 10 s timeout had already been reported as a failure.
- **Gateway could not start without the cache.** It awaited subscriptions at start-up, so with the cache down it never opened its device ports and crashed after about 20 retries.
- **Consumers never recovered from an empty cache.** If the cache came back empty, every consumer loop failed with `NOGROUP` forever.

## 3. Durable spool in the gateway

Code:
- `apps/api/src/gateway/spool/position-spool.ts` (disk FIFO)
- `position-publisher.ts` (policy)
- `gateway-health.ts` (local health)

### Design

- **Format.** Append-only JSON-lines segment files in `GATEWAY_SPOOL_DIR`, default `apps/api/var/spool/positions`. A record is `{m: mid, d: position JSON, r: remote, t: spooledAt}`. Segments rotate at 16 MB.
- **Durability.** Every append batch is one positional `write` followed by `fdatasync`, before the promise resolves (group commit: everything appended in the same tick shares one sync).
  - A crash mid-write leaves at most a torn last line, which is cut off on the next open; it was never acknowledged.
  - Positional writes (not `O_APPEND`) are deliberate: Windows refuses `ftruncate` on append-only handles. This was found and fixed during testing.
- **Replay.** `checkpoint.json` records `{segment, offset}` and is written atomically (write, fsync, rename). Fully replayed segments are deleted. On start, unreplayed records from before a crash or restart are replayed first.
- **Bounded.** `GATEWAY_SPOOL_MAX_MB` (default 1024 MB, about 3 million positions). When full, appends are refused (counted as `rejected`), and the publisher falls back to the old behaviour (§4).
- **Modes.**
  - `direct`: the cache is ready and the spool empty, so XADD as before.
  - `spooling`: the cache is not ready, an XADD failed or timed out, or the processor backlog exceeds 80% of the stream cap (backpressure, so XADD would otherwise trim unprocessed entries).
  - `draining`: the cache is back; replay oldest-first at `GATEWAY_SPOOL_REPLAY_PER_SEC` (default 2,000/s), with exponential backoff of 0.5–30 s on errors.
- **Ordering.** While anything is in the spool, new positions are appended **behind** it, never XADDed past it. The publisher returns to `direct` only when the spool is empty and no append is in flight, so per-device order is preserved through an outage.
- **Fail-fast connection.** Positions use their own connection with `enableOfflineQueue: false`, `commandTimeout: 5 s` and jittered reconnect. Nothing is queued in memory and applied late.
- **Metrics.** The gateway heartbeat carries `spool` (mode, pendingEntries, pendingBytes, oldestSpooledAt, spooled, replayed, rejected, directFailed, notAcked, lastError). It is shown in System Health and in `/api/health/tracking`, and logged every 30 s while not in `direct`.
- `GATEWAY_SPOOL=off` restores the release 1.5 behaviour exactly.

### Why a disk spool, and not something else

- **Device retransmission alone cannot work.** GT06 locations are never ACKed.
- **An in-memory buffer is lost on a gateway restart** (NSSM restart, deploy, crash) and is limited by the 4 GB host.
- **Writing straight to PostgreSQL from the gateway** would couple the gateway to the database. The gateway is deliberately database-free. It would also bypass the processor's filtering, status and alert logic, or duplicate it.
- **A second cache or queue** (for example a local Valkey) adds the same class of dependency we are trying to tolerate.
- **A local fsynced log is the standard store-and-forward answer.** It has no dependencies, survives restarts, and its replay feeds the unchanged processor path.

## 4. Device ACK semantics: what we kept and why

- **Unchanged: the protocol bytes and reply ordering.**
  - Replies to frames that carry positions are still written only after those positions are **durable**.
  - Login, heartbeat and time replies are still sent at once, or behind an earlier gated reply so the order is kept.
- **Changed: what "durable" means.**
  - Before: "XADD succeeded".
  - Now: "XADD succeeded **or** the positions were fsynced to the spool".
  - During a cache outage the device therefore sees exactly the replies it sees on a healthy day. It does not resend or reconnect, and Teltonika devices are no longer disconnected every few seconds.
- **Still withheld (as before) when both fail.** If the spool also failed (full, or a disk error) **and** the cache is down, the ACK is withheld and Teltonika connections are closed. The devices that can retransmit then do. This is counted as `notAcked` / `enqueueFailures` and raised as a CRITICAL `tracking.spool.*.refused` issue and a gateway `/health` `failing` status.
- **Not touched: commands.**
  - Engine stop is never queued (Q-01): fresh dispatch only. A queued engine stop found on reconnect is failed, not delivered (`gateway/main.ts`, `tcp-server.ts`).
  - `noQueue` position requests are never queued.
  - Command routing, matching and timeouts are unchanged; the existing Q-01 tests pass.

## 5. Duplicates and ordering in the processor

- **Message id.** Every stream entry now carries `mid` (a per-process boot id plus a counter).
  - The processor keeps the last 200,000 mids it committed (`processor/recent-ids.ts`, `PROCESSOR_DEDUPE_IDS`).
  - It drops a repeated mid without processing it (counted as `duplicates` in the heartbeat).
  - A repeat happens when an XADD timed out but was in fact applied, and was then replayed from the spool.
  - This prevents duplicate alerts and duplicate fuel / AC / door state steps.
- **Device retransmissions** (a new mid with the same fix) collapse on the `(deviceId, fixTime)` primary key, as before.
- **Out-of-order fixes** are stored, but `position-filter.ts` marks them LATE when older than the newest fix, and **they never move the live state** (`vt:live:*`). This existing rule is verified in the `dup-ooo` chaos scenario: live state ends on the newest fix.
- **Entries from older gateways** (no `mid`) are processed as before.

## 6. Health endpoints

| Endpoint | Meaning | Status codes |
|---|---|---|
| `GET /api/health/live` | liveness: the API process answers | always 200 |
| `GET /api/health/ready` | readiness: PostgreSQL `SELECT 1` (2 s) **and** cache `SET`+`GET` (1.5 s; a write catches MISCONF/OOM/read-only, not just PING) | 200 / **503** |
| `GET /api/health` | **same as `/ready`**, the path the deploy scripts gate on | 200 / **503** |
| `GET /api/health/tracking` | gateway → stream → processor → PostgreSQL (from the System Health collection, cached for 5 s) | 200 `OK`/`WARN`, **503 `CRITICAL`** |
| gateway `GET http://127.0.0.1:4121/health` (`GATEWAY_HEALTH_PORT`, localhost only) | `ok` / `degraded` (spooling, positions safe) / `failing` (positions refused, listener down) | 200 / 200 / 503 |
| gateway `GET http://127.0.0.1:4121/health/live` | gateway process up | 200 |

Every API body has `ok` (boolean) and `status`, so existing `{ ok: true }` consumers still parse it.

**`/api/health/tracking` turns CRITICAL when any of these hold:**
- the cache or the database is unreachable;
- no gateway or processor heartbeat;
- a listener port is down;
- the `vt:positions` lag exceeds `HEALTH_QUEUE_LAG_CRIT` (50,000);
- a gateway is refusing positions;
- the spool has not drained for `HEALTH_SPOOL_STUCK_MIN` (15 min) although the cache is up;
- devices are connected but nothing has been committed to PostgreSQL for `HEALTH_PERSIST_STALE_CRIT_SEC` (600 s; WARN after 180 s).

**WARN covers:**
- positions buffered in a spool;
- lag above the warning threshold;
- pending entries older than 60 s.

**Response body.** It lists the issues (host names removed), per-gateway connections and spool state, processor `lastBatchAt` and `duplicates`, stream lag / pending, and `lastPersistedAt` / `lastPersistedAgeSec`.
- `lastPersistedAt` is `max(Device.lastSeenAt)`, which the processor writes in the same transaction as the positions.
- That column is `timestamp without time zone` and is written in the session time zone, so the query reads it `AT TIME ZONE current_setting('TimeZone')`.

**Deploy gate.**
- `deploy-release.ps1` (and the other update scripts) still poll `http://localhost:4100/api/health` until it returns 200.
- **Since 1.6 that means the API is up _and_ PostgreSQL and the cache are usable.** A deploy while the cache is down now fails the gate, as it should. The script prints the reason (HTTP 503) and the tracking status.
- To check only that the process is up, use `/api/health/live`.

**System Health page and alert e-mails.**
- The same checks feed the existing System Health page and its alert e-mails (to the Super Admin and `SYSTEM_ALERT_EMAILS`, with cooldown and "resolved" mails).
- While the cache is unreachable, only the cache outage is reported. Heartbeats and port reports live in the cache, so they are *unknown*, not *missing*; reporting them would make every process look dead.

## 7. Recovery and alerts

### Reconnection inside the processes
- **Gateway.**
  - Device ports open even when the cache is down at start; subscriptions and forwarding rules retry every 5 s (`untilCacheUp`).
  - The positions connection reconnects with exponential backoff and jitter (0.25–5 s).
  - Replay starts as soon as it is `ready`.
- **Processor, notifier, webhooks, relay, driver media.**
  - Each recreates its consumer group on `NOGROUP` (cache restarted empty) instead of failing forever (`redis/stream-groups.ts`).
  - Database errors keep the batch pending and retry with backoff of 1–30 s, as before.

### NSSM restart policy (`ops/deploy/windows/install-reliability.ps1`)

Run once on the server; `-DryRun` first. For every `veetracer-*` service it sets:

| Setting | Value |
|---|---|
| `AppExit Default` | `Restart` |
| `AppRestartDelay` | 5 s |
| `AppThrottle` | 30 s (crash loops back off instead of spinning) |
| `AppStopMethodConsole` | 20 s (Ctrl+C first, so the gateway flushes cleanly) |
| SCM failure actions | restart after 10 / 30 / 60 s (reset daily) |

Two things it does **not** do:
- It adds no dependency on the cache service, because the gateway must run during a cache outage.
- It never gives the cache automatic restarts, unless `-CacheLicensed` is passed for a production-licensed cache.

### Watchdog (`ops/deploy/windows/veetrax-watchdog.ps1`, scheduled task every minute, SYSTEM)

- **Services.** A `veetracer-*` service that is not running gets an alert and `Start-Service`, at most 3 times per service per hour, then "gave up" alerts.
- **Cache.** A stopped cache service gets an **alert only**. It is never restarted from here: no scheduled or automatic restarts of Memurai Developer Edition.
- **API.** `/api/health/ready` returning 503, `/api/health/tracking` CRITICAL, or the API not answering all raise alerts.
- **Gateway.** Gateway `/health` `degraded` (spooling) or `failing` (refusing positions), or not answering, raises an alert.
- **Delivery.** Alerts repeat at most every 30 min while active, and a "Resolved: …" alert follows.
- **Maintenance.** `C:\apps\veetracer\maintenance.flag` silences it; `deploy-release.ps1` creates and removes the flag.
- **Channels.**
  - E-mail and SMS: `node apps\api\dist\monitoring\alert-cli.js` uses the app's own mail provider (Zoho / SMTP from `.env`) to `SYSTEM_ALERT_EMAILS`, or the Super Admin. Optional SMS goes to `SYSTEM_ALERT_SMS` when a DLT template id is configured in `SYSTEM_ALERT_SMS_DLT_TEMPLATE_ID`; Indian SMS requires a registered template.
  - The Windows Application event log (source `VeeTrax`, event 4100).

### Who alerts on what

| Failure | In-app System Health e-mail | Watchdog | Health endpoint |
|---|---|---|---|
| Cache disconnected / stopped | `valkey.unreachable` CRITICAL | cache service stopped; `/ready` 503; gateway degraded | `/api/health` 503, `/tracking` 503, gateway `degraded` |
| Gateway interrupted | `process.gateway` CRITICAL, `port.*` CRITICAL | service not running → start; gateway health not answering | `/tracking` 503 |
| Processing lag | `queue.vt:positions.lag` WARN/CRITICAL, `pending-age` WARN | `/tracking` CRITICAL | `/tracking` 200 WARN / 503 |
| Failed persistence | processor `database` CRITICAL, `tracking.persist-stale` WARN/CRITICAL | `/ready` 503 (database), `/tracking` CRITICAL | `/api/health` 503 |
| Positions at risk | `tracking.spool.*.pending` WARN/CRITICAL, `tracking.spool.*.refused` CRITICAL | gateway degraded / failing | gateway `/health` |
| API down | (cannot e-mail itself) | API not answering | — |

## 8. Configuration reference (all optional)

| Variable | Default | Process |
|---|---|---|
| `GATEWAY_SPOOL` | `on` | gateway |
| `GATEWAY_SPOOL_DIR` | `apps/api/var/spool/positions` | gateway |
| `GATEWAY_SPOOL_MAX_MB` | 1024 | gateway |
| `GATEWAY_SPOOL_REPLAY_PER_SEC` | 2000 | gateway |
| `GATEWAY_HEALTH_PORT` | 4121 (127.0.0.1; 0 disables) | gateway |
| `PROCESSOR_DEDUPE_IDS` | 200000 | processor |
| `HEALTH_PERSIST_STALE_WARN_SEC` / `_CRIT_SEC` | 180 / 600 | api |
| `HEALTH_SPOOL_STUCK_MIN` | 15 | api |
| `SYSTEM_ALERT_EMAILS` | — | api, watchdog |
| `SYSTEM_ALERT_SMS`, `SYSTEM_ALERT_SMS_DLT_TEMPLATE_ID` | — | watchdog |

No database schema change. No migration.
