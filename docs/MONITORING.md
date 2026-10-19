# VeeTrax — System Health monitoring

Super Admin page **Platform → System Health** (`/platform/system-health`, menu `sa_system_health`, actions view/edit).
It shows on one page whether the whole system is healthy, across every instance and host of every process, and
e-mails the Super Admin when it isn't.

## 1. How it works

```
gateway ─┐                                     ┌─ GET /api/admin/system-health   (page, every 5 s)
processor├─ heartbeat every 5 s ──► Valkey ◄───┤─ SystemMonitorService (API, every 15 s, one instance via SET NX lock)
notifier ├─ vt:health:proc:<role>:<instance>   │     checks → transitions → e-mail + socket `system:health`
summarizer┘ (JSON, EX 20 s)                    └─ sampler (API, every 10 s) → vt:health:series (throughput, lag)
api ─────── same heartbeat (sockets, offline sweeper)
```

| Valkey key | What |
|---|---|
| `vt:health:proc:<role>:<host>-<pid>` | Heartbeat of one process instance (EX 20 s); indexed in the sorted set `vt:health:procs` |
| `vt:health:series` | Capped list (400) of 10-second samples: stream counters, lag, notifier totals, `n_tup_ins` |
| `vt:health:issues` | Active issues (WARN/CRITICAL) with their since-time |
| `vt:health:events` | Last 50 status transitions |
| `vt:health:alert-sent` | Per check: last alert e-mail time (cooldown) and whether a recovery mail is owed |
| `vt:health:sa-email` | Cached Super Admin e-mail (alerts still go out while PostgreSQL is down) |
| `vt:health:updates` | Pub/sub: `SystemHealthSummary` after each evaluation → `system:health` to the Super Admin's sockets |

Heartbeat contents: role, instanceId, host, pid, version (`apps/api/package.json`), startedAt, uptime, RSS, heap, CPU %
(`process.cpuUsage` delta), event-loop delay p99 (`perf_hooks.monitorEventLoopDelay`) and role metrics:

| Role | Metrics |
|---|---|
| gateway | per listener: protocol, port, listening (+ bind error), connections, frames/s, positions/s, dropped, errors, enqueueFailures, lastPacketAt, lastPositionAt |
| processor | processed (total, /s), avgBatchMs, lastBatchAt, dbErrors, lastDbError, lastDbOkAt, current backoff, pending, lag |
| notifier | jobs (total, /s), sent / failed per channel since start, skipped, lastError |
| summarizer | runs, lastRunAt, lastRunMs, lastError |
| api | connected sockets, offline sweeper lastRunAt |

The numbers come from the counters the processes already keep for their periodic log lines.

## 2. The report (`GET /api/admin/system-health`)

| Section | Source |
|---|---|
| processes | heartbeats; every role in `SYSTEM_HEALTH_ROLES` (default all five) must have ≥ 1 live instance |
| ports | gateway heartbeats ∪ ports configured in the API env (`GT06_PORT`, `TELTONIKA_PORT`, `JT808_PORT`) |
| queues | `vt:positions` and `vt:notify`: XINFO STREAM / GROUPS / CONSUMERS, XPENDING: length, cap, lag, pending, backlog, consumers, oldest pending age, input rate, buffer time left |
| database | `SELECT 1` latency (2 s timeout), connections (`pg_stat_activity`), `max_connections`, database size, top 5 tables, positions inserted in the last minute (`pg_stat_user_tables.n_tup_ins` delta) |
| valkey | PING latency, INFO: memory / maxmemory, AOF, last RDB save, clients, evicted keys |
| throughput | last 60 min of 10-second samples: received (`entries-added` delta) vs processed (`entries-read − pending` delta), lag/backlog |
| host | API host: free disk for `HEALTH_DATA_DIR` (default `apps/api/var`, `fs.statfs`), load average, memory |
| issues / events | current checks with since-times; last 50 transitions |

Also: `GET …/status` (cheap summary for the top-bar banner), `GET …/settings` (recipients + thresholds in effect),
`POST …/test-alert` (edit permission). Every call has a timeout; when PostgreSQL is down the report still returns
(database = CRITICAL with the error), and Super Admin access falls back to the signed access token (15 min) because
the normal auth guard needs the database. Valkey down → valkey CRITICAL; heartbeats and queues are then unknown.

`GET /api/metrics` — the same numbers in Prometheus text format (`vt_*`), for Grafana. Authorization:
`Bearer $METRICS_TOKEN` or a Super Admin access token.

## 3. Checks and thresholds

