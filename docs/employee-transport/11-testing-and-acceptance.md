# 11: ETMS testing, reliability, performance and acceptance (Agent 7)

E0 discovery · worktree `D:\Vibhav\gps-app-wt\etms` at **v1.8.0 (f5b151b)** · 2026-11-11 · read-only, nothing was run
against a database or a server. Each section is marked **Verified** (with evidence: path + symbol) or **Proposed**.
The terms follow `00-e0-brief.md` §2.

> **Lead verification on the production server (2026-11-11, `ssh veetrax-prod`):**
> - **Memory:** `free -h` shows **10 GiB used, 16 GiB available**. Resident memory: GraphHopper 8.6 GB, Photon 1.1 GB,
>   Martin 45 MB, PostgreSQL and Valkey small. The "≈ 3 GB headroom" below sums configured maxima (`-Xmx`, PG
>   tuning); it is a planning ceiling, not current use. Keep the advice: size an OR-Tools worker explicitly and never
>   load-test on production.
> - **Backups:** the nightly local backup is installed (`/etc/cron.d/veetrax-backup`, 21:30 UTC, `/usr/local/sbin/veetrax-local-backup`)
>   but is **not yet in the repo**.
> - **Valkey `appendonly` is `no`:** confirmed; this is a durability gap.

---

## 1. Current test and reliability capabilities (Verified)

### 1.1 Test inventory

Counts are from `find` / `grep` on the worktree. `node_modules` is not installed in the worktree, so `jest --listTests`
could not run. Case counts are approximate: lines that start with `it(` / `test(`.

| Workspace | Runner / config | Files | ≈ cases | Notes |
|---|---|---|---|---|
| `apps/api` | Jest 29 + ts-jest. Config in `apps/api/package.json` → `jest` (`rootDir: src`, `testRegex: .*\.spec\.ts$`, `setupFiles: test-env.ts`) | **139** `*.spec.ts` | **≈1,210** | Mostly pure unit tests with hand-made fakes for Prisma and Redis. **No `@nestjs/testing` `Test.createTestingModule` and no HTTP-level tests**, although `@nestjs/testing` is already a devDependency. |
| ↳ DB-gated integration | `describe.skip` unless an env URL points at a scratch DB | 5 | (in the 139) | `reports/reports-golden.int.spec.ts` (`REPORTS_TEST_DATABASE_URL`, name must end in `_test`), `purge/purge-financial.int.spec.ts` (`PURGE_TEST_DATABASE_URL`), `inventory/inventory.integration.spec.ts`, `inventory/replace.integration.spec.ts`, `sims/sims.integration.spec.ts` (`INVENTORY_IT_DATABASE_URL`) |
| ↳ `*.db-test.ts` | **Not matched by `testRegex`**. Run by hand with `--testRegex 'stock\.db-test\.ts$' --runInBand` | 1 | | `stock/stock.db-test.ts` uses the plain `DATABASE_URL` and has **no `_test` name guard** |
| ↳ Golden test | `reports/reports-golden.int.spec.ts` + `reports/__golden__/reports-golden.json` | 1 | 33 report types | Fixed clock `NOW = 2026-11-09T12:00Z`. The frozen fixture is a copy of `veetrax_assess`. `TRIP_PERFORMANCE` / `PLANNED_TRIPS` pin only the empty result. |
| `apps/web` | `node --test "src/**/*.test.ts"` (`apps/web/package.json` → `scripts.test`) | **33** | **≈193** | Pure helpers only (for example `features/planned-trips/trip-map.test.ts`, `features/routes/route-stops.test.ts`). No component, DOM or E2E tests. |
| `packages/shared` | none | 0 | 0 | |
| `apps/mobile`, `apps/tracker` | **none**: no `test` script, no `*.test.*` / `__tests__` | **0** | 0 | The tracker's native Kotlin offline queue (`trackerengine/PointQueue.kt`, `Uploader.kt`) has no JVM tests either. |
| Routing branch (`feature/routing-engine`, not in main) | Jest + pytest | `routing-v2/access.spec.ts`, `routing-v2.spec.ts`, `routing.int.spec.ts`; `services/routing-optimizer/tests/test_solver.py`, `test_server.py`, `bench_optimizer.py` | | The branch's `.github/workflows/ci.yml` **does not run pytest**. |

`docs/modernization/09-test-strategy.md` §1 is out of date: it gives 97 API files, 21 web files and "CI: none".

### 1.2 CI exists, but it is narrow

`.github/workflows/ci.yml` (added in commit `635be6d`) runs on every PR and on push to `main`.

| CI job | What it runs |
|---|---|
| `api` | `npm ci`, `build:shared`, `prisma generate`, `tsc --noEmit`, `npx jest --ci`, build |
| `web` | `tsc -b --noEmit`, `npm test` (node --test), `vite build` |

Gaps in CI:

| Gap | Effect |
|---|---|
| No PostgreSQL / Valkey service containers | All 5 DB-gated specs and the golden test **skip in CI**. They run only by hand. |
| No mobile / tracker typecheck or tests | Expo apps can break silently. |
| No `packages/shared` tests | |
| No E2E (web or mobile) | |
| No tenant-isolation probe | `apps/api/scripts/tenant-isolation-probe.ts` and `inventory-isolation-probe.ts` are manual black-box scripts against the isolated instance. |
| No chaos or load run | `apps/api/scripts/chaos/chaos-run.ts` is manual. |
| No coverage report | |
| No pytest | for the optimiser (routing branch) |

