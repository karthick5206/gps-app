# 14 · D6 release gate: implementation-ready specifications for G1–G8 (E0.5)

> **Owner review 2026-11-11 (after reviewing this document)**
>
> - **Authorised for implementation and isolated testing only: v1.8.1.** It covers G6 (health checks and the
>   `release.sh` health gate), G1 (share-page coordinate fix), G8 web (remove the hard-coded OpenFreeMap, self-hosted
>   tile fallbacks, a build check against external map URLs) and the inert G4 installer AOF settings for **fresh
>   installs** (the installer is not run on production). Branch: `feature/hardening-v1.8.1` from `origin/main`.
> - **Not authorised:** production deployment or restart, production Valkey changes, DB migrations, mobile store
>   submission, purchases or provisioning, destructive DB or backup operations.
> - **On hold:** v1.8.2 G5 (review after v1.8.1); G4 production AOF (separate maintenance approval, safety gate in G4);
>   v1.8.3 G2 + G3 (high-risk notifier change); v1.8.4 G7 phase A (separate review); G7 phase B off-site (provider,
>   purchase and provisioning approval); G8 mobile (mobile URL decision recorded in §9 Q4, EAS build approval).
> - **Corrections applied in this document:** A — G2 guarantee (no exactly-once promise; DB duplicates vs external
>   duplicates); B — G4 production safety gate; C — G7 restore gate and key handling; D — G8 compatibility protection
>   for old mobile installations.
> - **Open questions:** resolved in §9 with the decision date 2026-11-11 (README §7).

| Item | Value |
|---|---|
| Status | **Specification; v1.8.1 (G6, G1, G8 web, inert G4 installer edit) authorised 2026-11-11 for implementation and isolated testing only — nothing is deployed.** All other items are on hold (box above). Every item still ships as a separate v1.8.x patch and reaches production **only after separate owner approval** (O1). |
| Code baseline | worktree `D:\Vibhav\gps-app-wt\etms` = **v1.8.0 (f5b151b)**; every path and line below was re-read in this worktree on 2026-11-11. The routing branch was read with `git -C D:\Vibhav\gps-app show feature/routing-engine:<path>`. |
| Production facts | Lead check 2026-11-11 (README §2, `11` box): Ubuntu, systemd `veetrax-{api,gateway,processor,notifier,summarizer}`, deploy via `ops/deploy/linux/release.sh`; Valkey 7.2 `appendonly no`; nightly local backup `/usr/local/sbin/veetrax-local-backup` from `/etc/cron.d/veetrax-backup` (21:30 UTC, `/var/backups/veetrax`, 14 days; `pg_dump -Fc` + Valkey RDB + config tarball incl. `.env` files and `/root/.veetrax-db-pass`; script **not in the repo**); no SMS / mail provider; `NODE_ENV=production`; web built with `VITE_MAP_STYLE_*` → `app.veetrax.com/tiles`; mobile EAS builds set no `EXPO_PUBLIC_MAP_STYLE_*` and `apps/mobile/eas.json` points at `gps.mintplus.co.in`; GraphHopper :8989, Photon :2322, Martin :3000 on localhost only. These are not verifiable from the repo and are taken as given. Exact production versions: `16` Lead box (Node 24.22.2, PostgreSQL 18.6 + TimescaleDB 2.31.0, Valkey 7.2.13, CPU without AVX). **Lead confirmations (E0.5 integration, 2026-11-11):** the production web build sets all three `VITE_MAP_STYLE_*` to `app.veetrax.com/tiles` (so F1 below is a live breach on the share page only); the production backup does **not** include uploaded files (`apps/api/var`). |
| Owner approvals that bound this spec | D1–D8 (D6 = this gate); **L4** push exception with generic payloads; **O8** encrypted off-site object storage, independent of production and of Git, user-controlled keys, nothing provisioned yet (provider and cost presented first, Q-03); **O9** keep the existing Google Maps hand-offs. |
| Test environment | Isolated test instance only: DB `veetrax_assess`, Valkey db 1, API :4100, web :5174 (modernization working agreement). Chaos runs need a scratch DB whose name ends in `_test` (`apps/api/scripts/chaos/chaos-run.ts` l.58–61). **Never production** for tests, drills or load. |
| Author / reviewers | E0.5 planning agent; to be reviewed by the Lead; owner approves each patch. |

Short references follow README §3 (`10` = `10-security-safety-and-privacy.md`, `11` = `11-testing-and-acceptance.md`,
`12` = `12-phased-implementation-plan.md`, `13` = `13-risks-dependencies-and-estimates.md`). **V** = verified in code
now; **P** = proposed design.

---

## 0. Summary

| Gate | Item | Effort (ew) | Risk of the change | Changes existing GPS-alert behaviour? | Depends on | Proposed patch |
|---|---|---|---|---|---|---|
| G1 | Share-page ETA line lat/lng swap | 0.25–0.4 | Low | No | none (GraphHopper on the test host for the visual check) | v1.8.1 |
| G2 | Lost alert notifications (XADD after commit; failed jobs acked) | 1.0–1.5 | **High** (notifier core, migration) | **Yes**: at-least-once with per-recipient dedupe, retries, DEAD state | schema owner; chaos harness extension; shares migration with G3 | v1.8.3 (with G3) |
| G3 | Misleading `SENT` for console / unconfigured providers | 0.4–0.6 | Medium | Recorded status only (no delivery change) | G2 migration (same columns) | v1.8.3 (with G2) |
| G4 | Valkey AOF + recovery validation | 0.4–0.6 | Medium (production config) | No (durability only) | dedicated Valkey 7.2 drill instance; owner maintenance window | ops change between v1.8.2 and v1.8.3; `install-ubuntu.sh` edit in v1.8.1 |
| G5 | Logout / revocation closes live sockets (R-14) | 0.4–0.6 | Low–Medium | No (socket lifecycle) | Lead (new `RedisKeys` channel) | v1.8.2 |
| G6 | GraphHopper / Photon / Martin health + `release.sh` post-deploy gate | 0.5–0.75 | Low | No | Lead (shared `HealthIssue.section`) | v1.8.1 |
| G7 | Secure backup **and restore** (O8) | 1.0–1.5 (+ procurement elapsed time) | Medium (production ops, secrets) | No | O8 provider + cost decision; key custody (O1); Lead read-only capture of the installed script; non-production drill host (C3) | v1.8.4 (phase A local-encrypted; phase B off-site) |
| G8 | Mobile **and web** builds without external map services | 0.5–0.75 | Medium (mobile server URL) | No | owner decision on the mobile server URL; O4 tools for network capture | web part v1.8.1; mobile = EAS build track |
| | **Total** | **≈ 4.5–6.7 ew** | | | | |

**Finding:** this total exceeds the `13` §3.2 E0.5 estimate of **2.5–4 ew**, which also includes 0.5-9 and 0.5-10. See §10.
**Lead resolution (E0.5, 2026-11-11):** `13` §3.2 and `12` §2 now use **4.5–6.7 ew** for G1–G8, plus 0.5–0.8 ew for
0.5-9 / 0.5-10, so E0.5 implementation = **5.0–7.5 ew** (confidence Medium); programme totals recomputed in `13` §3.2.

---

## G1 · Share-page ETA road line drawn with lat/lng swapped

### Problem (V)
- `apps/web/src/features/live-share/PublicSharePage.tsx:139`: `eta.route.map(([la, ln]) => [ln, la])` swaps every pair before handing it to MapLibre as GeoJSON.
- The API already sends `[lng, lat]`:
  - `apps/api/src/live-share/live-share.service.ts:178–179` (`LiveShareService.eta`) returns `route: road.shape` from `RoutingService.route`.
  - `RoutingService.fetchGraphHopper` (`apps/api/src/routing/routing.service.ts` l.126–141) decodes the polyline with `decodePolyline` (`apps/api/src/routing/route-estimate.ts` l.7–30), which pushes `[lng / factor, lat / factor]` (l.27).
- Result: whenever the routing engine answers (production `ROUTER_ENGINE=graphhopper`), the dashed ETA line is mirrored across the diagonal, so in India it lands far off the road (a lng of 80 becomes a lat of 80). README §2 records this as a confirmed live production bug.
- Contributing: the JSDoc of `RoutingService.route` (l.51) says "`[lat, lng] shape`", which is wrong. The shared DTO `PublicLiveShareDto.eta.route` (`packages/shared/src/live-share.ts` l.82) is `[number, number][]` with no stated order.
- The trail on the same page is correct: `data.trail.map(([, la, ln]) => [ln, la])` (l.137) matches the API's `[t, lat, lng]` (`live-share.service.ts` l.159).
- The fix exists only on the unreleased routing branch: commit `be6ad20` adds `apps/web/src/features/live-share/share-eta.ts` (`etaRouteFeatures`) and `share-eta.test.ts`.

### Root cause
An undocumented coordinate order crosses the API → web boundary, and a misleading JSDoc on `RoutingService.route` makes it worse (ETR-35).

### Proposed change (P)
1. Port `share-eta.ts` + `share-eta.test.ts` from `feature/routing-engine` (commit `be6ad20`). Copy the two files; do not merge the branch (D3).
2. `PublicSharePage.tsx` l.139: replace the inline mapping with `etaRouteFeatures(eta?.route)`.
3. `routing.service.ts` l.51: fix the JSDoc to "`[lng, lat]` shape (GeoJSON order)".
4. `packages/shared/src/live-share.ts` l.82: add a JSDoc "`route`: `[lng, lat]` pairs (GeoJSON order)". This is documentation only (Lead-owned contract file; no type change).
5. No API change, and no change to the Valkey `route:eta:*` cache (it already holds `[lng, lat]`).

GPS-alert behaviour: unchanged.

### Risks and blast radius
Web public share page only. Risk: someone "fixes" the API instead and breaks History gap estimates, which share `decodePolyline`. Mitigation: the unit test pins the contract.

### Acceptance criteria
1. `etaRouteFeatures` unit tests pass. They cover the order kept as is, every vertex with `lng > 60 && lat < 40` for India, and empty / one-point routes giving no line.
2. On the test instance with GraphHopper on, three synthetic shares (Chennai, Bengaluru, Delhi NCR) draw the dashed line on the road. Every vertex is within 30 m of a road in the base map; check by eye plus a spot check of 5 vertices against `/route` output.
3. `grep -rn "\[la, ln\]" apps/web/src/features/live-share` returns nothing.
4. The full web suite (`npm test -w @veetracer/web`) is green.

### Test plan
- **Unit:** `node --test src/features/live-share/share-eta.test.ts` (web `test` script, `apps/web/package.json` l.11).
- **Integration:** none needed (pure mapping).
- **Manual, test instance:**
  - API :4100, web :5174, `ROUTER_ENGINE=graphhopper` against a GraphHopper with the India graph, if the test host has one (§9 Q9).
  - Otherwise, point `ROUTER_URL` at a stub that returns a recorded GraphHopper response for the three routes.
  - Create shares with a destination for three simulated vehicles (`sim:route`) and open the public page.

### Evidence required for sign-off
- Test output with pass counts.
- Before / after screenshots of the three shares. Use Playwright if O4 is approved, otherwise browser screenshots.
- The grep output.
- After the owner-approved deploy: one production screenshot of a real or test share with the route visible, and the deploy record.

### Rollback
`REF=v1.8.0 bash release.sh --web-only` (web rebuild only, no restart). There is no data impact.

### Owner, effort, dependencies
Web engineer; reviewer: Lead. 0.25–0.4 ew. Depends on none, apart from GraphHopper (or a stub) on the test host.

