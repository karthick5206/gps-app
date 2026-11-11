# D6 G2 + G3 (v1.8.3) — durable alert notifications and truthful delivery status

Branch `feature/hardening-v1.8.3` (base v1.8.1 `c217521`). Isolated testing only: scratch DB `veetrax_assess_g2_test`
(local test PostgreSQL, all migrations applied), Valkey **db 1** with a private stream key per run (`vt:test:g2:<run>:notify`,
deleted afterwards). Nothing touched production, `veetracer` or Valkey db 0. Measured numbers: [`results.json`](results.json).

## Delivery guarantee (owner correction A, 2026-11-11) — not exactly-once

1. **Durable job recovery.** Every committed `Alert` has `notifiedAt IS NULL` until the notifier finished its job (column
   default, so it is written in the same transaction as the alert by every producer). The sweeper re-queues such alerts
   (60 s – 24 h old) until they are `notifiedAt` or DEAD (`notifyError`).
2. **Per-recipient deduplication inside VeeTrax.** `NotificationLog."dedupeKey" = alertId:CHANNEL:<recipient hash>` with a
   partial unique index: duplicate DB records = 0 by construction. The recipient hash is HMAC-SHA256 of the normalised
   (trimmed, lower-case) address with a server-side pepper `HMAC(JWT_SECRET, "veetrax:notify-dedupe:v1")`, so neither the
   key nor any log line carries the e-mail / phone in clear (security review L1 / L2).
3. **At-least-once delivery attempts.** A job that throws is not acknowledged and is redelivered by `XAUTOCLAIM`
   (≈ 60–90 s apart); DEAD at the 5th delivery. A row whose worker died is taken over after its 5 min lease, at most 3 times.
4. **Bounded duplicate risk at the provider boundary.** If a process dies after the provider accepted a message but before
   the status `UPDATE` (a window of milliseconds), or a send takes longer than the 5 min lease, the next worker sends again.
   Bound: one extra message per lease takeover, **at most 3 per dedupe key** (then the row is closed `FAILED`
   "abandoned after 3 lease takeovers").
5. **Provider idempotency keys where supported.**

| Provider | Idempotency key | Provider id stored |
|---|---|---|
| SMTP | supported (receiver-side): stable `Message-ID: <sha256(dedupeKey)[:32]@veetrax.notify>` on every retry / takeover | SMTP Message-ID |
| Zoho CPaaS mail | not verifiable (the v1.1 email call has no idempotency field) | `request_id` |
| Smartping SMS | not verifiable (no documented client-reference parameter; not sent) | `transactionId` |
| Expo push | not supported | ticket ids (comma-separated) |
| Arattai | not verifiable | none returned |

## Measured (integration tests, `notifier-durability.int.spec.ts`)

| Scenario | Result |
|---|---|
| Processor saved 100 alerts, XADD failed (no stream entry), sweeper recovers | 100 / 100 queued, 300 / 300 recipient rows `SENT`, **lost 0, duplicate DB records 0**, recovery ≈ 1.3–1.5 s after the sweep (bound: ≤ 2 min incl. 60 s minimum age + 30 s tick) |
| Duplicate jobs (stream entry + sweep, redelivery) | 0 new rows, 0 new provider calls |
| Partial resend: process killed after 1 of 3 recipients | after restart exactly 3 rows, all `SENT`; only the 2 missing recipients sent |
| Kill between provider acceptance and status `UPDATE`, 100 iterations | 200 accepted messages for 100 keys: **100 duplicate external messages, max 1 extra per key (bound 3)**, all in the documented window, every row `SENT` with `attempts = 2`, duplicate DB records 0. The 100 % rate is by construction (every iteration crashes inside the window); in production it equals the rate of crashes inside that millisecond window |
| Forced takeover chain (crash on every takeover) | 4 sends = 1 + 3 extra (the bound), then `FAILED` "abandoned after 3 lease takeovers", alert `notifiedAt` set |
| Injected throw in the job | not acked on deliveries 1–4; DEAD at 5: `notifyError = "dead after 5 deliveries: injected DB fault"`, acked, never swept; a transient fault succeeds on the next delivery |
| Zero-channel / zero-recipient alerts | `notifiedAt` set, never swept |
| Alerts handled by the previous notifier (rows without dedupe key) | marked `notifiedAt`, nothing re-sent |
| G3, no providers (test instance) | SMS + e-mail alert → `SKIPPED` "SMS provider not configured" / "E-mail provider not configured", **0 `SENT`** |
| Lost pre-rendered (test) message | re-queued, sent once, duplicate job sends nothing |
| Valkey semantics | `XPENDING` times_delivered grows by 1 per `XAUTOCLAIM`; `XAUTOCLAIM` returns `[next, entries, deleted]` |
| Sweeper query plan | uses the partial index `Alert_notify_pending_idx` |
| M1: System Health on the real DB (added 2026-11-11, security fixes) | DEAD SOS alert → `pipeline.notify-dead` **CRITICAL**; 10 min old un-notified alert → `pipeline.notify-unqueued` WARN; notifier `metrics()` → `deadJobs: 1`, `lastDead` set |
| PII in dedupe keys (added) | every `dedupeKey` matches `<uuid>:<CHANNEL>:<64 hex>`; 0 keys contain the recipient |
| Time zone (added) | processor raw `INSERT` under `SET TimeZone = 'Asia/Kolkata'` stores `createdAt` in UTC (skew < 60 s, was +5 h 30 min) |