### 1.3 Test environments and evidence conventions

| Asset | Fact |
|---|---|
| Isolated instance | `PROGRESS.md` header and `docs/modernization/09-test-strategy.md` §2: DB `veetrax_assess`, Valkey **db 1**, API **:4100**, web **:5174**, gateway :5123/5127/5130/6908. Seed + GT06 simulator + `apps/api/scripts/partb-synth-day.ts` (synthetic history). Second tenant "Beta Transport (assessment)". `scripts/test-env/` was proposed and **does not exist**. |
| Scratch-DB guard | Each int spec has its own regex `/\/[a-z0-9_]+_test(\?|$)/` (`purge-financial.int.spec.ts`, `reports-golden.int.spec.ts`). `chaos-run.ts` refuses a `CHAOS_DATABASE_URL` that does not end in `_test`. The probes refuse `:4000`. Each spec uses a **different env var name**. |
| Evidence convention | `PROGRESS.md` tables: *Item · Risk · Commit · Tests / verification*, with explicit pass counts (for example "API 870/870, web 95/95"). Raw evidence lives in dated folders, for example `docs/reliability/evidence/2026-11-09-full-run/` (`results.md`, `results.json`, process logs). Tokens are redacted (commit `0a92ec5` pattern). |

### 1.4 Simulators and load assets

| Asset | Fact |
|---|---|
| `src/simulator/gt06-sim.ts` (`npm run sim`) | N GT06 devices random-driving around Chennai: the load generator |
| `src/simulator/register.ts` (`sim:register --count N`) | Registers simulator IMEIs as devices and objects |
| `src/simulator/route-sim.ts` (`sim:route`) | Drives GT06 devices along a route. Pure timeline in `route-drive.ts` → `buildTimeline`, `arrivalTable` (tested by `route-drive.spec.ts`). Sources in `route-source.ts`: `parseRouteFile`, `parseStopsArg`, `fetchGraphHopperPath`. Flags: `--imei-start/--count/--stagger` (multi-vehicle) and `--speed-factor` (max 6 at 30 km/h). |
| `sim:route` scenarios | `scenarios/on-time`, `late-stop`, `deviation`, `skip-stop`, `unscheduled-stop` on `chennai-route.json` (5 stops, 10.6 km) |
| Chaos harness | `scripts/chaos/chaos-run.ts` + `tcp-proxy.ts` → `ChaosProxy` (modes `up` / `cut` / `blackhole`). Starts the real `dist/` api/gateway/processor against a `_test` DB and a private Valkey. Scenarios: `baseline, cache-kill, cache-restart-empty, net-blackhole, net-cut, gateway-restart, processor-restart, db-interruption, dup-ooo, prolonged`. |
| Load evidence | `docs/MONITORING.md` §8: 100,000-position burst drained in 8.7 s (≈11,450/s) on a dev Mac. `docs/reliability/test-evidence.md` §2.1: **26,521 / 26,521 positions, 0 lost, 0 duplicate rows** across all chaos scenarios, including an 11-minute cache outage. |
| HTTP / API load tests | **None**: no k6, autocannon or artillery. |
| Playwright | **Not a dependency.** Used ad hoc only: `apps/mobile/scripts/gen-vehicle-icons.mjs` needs `playwright` through `NODE_PATH`. The UI screenshots in `docs/ui-modernization` came from headless capture. |

### 1.5 Failure behaviour of the pipeline (Verified from code)

| Path | Behaviour | Evidence |
|---|---|---|
| Gateway → `vt:positions` | XADD `MAXLEN ~ 2,000,000` (`DEFAULT_POSITIONS_STREAM_MAXLEN`, env `POSITIONS_STREAM_MAXLEN`). When the cache is down or the backlog passes 80 % of the cap, positions go to a fsynced disk spool (`gateway/spool/position-spool.ts`, `position-publisher.ts`, max 1 GB) and replay in order. | `redis/keys.ts`, `docs/reliability/ingestion-reliability.md` §3 |
| Processor | Writes positions, alerts and trip progress in one transaction (`processor/position-processor.ts` → `writeBatch`). Backoff of 1–30 s on DB errors. `XAUTOCLAIM` after 30 s. Dedupe by `mid` (`processor/recent-ids.ts`) plus the `(deviceId, fixTime)` primary key. Consumer group recreated on `NOGROUP` (`redis/stream-groups.ts`). | chaos evidence above |
| **Alert → notification hand-off** | **Not durable.** `position-processor.ts` XACKs the positions (l.211) and only then calls `RulesBatch.commit()` (`processor/rules/rules-engine.ts`) or `PlannedTripBatch.commit()` (`planned-trips/tracker/tracker-engine.ts`). Those XADD `vt:notify` (`MAXLEN ~ 100,000`, `NOTIFY_STREAM_MAXLEN` in `alerts/alert-dto.ts`). On failure, `commitRules` / `commitTrips` **only log**. The `Alert` row exists but no notification job is ever queued: there is no outbox or sweeper. `NotifyQueueService.enqueueMessages` has the same gap (PG insert, then XADD). | `position-processor.ts` → `commitRules`, `commitTrips` |
| Notifier | `notifier/notifier.service.ts` → `processAll` catches a job error and **XACKs anyway**. Sends retry 3× with 1 s / 3 s backoff (`notifier/retry.ts` → `withRetries`), then the `NotificationLog` row is `FAILED`. There is no later retry and no dead-letter queue. A crashed consumer's jobs are reclaimed with `xautoclaim`. | |
| Routing engine down | `routing/routing.service.ts` → `route()` / `estimateGaps()` return `null` on engine failure ("an engine failure only means no estimate"). This means **no fabricated ETA today**. | |
| Health | `/api/health/live`, `/ready`, `/tracking`; gateway `127.0.0.1:4121/health`. System Health checks are in `monitoring/checks.ts` and `thresholds.ts`. Prometheus `GET /api/metrics` (`vt_*` in `monitoring/system-health.controller.ts`). E-mail alerts with cooldown. | `docs/MONITORING.md` §2–4 |
| Not monitored | **GraphHopper (:8989), Photon (:2322), Martin** have no System Health check. There is **no HTTP request latency metric** (`monitoring/api-metrics.ts` holds only `sockets`, `sweeperLastRunAt`). | |