### Deployment notes
Web-only (`release.sh --web-only`). Proposed for v1.8.1 together with G6 and the G8 web part. Separate owner approval is required.
**Status 2026-11-11:** authorised for implementation and isolated testing only (v1.8.1); deployment not authorised.

---

## G2 · Alert notifications that can be lost

### Problem (V)
1. **The XADD comes after the commit, with no reconciliation.**
   - `apps/api/src/processor/position-processor.ts` l.199 writes positions and `Alert` rows in one transaction (`writeBatch`). Then:
     - l.211 XACKs the positions;
     - l.212 `commitRules` → `RulesBatch.commit()` (`processor/rules/rules-engine.ts` l.131–143) runs the `pipeline.xadd(RedisKeys.notifyStream …)` (l.137);
     - l.213 `commitTrips` → `PlannedTripBatch.commit()` (`planned-trips/tracker/tracker-engine.ts` l.254).
   - `commitRules` / `commitTrips` (l.569–585) only log on failure.
   - Same pattern (PG insert, then XADD, nothing reconciles) at:
     - `alerts/offline-alerts.service.ts` l.176/196 and l.225/244
     - `attendance/attendance.service.ts` l.725/743
     - `documents/reminders.service.ts` l.86/115
     - `planned-trips/planned-trip-job.service.ts` l.235/255
     - `alerts/notify-queue.service.ts` l.29–51 (`enqueueMessages`: `NotificationLog` rows `QUEUED`, then XADD `logIds`) and l.53–55 (`enqueueAlert`).
   - A processor crash between l.199 and l.212 loses the job in the same way.
   - No outbox or sweeper exists. These are all seven `Alert` insert sites; every one expects a `vt:notify` job.
2. **Failed jobs are acknowledged.** `apps/api/src/notifier/notifier.service.ts` `processAll` (l.209–234) catches any error from `handleAlert` / `handleLogs` (l.219–222), logs it, and then unconditionally `xack`s (l.230). There is no dead letter, and `XAUTOCLAIM` (l.191–207) only helps with crashes.
3. **Duplicate guard too coarse.** `handleAlert` l.254–255 skips an alert that has *any* `NotificationLog` row. A crash after some recipients were sent therefore silently drops the rest.
4. **Webhooks ride on the same job** (`processAll` l.223–226 → `WebhookWorkerService.onAlert`), so they are lost too.
5. **Escalation is empty** (`escalateAlarm` l.241–243). This is out of G2 scope (ETMS E6, `10` §6).

### Root cause
The alert → notification hand-off is at-most-once. Persistence (PostgreSQL) and enqueue (Valkey) are two separate writes with no record of "notified", and the consumer treats any processing as done.

### Proposed change (P)

**Schema (additive migration `<ts>_notifier_durability`, schema owner; shared with G3):**

| Table | Column / index | Purpose |
|---|---|---|
| `Alert` | `notifiedAt timestamptz(3) NULL` | Set by the notifier when an alert job finished, including zero channels, zero recipients, a deleted object and all-SKIPPED. |
| `Alert` | `notifyError text NULL` | Set when the job is declared DEAD; excludes the alert from the sweeper. |
| `Alert` | index `("createdAt") WHERE "notifiedAt" IS NULL AND "notifyError" IS NULL` | Sweeper lookup. |
| `NotificationLog` | `attempts int NOT NULL DEFAULT 0`, `nextAttemptAt timestamptz(3) NULL` (lease), `providerMessageId text NULL`, `dedupeKey text NULL` + **unique partial index** `WHERE "dedupeKey" IS NOT NULL` | Per-recipient idempotency and lease (G2); provider id (G3). Matches `03` §3 / `12` G3. |
| (data) | `UPDATE "Alert" SET "notifiedAt" = "createdAt" WHERE "createdAt" > now() - interval '25 hours'` | Prevents a burst of re-queued recent alerts at deploy. Older rows stay NULL but fall outside the sweeper's 24 h bound. |

`Alert` is not a hypertable (only `Position` is, init migration l.509). A plain `CREATE INDEX` inside Prisma's migration
transaction blocks `Alert` inserts while it builds. Measure the build time on a **synthetic** table with the production
row count (`SELECT count(*) FROM "Alert"`, read-only, by the Lead) before approval. If it takes too long, add a constant
lower bound to the index predicate (`AND "createdAt" >= '<deploy date>'`) and to the sweeper query.

**Notifier (`apps/api/src/notifier/notifier.service.ts`):**
1. `processAll`: **no `xack` when `handleAlert` / `handleLogs` throws.** The entry stays pending, and the existing `claimStale` (`XAUTOCLAIM`, idle 60 s, every 30 s) re-delivers it. In `claimStale`, read the delivery count (`XPENDING <key> <group> <id> <id> 1`, field `times_delivered`). At **≥ 5 deliveries**: set `Alert.notifyError` (or mark the `NotificationLog` rows `FAILED` with reason `dead after 5 attempts`), then `xack`, log at error, and count `deadJobs` in `NotifierMetrics`. Webhook dispatch stays after `handleAlert` and runs even on failure (idempotent per event id `${type}_${alertId}`, `webhook-worker.service.ts` l.75–77).
2. `handleAlert`: on every non-throwing exit path (l.247 alert missing excepted; l.257 no context; l.265 no channels; end of loop) set `notifiedAt = now()`. Keep the deferred driver-event e-mail (`deferEmail`) as is; **residual risk:** an in-process deferred e-mail is lost on a crash.
3. Replace the alert-level guard (l.254–255) with **per-recipient idempotency** in `deliver` (l.341–376):
   - `dedupeKey = ${alertId}:${channel}:${recipient}`.
   - Claim first: `INSERT … status QUEUED, attempts 1, nextAttemptAt now()+5 min ON CONFLICT (dedupeKey) DO NOTHING`.
   - If the row already exists with `status = QUEUED` and `nextAttemptAt < now()`, take it over with a conditional `UPDATE … SET attempts = attempts + 1, nextAttemptAt = now() + 5 min WHERE id = $1 AND status = 'QUEUED' AND "nextAttemptAt" < now()`. Allow at most 3 takeovers, then `FAILED`.
   - Otherwise skip.
   - After sending, `UPDATE` to the final status (`writeLog` becomes an update).
4. **Sweeper** (new `apps/api/src/notifier/notify-sweeper.ts`, started from `notifier/main.ts` next to `notifier.run()`):
   - Every 30 s, guarded by `pg_try_advisory_lock(<constant>)` so only one notifier instance sweeps.
   - Alerts: `SELECT id, "companyId" FROM "Alert" WHERE "notifiedAt" IS NULL AND "notifyError" IS NULL AND "createdAt" < now() - interval '60 seconds' AND "createdAt" > now() - interval '24 hours' ORDER BY "createdAt" LIMIT 500`, then XADD `alertId` jobs.
   - Pre-rendered messages: `NotificationLog` rows with `status = 'QUEUED' AND "dedupeKey" IS NULL AND "createdAt"` between 5 min and 24 h old get `logIds` jobs.
   - Throttle: skip the sweep while the `notifier` group's `lag + pending` > 1,000 (XINFO GROUPS). Re-queue each id at most once per 5 min (in-memory map).
   - If Valkey is down, XADD fails and the next tick retries. Alerts are durable in PostgreSQL, so nothing is lost; latency equals the outage length.
5. **System Health** (`apps/api/src/monitoring/checks.ts` `notifierChecks`, collected in `system-health.service.ts collect`):
   - `pipeline.notify-unqueued`: WARN when any alert in the last 24 h has `notifiedAt IS NULL` and is older than 5 min.
   - `pipeline.notify-dead`: WARN on any `notifyError` in the last 24 h; CRITICAL when the type is `SOS` or `CRASH`.
   - Both are two cheap indexed counts per collection.
6. **Producers are unchanged** (no edit to the seven insert sites). This is the smallest blast radius: the sweeper is the safety net for every producer, including future ones. ETMS events use the `OutboxEvent` instead (E1a, `05` §5).

**Delivery guarantee (owner correction A, 2026-11-11). G2 does not promise exactly-once delivery.** It guarantees:
1. **Durable job recovery:** every committed `Alert` gets a notification job, from the stream or from the sweeper, until it is `notifiedAt` or DEAD.
2. **Per-recipient deduplication within VeeTrax:** at most one `NotificationLog` record per `alertId + channel + recipient` (`dedupeKey` unique index).
3. **At-least-once delivery attempts:** a failed or interrupted attempt is retried within the budget (5 deliveries, 3 lease takeovers).
4. **A bounded, documented duplicate risk at the external-provider boundary:** if a process dies after the provider accepted a message but before the status `UPDATE`, or a lease is taken over after a send slower than 5 min, the recipient can receive the same message twice. The bound is one extra message per lease takeover, at most 3 per `dedupeKey`. It is documented in the notifier runbook and in the UI help text.
5. **Provider idempotency keys wherever supported:** the `dedupeKey` (or a hash of it) is passed as the provider's idempotency or client reference field where the provider API supports one, so that the provider can drop the repeat. Each provider's support is recorded in the test evidence (supported / not supported / not verifiable); where unsupported, risk 4 applies unchanged.

**Does it change existing GPS-alert behaviour? Yes, intentionally:**
- notification attempts are at-least-once with per-recipient dedupe of VeeTrax records, not at-most-once;
- a transient DB / provider error in a job leads to up to 5 redeliveries about 60–90 s apart, instead of silent loss;
- a partially sent alert completes its missing recipients;
- an alert whose XADD failed is notified about 60–90 s late instead of never.

Users may receive notifications that today are silently dropped, and webhooks fire for those alerts too.

### Risks and blast radius
- **Notifier process:** e-mail, SMS, push, WhatsApp and Arattai alert notifications, test messages, webhooks for alerts.
- **Duplicates:** duplicate **DB records** are prevented by the unique `dedupeKey`. Duplicate **external messages** are possible only if a process dies between the provider accepting a message and the status `UPDATE` (milliseconds), or on a lease takeover after a slow (> 5 min) send. This is the bounded, documented risk of the delivery guarantee above (at most one extra message per takeover), reduced by provider idempotency keys where supported, and measured in the acceptance tests.
- **Migration lock** on `Alert` (see above).
- **Sweeper load:** bounded (500 rows / 30 s, indexed).
- **Redelivery storm** if a bug makes every job throw: capped at 5 deliveries per entry, then DEAD + System Health. Note: System Health e-mails go nowhere today, because no mail provider is configured (C2); the issue shows on the System Health page and its socket.
- **Interaction with G4:** with AOF off, a Valkey restart drops pending entries; the sweeper re-creates alert jobs from PostgreSQL within 24 h.

### Acceptance criteria
1. **Chaos "XADD `vt:notify` fails after alert commit"** (new scenario `notify-xadd-fail`; Valkey blackholed for the notify write only, or killed between the processor commit and the XADD, 100 synthetic alerts):
   - 100 % of the alerts get a notification job and a `NotificationLog` row per recipient and channel within **2 min of recovery**;
   - 0 lost;
   - **duplicate DB records = 0:** no two `NotificationLog` rows per `alertId + recipient + channel` (`SELECT … GROUP BY … HAVING count(*) > 1` returns 0).