## Migration `20261114070000_notifier_durability` (additive)

- `Alert`: `notifiedAt timestamptz(3) NULL`, `notifyError text NULL`; partial index `Alert_notify_pending_idx ("createdAt")
  WHERE notifiedAt IS NULL AND notifyError IS NULL AND createdAt >= '2026-11-01'` (constant floor keeps it small).
- `NotificationLog`: `attempts int NOT NULL DEFAULT 0`, `nextAttemptAt timestamptz(3)`, `providerMessageId text`,
  `dedupeKey text`; unique partial index on `dedupeKey`; partial index on `createdAt WHERE status = 'QUEUED'`.
- `Alert_notify_dead_idx ("createdAt") WHERE "notifyError" IS NOT NULL` (System Health `pipeline.notify-dead`; only DEAD
  alerts are indexed).
- `SET lock_timeout = '5s'` at the top (review L4). Prisma runs the file in one transaction: tested on the scratch DB with
  an `ACCESS SHARE` lock held on `Alert`, `prisma migrate deploy` failed after ≈ 5 s with `55P03 canceling statement due to
  lock timeout` and applied **nothing** (no column, no index). Recovery: `npx prisma migrate resolve --rolled-back
  20261114070000_notifier_durability`, then `migrate deploy` again off-peak; that run applied cleanly.
- Data: `notifiedAt = createdAt` for alerts of the last 25 h (no burst of re-queued recent alerts at deploy).
- Data (review L6): pre-rendered `NotificationLog` rows still `QUEUED` and older than 5 min → `FAILED` "Queued before the
  v1.8.3 upgrade and not completed; not retried" (stale test sends / reminders are not sent hours late after the upgrade);
  younger rows stay `QUEUED` (the running notifier may still send them). Verified on the scratch DB: 2 h old row → `FAILED`,
  1 min old row → `QUEUED`.
- Cost on a **synthetic 1,000,000-row** `Alert` copy (local test PostgreSQL 18): add columns 5 ms, partial index 78 ms,
  backfill (5,725 rows) 112 ms, index 1.3 MB. The Lead should still read the production row count
  (`SELECT count(*) FROM "Alert"`, read-only) before approval; the index build scans the whole table while holding a
  write lock on `Alert`.
- `prisma migrate diff` (DB → schema) after deploy: empty.

## Runbook notes

- **System Health** (from PostgreSQL, every 15 s, survives notifier restarts):
  - `pipeline.notify-dead`: any alert with `notifyError` in the last 24 h (`HEALTH_NOTIFY_DEAD_WINDOW_HOURS`).
    **CRITICAL** when any of them is `SOS` / `CRASH`, else WARN. The message names the types, the latest alert id and error.
  - `pipeline.notify-unqueued`: alerts without a finished job older than 5 min → WARN (`HEALTH_NOTIFY_UNQUEUED_WARN_MIN`),
    any older than 30 min → CRITICAL (`HEALTH_NOTIFY_UNQUEUED_CRIT_MIN`), within the sweeper's 24 h window.
  - Notifier heartbeat (`NotifierMetrics`): `deadJobs` and `lastDead` (kept apart from `lastError`, which the next ordinary
    failure overwrites), `unnotifiedAlerts` / `lastSweepAt` / `sweptAlerts` from the sweeper on the instance holding the lock.
    Prometheus: `vt_notifier_dead_jobs_total`, `vt_notifier_unnotified_alerts`.
- Watch the notifier log for `is DEAD`, `Re-queued N alert(s)`, `Taking over SMS row <id> of alert <id> (lease expired; a
  duplicate external message is possible …)`. Log lines carry row / alert ids only, never the recipient or the dedupe key;
  mailer log lines mask digit runs (OTP / activation codes, phone numbers) and links in subjects.
- **Time zone:** every `Alert."createdAt"` writer stores UTC (Prisma, and the processor's raw `INSERT` now sets
  `now() AT TIME ZONE 'UTC'` instead of relying on the column default), and the sweeper / health counts compare against
  `now() AT TIME ZONE 'UTC'`, so they no longer depend on the session `TimeZone`. Production is UTC anyway (verified); the
  local test PostgreSQL runs `America/Los_Angeles` and the suite passes there.
- Find DEAD alerts: `SELECT id, type, "notifyError" FROM "Alert" WHERE "notifyError" IS NOT NULL AND "createdAt" > (now() AT TIME ZONE 'UTC') - interval '24 hours'`.
  To retry one after fixing the cause: `UPDATE "Alert" SET "notifyError" = NULL WHERE id = '<id>'` (the sweeper picks it
  up within 30 s; recipients already `SENT` are not re-sent).