### 1.6 Backup, restore and production ops (Verified from repo; the server state was not inspected)

| Item | Fact |
|---|---|
| `ops/backup/veetrax-backup.sh` / `veetrax-restore.sh` | Encrypted bundle: `pg_dump -Fc`, Valkey RDB, uploads, config, and a manifest with sha256 and row counts of 11 tables. Restore refuses a non-empty target and verifies counts. S0.3 evidence: "11/11 counts equal under live writes" (`PROGRESS.md`). |
| `ops/backup/README.md` | Describes the **Windows** scheduled task and `nightly-backup.ps1` (age + GitHub Release). Last tested 2026-10-23. |
| Linux production | `ops/deploy/linux/*.service`: `Restart=always`, `RestartSec=5`, node `--max-old-space-size=512`. **No backup timer, no watchdog and no post-deploy health gate**: `release.sh` restarts, `sleep 5`, then `systemctl status`. `install-ubuntu.sh` sets Valkey `maxmemory-policy noeviction` but **not `appendonly yes`**. The hardened kit `ops/valkey/` (AOF, `valkey-backup.timer`) exists separately. |
| Memory budget on the 27 GiB box | PG 8 GB (`timescaledb-tune --memory 8GB`) + GraphHopper `-Xmx8g` + Photon `-Xmx3g` + 5 Node services (≈0.5–0.8 GB RSS each) + Valkey ≈1 GB for a full stream + Martin + OS ≈ **23–24 GB committed**. Only about 3 GB is left for an OR-Tools worker and a passenger-app API load. This drives the staging plan in §5.4. |

> **Validation note (E0 review):** Relevant to D6 / G7 and not flagged here: the Windows backup uploads age-encrypted dumps as **GitHub Release assets** to the private repo `veetrax/dailydbbackup` (`ops/backup/README.md` l.10), using a token with Contents read/write. Release assets are not Git history, but they do store backups on GitHub. Whether that storage is acceptable under D6 is an owner decision (README §7 O8). The repo also holds WSL-targeted `ops/backup/veetrax-backup.sh` / `veetrax-restore.sh` (GPG to a public key, upload only via an approved `UPLOAD_CMD`), which G7 should reuse.

> **Update in E0.5 (2026-11-11):** **O8 was approved by the owner on 2026-11-11** (README §1.1): encrypted off-site object storage, independent of production and of Git, with user-controlled encryption keys. Provider and cost are presented before anything is bought (decision Q-03), and nothing is provisioned under this approval. The G7 backup **and restore** drill (D6, approved as a gate, still outstanding) is planned against that target.

---

## 2. ETMS test strategy per phase (Proposed)

### 2.1 Layers and tools

| Layer | Tool | Why |
|---|---|---|
| Unit (api) | Jest (existing) | Pure rules: capacity, safety policy, booking cut-offs, schedule expansion with TZ/DST, ETA freshness, state machines |
| Unit (web) | `node --test` (existing) | Formatters, map/table helpers |
| DB integration | Jest `*.int.spec.ts` against a migrated `_test` DB | Fold `stock.db-test.ts` into this convention. One env var, **`TEST_DATABASE_URL`**, and one shared guard helper `test/scratch-db.ts`. In CI: a `postgres:18` + TimescaleDB service container and a `valkey` container. |
| API contract | Jest + `@nestjs/testing` (already a dep). HTTP through `app.listen(0)` + Node `fetch`, so no new dependency. DTOs validated against `packages/shared` types. | Each ETMS endpoint: status codes, shapes, idempotency keys, 409 on version conflicts |
| Tenant isolation | Generated matrix (§3), unit and HTTP | Exit criterion for E1 |
| E2E backend | New `scripts/etms-e2e/` harness built on the `chaos-run.ts` pattern (real `dist/` binaries, `_test` DB, private Valkey) + `sim:route` fleet mode + driver/employee event bots (§6) | Booking → plan → publish → drive → board/drop → notify → report |
| Web E2E | **Playwright** (`@playwright/test` as a root devDependency; needs owner approval as a new dependency). Chromium only in CI. Visual snapshots reuse the 1440/390 viewport convention. | Already the de-facto tool for the screenshots; first-class network throttling and WebSocket inspection |
| Mobile unit/component | **jest-expo** + `@testing-library/react-native` | The Expo-supported preset. Covers offline queue, sync reducers, permission gating and i18n. |
| Mobile E2E | **Maestro** (open-source CLI only; Maestro Cloud is paid and out of scope), on an Android emulator with an EAS development build or `expo run:android` | Black-box YAML flows. No native test code inside the app, and it tolerates Expo's managed native layer. Detox needs Detox-specific native build config, grey-box sync and more upkeep for Expo SDK 58 / RN 0.88. Maestro's weaknesses (iOS simulator only on macOS, less control over sync) are acceptable for an Android-first India pilot. |
| Native tracker | Plain JVM JUnit for `PointQueue.kt` / `JumpFilter.kt` (Gradle unit tests, no emulator) | Offline queue order, caps and dead-letter |
| Optimiser | pytest (routing branch) + **routing corpus** (§2.3), added to CI | |
| Load | **k6** (free OSS binary, outside npm) for HTTP. A tsx script with `socket.io-client` (already an API devDep) for dispatcher sockets. `gt06-sim` / `sim:route` for telemetry. | k6 gives percentiles and thresholds as pass/fail. Socket.IO needs its own client. |
| Poor network | Extend `ChaosProxy` with `latency` / `loss` / `bandwidth` modes (reuse-first, no toxiproxy). Playwright `route` throttling. Android emulator `-netdelay` / `-netspeed`. | |