2. **Notifier job failure:** with an injected throw in `handleAlert` (fake provider or DB fault), the entry is **not** acked, it is redelivered, and it succeeds once the fault is removed. With a permanent fault it is DEAD after 5 deliveries, `notifyError` is set, and `pipeline.notify-dead` is raised.
3. **Partial resend:** kill the notifier after 1 of 3 recipients; after restart, all 3 have exactly one `NotificationLog` row (duplicate DB records = 0).
3a. **Duplicate external messages: bounded, documented, measured** (separate from the DB-record count). The fake provider records every message it accepts. In `notifier-kill-mid-send` (kill between provider acceptance and the status `UPDATE`, ≥ 100 iterations) and in a forced slow-send lease takeover, report the number of duplicate accepted messages per `dedupeKey`. Pass: no `dedupeKey` exceeds the documented bound (one extra message per takeover, at most 3), every duplicate falls in one of the two documented windows, and the measured rate is written into the evidence. Where a provider supports an idempotency key, a test shows the key is sent and stable across retries of the same `dedupeKey`.
4. **Zero-recipient and zero-channel alerts** get `notifiedAt` set and are never swept.
5. The existing chaos suite still loses **0 positions** (baseline 26,521 / 26,521, `docs/reliability/test-evidence.md` §2.1), re-run per condition C6.
6. The API Jest suite is green.

### Test plan
- **Unit (Jest, `apps/api/src/notifier/*.spec.ts`):**
  - `notifier.processAll.spec.ts`: no XACK on throw; DEAD at the 5th delivery.
  - `notifier.dedupe.spec.ts`: claim, conflict-skip, stale-lease takeover, max 3 takeovers.
  - `notify-sweeper.spec.ts`: query bounds, throttle, advisory lock.
  - `checks.spec.ts`: new issues.
- **Integration (`*.int.spec.ts` against a `_test` DB + private Valkey, existing guard pattern `/\/[a-z0-9_]+_test(\?|$)/`):** sweeper picks up an `Alert` row with no stream entry; notifier marks `notifiedAt`.
- **Chaos:**
  - Extend `apps/api/scripts/chaos/chaos-run.ts`. Today `startProc` only knows `api | gateway | processor` (l.140), so add `notifier` with a fake SMS / push provider (env `SMS_PROVIDER=fake-ok`, a test-only class).
  - Scenarios: `notify-xadd-fail`, `notifier-throw`, `notifier-kill-mid-send`.
  - DB: `veetrax_assess_test` (the harness refuses names without `_test`); private Valkey on its own port.
- **Manual, test instance (`veetrax_assess`, Valkey db 1, API :4100):** raise SOS from `sim:route`, stop the notifier for 3 min, start it, confirm delivery rows and `notifiedAt`.

### Evidence required for sign-off
- A dated folder `docs/employee-transport/evidence/<date>-g2/` with `results.md` + `results.json` from the chaos runs (counts per scenario; the DB duplicate query output, which must be 0; the measured external duplicate count per scenario against its bound; the provider idempotency-key support table).
- Jest output with pass counts.
- Migration SQL and the measured index build time on the synthetic table.
- After the deploy: the System Health screenshot (no `pipeline.notify-*` issues), `SELECT count(*) FROM "Alert" WHERE "notifiedAt" IS NULL AND "createdAt" BETWEEN now()-interval '24 hours' AND now()-interval '5 minutes'` = 0 one day after the deploy (read-only query by the Lead), and the deploy record.

### Rollback
- Redeploy the previous tag (`REF=v1.8.2 bash release.sh`).
- The migration is additive. Leave the columns in place: v1.8.2 code ignores them. The partial unique index on `dedupeKey` does not affect old code, because old code never writes `dedupeKey`.
- No data rollback is needed. Do **not** drop the columns in a down-migration.

### Owner, effort, dependencies
Backend engineer (notifier); schema owner for the migration; reviewer: Lead. 1.0–1.5 ew. Depends on the chaos-harness
notifier support, the G3 columns (same migration), and the production row count for `Alert`. G4 is recommended first but not required.

### Deployment notes
Ships together with G3 as v1.8.3 (one migration, one notifier owner, `12` §2.2 parallelism note). Deploy off-peak.
Watch `pipeline.notify-*` for 24 h. Separate owner approval is required. **Status 2026-11-11: on hold** (high-risk
notifier change; not part of v1.8.1).

---

## G3 · Misleading `SENT` status

### Problem (V)
- **Console SMS:** `ConsoleSmsProvider.send` (`apps/api/src/notifier/sms.ts` l.38–51) only logs "NOT DELIVERED" in production (`consoleSmsLine`, l.29–35) and returns normally. `notifier.service.ts deliver` l.374–375 therefore writes `status: 'SENT'`, `provider: 'console'`. Same in `sendLog` l.460–464. The console provider is the default (`createSmsProvider`, l.116–126).
- **E-mail without a provider:** `MailerService.send` (`apps/api/src/auth/mailer.service.ts` l.52–60) logs "NOT DELIVERED: no mail provider configured" and returns. The notifier records `SENT` with `provider: 'mailer'` (l.375).
- **The same pattern in other writers**, via `SystemMessagesService.log` (`apps/api/src/templates/system-messages.service.ts` l.40–70; its `status` type allows only `'SENT' | 'FAILED'`):
  - `auth.service.ts` l.207 (OTP SMS), l.221 (OTP e-mail, always `SENT`), l.242 (reset e-mail, always `SENT`);
  - `mobile-tracker/mobile-tracker.service.ts` l.254 and l.284.
- **Push:** `SENT` means "Expo accepted a ticket" (`push.ts` l.77–81). There are no receipts, and no ticket id is stored.
- **Correct today:** push disabled → `SKIPPED` (`sendPush` l.412); WhatsApp → `SKIPPED` (l.357); Super-Admin-disabled channels → `SKIPPED` (`channelOff` l.384–397).
- **Helpers that already know the truth:** `deliveryChannels()` (`apps/api/src/config/env.ts` l.80–87) and `MailerService.provider` (l.48–50).
- Production has no SMS or mail provider (Lead check), so every alert SMS and e-mail row in production today reads `SENT` without being delivered (R-37, ETR-15).

### Root cause
Providers signal "not configured" by logging, not through their return value, and the callers map "no exception" to `SENT`.

### Proposed change (P)
1. **`SmsProvider`** (`sms.ts`): add `readonly configured: boolean` (`ConsoleSmsProvider` false; `Msg91SmsProvider` `!!authKey`; `SmartpingSmsProvider` true when its env is complete). `SmsResult.messageId` is already returned.
2. **New `apps/api/src/notifier/delivery-outcome.ts`:** `outcome({ configured, error, messageId }) → { status: 'SENT' | 'FAILED' | 'SKIPPED', error, providerMessageId }`. Not configured → `SKIPPED` with error `"<channel> provider not configured"`; error → `FAILED`; otherwise `SENT`.
3. **Notifier:**
   - `deliver` (l.374–375) and `sendLog` (l.460–464) check `sms.configured` / `mailer.provider` **before** calling `send`. When not configured, write `SKIPPED` without calling the provider. In development the console / file copy can still be produced, but the status stays `SKIPPED` with the reason "development copy only".
   - Store `providerMessageId` (Smartping `transactionId`; Expo ticket ids, which needs `PushResult.ticketIds` added in `push.ts`).
   - Increment `attempts` with the `withRetries` count (`retry.ts` already returns `attempts`).
4. **`SystemMessagesService.log`:** widen `status` to `'SENT' | 'FAILED' | 'SKIPPED'`. Callers at `auth.service.ts` l.207 / l.221 / l.242 and `mobile-tracker.service.ts` l.254 / l.284 use the same `outcome()` helper. `mobile-tracker.service.ts` l.271 already refuses console SMS, so keep it.
5. No `DELIVERED` status (that needs provider receipts, E6). Document in the UI help text that `SENT` = "accepted by the provider".
6. **No backfill:** historical rows stay as they are. Optionally show a one-line note in the notification log UI: "rows before v1.8.3 with provider `console` / `mailer` were not delivered".

GPS-alert behaviour: no delivery change. Only the recorded status, the notifier metrics (`totals.skipped` rises,
`sent` falls) and anything that counts `SENT` change. `notifierChecks` (`checks.ts` l.196–212) uses sent + failed
only, so skipped rows do not trip the failure ratio.

### Risks and blast radius
- Notification logs UI and any customer report that counts `SENT`.
- OTP / reset flows: they already refuse in production without a provider (`forgotPassword` uses `deliveryChannels`).
- Development habits: developers may look for `SENT` in local logs.
- Low technical risk.

### Acceptance criteria
1. Unit test per provider: console, Smartping fake OK / 5xx, SMTP unset, Zoho unset, Expo fake OK / error, push disabled, Arattai off. The status equals the provider outcome in 100 % of cases.
2. A fake provider returning 5xx gives `FAILED` after 3 attempts with `attempts = 3` (`11` R7).
3. On the test instance with no providers, an alert with SMS + e-mail channels yields `SKIPPED` rows with the reason "provider not configured" and no `SENT` rows.
4. After the deploy on production: `SELECT count(*) FROM "NotificationLog" WHERE "createdAt" > '<deploy time>' AND status = 'SENT' AND provider IN ('console', 'mailer')` = 0 (read-only, Lead).

### Test plan
- **Unit:** `delivery-outcome.spec.ts`, extend `sms.spec.ts`, `push.spec.ts`; new `notifier.deliver.spec.ts`; `system-messages.service.spec.ts`.
- **Integration:** in the G2 chaos `notifier` run, assert the statuses.
- **Manual, test instance:** raise a synthetic `OVERSPEED` with SMS / e-mail channels; read `NotificationLog` via the web notification log.

### Evidence required for sign-off
Jest output with counts; a test-instance screenshot or query output of the `SKIPPED` rows with reasons; the production query result after the deploy.

### Rollback
Redeploy the previous tag. The new columns stay; old code writes `SENT` again (status quo).

### Owner, effort, dependencies
Backend engineer (notifier); reviewer: Lead. 0.4–0.6 ew. Depends on the G2 migration (shared columns).

### Deployment notes
v1.8.3 together with G2. Separate owner approval is required. **Status 2026-11-11: on hold** with G2.

---

## G4 · Valkey AOF, including recovery validation

### Problem (V)
- `ops/deploy/linux/install-ubuntu.sh` l.51–57 sets only `maxmemory-policy noeviction` for Valkey. It does not set `appendonly`, and production runs `appendonly no` (Lead check).
- System Health already warns: `checks.ts` l.176–183 raises `valkey.aof` ("Valkey appendonly is off …") from `system-health.service.ts` l.450 (`info.aof_enabled`).
- What a Valkey restart loses:
  - `vt:positions` entries not yet processed. The gateway spool covers a Valkey *outage* (`11` §1.5), not entries already accepted into Valkey.
  - all `vt:notify` jobs, consumer groups and pending entries;
  - rule state (`RedisKeys.alertState`) and live state.
- The notifier and the processor recreate groups on `NOGROUP` (`notifier.service.ts` l.167–172; `redis/stream-groups.ts`), but the data is gone.
- The hardened kit `ops/valkey/valkey.conf.template` l.41–52 already has the AOF settings, and `ops/valkey/test/restore-test.sh` has a tested restore procedure. Its comment l.18–19 documents the key pitfall: "**With appendonly yes and no AOF, Valkey would start EMPTY and ignore dump.rdb**".

### Root cause
The Ubuntu install script never adopted the AOF settings from the hardened kit.

