# D6 G2 + G3 (v1.8.3) — durable alert notifications and truthful delivery status

Branch `feature/hardening-v1.8.3` (base v1.8.1 `c217521`). Isolated testing only: scratch DB `veetrax_assess_g2_test`
(local test PostgreSQL, all migrations applied), Valkey **db 1** with a private stream key per run (`vt:test:g2:<run>:notify`,
deleted afterwards). Nothing touched production, `veetracer` or Valkey db 0. Measured numbers: [`results.json`](results.json).

## Delivery guarantee (owner correction A, 2026-11-11) — not exactly-once

1. **Durable job recovery.** Every committed `Alert` has `notifiedAt IS NULL` until the notifier finished its job (column
   default, so it is written in the same transaction as the alert by every producer). The sweeper re-queues such alerts
   (60 s – 24 h old) until they are `notifiedAt` or DEAD (`notifyError`).
2. **Per-recipient deduplication inside VeeTrax.** `NotificationLog."dedupeKey" = alertId:channel:recipient` with a partial
   unique index: duplicate DB records = 0 by construction.
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

## Migration `20261114070000_notifier_durability` (additive)

- `Alert`: `notifiedAt timestamptz(3) NULL`, `notifyError text NULL`; partial index `Alert_notify_pending_idx ("createdAt")
  WHERE notifiedAt IS NULL AND notifyError IS NULL AND createdAt >= '2026-11-01'` (constant floor keeps it small).
- `NotificationLog`: `attempts int NOT NULL DEFAULT 0`, `nextAttemptAt timestamptz(3)`, `providerMessageId text`,
  `dedupeKey text`; unique partial index on `dedupeKey`; partial index on `createdAt WHERE status = 'QUEUED'`.
- Data: `notifiedAt = createdAt` for alerts of the last 25 h (no burst of re-queued recent alerts at deploy).
- Cost on a **synthetic 1,000,000-row** `Alert` copy (local test PostgreSQL 18): add columns 5 ms, partial index 78 ms,
  backfill (5,725 rows) 112 ms, index 1.3 MB. The Lead should still read the production row count
  (`SELECT count(*) FROM "Alert"`, read-only) before approval; the index build scans the whole table while holding a
  write lock on `Alert`.
- `prisma migrate diff` (DB → schema) after deploy: empty.

## Runbook notes

- Watch the notifier log for `is DEAD`, `Re-queued N alert(s)`, `Taking over … (lease expired; a duplicate external
  message is possible …)`. `NotifierMetrics.lastError` shows the last DEAD job on System Health.
- Find DEAD alerts: `SELECT id, type, "notifyError" FROM "Alert" WHERE "notifyError" IS NOT NULL AND "createdAt" > now() - interval '24 hours'`.
  To retry one after fixing the cause: `UPDATE "Alert" SET "notifyError" = NULL WHERE id = '<id>'` (the sweeper picks it
  up within 30 s; recipients already `SENT` are not re-sent).
- Un-notified backlog: `SELECT count(*) FROM "Alert" WHERE "notifiedAt" IS NULL AND "notifyError" IS NULL AND "createdAt" BETWEEN (now() AT TIME ZONE 'UTC') - interval '24 hours' AND (now() AT TIME ZONE 'UTC') - interval '5 minutes'` → expected 0.
- Statuses: `SENT` = accepted by the provider (no delivery receipts), `SKIPPED` = no provider configured / channel off,
  `FAILED` = provider refused after 3 tries, abandoned lease, or DEAD job. Rows before v1.8.3 with provider
  `console` / `mailer` and status `SENT` were **not** delivered (history is preserved, no backfill).

## Not in this patch (follow-ups)

- System Health issues `pipeline.notify-unqueued` / `pipeline.notify-dead` (CRITICAL for SOS / CRASH) — monitoring files
  were out of scope for this task; the data (`notifyError`, `notifiedAt`) and the queries above are ready for them.
- Chaos-harness `notifier` process and scenarios (`notify-xadd-fail`, `notifier-throw`, `notifier-kill-mid-send`); the same
  scenarios are covered here at integration level against a real DB and Valkey.
- UI help text ("SENT = accepted by the provider", bounded duplicate note, pre-v1.8.3 rows note) in the web notification log.
- In-process deferred driver-event e-mails (snapshot wait) are still lost on a crash during the wait (residual risk, as specified).