All thresholds are env variables of the API (defaults below; listed in `apps/api/.env.example`, shown read-only in
the page's settings panel).

| Check (id) | Severity | Default | Env |
|---|---|---|---|
| Role has no live instance (`process.<role>`) | CRITICAL | — (30 s grace after API start) | `SYSTEM_HEALTH_ROLES` |
| Heartbeat stale (`process.<role>.<id>.stale`) | CRITICAL | > 15 s | `HEALTH_HEARTBEAT_STALE_SEC` |
| Event-loop lag p99 (`…eventloop`) | WARN | > 200 ms | `HEALTH_EVENT_LOOP_WARN_MS` |
| Processor can't write to the database (`…database`) | CRITICAL | last DB error newer than last good batch, within 120 s | `HEALTH_DB_ERROR_WINDOW_SEC` |
| Gateway port not listening (`port.<protocol>.<port>`) | CRITICAL | — | — |
| No positions while devices are connected (`pipeline.no-positions`) | WARN | 5 min | `HEALTH_NO_POSITIONS_WARN_MIN` |
| `vt:positions` lag | WARN / CRITICAL | > 5,000 / > 50,000 | `HEALTH_QUEUE_LAG_WARN` / `_CRIT` |
| Oldest pending entry (both streams) | WARN | > 60 s | `HEALTH_PENDING_AGE_WARN_SEC` |
| Buffer time left (both streams) | WARN / CRITICAL | < 30 / < 10 min | `HEALTH_BUFFER_WARN_MIN` / `_CRIT_MIN` |
| PostgreSQL unreachable from the API | CRITICAL | 2 s timeout | — |
| PostgreSQL latency | WARN | > 200 ms | `HEALTH_DB_LATENCY_WARN_MS` |
| Valkey unreachable | CRITICAL | 2 s timeout | — |
| Valkey memory (only when `maxmemory` is set) | WARN / CRITICAL | > 80 / > 90 % | `HEALTH_VALKEY_MEM_WARN_PCT` / `_CRIT_PCT` |
| Valkey `appendonly` off | WARN | — | — |
| Last RDB save failed | WARN | — | — |
| Disk free | WARN / CRITICAL | < 15 / < 5 % | `HEALTH_DISK_WARN_PCT` / `_CRIT_PCT` |
| Notification failure ratio | WARN | > 20 % over 15 min, ≥ 5 sends | `HEALTH_NOTIFY_FAIL_WARN_PCT`, `_WINDOW_MIN`, `_MIN_ATTEMPTS` |

**Buffer time left** = (stream cap − backlog) / net fill rate, where backlog = lag + pending and net fill rate =
input − processed rate (averaged over ~30 s). Processed entries stay in a stream until MAXLEN trims them, so the
stream *length* is normally close to the cap and is not a risk by itself; the risk is unprocessed entries reaching the
cap. When the processor is stopped the net rate equals the input rate.

## 4. Alerts

- `SystemMonitorService` (API) evaluates every 15 s. A Valkey `SET NX PX` lock makes one API instance evaluate per
  round. If Valkey is unreachable every instance evaluates on its own with in-memory state (so the outage itself is
  still e-mailed).
- **E-mail** to the Super Admin's address plus `SYSTEM_ALERT_EMAILS` (comma list) through `MailerService` (Zoho /
  SMTP when configured; always also written to `apps/api/var/mail/`). The Super Admin e-mail is cached in memory and
  in Valkey, refreshed from PostgreSQL every 5 min, so mail goes out while PostgreSQL is down.
- Sent on a new WARN/CRITICAL issue and on escalation WARN → CRITICAL; a **recovery** mail when an alerted issue
  clears. Per-check cooldown `SYSTEM_ALERT_COOLDOWN_MIN` (default 15): a check that re-fires within the cooldown is
  recorded as an event but not mailed (and then gets no recovery mail); escalations always mail.
- Everything that changed in one evaluation goes out as **one digest** ("3 system issue(s) (1 critical), 1 resolved"),
  listing new, resolved and still-active issues, with a link to the page.
- **Web**: `system:health` socket event to the Super Admin's sockets → toast, instant page refresh, and a red banner
  under the top bar while the overall status is CRITICAL.
- Settings panel: recipients, cooldown, delivery channel, thresholds, **Send test system alert**.

## 5. Ingest-path hardening (same change)

- Gateway: replies of frames that carry positions (Teltonika record ACK, GT06 alarm ACK, JT808 location reply) are
  written **only after the XADD succeeded** (10 s timeout). On failure the ACK is withheld — the device retransmits —,
  `enqueueFailures` is counted and, for Teltonika, the connection is closed (it resends on reconnect). Login and
  heartbeat ACKs are always sent; per-connection reply order is kept. A listener that can't bind is retried every
  30 s and shown as not listening instead of killing the gateway.
- `POSITIONS_STREAM_MAXLEN` env (default 2,000,000).
- Processor: failed batches back off 1 s → 2 → 4 → 8 → 16 → 30 s (cap) instead of a fixed 1 s; while the database is
  unreachable it retries its own pending batch (no new entries pile up in its PEL); it starts even when PostgreSQL is
  down and recovers without a restart. `dbErrors` / `lastDbError` are in the heartbeat. Summarizer also starts with
  PostgreSQL down.