### 2.2 Phase matrix

| Phase | Unit | DB integration | API contract | E2E | Mobile | Web E2E |
|---|---|---|---|---|---|---|
| **E1** account / authorisation | Policy function `can(role, action, resource, scope)`; agreement validity windows | Agreement CRUD; `AuthContext` gains provider scope; existing `objectScopeWhere` unchanged | All new routes → isolation matrix (§3); regression: `tenant-isolation-probe.ts` = 20 PASS | n/a | n/a | Login as each new role; menus hidden |
| **E2** employee / driver / fleet | Import validation (phone per country, duplicates, capacity) | 10k import (§5); no duplicate master records (unique constraints, reuse of `Driver` / `TrackedObject`) | Import job API, error report download | n/a | n/a | Import wizard, error rows |
| **E3** booking / scheduling | Recurrence expansion (IST, US DST), cut-offs, waitlist, idempotent create | Concurrency: double submit → 1 booking; schedule → booking generation job | Booking lifecycle states; `Idempotency-Key` | Recurring week for 200 passengers generated, edited, cancelled | jest-expo: booking form, offline draft. Maestro: book / cancel | Corporate admin approves an exception |
| **E4** routing / optimisation | Invariants on solver output (capacity, safety, walking limit, shuttle stops, unassigned reasons) | `RoutingJob` lease and recovery; plan versioning | Job submit/poll/cancel; degraded responses (`eta: null`, `etaSource`) | Corpus run (§2.3); engine-down drill | n/a | Scenario compare, manual edit → new version |
| **E5** driver ops / notifications | Trip state machine; geofenced arrival; OTP / board / no-show rules | Outbox → notify (§4) | Driver event API: idempotent, out-of-order tolerant | **Driver-to-employee lifecycle** with `sim:route` + bots | Maestro: driver duty, start trip, board via OTP, offline 5 min → sync | Dispatcher sees board/drop live |
| **E6** safety | Mandatory-rule evaluation (night shift, escort, gender policy) blocks assignment | SOS persistence across a Valkey outage | SOS API, acknowledgement, escalation timers | SOS during cache outage → delivered after recovery, 0 lost | Maestro: SOS with no network → queued → sent | Emergency console |
| **E7** dispatcher / analytics | KPI maths (golden) | Report goldens extended with an ETMS fixture | Reports scoped per customer / provider | Exception journeys: breakdown → reassign, no-show, late | n/a | Normal + exception journeys, 1,000-vehicle live board (§5) |
| **E8** integrations / localisation | Locale formatting, currency/tax, phone validation per country | HRMS import adapters (synthetic files) | Webhooks HMAC (existing pattern), public API scopes | US-tenant run (America/Chicago, DST weekend) | i18n snapshots en/hi/ta/kn | RTL n/a; locale switch |
| **E9** hardening / pilot | n/a | Backup/restore drill with ETMS tables | Full regression | Chaos suite + ETMS scenarios; 24 h soak on staging | Device lab checklist (3 Android OEMs, 1 iOS) | Full suite + accessibility (axe, needs approval) |

### 2.3 Routing corpus (E4)

| Item | Proposal |
|---|---|
| Location | `services/routing-optimizer/corpus/*.json` |
| Size | About 30 problems: 10–2,000 passengers; shuttle, door-to-door and mixed fleets; women-safety night shifts; walking limits; infeasible cases |
| Assertions | Invariants, not exact routes: capacity ≤ seats; no safety violation; shuttle passengers only at designated stops; walk ≤ limit; every unassigned passenger has a reason code; solve time ≤ `timeLimitS` + 10 %; objective ≤ baseline × 1.05 (no regression) |
| CI | Uses haversine × 1.35 matrices (as `bench_optimizer.py` → `synth` already does), so no routing engine is needed in CI |
| Nightly on staging | Real GraphHopper matrices |

---

## 3. Tenant-isolation test suite (Proposed)

### 3.1 Matrix generator

Declare the policy once and generate the tests. File: `apps/api/src/etms/testing/isolation-matrix.ts`.

