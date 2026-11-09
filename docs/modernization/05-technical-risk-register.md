# 05 — Technical, Security, Safety & Reliability Risk Register

Branch `feature/modernization-phase0` · 2026-11-09 · **Phase 0: no code changed; nothing below has been remediated.**

**Evidence levels:**
- **V-code**: re-verified in source during Phase 0.
- **V-run**: verified at runtime on the isolated assessment instance.
- **P1**: Phase 1 finding (code-read by an analyst), not re-verified.

The owner column shows the proposed owner role, to be confirmed. Each item lists the test that will prove the fix (see [09](09-test-strategy.md)).

## 1. Mandatory review items (assignment §9.2, §10)

### R-01 Offline engine-stop executes late without a fresh speed check (**Critical, safety**) — V-code
- **Evidence:**
  - The speed interlock is evaluated only at request time, and only when the vehicle is not OFFLINE: [commands.service.ts:146](../../apps/api/src/commands/commands.service.ts#L146) `if (live && live.status !== 'OFFLINE' && live.speedKph > ENGINE_STOP_MAX_SPEED_KPH)`.
  - An offline device's command is RPUSHed to `vt:cmd:queue:<imei>` with a 24 h TTL ([commands.service.ts:184-190](../../apps/api/src/commands/commands.service.ts#L184-L190)).
  - On reconnect the gateway drains the queue and sends every command with **no state re-check** ([tcp-server.ts:416-432](../../apps/api/src/gateway/tcp-server.ts#L416-L432) `onIdentified`).
  - The DB row is marked EXPIRED by `reconcile()` only when someone lists commands. Expiry does not remove the Valkey queue entry, and each new RPUSH refreshes the key's TTL.
- **Scenario:** a vehicle is in a tunnel or parked with no signal. A user sends engine-stop. Hours later the vehicle reconnects **while driving at highway speed**, and the immobiliser command is delivered.
- **Mitigation (proposal, needs approval; behaviour must not change before the safety review):**
  1. Refuse engine-stop or immobilise for OFFLINE or stale vehicles, or queue it with a short configurable TTL (for example 5 min).
  2. At delivery time in the gateway, re-check the latest live state (freshness ≤ N s and speed ≤ limit) from Valkey. If it fails or is unknown, drop the command and mark it FAILED with a reason.
  3. Expire queue entries per command, not per key.
  4. Audit requested, queued, cancelled, delivered and dropped.
  5. Add a cancel action.
- **Tests:**
  - Unit: the delivery guard.
  - Integration with the simulator: offline → queue → reconnect at 60 km/h → command not sent; reconnect stationary → sent if within TTL.
  - Duplicate delivery.
  - Race between two gateways.
- **Owner:** backend lead + product owner (policy).

### R-02 Production runs without `NODE_ENV=production` (**Critical/High, security**) — V-code
- **Evidence:**
  - `NODE_ENV` is not set in `ops/run/ecosystem.config.cjs` or `apps/api/.env` (grep, 2026-11-08).
  - `assertProductionSafe` runs only when it equals `production` ([env.ts:70](../../apps/api/src/config/env.ts#L70)).
  - The webhook and relay URL guards allow private and loopback targets otherwise ([url-guard.ts:60](../../apps/api/src/webhooks/url-guard.ts#L60), [relay/guard.ts:37](../../apps/api/src/relay/guard.ts#L37)).
  - Result: SSRF from any Admin with Developer API access; dev echo flags (OTP and mail written to disk/stdout) are allowed.
- **Mitigation:**
  1. Set `NODE_ENV=production` for api, gateway, processor, notifier and summarizer in the deployment.
  2. Fix whatever `assertProductionSafe` then rejects.
  3. Purge `var/mail` and `var/sms`.
  - This is a **production configuration change, so the owner must approve it** (rule 13).
- **Tests:**
  - A startup test that production mode with dev echo enabled fails.
  - URL-guard tests: private, loopback and link-local addresses are rejected in production mode.
- **Owner:** DevOps.

## 2. Register
| ID | Area | Risk | Sev | Evidence | Mitigation (summary) | Phase |
|---|---|---|---|---|---|---|
| R-01 | Safety | Queued engine-stop without delivery-time re-check | **Critical** | V-code | above | 0 → 7 (fix first) |
| R-02 | Security | No `NODE_ENV=production` → SSRF, dev echo | **Critical** | V-code | above | 0 |
| R-03 | Data | Backups cover PostgreSQL only; uploaded files (`apps/api/var`: documents, selfies, media, invoices) not backed up; scripts target another host layout; **no restore test recorded** | High | P1 ([13](../discovery/13-security-performance-ops-quality.md)) | Include `var/` and object storage; fix paths; documented restore test | 0/7 |
| R-04 | Security | Seed creates / re-activates Super Admin with the README-published password in any environment | High | P1 + `seed.ts:188` | Require an env-provided bootstrap password; never re-activate | 1 |
| R-05 | GPS reliability | Stream MAXLEN ≈2M can drop already-ACKed positions during outages > ~30 min | High | P1 ([09](../discovery/09-gps-tracking-architecture.md)) | Lag alerting, backpressure before trim | 7 |
| R-06 | GPS reliability | No dead-letter queue; a poison batch retries forever and blocks ≤499 good points | High | P1 | DLQ + replay tool | 7 |
| R-07 | GPS correctness | Live/track state written before DB commit; retried points flagged LATE and skip rules | High | P1 | Write live state after commit, or mark retries | 7 |
| R-08 | Scale | Multiple processors unsafe (unpartitioned per-device state) | High | P1 | Shard by device | 7 |
| R-09 | DB perf | Summarizer scans `Position` by unindexed `serverTime` every 60 s | High | P1 ([11](../discovery/11-database.md)) | Index or rework; measure at 2,000 devices | 7 |
| R-10 | DB | Retention by batched DELETE, no compression/chunk drop → bloat | High | P1 | Timescale compression + drop_chunks (if present) | 7 |
| R-11 | DB correctness | Mixed `timestamp`/`timestamptz` in raw SQL; correct only if session TZ = UTC | High | P1 | Enforce UTC, migrate columns | 7 |
| R-12 | AuthZ | Permission ceiling missing (scope ceiling exists; self-assign of ASSIGNED roles works) | High | **V-run** ([02 §3](02-role-permission-matrix.md)) | A grantor can only grant permissions they hold; built-in roles immutable; no self role change | 1/4 |
| R-13 | AuthZ | API keys can exceed creator's scope | High | P1 | Clamp key scope to creator | 4 |
| R-14 | Session | Socket.IO keeps streaming after logout or revocation | High | P1 | Disconnect on revoke; session check | 4 |
| R-15 | AuthZ | Template test-send needs only `view`, sends real SMS/email | High | P1 | Require edit + rate limit | 4 |
| R-16 | Privacy | Purge and account deletion leave files on disk | High | P1 | Delete files; verify | 4/7 |
| R-17 | Finance | **UPI/cash claim confirm not atomic** (check-then-act) → double fulfilment and double GST invoice on concurrent confirm; reject not audited | High | **V-code** ([upi.service.ts:75-80](../../apps/api/src/licences/upi.service.ts#L75-L80)) | Claim PENDING→PROCESSING atomically first; audit reject | 5 |
| R-18 | Finance | Second captured Razorpay payment on the same order returns "duplicate" with no alert or refund | Medium | code-read (licensing audit) | Detect, alert, reconcile view | 5 |
| R-19 | Licensing | Trial seats told "viewing stops at expiry + 15 d" but lock at expiry (reminders use platform grace) | Medium | code-read | Use seat grace in reminders | 5 |
| R-20 | Licensing | Seat follows device on Super Admin *Transfer* but stays with old company on admin *move*: inconsistent | Medium | code-read | Product-owner decision, then unify | 5 |
| R-21 | Tenancy | Suspension blocks sign-in, API keys, tracker and schedules, but **gateway, processor and alerts keep processing**; UI says "data is not processed" | Medium | code-read (`CompaniesPage.tsx:107`) | Decide policy; fix hint or stop ingestion | 5 |
| R-22 | Mobile | Customer app signs out and wipes credentials when offline or on a transient API error | High | P1 ([08](../discovery/08-mobile-apps.md)) | Sign out only on definitive 401 | 6 |
| R-23 | Mobile | Tracker: silent re-pair by Android ID; lookup may disclose email/name | High | P1 (server side to verify) | Require a code; minimise lookup output | 6 |
| R-24 | Mobile | Tracker upload queue blocked forever by one 4xx batch | High | P1 | Dead-letter 4xx batches | 6 |
| R-25 | Web security | No security headers (helmet/CSP/HSTS); refresh token in localStorage; web served by `vite preview` | Medium | P1 | Headers, httpOnly cookie, static server | 7 |
| R-26 | Auth abuse | Lockout keyed only on email (lets anyone lock out any account); timing enumeration; no per-mobile OTP cap; in-memory throttler | Medium | P1 | Per account+IP, constant-time, Redis throttler | 7 |
| R-27 | Device trust | No device authentication beyond IMEI; claim by IMEI within 24 h; no per-IP connection cap | Medium | P1 | Claim code; connection limits | 7 |
| R-28 | Ops | OTP codes and reset links written to stdout / `var/sms` / `var/mail`, never deleted | High | P1 | Disable echo in production; purge | 0 |
| R-29 | Observability | No error tracking, APM, correlation IDs or request logs | Medium | V-code (Phase 0 grep) | Structured logs + correlation ID + error tracking | 7 |
| R-30 | Quality | No CI; no e2e/integration tests; 0 tests in shared/mobile/tracker; 14 API modules without specs | High | P1 (counts: API ≈834 cases, web ≈96) | CI + test pyramid ([09](09-test-strategy.md)) | 1 (start) |
| R-31 | UX correctness | Report and History times in browser TZ against company-day periods | High | **V-run** ([03 D-1](03-report-inventory.md)) | Company-TZ formatter | 2 |
| R-32 | UX correctness | Scheduled reports drop report options | High | V-code | Persist options | 2 |
| R-33 | Performance | Initial page preloads 46 scripts / **744 KB gz**, incl. MapLibre (264 KB gz) and all translations (176 KB gz), even on `/login` | Medium | **V-run** (dist analysis) | Lazy-load map and locales | 1 |
| R-34 | Licensing | Locked (expired) vehicles still raise alerts, webhooks, relay | Decision | code-read | Product-owner decision | 5 |
| R-35 | Docs | HANDOFF/README outdated (Flutter, module list, PDF name); `ops/run` untracked | Low | V-code | Update docs; version ops (no secrets) | 1 |

## 2b. Status updates
| ID | Status (2026-11-09) | Evidence |
|---|---|---|
| R-01 | **Mitigated in code** (S0.1, `5f8923f`). Not yet deployed | Unit, gateway and live-simulator e2e |
| R-02 | **Mitigated:** validated in staging; production PM2 config sets `NODE_ENV=production` (takes effect at next start) | Staging SSRF probes |
| R-03 | **Partially mitigated:** encrypted full backup + verified restore implemented; off-site upload and schedule await provider approval | backup-plan.md |
| R-04 | **Mitigated in code** (S0.4). Not yet deployed | Unit tests, seed runs |
| R-17 | **Mitigated in code** (S0.5). Not yet deployed | Concurrency tests |
| R-28 | **Mitigated in code** (S0.2); existing `var/mail` copies still on disk (awaiting deletion approval) | Unit tests |

| R-28 | **Closed:** code mitigated (S0.2); 18 stored copies shredded; no outstanding tokens; backups exclude `var/mail`/`var/sms` | security-log.md |
| R-36 | **Confirmed by code reading** (not executed): the purge planner only skips SET NULL/SET DEFAULT children, so RESTRICT-protected Invoice/CreditNote/LicenceOrder/LicenceSeat/BillingProfile/AuditLog rows are deleted; also reachable via `/delete-account` for personal accounts. Design ready for review ([company-retention-design.md](company-retention-design.md)); stop-gap proposed | purge-plan.ts:74-75, purge.service.ts:68-89 |
| R-37 | **Partially mitigated:** production returns clear 503s, and the admin-assisted reset is demonstrated (21/21 smoke). Providers still needed | release-s0-checklist.md |

New risks:
| ID | Area | Risk | Sev | Evidence | Mitigation | Phase |
|---|---|---|---|---|---|---|
| R-36 | Finance / legal | Company **purge** deletes child rows even where FKs are Restrict; it likely deletes legally retained GST invoices and credit notes | High | Inferred from the purge algorithm (Phase A analysis, not executed) | Exclude financial records from purge (retain with snapshot), confirm on the isolated DB | P5 / Inventory E |
| R-38 | Compliance | Default credit-note number `VTX/CN/2026-27/0001` is 19 characters; GST Rules 46/53 allow at most 16 | Medium | Code-read (owner-decision doc QI-5) | CA to confirm; shorter prefix series | Inventory E / P5 |
| R-39 | Safety (UX) | A Concox heartbeat or "Request location" reply does not refresh telemetry, so legitimate engine stops on parked vehicles are refused (safe failure) | Low | Code-read (anti-theft proposal) | Proposal option 1, after approval | — |
| R-37 | Ops | Live production has no SMS or mail provider: OTP SMS and reset e-mails are not delivered; notification log records e-mail as SENT | Medium | Live `.env` names; mailer code | Configure providers (DLT, SMTP); honest delivery status | P4 |

## 3. Risk heat summary
| Severity | Count | IDs |
|---|---|---|
| Critical | 2 | R-01, R-02 |
| High | 22 | R-03…R-17, R-22…R-24, R-28, R-30…R-32 |
| Medium | 9 | R-18…R-21, R-25…R-27, R-29, R-33 |
| Decision / Low | 2 | R-34, R-35 |