### Proposed change (P)
1. **`ops/deploy/linux/install-ubuntu.sh`** after l.54: idempotently set the following in `/etc/valkey/valkey.conf` (same `sed` / `grep -q || echo` pattern):
   - `appendonly yes`
   - `appendfsync everysec`
   - `auto-aof-rewrite-percentage 100`
   - `auto-aof-rewrite-min-size 64mb`
   - `aof-use-rdb-preamble yes`
   - `aof-load-truncated yes`
   - `no-appendfsync-on-rewrite no`

   Keep the RDB `save` lines. For a **fresh** install only, restart is safe (no data yet).

   **This installer edit is the only G4 item in v1.8.1 (authorised 2026-11-11 for implementation and isolated testing).** It is inert for production: the installer is not run on production. **Not part of v1.8.1:** any `CONFIG SET`, any edit of the production `/etc/valkey/valkey.conf`, any Valkey restart, any `maxmemory` change.
2. **Production change procedure** (new `ops/deploy/linux/VALKEY-AOF.md`, run in an owner-approved off-peak window; **no Valkey restart needed**). **On hold: needs a separate maintenance approval**, given only after the drill evidence below and only if the safety gate passes.

   **Production safety gate (owner correction B, 2026-11-11), all required before the owner is asked to authorise the window:**
   - **Measured free disk and memory**, recorded in the transcript just before step 2: free space on the Valkey `dir` filesystem ≥ 3× `used_memory_dataset` plus 2 GiB, and available host memory (`MemAvailable`) ≥ `used_memory_rss` (fork copy-on-write worst case) plus 2 GiB. If either is below, stop; do not run step 2.
   - **Stream and consumer-group counts before and after:** `XLEN`, `XINFO GROUPS` (`pending`, `lag`) for `vt:positions` and `vt:notify`, and `DBSIZE`, captured in step 1 and step 6. Post-counts equal pre-counts plus normal traffic, and every consumer group is still present.
   - **AOF rewrite completed with a successful write status:** `aof_rewrite_in_progress:0`, `aof_enabled:1`, `aof_last_bgrewrite_status:ok`, `aof_last_write_status:ok` before the config file is touched (step 3).
   - **Documented recovery procedure if the rewrite fails** (in `VALKEY-AOF.md`, rehearsed on the drill instance): if `aof_last_bgrewrite_status:err` or `aof_last_write_status:err`, or the rewrite does not finish within the agreed time, run `CONFIG SET appendonly no` at once (Valkey keeps its data in memory and accepts writes again); **do not** edit `valkey.conf` and **do not** restart; confirm `rdb_last_bgsave_status:ok` (run `BGSAVE` if needed) and the stream / group counts; collect `INFO persistence`, `df`, and the Valkey journal; leave any partial files in `appendonlydir` for analysis; report to the owner before any retry.
   - **`maxmemory`:** any change needs its own separate approval (§9 Q8); it is never part of the AOF window.

   Procedure:
   1. Pre-check: `valkey-cli INFO persistence`, `INFO memory` (`used_memory_human`, `used_memory_rss`, `used_memory_dataset`), `df -h /var/lib/valkey`, `grep MemAvailable /proc/meminfo`, `DBSIZE`, `XLEN vt:positions`, `XLEN vt:notify`, `XINFO GROUPS vt:positions`, `XINFO GROUPS vt:notify`. Apply the safety-gate thresholds.
   2. `valkey-cli CONFIG SET appendonly yes` (the server rewrites an AOF from memory in the background), then `CONFIG SET appendfsync everysec`.
   3. Wait for `aof_rewrite_in_progress:0`, `aof_enabled:1`, `aof_last_bgrewrite_status:ok` and `aof_last_write_status:ok`.
   4. Persist: edit `/etc/valkey/valkey.conf` with the same lines as step 1. Then `CONFIG GET appendonly` / `appendfsync` and `grep` the file to prove they match.
   5. **Never** edit the file and restart before step 3: that starts Valkey empty.
   6. Post-check: the same counters as step 1; System Health `valkey.aof` WARN cleared. On any failure in steps 2–4, follow the recovery procedure above.
3. **Backup interaction (G7):** keep the RDB `BGSAVE` copy in the backup bundle. Optionally add an AOF directory tarball, as in `ops/valkey/valkey-backup.sh` l.35.
4. No application code change.

GPS-alert behaviour: unchanged (durability only).

### Risks and blast radius
- **Production Valkey** (every service depends on it).
- Fork + copy-on-write memory during the rewrite: measure `used_memory`; the host has about 16 GiB available (Lead).
- Disk: AOF plus rewrite temporary copy (≈ 2–3× dataset).
- `everysec` fsync latency: negligible at the current rate; measure on the drill.
- Separate observation: `install-ubuntu.sh` sets **no `maxmemory`**, so with `noeviction` Valkey can grow until the host runs out of memory. Not part of G4; flagged for the owner (§9 Q8).

### Acceptance criteria
1. **Recovery drill** on a **dedicated throwaway Valkey 7.2 instance** (same major as production, own port such as 6390, own `dir`). **Not** the shared WSL Valkey whose db 1 serves the test instance, because that instance also hosts other environments.
   - Run the test-instance processes against it, accumulate a backlog (processor stopped, about 10,000 positions; notifier stopped, about 100 jobs), then `kill -9` Valkey and restart it.
   - `XLEN vt:positions` / `vt:notify` equal to the pre-kill values minus at most 1 s of writes.
   - `XINFO GROUPS` lists `processor`, `notifier` (and `relay`, `webhooks` where present) with the same `pending` counts.
   - After restarting the processes: 0 positions lost against the simulator's record.
2. **AOF restore onto a fresh Valkey:** copy `appendonlydir` to a new empty `dir`, start a second instance, and get the same counts (pattern `ops/valkey/test/restore-test.sh`).
3. **Chaos `cache-restart-empty` passes with AOF on.** Also add a scenario `cache-kill-aof`: kill -9 then restart with data, expecting 0 lost and no group recreation.
4. **Measured:** rewrite duration, peak RSS during the rewrite, AOF size after the rewrite, and the p99 of processor batch latency with and without AOF (from the chaos report).
4a. **Recovery procedure rehearsed** on the drill instance: a rewrite forced to fail (for example a full or read-only `dir` on the throwaway instance) is handled by the documented steps, with no data loss and the stream / group counts unchanged.
4b. **v1.8.1 installer edit:** on a fresh throwaway install (test host or VM, never production) `install-ubuntu.sh` leaves the AOF lines in `valkey.conf` exactly once after two runs (idempotent), and Valkey starts with `aof_enabled:1`.
5. **Production after the window (only after the separate maintenance approval):** the safety-gate transcript is complete (free disk and memory measured, before / after counts, rewrite and write status `ok`); `CONFIG GET appendonly` = `yes`; `INFO persistence` shows `aof_enabled:1` and `aof_last_write_status:ok`; System Health has no `valkey.aof` issue.

### Test plan
- **Unit:** none.
- **Integration / chaos:** `chaos-run.ts` with its private Valkey started with `--appendonly yes`.
- **Manual drill** as above on the test host. Script it as `ops/deploy/linux/valkey-aof-drill.sh` (new, test-only, refuses port 6379 and any `REDIS_URL` without `127.0.0.1:63[89]x`).
- **Production:** only the documented `CONFIG SET` procedure with its safety gate, in a separately approved window. Nothing in production under v1.8.1.

### Evidence required for sign-off
- The drill log (before / after `XLEN`, `XINFO GROUPS`, `XPENDING` summary, timings, RSS, AOF size).
- Chaos results for `cache-restart-empty` and `cache-kill-aof`.
- The production transcript of the procedure (pre / post `INFO persistence`, `CONFIG GET`, `grep` of `valkey.conf`) and a System Health screenshot.

### Rollback
`valkey-cli CONFIG SET appendonly no`, revert the `valkey.conf` lines, and optionally remove `appendonlydir` after a fresh `BGSAVE`. No restart is needed.

### Owner, effort, dependencies
Ops engineer; approver: owner (window). 0.4–0.6 ew. Depends on a Valkey 7.2 binary on the test host and the owner-approved window.

### Deployment notes
- The `install-ubuntu.sh` edit has no effect on the running server; it is part of v1.8.1 (**authorised 2026-11-11 for implementation and isolated testing only**, fresh installs).
- The production change is a config operation in its own approved window. Recommended **after** v1.8.2 and **before** v1.8.3, so G2's sweeper and AOF together close the notify gap. **Status 2026-11-11: on hold** — separate maintenance approval, after the safety gate above.

---

## G5 · Logout and session revocation close live socket connections (R-14)

### Problem (V)
- **Handshake only:** `apps/api/src/live/live.gateway.ts afterInit` l.62–77 authenticates the socket once, with `AuthContextService.fromToken`. `fromToken` (`access/auth-context.service.ts` l.32–42) checks the session (`revokedAt`, `expiresAt`) and returns `sessionId`.
- **The refresh ignores the session:** `refreshAll` (l.272–289; every 60 s, l.90, and on `cacheInvalidate`, l.263–269) re-resolves with `contexts.forUser(ctx.userId, …)` (l.277). This is by user id only, with no session check, and `client.ctx = next` (l.280) even drops the `sessionId`. A logged-out user's socket keeps streaming until it drops.
- **Revocation sites that publish nothing:**
  - `TokenService.revoke` (`auth/token.service.ts` l.67–72, used by `AuthService.logout` l.123–133)
  - `revokeOwn` (l.85–88), `revokeOthers` (l.91–97), `revokeAll` (l.99–101, used by the password reset `auth.service.ts` l.165)
- **Probe evidence:** `docs/modernization/tenant-isolation-probes.md` F-1 (0 → 9 `live:batch` events in the 10 s after logout). That doc cites `live.gateway.ts:252`; the method is now at l.272.
- **Existing safe paths:** an inactive user or suspended company is already disconnected within 60 s, because `forUser` throws (l.54–55).
- **Client:** both `apps/web/src/features/live/realtime.ts` (l.80–88) and `apps/mobile/src/features/live/realtime.ts` (l.81–88) react to `io server disconnect` by refreshing the token. A revoked session fails the refresh, and the API client signs the user out. **No client change needed.**

### Root cause
The socket is bound to a user, not to the session that opened it, and revocation is not broadcast.

### Proposed change (P)
1. **New channel** `RedisKeys.sessionsRevoked = 'vt:sessions:revoked'` (Lead-owned `apps/api/src/redis/keys.ts`, `12` §1). Payload: `{ sessionIds?: string[]; userId?: string; allExcept?: string; at }`.
2. **`TokenService`:** after each successful update in `revoke`, `revokeOwn`, `revokeOthers` and `revokeAll`, publish the affected session ids (`revokeOthers` / `revokeAll`: `userId` + `allExcept`). Publish failures are logged, not thrown; step 4 is the fallback.
3. **`LiveGateway`:**
   - Store `sessionId` on `Client` at `handleConnection` (from `socket.data.ctx.sessionId`).
   - Subscribe to `sessionsRevoked` in `afterInit` (l.79–87) and `disconnect(true)` matching sockets immediately.
4. **`refreshAll`:** collect the clients' `sessionId`s, run one `prisma.session.findMany({ where: { id: { in } }, select: { id, revokedAt, expiresAt } })` per tick, and disconnect sockets whose session is missing, revoked or expired. Preserve `sessionId` when replacing `client.ctx` (fix l.280). This bounds the worst case to 60 s even if the pub/sub message is lost (for example Valkey down).
5. Optional, recommended: an `AuthContextService.sessionValid(id)` helper reused by the HTTP guard and the gateway.

GPS-alert behaviour: unchanged. In-app alert events stop for revoked sessions, which is intended.

### Risks and blast radius
- Live map and in-app alerts for web and mobile. A wrong session comparison would disconnect everyone; the clients then reconnect with a fresh token, so there is no lockout, only reconnect churn.
- Load: one extra indexed query per 60 s per API instance.