## 6. Ports

| Port | Who | Exposure |
|---|---|---|
| 443 (80 → redirect) | reverse proxy → web + `/api` + `/socket.io` | internet |
| 5023 | gateway, Concox GT06 family | internet (TCP) |
| 5027 | gateway, Teltonika | internet (TCP), 0 disables |
| 6808 | gateway, JT/T 808 dashcams | internet (TCP), 0 disables |
| 5030 | gateway, AIS-140 (planned) | internet (TCP) |
| 4000 | API (REST + Socket.IO) | private — behind the proxy only |
| 5432 | PostgreSQL | private |
| 6379 | Valkey | private |
| 5173 | Vite dev server | development only |

`GET /api/metrics` is served by the API; expose it to Prometheus over the private network only and set `METRICS_TOKEN`.

## 7. Production recommendations

- **Valkey `appendonly yes`** (`appendfsync everysec`): `vt:positions` holds positions not yet written to PostgreSQL;
  without AOF a Valkey restart loses everything since the last RDB snapshot. Set `maxmemory` with
  `maxmemory-policy noeviction` (evicting stream entries would silently lose data) and size it for the stream cap.
- **Stream cap sizing**: `POSITIONS_STREAM_MAXLEN` ≥ peak positions/s × the longest processor/database outage you want
  to survive. 2,000,000 ≈ 33 min at 1,000/s, ≈ 5.5 h at 100/s. Measured here: Valkey used ~440 MB with ~900k stream
  entries plus all other keys (≈ 0.5 KB per entry), so budget ≈ 1 GB for a full 2M stream.
- **Firewall**: open only 443/80 and the device ports; never expose 4000, 5432, 6379. `track.mintplus.co.in` must be DNS-only.
- **Redundancy**: run ≥ 2 processors (distinct `PROCESSOR_CONSUMER` names; XAUTOCLAIM re-takes a crashed consumer's
  entries after 30 s) and ≥ 2 gateways behind a TCP load balancer; ≥ 2 API instances are supported (lock-guarded
  monitor/sampler). The page lists every instance; set `SYSTEM_HEALTH_ROLES` if a role intentionally doesn't run.
- Configure `SMTP_URL`/Zoho and `SYSTEM_ALERT_EMAILS` (a team address that is not on the same infrastructure).
- Keep ≥ 15 % disk free on the PostgreSQL / Valkey volumes; point `HEALTH_DATA_DIR` at the data volume.
- Run an external uptime check against `GET /api/health` — System Health cannot e-mail if every API instance is down.

## 8. Measured on the development Mac (19 Oct 2026)

Mac mini (8 cores, 8 GB), PostgreSQL 16 and Valkey 9.1.2 local, full dev stack + 20 simulated devices.

| Scenario | Result |
|---|---|
| Normal, 20 devices | Overall WARN only for real conditions of this Mac: Valkey AOF off, disk 5.1 % free (→ CRITICAL at 4.9 % later). All 5 processes OK, ports 5023/5027/6808 listening, lag 0, PostgreSQL 0.7 ms, Valkey 0.5 ms |
| Burst 10,000 positions (500 registered Load Test devices × 20 GT06 0x22 packets through the gateway) | sent in 58 ms; peak backlog 10,001; drained in **1.48 s** (≈ 6,780 positions/s end to end); 10,000 / 10,000 rows in PostgreSQL |
| Burst 100,000 positions (1,000 devices × 100) | sent in 303 ms; peak backlog **96,479**; drained in **8.7 s** (≈ 11,450/s); 100,000 / 100,000 rows. The page showed the lag spike and fall; the buffer check briefly went WARN ("cap reached in 23 min" at the burst rate) and recovered 15 s later |
| Processor stopped (SIGTERM) for 82 s | `process.processor` CRITICAL at the next evaluation, e-mail 11 s after the stop, red banner; backlog grew to 327; after restart the backlog drained in the first batch, recovery e-mail 4 s after restart; **330 / 330** positions of the outage window in PostgreSQL |
| Processor with an unreachable database (`DATABASE_URL` → port 1) for 100 s | starts despite the DB; retries at 1, 2, 4, 8, 16, 30, 30 s; held only its first batch (3 entries) pending; `process.processor.<id>.database` CRITICAL + e-mail, `pending-age` WARN + e-mail; after restoring the normal processor: backlog 400 drained, "2 system issues resolved" e-mail; **400 / 400** positions persisted |
| API's own PostgreSQL connection cut (second API on :4100 through a TCP proxy that was then killed) | report still returned (database CRITICAL with the error, Super Admin auth via the signed token); the monitor e-mailed "PostgreSQL is not reachable" using the cached Super Admin address |
| Valkey appendonly off | `valkey.aof` WARN shown (this Mac's Valkey config was not changed) |