| Axis | Values |
|---|---|
| **Role** | Super Admin; Corporate Admin; Corporate Manager (`DataScope = 'ASSIGNED'`, site/shift-scoped); Provider Admin; Provider Dispatcher; Driver; Passenger (role name per D5, approved 2026-11-11; was "Employee (passenger)"); public API key (`AuthContext.apiKey` scopes); anonymous; existing GPS roles (Admin/Manager/User/Viewer) of a non-ETMS company |
| **Resource** | passenger profile, home location, pickup point, booking, recurring schedule, route plan, transport trip, trip live position, trip passenger manifest, vehicle, driver, SOS incident, notification log, report run/export file, document/photo, Socket.IO trip room, webhook delivery |
| **Scope** (relative to the caller) | own; other customer of the same provider; customer of another provider; customer with **no** agreement; **expired / suspended** agreement; agreement restricted to a site/shift; another tenant with no ETMS; driver: own assigned trip, inside vs outside the trip window; employee: own vs co-passenger |
| **Action** | list, read, create, update, delete, export, subscribe (socket), search/autocomplete |

How it works:
- `expected(role, resource, scope, action) → 'allow' | 'deny404' | 'deny403' | 'masked'` comes from one declarative table that the security doc (`10-security-safety-and-privacy.md`) signs off.
- **Level 1 (unit):** `describe.each` over the cartesian product, against the pure policy and the Prisma `where` builders (pattern of `access/access-rules.spec.ts` → `objectScopeWhere`). Thousands of cases, milliseconds.
- **Level 2 (HTTP):** for each ETMS route, a fixture per scope (2 providers × 3 customers × agreements), driven through the Nest app on a `_test` DB. This generalises `tenant-isolation-probe.ts` into CI.
- **Completeness guard:** a test enumerates every controller route through Nest `DiscoveryService` / reflection metadata, and **fails if an ETMS route has no row in the matrix**. Every new route must declare its policy.
- `masked` asserts field-level redaction, for example a provider seeing a passenger without the full home address or phone.

### 3.2 Provider-to-customer leakage cases (must-have)