### Acceptance criteria
1. After `POST /api/auth/logout`, or an admin / own `DELETE` of the session, the socket receives **no event after 5 s** in **20 / 20 runs**, and is disconnected with reason `io server disconnect`.
2. With pub/sub suppressed (Valkey channel blocked), it is disconnected within **≤ 65 s**.
3. `revokeOthers` disconnects the other sessions' sockets and keeps the current one.
4. `apps/api/scripts/tenant-isolation-probe.ts` probe 1 (F-1) → **PASS**, with all 20 original probes PASS (21 PASS rows, 0 FAIL; `16` §6.1 Q13, Lead-confirmed).
5. The Jest suite is green.

### Test plan
- **Unit (Jest):**
  - `live.gateway.session.spec.ts`: revoked message disconnects the matching socket only; `refreshAll` with a revoked or expired session disconnects; `sessionId` is preserved.
  - `token.service.spec.ts`: every revoke path publishes.
- **Integration:** a socket.io client against the test API :4100 (probe script mode).
- **Manual, test instance:** web :5174 logged in on two browsers; logout in one; the other session stays live; DevTools shows the socket closed in the first.

### Evidence required for sign-off
Probe script output (20 / 20 PASS incl. F-1); a 20-run loop log with the time to the last event; Jest output.

### Rollback
Redeploy the previous tag. No schema or data change.

### Owner, effort, dependencies
Backend engineer (live gateway); reviewer: security role; Lead for `RedisKeys`. 0.4–0.6 ew. No other dependencies. It is an E1a entry dependency (`12` §3).

### Deployment notes
v1.8.2 (API restart only). Separate owner approval is required. **Status 2026-11-11: on hold**, reviewed after v1.8.1.

---

## G6 · Map-service health checks and a `release.sh` post-deploy health gate

### Problem (V)
- **No map-service checks:** `apps/api/src/monitoring/checks.ts evaluateChecks` (l.289–303) covers processes, ports, tracking, queues, stores (PostgreSQL, Valkey, disk), notifier failures and relay. It has nothing for GraphHopper, Photon or Martin.
- **What their failure looks like today:**
  - `RoutingService` returns `null` on failure (`routing.service.ts` l.54–62, l.126–135), so a stopped GraphHopper only shows as missing ETAs and road snapping.
  - `GeocodingService` reads `GEOCODER_URL` (`geocoding/geocoding.service.ts` l.30).
  - Martin has no API setting at all. It is reached only through Caddy (`ops/deploy/linux/Caddyfile` `handle /tiles/india/*` → `127.0.0.1:3000`), and a stopped Martin means blank maps for every user.
- **No release gate:** `ops/deploy/linux/release.sh` l.47–50 restarts, `sleep 5`, then prints `systemctl status`, with no health check and no failing exit code.
  - Health endpoints already exist: `GET /api/health/ready` (`apps/api/src/health.controller.ts` l.10, 503 when PostgreSQL / cache are down), `GET /api/health/tracking`, and the gateway `:4121/health` (`gateway/main.ts` l.48, l.270; `gateway/spool/gateway-health.ts` l.64).
  - The script header still says "NOT yet run on a real server" (l.6), although production deploys use it.
- **System Health e-mails** are sent by `SystemMonitorService` (evaluated every 15 s, `system-monitor.service.ts` l.19), but production has no mail provider, so they are not delivered (C2).

### Root cause
The map stack was added later (`ops/deploy/linux/maps/README.md`) without monitoring, and the release script predates the health endpoints.

### Proposed change (P)

**System Health:**
1. **Env** (`apps/api/.env`, documented in `ops/deploy/linux/maps/README.md`): reuse `ROUTER_URL`, `GEOCODER_URL`; add `MARTIN_URL` (production `http://127.0.0.1:3000`). A service whose URL is unset is "not configured" and not checked.
2. **New collector** `apps/api/src/monitoring/map-services.ts` `collectMapServices()`: one HTTP GET per service with a 2 s timeout, run inside `SystemHealthService.collect` (l.106–137).
   - Endpoints to confirm against the installed versions on the test host:
     - GraphHopper `GET /health` (expects `OK`);
     - Photon `GET /status`;
     - Martin `GET /health` (expects `OK`).
   - Optional functional probe at most every 5 min: GraphHopper `/route` Chennai → Coimbatore with `calc_points=false`, as in maps README l.50; Photon `/reverse` (l.51).
   - Keep the last result in memory and report a failure only after **2 consecutive failures** (about 30 s), to avoid flapping.
3. **`CheckInput`** gains `maps: { name: 'graphhopper' | 'photon' | 'martin'; configured: boolean; ok: boolean; latencyMs: number | null; error: string | null }[]`.
4. **New `mapChecks`** in `checks.ts`:
   - `maps.graphhopper`: WARN, "routing, ETAs and road snapping are skipped". It becomes CRITICAL once ETMS ETAs depend on it (`11` R5).
   - `maps.photon`: WARN, "addresses and place search unavailable".
   - `maps.martin`: **CRITICAL**, "map tiles unavailable: web and mobile maps are blank".
5. **Shared contract** (Lead): `packages/shared/src/system-health.ts` l.268 `HealthIssue.section` += `'maps'`, and `SystemHealthDto` += `maps`. The web `SystemHealthPage.tsx` lists issues generically (l.120–135); add a small "Map services" card.

**`release.sh` health gate:**
1. Record `PREV=$(git rev-parse --short HEAD)` before the checkout. After the restart, replace `sleep 5` + `status` with `health_gate`:
   - `systemctl is-active --quiet` for each of `$SERVICES` (retry for up to 30 s);
   - poll `${API_HEALTH_URL:-http://127.0.0.1:4000/api/health/ready}` until HTTP 200 (timeout `HEALTH_TIMEOUT_SEC`, default 90);
   - poll `${GATEWAY_HEALTH_URL:-http://127.0.0.1:4121/health}` until 200;
   - poll `${TRACKING_HEALTH_URL:-http://127.0.0.1:4000/api/health/tracking}` and accept 200 (OK / WARN). The default is on; `HEALTH_GATE_TRACKING=0` disables it for a first install with no devices.
   - Map services (not deployed by `release.sh`): `curl` each configured URL and print a **warning only**.
2. **On failure:** print `journalctl -u <failed unit> -n 50 --no-pager`, then "RELEASE FAILED HEALTH GATE — roll back with `REF=$PREV bash release.sh`", and exit **1**. No automatic rollback (owner decision 2026-11-11, §9 Q7).
3. **`--health-only` flag:** runs only the gate, with no checkout, build or restart. This is the "dry run", usable on the test instance with `API_HEALTH_URL=http://127.0.0.1:4100/api/health/ready`.
4. Update the l.6 header.

GPS-alert behaviour: unchanged.

### Risks and blast radius
- System Health page and its socket, and `release.sh` on every future deploy.
- False negatives (the gate fails while the service is fine): mitigated by retries and timeouts, plus an env override.
- Check traffic: 3 tiny requests per 15 s on localhost.

### Acceptance criteria
1. On the test instance, stopping each of GraphHopper, Photon and Martin raises its issue within **2 min**, and starting it clears the issue within **2 min**. This needs the services on the test host, or local stubs, §9 Q9.
2. A service whose URL is unset raises nothing.
3. `bash release.sh --health-only` with the API stopped exits **non-zero** within `HEALTH_TIMEOUT_SEC` and prints the journal tail. With everything healthy it exits **0**.
4. Unit tests for `mapChecks` (configured / unconfigured / failing / recovering / 2-consecutive rule).

### Test plan
- **Unit:** `checks.spec.ts` additions; `map-services.spec.ts` with a local HTTP stub server.
- **Integration:** `system-health.service` collect with stubs.
- **Manual, test instance:**
  - `systemctl stop` / `start`, or kill the stub, for each service; watch System Health on web :5174.
  - Run `release.sh --health-only` against API :4100 with the API up and down.
  - Shell lint: `shellcheck release.sh`, if O4 allows it.

### Evidence required for sign-off
Jest output; screenshots or logs of each issue raised and cleared with timestamps; the `release.sh --health-only` transcripts (fail and pass, with exit codes).

### Rollback
Redeploy the previous tag. Revert `release.sh` with the same tag (the script runs from the checked-out tree). Unset `MARTIN_URL` to silence the Martin check.

### Owner, effort, dependencies
Ops engineer (+ backend for the collector); Lead for the shared contract. 0.5–0.75 ew. Depends on map services or stubs on the test host.

### Deployment notes
v1.8.1. Ship it **first**, so that every later patch is deployed through the gate. Separate owner approval is required.
**Status 2026-11-11:** authorised for implementation and isolated testing only (v1.8.1); deployment not authorised.
Severities as proposed and no automatic rollback (§9 Q7).

---

## G7 · Secure backup and restore, consistent with O8

### Problem (V for the repo, Lead facts for the server)
- **Production backup is undocumented and not in the repo:** `/usr/local/sbin/veetrax-local-backup` from `/etc/cron.d/veetrax-backup`, nightly at 21:30 UTC, 14 days in `/var/backups/veetrax`. It contains `pg_dump -Fc`, the Valkey RDB and a config tarball including `.env` files and `/root/.veetrax-db-pass` (Lead check).
- **On the same disk:** the archives sit on the production host, so a host loss or ransomware loses both data and backups.
- **Unknown from the repo:** whether these archives are encrypted. They contain secrets.
- **Uploads not covered:** per the Lead's description, the production backup does **not** include uploaded files (`apps/api/var`: documents, selfies, media, invoices, reports). The repo kit includes them (`ops/backup/veetrax-backup.sh` l.8, l.66–71).
- **Reusable repo kit** (WSL-targeted, path-agnostic via conf):
  - `ops/backup/veetrax-backup.sh` (l.1–123): snapshot-consistent `pg_dump` + manifest row counts of 11 tables; Valkey `BGSAVE` copy; uploads; config; optional pre-encryption verify-restore; GPG to a **public key only**; `UPLOAD_CMD`; `last-status.json`.
  - `ops/backup/veetrax-restore.sh` (l.1–53): throw-away `GNUPGHOME`, checksums, **refuses a non-empty target**, verifies counts.
  - `ops/backup/s3-put.sh`, `ops/backup/aws/{bucket-policy,iam-backup-writer,lifecycle}.json`: write-only IAM, TLS-only, SSE.
  - `ops/backup/backup.conf.example`.
- **GitHub Release assets:** the Windows flow (`ops/backup/README.md` l.10, `nightly-backup.ps1`) uploads age-encrypted dumps as GitHub Release assets to `veetrax/dailydbbackup` (O8: retire after the G7 drill).
- **Earlier provider record:** `docs/modernization/backup-plan.md` §4 records "Off-site destination: AWS S3 Mumbai (ap-south-1). Owner decision 2026-11-09; **not created yet**". The E0 pack does not mention it (§10).
- **No secret guard:** `.gitignore` has no backup / key patterns, and CI (`.github/workflows/ci.yml`) has no secret scan.
- **No freshness check:** System Health has no backup check.

### Root cause
Backups were set up by hand on the new Ubuntu host during the move (v1.8.0), outside the repo. The repo kits target the older WSL / Windows hosts, and the off-site target was never provisioned.

### Proposed change (P)
**Principle (O8, `12` §1):**
- The repo holds **scripts and documentation only**. Dumps, archives, keys, passphrases and storage credentials never enter Git.
- Backups are encrypted **client-side** to a key the owner controls before they leave the host.
- The off-site store is independent of production and of Git.
- Nothing is bought or provisioned until the owner approves the provider and cost.