- Un-notified backlog: `SELECT count(*) FROM "Alert" WHERE "notifiedAt" IS NULL AND "notifyError" IS NULL AND "createdAt" BETWEEN (now() AT TIME ZONE 'UTC') - interval '24 hours' AND (now() AT TIME ZONE 'UTC') - interval '5 minutes'` → expected 0.
- Statuses: `SENT` = accepted by the provider (no delivery receipts), `SKIPPED` = no provider configured / channel off,
  `FAILED` = provider refused after 3 tries, abandoned lease, or DEAD job. Rows before v1.8.3 with provider
  `console` / `mailer` and status `SENT` were **not** delivered (history is preserved, no backfill).

## Not in this patch (follow-ups)

- Chaos-harness `notifier` process and scenarios (`notify-xadd-fail`, `notifier-throw`, `notifier-kill-mid-send`); the same
  scenarios are covered here at integration level against a real DB and Valkey.
- UI help text ("SENT = accepted by the provider", bounded duplicate note, pre-v1.8.3 rows note) in the web notification log.
- In-process deferred driver-event e-mails (snapshot wait) are still lost on a crash during the wait (residual risk, as specified).

## Security review fixes (2026-11-11, second run)

Independent review of `0923cc5` (v1.8.3 "PASS WITH CONDITIONS"). Fixed on `feature/hardening-v1.8.3`:

| Finding | Fix |
|---|---|
| M1 DEAD jobs invisible (spec G2 acceptance #2) | `pipeline.notify-dead` (CRITICAL for SOS / CRASH, WARN otherwise) and `pipeline.notify-unqueued` (WARN 5 min / CRITICAL 30 min) in `monitoring/checks.ts`, collected by `SystemHealthService.notifyBacklog()` (two indexed counts); `deadJobs`, `lastDead`, sweeper counts in `NotifierMetrics`; Prometheus counters |
| L1 / L2 recipient PII in the dedupe key and the takeover log | keyed hash in the key (format above); takeover log names row + alert id; development-copy warning masks the address |
| L3 time-zone dependence | processor raw `INSERT` writes `createdAt` explicitly in UTC; integration test under `Asia/Kolkata` |
| L4 migration without `lock_timeout` | `SET lock_timeout = '5s'`; behaviour under a held lock measured (above) |
| L5 OTP code in mail log lines | `logSubject()` masks runs of 4+ digits and links in all three mailer log lines |
| L6 old QUEUED rows re-sent after deploy | migration backfill (older than 5 min → `FAILED`, reason above) |

**Pepper choice:** HMAC with a key derived from `JWT_SECRET` (domain-separated), not a plain SHA-256: a plain hash of an
Indian mobile number is reversed by enumerating 10^10 candidates in minutes, so it would not protect the key. Every API /
notifier process already requires `JWT_SECRET` (`loadEnv`); no new secret to provision. Trade-off: rotating `JWT_SECRET`
changes the hash, so only an alert that is mid-delivery at that moment can get one extra message per recipient already
sent (finished alerts are skipped at alert level). Without a secret (unit tests, scripts) the context string is the key.

**Runs (`feature/hardening-v1.8.3`, working tree before the commit):**
- API: `tsc -p tsconfig.build.json --noEmit` clean, `tsc --noEmit` (incl. specs) clean, `nest build` OK.
- API Jest (full): **145 suites passed, 6 skipped (DB-guarded); 1,399 tests passed, 43 skipped, 0 failed** (before the 3
  new integration tests, which skip without a DB; re-run after adding them: 1,399 passed, 46 skipped, 0 failed).
- G2 integration suite against `veetrax_assess_g2_test` + Valkey db 1 (`NOTIFY_TEST_DATABASE_URL=…/veetrax_assess_g2_test`,
  `NOTIFY_TEST_REDIS_URL=redis://127.0.0.1:6379/1`, a throw-away `JWT_SECRET`): **18 / 18 passed** (15 earlier + M1, PII,
  time zone); XADD-fail recovery 100 / 100, 300 rows, **lost 0, duplicate DB records 0**, recovery 1.3 s; kill-mid-send max
  1 extra per key (bound 3), duplicate DB records 0. Scratch rows and the private stream key were deleted afterwards.
- Migration re-applied on the scratch DB (reverted, then `migrate deploy` of the edited file); `prisma migrate diff` empty.
- Web: `tsc --noEmit -p tsconfig.app.json` clean (shared `NotifierMetrics` gained optional fields only).

**Deploy-note changes for v1.8.3:**
- Before deploy, item "SHOW TimeZone = UTC" is no longer a correctness condition (keep it as a check); the 5 s
  `lock_timeout` replaces the manual "no long-running queries" gate as the safety net — if `release.sh` stops at the
  migration with `55P03`, nothing was applied: run `prisma migrate resolve --rolled-back 20261114070000_notifier_durability`
  and re-run the release off-peak.
- After deploy: 4 partial indexes expected (`NotificationLog_dedupeKey_key`, `NotificationLog_queued_createdAt_idx`,
  `Alert_notify_pending_idx`, `Alert_notify_dead_idx`). System Health must show no `pipeline.notify-*` issue; the manual
  daily DEAD query is no longer the only DEAD monitor.