1. A provider lists bookings, trips and passengers: only customers with an **active** agreement appear. When an agreement ends, live access is revoked within one request. Whether historical access remains is an owner question.
2. A provider dispatcher on a vehicle serving customer A cannot read customer B's manifest on the next trip of the same vehicle.
3. A driver sees passenger name, pickup and masked phone **only for the assigned trip, only from T−X min to trip end**.
4. An employee never sees co-passengers' home locations or phones; ETA only for their own pickup.
5. The Socket.IO trip room is assigned server-side, as `live.gateway.ts` does today (no client `subscribe`). Spoofed `companyId` / `tripId` in the handshake receives nothing (cf. probe #1).
6. Cross-customer reports and exports of a provider aggregate without leaking per-customer PII. Export files are downloadable only by the creator's scope.
7. IDs from another tenant return **404, not 403** (no enumeration). Search and autocomplete return nothing.
8. Notification templates and webhook payloads for customer A never contain customer B data. Webhook fan-out stays `companyId`-filtered (existing pattern).
9. A Super Admin `X-Company-Id` switch still works. A non-SA `X-Company-Id` is ignored (existing `auth-context.service.ts` → `forUser`).
10. Existing GPS-only tenants: the full existing suite passes with ETMS flags off and on, so existing customers are unaffected (E1 exit).

---

## 4. Reliability tests (Proposed; each one extends `chaos-run.ts` with a scenario, unless noted)

| # | Test | Fault | Pass criteria |
|---|---|---|---|
| R1 | Valkey down during a shift start | `kill -9` Valkey 60 s and 11 min with booking, driver-event and SOS traffic | 0 positions lost (existing baseline). 0 SOS / trip events lost. **Every alert gets a notification job after recovery.** This needs a transactional outbox. Today it fails by design (§1.5), so it is a gap to fix in E5/E6. API returns 503 + `Retry-After` for writes that need the cache. No duplicate bookings after client retry. |
| R2 | Postgres restart / failover | `systemctl restart postgresql` and the existing `db-interruption` proxy cut | Processor resumes (existing). Booking writes fail fast (no hang > 5 s). The mobile clients' queued events replay idempotently. Health 503 → 200. |
| R3 | Processor / notifier restart | `kill -9` mid-batch | Existing processor criteria. Notifier: reclaimed jobs are not sent twice (dedupe on `NotificationLog` per alert + recipient + channel). |
| R4 | Optimisation worker crash | Kill the worker mid-solve (`RoutingJob` on the routing branch) | The job lease expires, the job is re-queued at most N times, then `FAILED` with a reason. No half-written `RoutePlan`: the result is written in one transaction with a unique `(jobId, version)`. The dispatcher sees status within 1 poll. |
| R5 | Routing engine down | Stop `veetrax-graphhopper` | ETAs become `null` with `etaSource: 'unavailable'` within one refresh (as `RoutingService.route` returns `null` today). **No straight-line or stale ETA presented as live.** Optimisation submits are refused or queued with a clear state. A System Health CRITICAL (new check) fires. Trips keep tracking (geofence-based). |
| R6 | Mobile offline sync | Driver app offline 10 min. Events replayed duplicated (×2) and out of order (board before arrive; drop before board) | The server applies events by `(tripId, eventId)` idempotently and orders them by device time with server validation. State converges to the same result as the in-order run. No duplicate notifications. Rejected events come back with a reason. Tested in a Jest contract test and in a Maestro airplane-mode flow. |
| R7 | Notification provider failure | SMS/push provider returns 5xx / times out (fake provider in the test env) | `FAILED` logged after 3 attempts (existing). **Proposed:** a delayed retry queue for safety-class messages, and the existing "notification failure ratio" WARN fires. SOS falls back to another channel. |
| R8 | Concurrent dispatcher edits | Two dispatchers edit the same trip or plan (Playwright, two contexts) | The second save returns 409 with a diff (optimistic `version`, cf. `RoutePlanVersion`). No lost update. Audit has both attempts. |
| R9 | Backup/restore drill | `veetrax-backup.sh` → `veetrax-restore.sh` into an empty `veetrax_restore_test` on staging | Manifest counts include the new ETMS tables. Restore time measured (target RTO ≤ 2 h). RPO matches the schedule. Quarterly. Evidence folder under `docs/employee-transport/evidence/`. |
| R10 | Stream cap | Notifier stopped during a peak | `vt:notify` buffer-time-left WARN/CRIT fires before the `MAXLEN ~100,000` trim. Outbox guarantees no loss even if trimmed. |

---

## 5. Performance and capacity (Proposed)

### 5.1 Workloads

| Workload | Shape | Tool |
|---|---|---|
| Employee import | 10,000 rows CSV/XLSX (exceljs already a dep), 2 % invalid rows; repeated with 50,000 | k6 upload + DB timing |
| Booking burst | 5,000 passengers booking or confirming within 10 min before a shift cut-off; peak 50 req/s for 2 min | k6 ramping arrival rate |
| Multi-customer optimisation | 200 / 500 / 2,000 / 5,000 passengers × 20–300 vehicles, 1–5 customers pooled vs separate | corpus + `bench_optimizer.py` |
| Live dispatch | **1,000 vehicles** at a 10 s fix interval (`gt06-sim --count 1000` or `sim:route` fleet mode). 50 dispatcher sockets + 2,000 employee app pollers of trip ETA. | gt06-sim + socket script + k6 |
| Poor connectivity | 2G profile (300 ms RTT, 50 kbps, 5 % loss) via `ChaosProxy` latency mode, between the bots and the API | ChaosProxy + k6 |

### 5.2 Target SLOs (Proposed, for the pilot)

| SLO | Target |
|---|---|
| API read p95 / p99 (ETMS endpoints) | ≤ 300 ms / ≤ 1 s |
| Booking create p95 at 50 req/s | ≤ 500 ms. Error rate < 0.1 %. 0 duplicates. |
| 10k import | ≤ 60 s end to end, per-row error report, no partial master duplicates |
| Optimisation 500 pax / 40 veh | ≤ 60 s. 2,000 / 150: ≤ 5 min. Never above `timeLimitS` + 10 %. |
| Fix → dispatcher map | p95 ≤ 3 s (`FLUSH_MS = 1000` in `live/live.gateway.ts` + pipeline) |
| Employee ETA freshness | ≤ 60 s old, or shown as unavailable |
| SOS → dispatcher socket | ≤ 5 s. SOS → push/SMS sent ≤ 30 s. **0 lost.** |
| Trip alert → notification sent | p95 ≤ 30 s |
| Poor network | Booking succeeds with retries ≤ 30 s. No duplicate from retried POSTs. |
| Pilot availability | 99.5 % monthly on `/api/health` (external check) |
| Positions | 0 lost (existing chaos baseline holds with ETMS on) |

### 5.3 Measuring

| Need | How |
|---|---|
| Thresholds as pass/fail | k6 `thresholds` |
| Server latency | Add a `vt_http_request_duration_seconds` histogram to `/api/metrics`, hand-written Prometheus text with no new dependency. Today no latency metric exists. |
| Pipeline and DB | Existing `vt_queue_*`, `vt_processor_*`, `vt_db_*` |
| Host | `pidstat` / `free` / PG `pg_stat_statements` on staging |
| Results | Stored as a dated evidence folder (`results.md` + `results.json`), following the `docs/reliability/evidence/` convention |

### 5.4 Staging plan (production is never touched)

1. **The production box is off-limits.** Its headroom is about 3 GB (§1.6), and load would affect live customers.
2. **Staging = a production-class replica.** Option A: a separate 6 vCPU / 27 GiB Ubuntu 24.04 VM. Option B: the dev workstation's WSL2 capped with `.wslconfig` `memory=27GB`, `processors=6`. Either one is provisioned with the same `ops/deploy/linux/install-ubuntu.sh` + `maps/` services (GraphHopper India, Photon), a `veetrax_etms_test` DB built from migrations + seed + synthetic data (§6), and ETMS flags on only there.
3. Run the same systemd units and memory flags as production. Add the OR-Tools worker with an explicit `MemoryMax=` to prove it fits next to GraphHopper `-Xmx8g`. If it does not fit, that is a finding for the Lead (the worker may need a smaller GraphHopper heap or a separate host).
4. **Load generators run off-box** (another machine or a Windows host), so they do not steal CPU.
5. **Gate.** E9 is not signed off until the staging run meets §5.2 for 2 consecutive runs plus a 24 h soak (1,000 vehicles, 3 shift peaks) with no memory growth over 10 % per process.

> **E0.5 Lead note (2026-11-11):** Option B (capped WSL2, `memory=27GB`, `processors=6`) is **not feasible** as
> production-class staging: the dev PC has 28.8 GB RAM in total, `.wslconfig` is global (it also caps the dev stack and
> needs `wsl --shutdown`), and the dev CPU has AVX while production has none (`16` §3.2). README C3 now recommends a
> **separate host** (still unresolved); a reduced WSL2 profile serves only labelled pre-checks. The G4 Valkey drill uses
> a private Valkey 7.2 instance, never the shared WSL Valkey (`12` G4, `16` §2.2).

---

## 6. Synthetic data generator (Proposed)

`apps/api/scripts/etms-synth/` (tsx). It is deterministic: a seeded PRNG (`--seed`), so a run is reproducible and can be golden-tested. **No real people.**

| Entity | Generation |
|---|---|
| Cities and sites | Presets with real public **landmarks only** as office sites. **Chennai:** OMR/Sholinganallur ≈12.90,80.23; Guindy ≈13.01,80.21; Perungudi ≈12.96,80.24. **Bengaluru:** Whitefield ≈12.97,77.75; Electronic City ≈12.84,77.66; Manyata ≈13.05,77.62. **US:** Dallas–Irving (Las Colinas ≈32.87,−96.94) and Phoenix (Tempe ≈33.43,−111.94). |
| Homes | Sampled from 10–20 residential cluster centroids per city with Gaussian jitter (σ 300–800 m) and a 3–25 km commute distribution. Optionally snapped with local GraphHopper `/nearest` (staging only; never an external service). Labelled `Synthetic Home #00123, <cluster>`. **No street addresses.** |
| Passengers | Synthetic names from a generated syllable list, tagged `synthetic: true`. E-mails `@example.test`. Phones: US `+1 555-01xx` (fictional range). India: a non-allocatable `+91 00000xxxxx` pattern, rejected by real SMS routing, flagged synthetic. Attributes: gender (for safety rules), shift, site, accessibility needs (2 %), shuttle vs door-to-door preference. |
| Shifts | India IT: 06:00–15:00, 14:00–23:00, 22:00–07:00 IST (night shift → safety rules). US: 07:00–16:00, 15:00–00:00 America/Chicago, including a **DST transition week**. Recurrence patterns, leave/WFH days (20 %), ad-hoc bookings (5 %). |
| Fleets | 1–3 providers per city. Mix of sedan 4, SUV 6, tempo traveller 12, minibus 26, bus 40, with seat capacity and allowed ownership. Drivers with licence expiry (some expired, to test blocking). Shuttle stops on main roads. |
| Outputs | Seed into the `_test` DB through services (not raw SQL), plus CSV/XLSX import files (10k / 50k) and corpus JSON for the optimiser |

**Extending `sim:route`** (keeps `route-drive.ts` pure):

| Extension | What it adds |
|---|---|
| `--trip <id>` / `--trip-file` | Load a published transport trip (stops + manifest). This mirrors the existing `--route-file` shape (`parseRouteFile`). |
| Passenger events in the scenario | `board: {stop, passengers}`, `noShow: {stop, passenger}`, `sosAt: {frac, passenger}`, `driverOffline: {fromFrac, toFrac}`. At the timeline's `arrive` / `depart` events, a bot calls the driver and employee APIs with stable event ids. In offline windows it buffers them and replays them **shuffled and duplicated** (R6). |
| Fleet mode | `--plan <routePlanId>` drives every trip of a plan with its own IMEI, using the existing `--imei-start` / `--stagger`. |
| New scenarios | `etms-on-time`, `etms-no-show`, `etms-breakdown` (stops at 40 %, needs reassignment), `etms-sos`, `etms-offline-driver`, `etms-late-shift`. Same JSON format as `scenarios/*.json`. |

---

## 7. Acceptance criteria per phase (Proposed, mapped to plan §17)

| Phase | §17 exit criterion | Measurable acceptance |
|---|---|---|
| E0 | Architecture approved | Docs 01–13 signed. No code change. |
| E1 | Cross-tenant tests pass; existing customers unaffected | Isolation matrix: 100 % of generated cases pass; completeness guard green. `tenant-isolation-probe.ts` 20/20 PASS. The full existing API + web suites pass with ETMS flags off **and** on. The reports golden test is unchanged. CI runs the DB-integration job. |
| E2 | No duplicate master records; ownership/capacity tested | Re-importing the same 10k file creates 0 new rows. Unique constraints are tested. Vehicle capacity and provider ownership have unit + DB tests. Import meets the §5.2 SLO. |
| E3 | Booking/schedule E2E | E2E: recurring week for 200 passengers (IST + US DST) is generated, modified and cancelled with correct counts. Double submit → 1 booking. Burst SLO met on staging. |
| E4 | Routing corpus passes; outage degrades safely; no false ETA | 30/30 corpus problems pass all invariants. R4 and R5 pass. With the engine down, 0 ETAs are shown with a live source (asserted by Playwright and the API contract). Manual edits create a new plan version. |
| E5 | Driver-to-employee lifecycle E2E | `etms-on-time`, `etms-no-show` and `etms-offline-driver` pass end to end: notifications sent, states converge (R6). Maestro driver and employee flows are green on an emulator. |
| E6 | Mandatory violations block assignment; emergency workflow and delivery status tested | Each mandatory rule has a failing-assignment test. `etms-sos` during a Valkey outage: 0 lost, the notification is delivered after recovery (requires the outbox), and delivery status is visible. SOS SLO met. |
| E7 | Dispatchers manage normal and exception journeys | Playwright: normal, breakdown/reassign, no-show and late-shift journeys. R8 passes. 1,000-vehicle live board meets p95 ≤ 3 s. |
| E8 | Integration/localisation suites | Webhook HMAC + HRMS adapter suites. Locale snapshots for en/hi/ta/kn. US tenant run green. |
| E9 | Signed acceptance, rollback plan, monitoring, deployment approval | Staging meets every §5.2 SLO twice plus the 24 h soak. Chaos suite (existing + ETMS) 0 lost. Backup/restore drill R9 within RTO. ETMS alerts (§8) are live on staging. Rollback rehearsed: flags off plus the additive migration left in place. Owner sign-off recorded in `PROGRESS.md` / the decision log. |

> **E0.5 Lead note (2026-11-11):** E3 "Burst SLO met on staging" is superseded: in E3 the booking burst is measured on
> the local isolated instance (T3) as an indicative figure; the burst SLO of record is measured on staging at E9 (`12`
> §5, §12; `16` Q12). E1 "`tenant-isolation-probe.ts` 20/20 PASS" becomes 0 FAIL with 21 PASS after G5 (`12` §3).
> Both the probe and the chaos baselines must be re-run on production versions (Node 24.22.2, PostgreSQL 18.6 +
> TimescaleDB 2.31.0, Valkey 7.2.13), not the Node 22 / Valkey 9 of the 2026-11-09 runs (C6, `16` §6).

---

## 8. Observability additions (Proposed)

| Kind | Additions |
|---|---|
| Metrics (`/api/metrics`, `vt_etms_*`) | `bookings_created_total{source}`; `booking_errors_total`; `http_request_duration_seconds{route}` (histogram); `opt_jobs{state}`; `opt_job_duration_seconds`; `opt_unassigned_passengers`; `routing_engine_up{engine}`; `routing_engine_latency_ms`; `geocoder_up`; `eta_unavailable_total`; `trips{state}`; `pickup_late_total`; `no_show_total`; `sos_open`; `sos_ack_seconds`; `notify_outbox_oldest_seconds`; `notify_sent_total{channel,class}`; `driver_app_last_seen_seconds` (max); `mobile_offline_queue_depth` (reported in app heartbeats); `dispatcher_sockets` |
| System Health checks (`monitoring/checks.ts`) | **GraphHopper / Photon / Martin up** (CRITICAL only when ETMS or routing is enabled). Outbox oldest entry > 2 min (CRITICAL for the safety class). SOS unacknowledged > 60 s (CRITICAL, plus escalation outside System Health). Optimisation job past `timeLimit` + 2 min. Driver app silent on an active trip > 5 min (WARN). Valkey `appendonly` off already exists (WARN), so promote it to CRITICAL when ETMS is on. |
| Ops | A Linux equivalent of the Windows watchdog: a systemd timer that probes `/api/health` and gateway `:4121/health` and alerts through `alert-cli`. A post-deploy health gate in `release.sh`. A backup systemd timer with the `last-status.json` freshness checked by System Health. |
| Dashboards | An "ETMS" section on the System Health page (Super Admin), plus an optional Grafana board over `/api/metrics` on the private network: shift-peak view (bookings/min, opt jobs, trips by state, late pickups), safety view (open SOS, ack latency, notification delivery per channel) and engine view (routing/geocoder up and latency). |
| Logs | Structured `etms.*` log lines with `tripId` / `bookingId` correlation ids, and **no PII** (passenger ids only) |

---

## 9. Open questions for the owner

1. **Notification durability:** may E5/E6 add a transactional outbox (a `NotificationLog QUEUED` row or a sweep of un-notified `Alert` rows) to fix the alert → `vt:notify` gap (§1.5)? It affects existing GPS alerts too.
2. **Staging host:** a separate 27 GiB VM (which provider, free tier?) or the dev workstation's WSL2 capped to 6 vCPU / 27 GB? Is the Mintplus Windows server (166.0.242.121) available as a load-generator or staging host?
3. **New dev tools:** do you approve `@playwright/test`, `jest-expo` + `@testing-library/react-native`, the Maestro CLI and the k6 binary? All are free and open source; none is a runtime dependency.
4. **CI service containers:** may CI start PostgreSQL 18 + TimescaleDB and Valkey containers, so that the DB-integration and isolation suites run on every PR? This costs about 5 extra minutes per run.
5. **Production backups on Linux:** is a backup timer actually running on app.veetrax.com, and is Valkey AOF on there? The repo shows neither for `ops/deploy/linux` (§1.6). This was not checked on the server, per the rules.
6. **Retention after an agreement ends:** may a provider still read historical trips of a former customer?
7. **SLO targets in §5.2:** acceptable for the pilot? In particular, should the SOS end-to-end target be ≤ 30 s?
8. **Device lab:** which physical Android OEMs, and is any iOS device needed for the pilot (Maestro iOS needs macOS)?
9. **India test phone numbers:** is the non-allocatable `+91 00000…` pattern acceptable, or do you have a reserved test range from the SMS provider?

> **Validation note (E0 review):** Answered by the Lead's production check in the box at the top of this document (2026-11-11): the nightly cron `/etc/cron.d/veetrax-backup` is installed (script not in the repo) and Valkey `appendonly` is `no`. Agent 7 did not access the server; those facts are the Lead's.

> **Update in E0.5 (2026-11-11):** Q1 is covered by **D6, approved as a pre-pilot gate on 2026-11-11** (G2 lost alert notifications; ETMS events via `OutboxEvent`, `02` §3.1); implementation still needs separate authorisation. The other questions stay open as owner decisions (README §7): Q2 → **C3**; Q3 and Q4 → **O4**; Q6 → **L3**; Q8 → **O6**. Q7 and Q9 are not listed in README §7 and stay with the owner.