**Phase A: in-repo kit and local encrypted backups (no purchase):**
1. **Capture:** the Lead reads the installed script and cron read-only (`sudo cat`) and records their behaviour in the runbook, **with secrets redacted**, after owner approval of the access. The script itself is replaced, not copied, if it handles secrets inline.
2. **Reuse `ops/backup/veetrax-backup.sh` / `veetrax-restore.sh` unchanged in logic; generalise only paths and comments** (it says "Runs inside WSL"). Add:
   - `ops/deploy/linux/backup.conf.example`:
     - `OUT_DIR=/var/backups/veetrax`
     - `UPLOADS_DIR=/opt/veetrax/app/apps/api/var`
     - `CONFIG_FILES=/opt/veetrax/app/apps/api/.env /opt/veetrax/app/apps/web/.env /etc/caddy/Caddyfile /etc/valkey/valkey.conf /opt/veetrax/maps/graphhopper.yml` (exact list confirmed at capture; `/root/.veetrax-db-pass` only if the owner wants it inside the encrypted bundle)
     - `VERIFY_ADMIN_URL` for the pre-encryption restore check
     - `GPG_RECIPIENT_FILE=/etc/veetrax/veetrax-backup.pub.asc`
     - `UPLOAD_CMD=""`
   - `ops/deploy/linux/veetrax-backup.service` + `veetrax-backup.timer`: `OnCalendar=*-*-* 21:30:00 UTC`, `Persistent=true`, runs as root, `Nice=10`, `IOSchedulingClass=idle`. They replace the cron entry, which is removed only after two successful timer runs.
   - `ops/deploy/linux/BACKUP.md`, the runbook: what is backed up, schedule, RPO (≤ 24 h) / RTO target (≤ 2 h), key custody, restore steps, quarterly drill, retiring the GitHub Release flow, and what to do on a failed backup.
3. **Encryption (all backups; owner decision Q3, 2026-11-11):**
   - GPG public key on the server. The private key is generated **offline on the owner's machine** and **never** placed on the server or in Git.
   - **Existing plaintext backups are not deleted** until an encrypted backup **and its restore** have been verified (acceptance criterion 1) **and** the deletion is separately approved by the owner. `/var/backups/veetrax` mode `0700` root.
   - **Scope (owner correction C):** `apps/api/var` (documents, selfies, invoices, media, reports) is in the backup scope (`UPLOADS_DIR` above), and its file count and total size are written to the manifest.
4. **System Health** (`checks.ts` + `system-health.service.ts`):
   - read `BACKUP_STATUS_FILE` (default `/var/backups/veetrax/last-status.json`);
   - the script writes it world-readable (`0644`, no secrets: time, size, sha256, counts, `uploaded`);
   - the directory needs `0711` so the `veetrax` user can read the file.
   - Issues:
     - `backup.stale` WARN when `at` is older than **26 h**;
     - `backup.failed` WARN when `ok:false`;
     - `backup.not-offsite` WARN when `uploaded:false` once `BACKUP_OFFSITE_REQUIRED=true` (phase B).
   - New section `'backup'` (Lead, shared contract).
5. **Git guard:**
   - `.gitignore` += `*.dump`, `*.sql.gz`, `*.tar.gpg`, `*.age`, `*.asc` (except `ops/**/*.pub.asc` if the owner wants the public key in the repo, which is optional and harmless), `*.pem`, `*.key`, `backup.conf`, `restore.conf`.
   - CI job `secret-scan`: gitleaks (free; O4) **or** a fallback `scripts/check-no-secrets.sh` (`git ls-files` extension and pattern check, plus a grep for `BEGIN .*PRIVATE KEY`).

**Phase B: off-site (after the O8 provider and cost decision, Q-03):**
1. Provision the chosen store with versioning + object lock / immutability (if offered), lifecycle retention, TLS-only, and a **write-only** credential on the server. Read / delete credentials are held by the owner only. The existing AWS policy files are the template.
2. `UPLOAD_CMD` in `/etc/veetrax/backup.conf` (`0600`, not in Git) uses `s3-put.sh` (S3-compatible) or `rclone`, the latter only if approved (new package on production).
3. Set `BACKUP_OFFSITE_REQUIRED=true`.
4. After a successful off-site drill, retire the GitHub Release upload of the Windows flow (O8 default) and archive `ops/backup/README.md` as historical.

**Off-site provider (Lead, E0.5 integration):** the **default is AWS S3 Mumbai (ap-south-1)** — the earlier owner
decision of 2026-11-09 recorded in `docs/modernization/backup-plan.md` §4, with **verified prices** from the AWS Price
List API (publication 2026-11-04, e.g. S3 Standard $0.025 / GB-month, Glacier Instant Retrieval $0.005 / GB-month,
egress $0.1093 / GB; estimate today < $0.10 / month) and an existing kit. It is consistent with O8 (approved
2026-11-11) and needs **only owner confirmation and purchase approval** (README §7 O10). Nothing is bought or created.
**Owner decision 2026-11-11 (§9 Q1, O10): AWS S3 Mumbai (ap-south-1) is confirmed as the target. The purchase is NOT
authorised**; it needs its own approval together with G7 phase B provisioning.
The other candidates below remain alternatives if the owner does not confirm; their prices are not given here and must be
quoted at decision time.

**Candidates (S3 Mumbai = default; the rest = alternatives):**

| Candidate | Why on the list | Points to check at decision time |
|---|---|---|
| AWS S3, Mumbai (ap-south-1) | Earlier owner decision 2026-11-09 (`docs/modernization/backup-plan.md` §4, not provisioned); kit exists (`s3-put.sh`, policies, lifecycle); India region; Object Lock | Current price list; egress cost for a full restore; whether the 2026-11-09 choice still stands |
| Cloudflare R2 | S3-compatible; the owner already has a Cloudflare account (tunnels); no egress fees by design | Data location / jurisdiction options vs India data-residency preference; object-lock / bucket-lock support |
| Backblaze B2 | S3-compatible; Object Lock | Region (no India region known to us; verify); egress terms |
| Google Cloud Storage (Mumbai / Delhi) or Azure Blob (Central India) | India regions; retention / immutability policies | S3-compatibility of the upload path (needs a different upload command); price |
| Wasabi or another S3-compatible store | S3-compatible; immutability | Minimum storage duration / minimum billing terms; region |
| Second host or disk at a different provider (e.g. an rsync / restic target) | Independent of the production host; no object-store learning curve | Is it truly independent (different provider, account and site)?; immutability is weaker |

Required properties for any choice:
- client-side GPG encryption (user-controlled key);
- a write-only credential on the server;
- versioning or immutability ≥ 30 days;
- a lifecycle retention matching L3 / the owner's choice;
- TLS;
- a restore cost known in advance.

**Key custody procedure (owner decision 2026-11-11, §9 Q2 / O11; the deputy's name is still open):**
1. The owner generates the GPG key pair (RSA 4096 or ed25519 / cv25519) offline, with a strong passphrase.
2. The owner holds **two protected copies** of the private key and passphrase in places the owner controls (for example an encrypted USB in a safe plus a password-manager entry or a printed paper key in a separate location). Never on the server, in Git, in chat or in e-mail.
3. The server gets **only** the public key (`/etc/veetrax/veetrax-backup.pub.asc`) and **write-only** storage credentials.
4. **One sealed deputy copy** is part of the decision. The deputy must be **explicitly named** before a real recovery arrangement is considered; until then this part stays open (O11).
5. Restore: the key is imported only into the throw-away `GNUPGHOME` of `veetrax-restore.sh` on the drill / restore host, which deletes it on exit.
6. Rotation: on staff change or suspicion, generate a new key, switch the public key on the server, and keep the old private key until the last backup encrypted to it expires.
7. Storage credentials: the server holds write-only. Read / delete stay with the owner and are rotated yearly.
8. Every use of the private key is recorded in `BACKUP.md`'s drill log (date, who, why).

GPS-alert behaviour: unchanged.

### Risks and blast radius
- Production host I/O and CPU at 21:30 UTC: `pg_dump` + the optional verify-restore on the same server doubles the I/O. Measure, or move the verify to the drill host.
- Disk use in `/var/backups`.
- **Secrets:** the bundle contains `.env` files, so encryption is mandatory.
- **Losing the private key** makes every backup useless; mitigated by two copies and the quarterly drill.
- A wrong `CONFIG_FILES` list loses configuration.
- Removing the cron before the timer is proven leaves a gap.

### Acceptance criteria
1. **Restore gate: drill on a non-production host** (test host or staging, C3; never production). All of the following must be proven (owner correction C, 2026-11-11):
   - download (phase B) or copy (phase A) the latest encrypted bundle;
   - `veetrax-restore.sh` into an empty `veetrax_restore_test`;
   - **DB table counts match:** the manifest row counts **equal** for all `COUNT_TABLES` (`VERIFY: PASS`);
   - **uploaded files match:** the restored `apps/api/var` file count **and** total size equal the manifest (**add both to the manifest**);
   - **Valkey RDB valid:** it passes `valkey-check-rdb` and loads into a throwaway Valkey 7.2 (`DBSIZE` > 0);
   - **config restored into quarantine only:** a separate quarantine directory, compared by checksum against the manifest; it is **never applied automatically** (no copy into `/etc`, `/opt/veetrax` or `.env` by any script);
   - **restore time measured**, target RTO ≤ 2 h, from "start download" to "API on the restored DB answers `/api/health/ready`";
   - the private key is used only in the throw-away `GNUPGHOME` on the drill host and is **never** on the production server or in Git.
2. `backup.stale` WARN appears when `last-status.json` is older than 26 h (simulated on the test instance) and clears after a run.
3. `git ls-files` contains no dump, archive, key or secret, and the CI secret-scan job is green and fails on a planted test file.
4. The key custody record exists: who holds the key, where, and the number of copies. It is written in `BACKUP.md` without the key itself.
5. Phase B: one bundle is visible in the store, the server credential **cannot** list, read or delete (tested), and the read credential downloads it.

### Test plan
- **Unit:** `checks.spec.ts` for the backup issues (fresh / stale / failed / not-offsite).
- **Integration:** run `veetrax-backup.sh` on the test host against `veetrax_assess` (synthetic data) with a **test key pair** (not the production key) → `veetrax-restore.sh` into `veetrax_restore_test`.
- **Manual drill:** the production bundle restored on the non-production drill host by the owner or a named person (the production key is used only there); timings recorded.
- **Security:** the planted-file test for the secret scan.

### Evidence required for sign-off
- The drill log in `docs/employee-transport/evidence/<date>-g7/`: counts table, timings, hosts, **no data**.
- Secret-scan output (pass and planted-fail).
- System Health screenshots of the stale WARN raised and cleared.
- The `BACKUP.md` key-custody section.
- Phase B: the store's object listing with the owner's read credential (names, sizes, dates only) and the denied list / read / delete attempts from the server credential.

### Rollback
- Disable the timer (`systemctl disable --now veetrax-backup.timer`) and re-enable the cron.
- The repo files are inert. Unset `BACKUP_STATUS_FILE` to silence the check.
- Off-site objects stay until the lifecycle expires them.

### Owner, effort, dependencies
Ops engineer; approver: owner (key custody, provider, cost, retirement of the GitHub Release flow). 1.0–1.5 ew plus
procurement elapsed time. Depends on O8 provider and cost (Q-03), owner key generation, the Lead's read-only capture of
the installed script, and a non-production drill host (C3).

### Deployment notes
- **Phase A** (repo kit, timer, local encryption, freshness check) as v1.8.4. Installing the timer and removing plaintext archives are production operations needing explicit approval.
- **Phase B** only after the purchase is approved and provisioned.
- Separate owner approval for each.
- **Status 2026-11-11: both phases on hold.** Phase A: separate review. Phase B: provider confirmed (S3 Mumbai), but purchase and provisioning need approval. The read-only, secrets-redacted capture of the installed script and cron is approved (§9 Q11); no destructive backup operation is authorised.

---

## G8 · Mobile and web builds with no external map services

### Problem (V)
1. **Mobile:**
   - `apps/mobile/src/lib/config.ts` l.7–11 defaults `MAP_STYLE` to `https://tiles.openfreemap.org/styles/{liberty,positron,dark}`, used by `features/map/basemap.ts useMapStyle` (l.70–76) for every map screen.
   - `apps/mobile/eas.json` l.6–12 sets only `EXPO_PUBLIC_SERVER_URL=https://gps.mintplus.co.in`, so store and preview builds fetch OpenFreeMap tiles and talk to `gps.mintplus.co.in`, not `app.veetrax.com`. `config.ts` l.2 has the same default.
2. **Web, the public share page ignores the build env:**
   - `apps/web/src/features/live-share/PublicSharePage.tsx:104` creates its map with `style: OPENFREEMAP.standard`, **hard-coded**.
   - The production share page therefore loads OpenFreeMap styles, tiles and glyphs **even though** the production build sets `VITE_MAP_STYLE_*`. Every external viewer's IP and the viewed area go to a third party.
   - This contradicts the brief's correction row and README §6 "Map tiles today", which attribute the web risk only to code defaults. It is a live production breach of "nothing leaves the server".
3. **Web, other maps:**
   - `apps/web/src/features/live/map/map-style.ts` l.33–37 falls back to `OPENFREEMAP.*` when `VITE_MAP_STYLE_*` is unset. Production sets them (Lead), so those maps are self-hosted in production.
   - `apps/web/.env.example` l.3–4 suggests OpenFreeMap.
4. **Dormant:** `packages/shared/src/basemap.ts satelliteStyle` (l.37–42) always uses `OPENFREEMAP.glyphs` and `OPENFREEMAP.vector` for the hybrid overlay. It is reached only when satellite imagery is configured (`ESRI_BASEMAP_KEY`, off; maps README l.13).
5. **Self-hosted styles exist:** `ops/deploy/linux/maps/make-styles.sh` writes `/opt/veetrax/maps/tiles/styles/{liberty,positron,dark}.json` with tiles, fonts and sprites under `https://app.veetrax.com/tiles`, and fails if "openfreemap" remains (l.26).
6. **O9 hand-offs, keep unchanged:**
   - mobile `sos/[id].tsx` l.54–55 `openDirections` (`google.navigation:` / `maps://` / Google web);
   - mobile `attendance-day.tsx` l.18 `openMap`;
   - web `AttendancePage.tsx` l.106 and l.159 (`https://www.google.com/maps?q=`);
   - web `ShareLiveDialog.tsx` l.93 (`wa.me` share link, user-initiated).

   These are user-initiated links, not background map loads.
7. Not map-related but external in the web bundle: `features/billing/razorpay.ts` l.3 (checkout script, payments only). It is out of G8 scope and listed for completeness.

### Root cause
OpenFreeMap was the development default and was never replaced in code. One page bypasses the configurable style, and the EAS profiles were never updated after the move to self-hosted tiles and `app.veetrax.com`.

### Proposed change (P)

**Web:**
1. `PublicSharePage.tsx` l.104: use the configured standard style (export `shareStyleUrl()` from `map-style.ts`, returning `STYLE_URLS.standard`).
2. `map-style.ts` l.33–37: fall back to the **same-origin self-hosted** styles (`/tiles/styles/liberty.json`, `/tiles/styles/positron.json`, `/tiles/styles/dark.json`) instead of OpenFreeMap.
3. `packages/shared/src/basemap.ts`: remove `OPENFREEMAP`. Add `selfHostedStyles(base: string)` and let `satelliteStyle` take `{ glyphs, vector }` from the caller: `${base}/tiles/fonts/{fontstack}/{range}.pbf` and a TileJSON or tiles URL `${base}/tiles/india/{z}/{x}/{y}`.
4. `apps/web/.env.example`: self-hosted examples. A comment explains that local development without Martin may point at OpenFreeMap **explicitly** in `.env.local`, never by default.
5. **Build check:** after `npm run build -w @veetracer/web`, `release.sh` runs `grep -rIl "openfreemap" apps/web/dist && exit 1`. It also fails the release when `VITE_MAP_STYLE_STANDARD` is unset in `apps/web/.env`.

**Mobile:**
1. `config.ts` l.7–11: default to `${SERVER_URL}/tiles/styles/{liberty,positron,dark}.json`.
2. `eas.json` `build.base.env`: set `EXPO_PUBLIC_MAP_STYLE_STANDARD|LIGHT|DARK=https://app.veetrax.com/tiles/styles/…json`, and `EXPO_PUBLIC_SERVER_URL=https://app.veetrax.com` (**owner decision 2026-11-11, §9 Q4 / O12**: new builds use `https://app.veetrax.com`).
3. **No change** to the O9 hand-offs or to push registration (Expo / FCM, L4).
4. **Compatibility protection for old installations (owner correction D, 2026-11-11):** existing installs may still use `gps.mintplus.co.in`. That endpoint **stays functional** (serving or proxying to production, not a redirect that breaks API calls) for the whole migration period. **Changing the mobile production build** (a store submission with the new URL) and **retiring the old endpoint** each need a **separate owner approval**; neither is part of v1.8.1. Retirement is proposed only once request logs show old-build traffic on `gps.mintplus.co.in` has dropped to an owner-agreed level.

**Status 2026-11-11:** the web part is in v1.8.1 (authorised for implementation and isolated testing only). The mobile
part is **on hold**: the URL is decided, but the EAS build and any store submission need approval.

GPS-alert behaviour: unchanged.

### Risks and blast radius
- **All maps** on web and mobile. If `/tiles` is down (Martin or Caddy), maps are blank instead of falling back to a third party, which is intended and monitored by G6 `maps.martin`.
- **Local development** without Martin shows blank maps unless the developer opts in.
- **Mobile server URL change:** new builds talk to a different host. Existing installs keep `gps.mintplus.co.in` until updated, so that host must keep serving during the transition (owner correction D: the old endpoint is preserved; retiring it needs separate approval). What `gps.mintplus.co.in` points at today is to be recorded before the mobile build is approved.
- The Martin styles are pinned to `app.veetrax.com` (`make-styles.sh` `SITE`).

### Acceptance criteria
1. **Mobile:**
   - A preview EAS build (`eas build --profile preview`) installed on an Android emulator, 5 min of map use (fleet map, history, alert detail, geofence, POI);
   - network capture shows **0 requests** to hosts other than the configured server host(s), excluding push registration (`exp.host`, FCM; D7 / L4);
   - the O9 links are **not** tapped during the capture, and are checked separately to still open Google Maps.
2. **Web:**
   - the production-mode build (`.env` with `VITE_MAP_STYLE_*`) has `grep -rIl openfreemap apps/web/dist` empty;
   - a browser capture (HAR) of the live map, history, geofences, routes and the **public share page** shows 0 requests to any host other than the app origin;
   - with `VITE_MAP_STYLE_*` unset, the build still contains no OpenFreeMap URL and maps load from `/tiles/…`.
3. `eas.json` diff reviewed by the Lead; `make-styles.sh` output has no external host (its existing check).
4. **Old-install compatibility (owner correction D):** with a current store build (old URL), against the test host aliased as `gps.mintplus.co.in` or, after the approved mobile release, by a read-only check of production: login, live map and alert list work through `gps.mintplus.co.in`, and `GET https://gps.mintplus.co.in/api/health/ready` returns 200. A new build pointed at `https://app.veetrax.com` passes criterion 1 at the same time.

### Test plan
- **Unit:** `basemap.spec`, in shared or web (`node --test`): `selfHostedStyles`, `satelliteStyle` with an injected base; the share page uses the configured style (component-level test or a grep-based test).
- **Integration:** web build + dist grep, scripted as `scripts/check-no-external-maps.sh` (new); runs in CI on the web build.
- **Manual, test instance:**
  - Web :5174 against a test-host Martin or a static copy of `/opt/veetrax/maps/tiles` plus a test `pmtiles` extract.
  - Mobile preview build against the test host (via the tunnel or LAN, or `EXPO_PUBLIC_SERVER_URL` = the test URL).
  - Capture: Android emulator `-tcpdump capture.pcap`, then list DNS query names and TLS SNI (tshark / Wireshark; free tools under O4); web: Chrome DevTools HAR export, or Playwright `page.on('request')` if O4 is approved.

### Evidence required for sign-off
- Host lists (unique hostnames with counts) from the mobile and web captures.
- The EAS build id and profile.
- The `eas.json` diff.
- The dist grep output.
- The web build env check (the `VITE_MAP_STYLE_*` variable names and values with no secrets).
- After the web deploy: a production HAR summary of the public share page (host list only).

### Rollback
- Web: redeploy the previous tag (web-only).
- Mobile: do not promote the build; the previous store build remains. No server or data change.

### Owner, effort, dependencies
Mobile engineer (EAS); web engineer (web part); reviewer: Lead. 0.5–0.75 ew. Depends on the owner decision on the
mobile server URL, O4 tools for captures, and a reachable test `/tiles`.

### Deployment notes
- **Web part** in v1.8.1 (`release.sh --web-only` would suffice; bundled with G1 and G6).
- **Mobile part** is an EAS build plus a store submission, not a server deploy. The server URL is decided (`https://app.veetrax.com`, 2026-11-11); the EAS build, the store submission and any retirement of `gps.mintplus.co.in` each need their own approval (they change what newly installed apps talk to). **On hold.**

---

## 7. Release grouping proposal

Each patch needs a **separate owner approval** before production (O1, `12` §1). Each is tagged, deployed with
`REF=v1.8.x bash release.sh`, and through the G6 gate from v1.8.1 onwards.

| Order | Patch | Contents | Why together / why this order | Restart / migration |
|---|---|---|---|---|
| 1 | **v1.8.1** | G6 (health checks + `release.sh` gate), G1 (share-page line), G8 web part (share page style, self-hosted fallbacks, dist check), G4 `install-ubuntu.sh` edit (inert on the running host) | Low risk, no migration, no notifier change. G6 first so that every later patch goes through the gate. G1 and G8 touch the same page (`PublicSharePage.tsx` l.104, l.139). | API restart + web build; no migration |
| 2 | **v1.8.2** | G5 (session-bound sockets) | Auth-adjacent; kept alone for a clean rollback. E1a entry dependency. | API restart; no migration |
| 3 | **Ops window** | G4 production AOF switch (`CONFIG SET`, no restart) | After the test drill; before G2 so that streams are durable when the notifier starts relying on redelivery | none |
| 4 | **v1.8.3** | G2 + G3 (notifier durability + truthful status) | One migration, one owner, same files (`12` §2.2). Highest risk, shipped once the gate and AOF are in place. | Migration (additive) + notifier / API restart |
| 5 | **v1.8.4** | G7 phase A (repo kit, systemd timer, local GPG encryption, freshness check) | Independent of code risk. Needs key generation by the owner. The freshness check ships with the timer so it does not WARN before backups exist. | API restart; production timer install (approval) |
| 6 | **Ops** | G7 phase B (off-site store, drill, retire GitHub Release flow) | Only after the provider and cost approval (Q-03 / O8) and provisioning | none |
| parallel | **Mobile build** | G8 mobile (EAS profiles, config defaults) | Not a server deploy; waits for the server-URL decision; can run any time after v1.8.1 (needs the `/tiles` styles reachable) | none |

Alternative if fewer deploys are wanted: merge v1.8.2 into v1.8.1 (both low risk, no migration). **Not recommended**:
it makes a session-logic regression harder to isolate.

**Status (owner review 2026-11-11):** v1.8.1 = **authorised for implementation and isolated testing only** (branch
`feature/hardening-v1.8.1` from `origin/main`; no production deployment or restart). Every other row = **on hold**:
v1.8.2 reviewed after v1.8.1; the G4 ops window needs a separate maintenance approval; v1.8.3 is a high-risk notifier
change; v1.8.4 needs a separate review; G7 phase B needs provider purchase and provisioning approval; G8 mobile needs
EAS build approval.

---

## 8. Cross-cutting test-environment notes

| Topic | Note |
|---|---|
| Test instance | `veetrax_assess`, Valkey db 1, API :4100, web :5174. Synthetic data only (`12` §1). The probes refuse :4000. |
| Chaos runs | The harness requires a DB whose name ends in `_test` and a private Valkey (`chaos-run.ts` l.58–61). Use `veetrax_assess_test` (migrated + seeded), not `veetrax_assess`. |
| Valkey drills (G4) | The test instance shares a WSL Valkey (db 1) with other local environments. **Do not `kill -9` it.** Run a dedicated Valkey **7.2** (production major) on its own port and data directory. |
| Map services (G1, G6, G8) | GraphHopper / Photon / Martin may not exist on the test host (§9 Q9). Fallback: small HTTP stubs with recorded responses for the unit / integration level; the real stop / start checks wait for staging (C3). |
| Production | Read-only checks by the Lead only (queries, `INFO`, `CONFIG GET`); no tests, drills or load (`12` §1). |
| Evidence | `docs/employee-transport/evidence/<date>-g<N>/`, tokens redacted (`0a92ec5` pattern); `PROGRESS.md` row per item (item · risk · commit · tests with counts). |

---

## 9. Open questions for the owner

Each question is merged into README §7 under the ID shown (E0.5 Lead integration). **All twelve were answered by the
owner on 2026-11-11** (column "Owner decision"); the parts that stay open are marked **open**. The recommended
defaults are kept for the record.

| # | Question | Recommended default | Owner decision (2026-11-11) |
|---|---|---|---|
| Q1 | **Off-site storage provider (O8 / Q-03; README O10).** Does the 2026-11-09 choice of AWS S3 Mumbai (`docs/modernization/backup-plan.md` §4, verified prices) still stand, and is the purchase approved? India data residency required? | **Confirm AWS S3 ap-south-1** (earlier owner decision, verified prices, kit exists) and approve the purchase when G7 phase B is authorised; alternatives (e.g. Cloudflare R2) only if the owner does not confirm | ✅ **Resolved.** AWS S3 Mumbai (ap-south-1) confirmed as the target. **Purchase NOT authorised.** |
| Q2 | **(README O11)** **Key custody:** who generates and holds the GPG private key, where are the two copies, is there a named deputy, and who may run a restore? Who holds the storage read / delete credential? | Owner holds both copies (safe + password manager); one sealed deputy copy; the server gets public key and write-only credential only | ✅ **Resolved, except the deputy.** The owner holds two protected private-key copies plus one sealed deputy copy; the server gets only the public key and write-only storage credentials. **Open:** the deputy must be explicitly named before a real recovery arrangement is considered. |
| Q3 | **(README O11)** Is today's local backup (`/var/backups/veetrax`) encrypted? It holds `.env` files and `/root/.veetrax-db-pass`. May the plaintext archives be deleted after the first verified encrypted run? | Encrypt everything; delete plaintext after verification. *(Uploads: Lead-confirmed that today's backup omits `apps/api/var`; adding them is now part of G7's scope, `12` §2.1.)* | ✅ **Resolved.** Encrypt all backups. Do not delete existing plaintext backups until an encrypted backup and its restore have been verified **and** deletion is separately approved. |
| Q4 | **(README O12)** **Mobile server URL:** keep `gps.mintplus.co.in` (current `eas.json` and code default) or switch new builds to `app.veetrax.com`? What does `gps.mintplus.co.in` serve today, and must it keep serving old installs? | Switch to `app.veetrax.com`; keep `gps.mintplus.co.in` proxying or redirecting to production until old installs have updated | ✅ **Resolved.** New mobile builds use `https://app.veetrax.com`; the old endpoint is preserved for existing installations (G8 correction D). The EAS build, store submission and retirement of the old endpoint need separate approval. |
| Q5 | **(README O17)** G2 retry budget: DEAD after 5 deliveries (≈ 5–8 min)? Sweeper window 24 h? CRITICAL only for SOS / CRASH? | Yes to all three | ✅ **Resolved.** Five deliveries, a 24-hour sweep window, CRITICAL for SOS / CRASH. |
| Q6 | **(README O17)** G3: show `SKIPPED` ("provider not configured") also in development, and leave historical `SENT` rows unchanged with a UI note? | Yes | ✅ **Resolved.** `SKIPPED` for unconfigured providers in development and production; historical records are preserved. |
| Q7 | **(README O17)** G6: Martin down = CRITICAL, GraphHopper / Photon = WARN until ETMS? Should a failed release gate roll back automatically? | Yes to the severities; no automatic rollback (manual `REF=<previous>` with the printed command) | ✅ **Resolved.** Proposed health severities approved; no automatic rollback. |
| Q8 | **(README O17 / O1)** G4 maintenance window. Should a `maxmemory` limit be set for Valkey as a separate item (today none, with `noeviction`)? | Off-peak IST window; raise `maxmemory` as a separate approved item after measuring | ✅ **Resolved.** `maxmemory` stays a separate future decision. *(The G4 production window itself stays under O1: separate maintenance approval after the G4 safety gate.)* |
| Q9 | **(README C3 / O13)** Test host capabilities (C3): GraphHopper / Photon / Martin and a Valkey 7.2 binary on the test host, or wait for staging? | Stubs for E0.5 unit / integration evidence; the real stop / start checks on staging, or on the test host if the services fit | ✅ **Resolved (test approach).** Local stubs for early tests; staging is required for production-class service checks. **Open:** C3 for the staging host itself (and O13). |
| Q10 | **(README O4)** O4 tools for evidence: Playwright, gitleaks, tshark / Wireshark (captures), shellcheck | Approve (free, dev-only) | ✅ **Resolved.** Free, developer-only test tools approved; no paid overage, no production installation. |
| Q11 | **(README O18)** Lead read-only access to the production backup script and cron for the G7 capture | Approve, redacting secrets in any notes | ✅ **Resolved.** Read-only, secrets-redacted inspection of the backup script and cron approved. |
| Q12 | **(README O19)** O9 scope: do the web `AttendancePage.tsx` Google Maps links (l.106, l.159) count as "existing hand-offs" to keep? | Yes, keep them (user-initiated, existing) | ✅ **Resolved.** Existing attendance Google Maps links preserved under O9. |

---

## 10. Findings that contradict or extend the existing documents

| # | Finding (V) | Affects | Suggested action |
|---|---|---|---|
| F1 | **The public share page hard-codes OpenFreeMap** (`PublicSharePage.tsx:104` `style: OPENFREEMAP.standard`). The production share page therefore loads third-party tiles **despite** `VITE_MAP_STYLE_*`. The docs say the production web build is self-hosted and only code defaults are at risk. `12` G8's web acceptance ("bundle built with `VITE_MAP_STYLE_*`") would pass while the breach continues. | `00` correction row, README §6 "Map tiles today", `12` §2.1 G8, VALIDATION §6 | Lead updates G8 acceptance to the dist grep + share-page HAR (this doc). Treat as a live breach fixed in v1.8.1. **Done in the docs (E0.5):** `12` G8, README §2 / §6 / §9, `02` §1.1, VALIDATION; the fix itself is outstanding and needs owner approval of v1.8.1. |
| F2 | `packages/shared/src/basemap.ts satelliteStyle` always uses OpenFreeMap glyphs / vector tiles (dormant while `ESRI_BASEMAP_KEY` is unset) | VALIDATION §6 (lists only Esri) | Fixed in G8 (self-hosted glyphs / vector) |
| F3 | Per the Lead's description, the production backup **does not include uploaded files** (`apps/api/var`), and its encryption is unknown although it contains secrets | README §2, `12` G7 | G7 adds uploads and mandatory encryption; Q3. **Lead-confirmed; applied to `12` G7, `13` ETR-17, README §2.** |
| F4 | `docs/modernization/backup-plan.md` §4 already records an **owner decision of 2026-11-09 for AWS S3 Mumbai** (not provisioned). The E0 pack (README O8, VALIDATION §8) presents the off-site target as undecided. | README §7 O8, `13` ETR-17 | Owner confirms or replaces it (Q1). **Applied:** README O10, `12` G7, `13` ETR-17, `02` §10 present S3 Mumbai as the default awaiting confirmation and purchase approval. |
| F5 | The `RoutingService.route` JSDoc (`routing.service.ts` l.51) says "`[lat, lng] shape`", while `decodePolyline` returns `[lng, lat]` (`route-estimate.ts` l.27). README §2 is right; the code comment is wrong and caused the G1 bug. | ETR-35 | Fixed in G1 |
| F6 | The alert-loss window is wider than "XADD fails": the processor XACKs positions (`position-processor.ts` l.211) before `commitRules` / `commitTrips`, so a **process crash** between the DB commit and the XADD also loses the job. Webhooks for those alerts are lost too. | `10` §1.5, `11` §1.5 | G2's sweeper covers both |
| F7 | `refreshAll` also **drops `sessionId`** from the socket context (`live.gateway.ts` l.280). F-1 in `tenant-isolation-probes.md` cites l.252 (now l.272). | `10` W4 | Fixed in G5 |
| F8 | The chaos harness starts only api / gateway / processor (`chaos-run.ts` l.140) and needs a `_test` DB. The G2 chaos acceptance in `12` assumes a notifier scenario that does not exist yet. The G4 drill cannot use the shared WSL Valkey of the test instance. | `12` G2 / G4, `11` §4 | Harness extension counted in the G2 effort; dedicated Valkey 7.2 for G4 |
| F9 | **Estimate:** G1–G8 alone come to about **4.5–6.7 ew** here, against `13` §3.2's **2.5–4 ew** for G1–G8 plus 0.5-9 / 0.5-10 | `13` §3.2, `12` §2 | Lead revises the E0.5 row (confidence stays Medium or lower). **Done:** `13` §3.2 E0.5 implementation 5.0–7.5 ew, Medium. |
| F10 | System Health e-mails (`SystemMonitorService`) cannot be delivered in production (no mail provider), so the new G2, G6 and G7 issues are visible only on the System Health page or socket | `12` G2 / G6 / G7 "System Health alert" wording | Note in acceptance; C2 (mail provider) unblocks e-mail |
| F11 | `release.sh` l.6 still says "NOT yet run on a real server", although production deploys use it | ops docs | Updated in G6 |
| F12 | `install-ubuntu.sh` sets no Valkey `maxmemory` while using `noeviction` | `11` §1.6 | Q8 (separate item) |

No code, schema, configuration, database or server was touched while writing this specification. Nothing was committed.
