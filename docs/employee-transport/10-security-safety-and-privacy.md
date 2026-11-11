# 10: Security, safety and privacy (E0)

Agent 6 (Security, Safety and Privacy Auditor) · 2026-11-11 · code baseline **v1.8.0** (`f5b151b`), worktree
`D:\Vibhav\gps-app-wt\etms`, read-only. Answers brief questions **2, 9, 10, 11** (and part of 7).

Labels: **Verified** = read in source or in a committed evidence document (path + symbol cited). **Proposed** = design
for approval; nothing in it exists in code. Legal points are **flags for legal review, not legal advice**.

---

## 0. Answers at a glance

| Q | Short answer |
|---|---|
| **2. Tenant isolation** | Application-level only. The tenant is `Company`. Every request builds an `AuthContext` whose `companyId` is the user's own company (only the Super Admin may switch with `X-Company-Id`), and every service query adds `companyId` / scope helpers by hand. **No PostgreSQL row-level security, no Prisma extension that injects the tenant filter.** Black-box probes found no cross-tenant leak (20 PASS / 0 FAIL). Weak points: hand-written filters (111 raw-SQL call sites), routes without `@RequirePermission` are allowed for any signed-in user, no permission ceiling for role grants (R-12), sockets survive logout (R-14), no read-access audit. |
| **9. Provider ↔ customer authorisation** | **Today: none.** `Partner` is a billing/reseller construct and is explicitly "not a data-access grant"; `VehicleShare` (Super Admin only) is the only cross-company data grant. **Proposed:** a new `TransportServiceAgreement` (provider company ↔ customer company, scoped grants, validity window) loaded into `AuthContext` like `shares`, enforced by guards plus mandatory query helpers on dual-keyed transport rows (`customerCompanyId` = data owner, `providerCompanyId` = operator). Provider users never switch `companyId`, so no existing GPS module is widened. |
| **10. Driver vs employee mobile permissions** | Today there is no driver login (`Driver` has no `User` link) and no passenger identity. Proposed: relationship-based authorisation (driver ↔ assigned trip, passenger ↔ own booking), not menu permissions; minimum-data projections; passenger phone location is never collected by default. |
| **11. SOS / trip-event durability** | **Today:** device and tracker-app SOS are durable *to the server* (gateway disk spool, phone SQLite queue), but the alert → notification hop is Valkey-only: if the `XADD` to `vt:notify` fails after the `Alert` row commits, no notification is ever sent and nothing reconciles; a notifier job that throws is acknowledged anyway (no dead letter); escalation is an empty stub; push "SENT" means "Expo accepted the ticket". **Proposed:** Postgres-first incident + transactional outbox, DB-scheduled escalation, per-recipient delivery and acknowledgement states that only claim "delivered" with a provider receipt, a direct-send fallback for SOS when Valkey is down, on-device offline fallback (dialler / SMS). |

---

## 1. Verified current state

### 1.1 Tenant isolation mechanism (Q2)

| Element | Evidence | Behaviour |
|---|---|---|
| Tenant entity | `apps/api/prisma/schema.prisma` `model Company` (`partnerId` required, `isPlatform`, `retentionDays`, `settings`) | Every business row carries `companyId`. `Branch` subdivides a company. |
| Identity → context | `apps/api/src/access/auth-context.service.ts` `AuthContextService.fromToken` / `forUser` | Verifies the JWT, checks the `Session` row (revoked / expired → 401), loads roles, branches, mapped objects; rejects inactive users and suspended companies. |
| Company switch | same, `forUser` | `requestedCompanyId` (header `X-Company-Id` / socket `companyId`) honoured **only if `user.isSuperAdmin`**; `ALL_COMPANIES` gives `allCompanies: true` for the live map and lists only (`access-rules.ts` `allCompaniesOr`). |
| Global guards | `apps/api/src/access/access.module.ts` (`APP_GUARD` → `JwtAuthGuard`, `PermissionGuard`) | Every HTTP route needs a Bearer token unless `@Public()`. API keys (`vtx_…`) are refused outside `/api/v1` (`auth.guard.ts`). |
| Permission check | `apps/api/src/access/permission.guard.ts` `PermissionGuard.canActivate` | Enforces `@RequirePermission(menu, action)` / `@RequireAnyPermission`; CSV export also needs `export`. **If a route declares no grant, it is allowed for any authenticated user.** |
| Data scope | `apps/api/src/access/access-rules.ts` `objectScopeWhere`, `objectReadScopeWhere`, `branchScopeWhere`, `deviceScopeWhere`, `userScopeWhere` | `COMPANY` scope → `{ companyId }`; `ASSIGNED` → company ∧ (branch ∈ `branchIds` ∨ object ∈ `objectIds`). Services must call these themselves. |
| Cross-company read grant | `schema.prisma` `model VehicleShare`; `auth-context.service.ts` `sharesOf`; `access-rules.ts` `shareOf`, `objectReadScopeWhere`; `vehicle-shares/vehicle-shares.service.ts` `assertSuperAdmin` | Time-boxed (`startAt`/`endAt`), Super Admin creates, loaded per request into `AuthContext.shares`, **read paths opt in one by one; write paths never include shares.** This is the best in-repo precedent for ETMS agreements. |
| Realtime | `apps/api/src/live/live.gateway.ts` (no `@SubscribeMessage`; rooms from `roomOf()`), evidence in `docs/modernization/tenant-isolation-probes.md` §Evidence | Clients cannot pick rooms; fan-out filtered by allowed objects and permission. |
| Database | `grep "ROW LEVEL SECURITY\|CREATE POLICY"` in `apps/api/prisma/**`: no hits; no `$extends`/`$use` in `apps/api/src/prisma/` | **No database-level isolation.** |

**Runtime evidence:** `docs/modernization/tenant-isolation-probes.md` (script `apps/api/scripts/tenant-isolation-probe.ts`):
sockets, documents, receipts, selfies, driver-event media, report files, invoices, partner boundary, webhooks:
**PASS 20 / FAIL 0** on the isolated instance. `docs/modernization/02-role-permission-matrix.md` §4 adds objects,
history, trips, commands, drivers and `X-Company-Id` spoofing.

**Weak points (Verified unless noted):**

| # | Weak point | Evidence | ETMS relevance |
|---|---|---|---|
| W1 | Isolation is a convention: every query must add `companyId`/scope. 111 `$queryRaw`/`$executeRaw` call sites in `apps/api/src` (grep count, non-spec). One missed filter = leak. | `access-rules.ts`; grep | ETMS adds cross-company rows (provider sees customer data); the convention gets harder. Needs mandatory helpers + tests. |
| W2 | Default-allow for authenticated routes without a grant. Controllers with zero grants: `maps`, `masters/menus`, `public-api` (API-key path), `purge`, `transfer` (plus public ones). | `permission.guard.ts` (`if (!grants?.length) return true`) | Every ETMS route must carry an explicit grant or relation check; add a lint/test that fails on ungranted ETMS routes. |
| W3 | No permission ceiling: a branch-scoped user with `users:edit` can give themselves any ASSIGNED-scope role; anyone with `roles:edit` can build an Admin-equivalent role. | R-12 / AZ-1, `02-role-permission-matrix.md` §3 (V-run). No ceiling code found by grep at v1.8.0. | A corporate dispatcher could self-escalate to safety-override or passenger-PII rights. Fix before E1. |
| W4 | Socket keeps streaming after logout / session revocation. | R-14, F-1 in `tenant-isolation-probes.md`; `live.gateway.ts refreshAll()` re-resolves by user id only (no session reference in `live.gateway.ts`). | Live passenger/vehicle positions after a dispatcher is off-boarded. |
| W5 | API keys may exceed the creator's scope. | R-13 (P1, not re-verified) | Public ETMS endpoints must not be added to `/api/v1` until fixed. |
| W6 | No read audit: `AuditAction` = CREATE/UPDATE/DELETE/LOGIN/LOGIN_FAILED/LOGOUT/PASSWORD_RESET only. | `schema.prisma enum AuditAction`; `audit/audit.service.ts` | Plan §10 requires "audit sensitive access" (who viewed a passenger's home address / live location). |
| W7 | Throttler is per-module and in-memory (`ThrottlerModule.forRoot` in `auth.module.ts`, `guide.module.ts`); lockout keyed on e-mail only. | R-26; grep `ThrottlerModule` | Booking spam and OTP abuse; does not hold across processes. |
| W8 | Company suspension blocks sign-in but gateway/processor/alerts keep processing. | R-21 | Decide what a suspended provider/customer means for live trips and SOS (SOS should keep flowing). |
| W9 | Super Admin acts inside any company with full rights; audit rows record the Super Admin's `userId` in the target company, but there is no "reason" or break-glass marker. | `auth-context.service.ts forUser`; `audit.service.ts record` | Super Admin access to passenger PII / incidents should require a reason and be visible to the customer. |

### 1.2 Role / permission model

- **Menu × action RBAC.** `packages/shared/src/permissions.ts`: `ACTIONS` = view/create/edit/delete/export/command;
  `MENUS` (43 keys, `superAdminOnly` platform menus, `partnerOnly` `stock`); `can()`.
- **Roles are per company** (`Role.companyId`), union of granted actions; data scope is `COMPANY` if any role is
  `COMPANY`, else `ASSIGNED` (`access-rules.ts resolvePermissions`). Built-in roles `Admin`, `Manager`, `User`,
  `Viewer` (`SYSTEM_ROLES`; created by `access/system-roles.ts ensureSystemRoles`).
- **Super Admin** = `User.isSuperAdmin`, gets every menu, `COMPANY` scope, may switch company.
- **Partner (reseller)** = `model Partner` with `homeCompanyId`; `Company.partnerId` is **required and single**.
  Used for licence pools, prices, invoices, stock (`licences/partners.service.ts`, `billing.service.ts partnerOf`,
  `licences.controller.ts PartnerLicencesController.customer` → "This company is not your customer"). The
  modernization matrix states it is **"Not a data-access grant by itself"** (`02-role-permission-matrix.md` §1).
- **Missing for ETMS:** no "own record" concept (a passenger seeing only their bookings cannot be expressed as a menu
  grant); no driver principal; no cross-company operational grant except `VehicleShare`.

### 1.3 Audit coverage

| Covered | Evidence |
|---|---|
| CRUD with field diffs, secret fields masked (`passwordHash`, `ingestToken`, `refreshTokenHash`, `tokenHash`, `codeHash`) | `audit/audit.service.ts` `diffSnapshots`, `SECRET_FIELDS` |
| Login / failed login / logout / password reset (system actor) | `AuditService.recordSystem` |
| 56 non-spec files call `audit.record`/`recordSystem` (grep) | e.g. `live-share/live-share.service.ts`, `licences/partners.service.ts` |
| Transactional audit possible (`db` parameter) | `AuditService.record(ctx, entry, db)` |

| Gaps | Evidence |
|---|---|
| Alert acknowledgement is stored on the row (`Alert.ackById`, `ackAt`, `ackNote`) but **not** written to `AuditLog`; `ackAll` can bulk-acknowledge **SOS** alerts | `alerts/alerts/alerts.service.ts ack`, `ackAll` (filter `ACK_REQUIRED_WHERE`, no type exclusion) |
| No read/view events | `enum AuditAction` |
| `AuditLog` is not retention-managed (no delete in `retention/retention.service.ts`), and company purge may delete it (R-36) | `retention.service.ts`; `05-technical-risk-register.md` R-36 |

### 1.4 Existing SOS and alert-acknowledgement flow (Verified)

```
Hardware tracker SOS ─TCP─▶ gateway (codec: gt06 0x01, jt808 bit0, teltonika priority 2, ais140 EA/10)
        │  disk spool when Valkey unavailable (GATEWAY_SPOOL, gateway/spool/position-publisher.ts)
Tracker app SOS button ─HTTPS─▶ POST mobile-tracker upload (sos=true → attributes.alarm='sos')
        │  phone SQLite queue keeps the point until HTTP 200 (Engine.kt finishSos)
        ▼
Valkey stream vt:positions ──▶ processor (position-processor.ts; LATE alarm points still alert)
        ▼
rules/evaluate.ts raise('SOS') → Alert row in PostgreSQL (DB write)
        ▼ after commit: rules-engine.ts RulesBatch.commit() → PUBLISH vt:alerts + XADD vt:notify {alertId}
        ▼
notifier (consumer group `notifier`, notifier.service.ts) → recipients (alert settings) → SMS / e-mail / push /
WhatsApp / Arattai, 3 in-process attempts (notifier/retry.ts withRetries) → NotificationLog row per recipient
        ▼
Mobile app: push channel 'sos' + siren loop until acknowledged (notifier/push.ts pushStyle; apps/mobile/src/app/sos/[id].tsx;
features/notifications/siren.ts); web repeats siren. POST /alerts/:id/ack (alerts:edit).
```

| Property | Evidence | Assessment |
|---|---|---|
| SOS is `mandatory` (cannot be disabled below company level, cannot be snoozed) | `packages/shared/src/alerts.ts` (`SOS … mandatory: true`); `alerts/logic/settings-resolution.ts` (mandatory filter, snooze skip); `snoozes-packs.service.ts` ("cannot be snoozed") | Good. A **company Admin can still disable SOS** at company level; schedule/cooldown still apply (`evaluate.ts` comment near `deviceReported`). For ETMS this must be impossible. |
| SOS / CRASH always require ack | `alerts.ts isAckMandatory`, `ACK_MANDATORY_TYPES`; `ACK_REQUIRED_ALERT_TYPES` adds emergencies, `DEVICE_OFFLINE`, `PARKING_BREACH` | Good. |
| Push never goes nowhere | `alerts/logic/recipients.ts resolveRecipientEntries` (`PUSH_FALLBACK` → all viewers) | Good, push only. |
| Tracker app SOS honesty | `apps/tracker/src/lib/strings.ts` `sosSent` "SOS sent to your account or company." / `sosQueued` | "sent" = **server accepted the point into the Valkey stream**, not "someone was notified". Wording over-claims for ETMS use. |
| Suppression | `position-processor.ts` (`!object.inMaintenance`, `reupload !== true` for LATE alarms) | An SOS from a vehicle in maintenance, or a history (AIS-140 `H`) SOS packet dated before the last point, raises no alert. |
| Escalation | `notifier.service.ts escalateAlarm` "Intentionally empty until SMS / voice-call escalation is enabled" | **No escalation exists.** |
| Delivery truth | `notifier/push.ts` counts Expo **tickets** `status === 'ok'` as sent; no receipts; R-37 (mail logged SENT while no provider) | `NotificationLog.status = SENT` ≠ delivered. |

### 1.5 Notification durability through Valkey / queue outages (Q11, current state)

| Hop | Valkey down | Valkey restarted empty | Evidence |
|---|---|---|---|
| Hardware → gateway | Fixes fsynced to disk spool and replayed (chaos full run 2026-11-09: 26,521 sent, 26,521 received, 0 lost, 0 duplicates) | Same | `gateway/main.ts` (`GATEWAY_SPOOL`, `GATEWAY_SPOOL_MAX_MB` 1024), R-41 |
| Tracker app → API | `upload()` pipeline fails → `ServiceUnavailableException`; phone keeps the point and retries | Same | `mobile-tracker/mobile-tracker.service.ts upload` ("a failed write must not be confirmed") |
| Stream trimming | `MAXLEN ~` can drop entries in long outages | — | R-05 |
| Processor → `Alert` row | No input while Valkey is down; resumes on recovery | NOGROUP recreated | `redis/stream-groups.ts ensureStreamGroup` |
| `Alert` row → `vt:notify` | `RulesBatch.commit()` runs **after** the DB write; if `XADD` fails the alert exists but **no job is ever queued; no sweeper/outbox reconciles** (grep `outbox`: none) | Pending entries lost unless persisted | `processor/rules/rules-engine.ts commit`; same pattern in `planned-trips/tracker/tracker-engine.ts`, `alerts/offline-alerts.service.ts`, `attendance.service.ts`, `documents/reminders.service.ts` |
| Notifier job | A thrown error is logged and the entry is **XACKed anyway** → lost; no dead letter | — | `notifier.service.ts processAll` (catch → continue → `xack`) |
| Provider send | 3 attempts, backoff 1 s / 3 s, then `FAILED` row; no later retry | — | `notifier/retry.ts` |
| Duplicate protection | Skips an alert that already has any `NotificationLog` row (also skips a partial resend) | — | `handleAlert` (`notificationLog.count({ where: { alertId } })`) |
| Valkey persistence | Installer sets `noeviction` and localhost bind; **does not enable AOF** (package default persistence; not verified on host) | — | `ops/deploy/linux/install-ubuntu.sh` lines 51–57 |

> **Resolved in E0.5 (2026-11-11):** The row said "chaos: 36,220 sent, 0 lost". 36,220 appears only in `docs/modernization/05-technical-risk-register.md` l.110 (R-41). The full chaos evidence reports **26,521 / 26,521, 0 lost, 0 duplicates** (re-checked: `docs/reliability/test-evidence.md` l.75; `docs/reliability/evidence/2026-11-09-full-run/results.md` l.17; the E0 review cited the folder as `docs/modernization/`). The row now uses the evidence figure. Both are manual runs on 2026-11-09 and CI runs neither; condition C6 requires a re-run on the test instance before they serve as acceptance baselines.

**Conclusion:** location data is durable; **alert notification is at-most-once across a Valkey hiccup**. Acceptable
for fleet alerts, not for ETMS SOS.

> **E0.5 Lead note (2026-11-11):** The loss window is wider than a failed `XADD`: the processor acks positions before
> the rule commit, so a process crash between the DB commit and the `XADD` also loses the job (`14` G2 / F6); G2's
> sweeper covers both. For W4 / R-14 the post-G5 probe baseline is 0 FAIL with **21 PASS** (20 original + F-1) (`12` G5).
> The 26,521 / 0-lost chaos figure ran on Node 22 / Valkey 9 and must be re-run on production versions (C6, `16` §6).

### 1.6 Retention controls (Verified)

| Data | Rule | Evidence |
|---|---|---|
| Positions, trips, stops, fuel events, closed geofence visits, **alerts**, driver events | Company `retentionDays` clamped 30–180 | `retention/retention.service.ts` `effectiveRetentionDays`; `packages/shared/src/api.ts` `RETENTION_MIN_DAYS`/`MAX` |
| Notification logs | `NOTIFICATION_LOG_RETENTION_DAYS` (90) | `retention.service.ts LIMITS` |
| Raw packets 7 d, unknown devices 30 d, webhook deliveries, expired sessions/OTPs/resets | env / constants | same |
| Attendance selfies (file + row) | `ATTENDANCE_SELFIE_KEEP_DAYS` = 90 | `packages/shared/src/attendance.ts`; `attendance.service.ts` (purge loop) |
| Kill switch | `RETENTION=off` | `retention.service.ts` |
| Live-share links | ≤ 168 h, hashed token, revocable, end 15 min after arrival, view count | `live-share/live-share.service.ts`, `LIVE_SHARE_MAX_HOURS` |
| Gaps | Files left on disk after purge (R-16); purge deletes legally retained rows (R-36); **SOS alerts are deleted with ordinary alerts** (no legal hold); uploaded files not in backups (R-03, partially mitigated) | register |

### 1.7 Consent and disclosure today

- Tracker app shows a Google Play prominent disclosure before permission dialogs
  (`apps/tracker/src/app/disclosure.tsx`, strings `disclosureBody`); acceptance is **local only, not recorded
  server-side**, not versioned.
- Family/self-service phone adds use OTP consent (`schema.prisma` comments on self-service consent model, line ≈1927).
- No per-purpose consent records, no tracking time windows: tracking is ON until the person presses Stop.

### 1.8 Webhook / relay private-network protection (Verified)

`apps/api/src/webhooks/url-guard.ts` (`isPrivateAddress`, connect-time `lookup` re-check against DNS rebinding,
`WEBHOOK_ALLOW_PRIVATE`), `apps/api/src/relay/guard.ts relayPolicy` (`allowPrivate` when not production or
`RELAY_ALLOW_PRIVATE=true`, own hosts and device ports refused). Both depend on `NODE_ENV=production` (R-02). The
systemd units load `apps/api/.env` (`ops/deploy/linux/*.service EnvironmentFile`) and do not set `NODE_ENV`
themselves; whether the production `.env` sets it is **not verifiable from the repo** → open question.

### 1.9 Open security risks relevant to ETMS (from `RISK_REGISTER.md`, `docs/modernization/05-technical-risk-register.md`)

| ID | Risk | Status at v1.8.0 | ETMS impact |
|---|---|---|---|
| R-12 / AZ-1 | No permission ceiling | Planned P4 | **Blocker for E1** (role self-escalation to PII / override rights) |
| R-13 | API key scope > creator | Planned P4 | Keep ETMS out of `/api/v1` until fixed |
| R-14 | Socket after logout | Planned P4 | Live passenger data after off-boarding |
| R-15 | Template test-send with `view` sends real SMS | Planned P4 | SMS abuse, cost |
| R-16, R-36 | Purge leaves files / deletes retained records | Design pending | Incident records and consent evidence must survive |
| R-22 | Customer app signs out when offline | Planned P6 | An employee app that logs out offline cannot raise SOS |
| R-23 | Tracker silent re-pair by Android ID | Planned P6 | Device takeover of a passenger/driver identity |
| R-25 | No security headers, refresh token in localStorage | P7 | Web dispatcher session theft exposes manifests |
| R-26 | Lockout/throttler weaknesses | P7 | Booking spam, OTP abuse |
| R-27 | Device auth = IMEI only | P7 | Spoofed vehicle positions |
| R-37 | No SMS/mail provider in production; mail logged SENT | Partially mitigated | SOS SMS cannot be promised today |
| R-05/06/07 | Stream trim, no DLQ, live state before commit | P7 | Trip-event integrity in outages |

---

## 2. Provider ↔ corporate-customer authorisation (Q9) — Proposed

### 2.1 Options

| Option | How | Pros | Cons | Verdict |
|---|---|---|---|---|
| A. Reuse `Partner` / `Company` hierarchy | Provider = Partner; customers = its companies; partner admins act in customer companies | No new table | `Company.partnerId` is **required and single** → a customer cannot use two providers, and existing reseller relations would silently become data grants. Partner is billing semantics; the platform's own docs say it grants no data. Corporate-managed customers would need fake partners. Provider would need full `companyId` switch (like Super Admin) → over-reach into every GPS module (history, commands, attendance). | **Reject** |
| B. `TransportServiceAgreement` + scoped grants in guards and query helpers | New agreement row (provider company, customer company, status, validity, grants, sites/zones); `AuthContext.agreements` loaded per request like `shares`; transport rows dual-keyed; helpers decide visibility | Many-to-many; explicit, time-boxed, revocable, auditable; mirrors the proven `VehicleShare` pattern; existing modules untouched because `ctx.companyId` never changes | New code path that every ETMS query must use; needs tests | **Recommend** |
| C. Ad-hoc cross-company row access | Queries use `companyId IN (…)` lists or per-row ACL tables | Flexible | No single point of control; easy to leak; per-row ACLs explode in volume (passengers × trips) | **Reject** (row-level grants only as a narrow addition, e.g. one incident link) |

### 2.2 Recommended design (Option B)

1. **Tenancy stays `Company`.** A provider is a `Company`; a corporate customer is a `Company`. Corporate-managed
   model: the customer company operates itself, `providerCompanyId = customerCompanyId`, no agreement needed.
2. **`TransportServiceAgreement`** (Agent 1 owns the schema; fields indicative): `id, providerCompanyId,
   customerCompanyId, status (DRAFT | ACTIVE | SUSPENDED | ENDED), startAt, endAt, grants (enum set, below), siteIds /
   serviceZoneIds (customer's), dataProfile (MINIMAL | STANDARD), createdBy, approvedByCustomerAt,
   approvedByProviderAt`. **Both sides must approve**; the customer can suspend unilaterally with immediate effect.
3. **Grants** (closed enum, never free text): `VIEW_BOOKINGS`, `MANAGE_DISPATCH`, `VIEW_PASSENGER_MINIMAL`,
   `VIEW_PASSENGER_CONTACT` (masked by default), `MANAGE_SCHEDULES`, `RECEIVE_INCIDENTS`, `MANAGE_INCIDENTS`,
   `VIEW_REPORTS`, `OVERRIDE_SAFETY_WARN` (never BLOCK overrides by default).
4. **Dual-keyed rows.** Booking, transport trip, manifest entry, incident carry `customerCompanyId` (data owner,
   retention and consent follow it) and `providerCompanyId` (operator). Fleet, drivers and devices stay in the
   provider's company and remain governed by existing helpers.
5. **Context.** `AuthContextService.forUser` adds `agreements: { id, customerCompanyId, grants, siteIds, endAt }[]`
   for active agreements where `providerCompanyId = companyId` (cached; invalidated on agreement change via the
   existing `RedisKeys.cacheInvalidate` channel; also re-checked on socket refresh).
6. **Helpers (single source).** `transportScopeWhere(ctx, grant)` →
   `OR [ { customerCompanyId: ctx.companyId, …branch/site scope }, { providerCompanyId: ctx.companyId,
   customerCompanyId IN agreements-with-grant, siteId IN agreement.siteIds } ]`, plus `assertTransportAccess(ctx,
   row, grant)` for single rows. Writes use a stricter `transportWriteScope`. **Passenger projections are chosen by
   the helper** (`MINIMAL` vs `STANDARD`), never by the controller.
7. **Guards.** New menu keys (e.g. `transport_bookings`, `transport_dispatch`, `transport_passengers`,
   `transport_policies`, `transport_incidents`, `transport_agreements`) gate *what* a role may do; the agreement
   gates *for which customer*. Both must pass. A CI test fails any ETMS controller route lacking a grant or a
   relation guard (fixes W2 for ETMS).
8. **Super Admin.** Keeps platform reach, but access to passenger PII and incidents of a customer requires a
   reason header and writes a `READ_SENSITIVE` audit event visible to the customer admin.
9. **Prerequisites:** fix R-12 (permission ceiling) and R-14 (socket session) before E1; add `READ_SENSITIVE` (or
   a separate `SensitiveAccessLog`) for passenger address/phone/live-location views.

> **Resolved in E0.5 (2026-11-11):** The `transport_*` key names in item 7 are replaced by the Lead's working names (`02` §3.1); Agent 6's semantics are kept. The final key set and group placement remain owner decision **P6** (Open). E0 review detail: menu keys are **`etms_*`** (`etms_bookings`, `etms_dispatch`, `etms_passengers`, `etms_policies`, `etms_incidents`, `etms_partners` for agreements), plus `etms_self` / `etms_driver`; semantics map 1:1 (`02` §3.1; `05` §1). Web routes follow `features/transport/*`.

### 2.3 Authorisation matrix (Proposed)

Scope legend: **OWN** = the caller's own record; **ASSIGNED** = trips/vehicles assigned to the caller; **SITE** =
caller's branches/sites in their own company; **COMPANY** = caller's company; **AGR(g)** = customers in an active
agreement that grants *g*, limited to the agreement's sites; **INC** = one incident via a signed link; **PLAT** =
all companies with reason + audit; — = no access. Actions: V view, C create, E edit, D delete/cancel, X export,
A acknowledge/approve, O override.

| Resource | Super Admin | Provider admin | Provider dispatcher | Corporate admin | Corporate dispatcher | Driver | Employee / passenger | Escalation contact |
|---|---|---|---|---|---|---|---|---|
| Service agreement | V/E PLAT (reason) | V/C(draft)/A COMPANY | V COMPANY | V/A/suspend COMPANY | V COMPANY | — | — | — |
| Employee transport profile (PII: name, phone, home address, gender, needs) | V PLAT (reason, audited) | V AGR(passenger) minimal | V AGR(passenger) minimal | V/C/E/D/X COMPANY | V/E SITE | V ASSIGNED: first name, pickup point, masked phone, during trip window only | V/E OWN | V INC: name + photo only |
| Booking | V PLAT | V/X AGR(bookings) | V/E(assign) AGR(dispatch) | V/C/E/D/X COMPANY | V/C/E/D SITE | — | V/C/D OWN (policy limits) | — |
| Recurring schedule | V PLAT | V AGR(schedules) | V/E AGR(schedules) | V/C/E/D COMPANY | V/C/E/D SITE | — | V/C/E/D OWN | — |
| Transport trip / manifest | V PLAT | V/C/E/D/X AGR(dispatch) | V/C/E AGR(dispatch) | V/X COMPANY (+C/E in corporate-managed) | V SITE (+C/E corporate-managed) | V/E(status events) ASSIGNED | V OWN leg only (vehicle, driver first name, ETA) | V INC |
| Vehicle live location | V PLAT | V COMPANY (own fleet) | V COMPANY / SITE | V for trips carrying its employees, trip window only | same, SITE | V own vehicle | V own trip's vehicle, from dispatch to drop + grace | V INC, until resolved + grace |
| Passenger phone location (if ever enabled) | — (break-glass only) | — | — | V only inside an open incident, if consented | V only inside an open incident | — | own device | V INC (last known) |
| Safety policy | V PLAT | V AGR(any) | V AGR(any) | V/C/E/publish COMPANY | V COMPANY | — | — | — |
| Policy evaluation result | V PLAT | V AGR(dispatch) | V AGR(dispatch) | V COMPANY | V SITE | — | — | — |
| Policy override (WARN) | — | O if AGR(override) | O if role + AGR(override) | O COMPANY | O SITE if role | — | — | — |
| Policy override (BLOCK) | — | — | — | Only if the policy version marks the rule overridable, two-person approval | — | — | — | — |
| Incident / SOS | V PLAT (reason) | V/A AGR(incidents) | V/A/E AGR(incidents) | V/A/E/close COMPANY | V/A/E SITE | C (raise), V own | C (raise), V own | V/A INC |
| Fleet, drivers, devices (existing masters) | as today | as today COMPANY | as today SITE | as today (own fleet if any) | as today | V own profile | — | — |
| Reports | V PLAT | V/X AGR(reports), aggregated, no home addresses | V AGR(reports) | V/X COMPANY | V SITE | V own duty summary | V own trip history | — |
| Audit / sensitive-access log | V PLAT | V COMPANY | — | V COMPANY (incl. provider and Super Admin access to its data) | — | — | V own access log (DSR) | — |

---

## 3. Driver vs employee mobile permissions (Q10) — Proposed

**Verified baseline:** `Driver` (`schema.prisma model Driver`) has no `User` link, so drivers cannot sign in today;
the tracker app authenticates a *device* (`MobileTrackerSession`, `ingestToken`), not a person; the customer app
(`apps/mobile`) builds its navigation from `MENUS` permissions. There is no passenger principal.

| Topic | Driver | Employee / passenger |
|---|---|---|
| Principal | `User` in the **provider** company, role "Driver", linked 1:1 to `Driver` | `User` in the **customer** company, role "Passenger", linked 1:1 to the employee transport profile |
| Authorisation style | Relationship: may act only on trips where `trip.driverId = me` and status ∈ {assigned … completed} | Relationship: own bookings/schedules/trip legs only |
| Sees about others | Manifest for the current trip only: first name (or initials per policy), pickup point label + coordinates, stop order, special-assistance flag, OTP/boarding code check result. **Phone masked**; contact through server-side call/SMS relay if available, else revealed only within the pickup window and logged | Driver first name + photo, vehicle number/model/colour, live vehicle position and ETA for own leg; never other passengers' names or addresses |
| Location collected | Vehicle position from the hardware tracker; driver phone location only while on duty (duty start → end), for trip execution | **None by default.** Optional, consented, per-purpose: (a) "share my location while waiting for pickup" (≤ 30 min window), (b) SOS last-known location at the moment of SOS. No background tracking of employees |
| Actions | Accept/decline trip, start, arrived, picked up / no-show (with geofence + time evidence), dropped, end, raise SOS/incident, report breakdown | Book/cancel within policy, confirm boarding (OTP / QR), rate, raise SOS, manage emergency contacts, view/export own data |
| Offline | Cached manifest for the current trip only, encrypted at rest, wiped at trip end + grace; events queued with client UUID idempotency | Cached own upcoming trips; SOS fallback (§6.6) |
| Data after trip | Manifest removed from the device; history shows trip ids and counts, not passenger names | Own history per retention |
| Prohibited | Bulk export, search across passengers, viewing past manifests, screenshots of manifest (Android `FLAG_SECURE` on manifest screen) | Viewing any other passenger, live vehicle outside own trip window |

> **Resolved in E0.5 (2026-11-11):** The "driver phone location only while on duty" cell (and the matching rows in §4.1, §4.2 `DRIVER_DUTY_LOCATION` and §4.3) is superseded by **D4, approved by the owner on 2026-11-11** (README §1.1, §5). Agent 6's original reasoning is kept for the record. The driver phone needs **no GPS initially**; driver phone location is **not collected by default** (the vehicle device or a tracker-app phone fitted to the vehicle feeds the tracker). An optional while-in-use fix may be attached to an SOS or event (`02` §7.1; `09` §2.1). The duty-window rule here applies only if the owner later enables driver-phone location.

**Minimum-data rules (server-enforced projections):** a DTO per audience (`PassengerForDriverDto`,
`PassengerForProviderDto`, `PassengerForCorporateDto`); gender is never sent to drivers (used only inside the policy
engine); home address is sent to the driver as a pickup point, not as a postal address, where shuttle stops are used;
phone numbers are masked (`+91 ••••• ••123`) unless the relevant grant + time window applies; every reveal is audited.

---

## 4. Location privacy and consent — Proposed (legal review required)

### 4.1 What is recorded

| Data | Source | Purpose | Proposed retention (configurable per customer/country) |
|---|---|---|---|
| Vehicle positions | Hardware tracker / driver phone on duty | Trip execution, ETA, safety, billing | Company `retentionDays` (30–180) as today |
| Trip events (pickup/drop with time + location) | Driver app, geofence | Safety evidence, billing, disputes | Longer than positions (e.g. 1 year), configurable; aggregate after |
| Passenger pickup point (home) | Corporate HR / employee | Routing | While employed + short grace; deleted on off-boarding |
| Passenger live location (optional) | Employee app, consented window | Pickup coordination, SOS | Minutes–days; SOS copy follows incident retention |
| Incident record + evidence | SOS / dispatcher | Safety, legal | Separate, long retention with legal hold; **excluded from ordinary retention and purge** |
| Consent records | Employee app / web | Proof of notice and consent | Life of account + statutory period |
| Sensitive-access log | API | Accountability | ≥ 1 year (legal to confirm) |

### 4.2 Consent and notice records

`ConsentRecord` (Agent 1 to model): `subjectUserId, customerCompanyId, purpose (PICKUP_LOCATION_SHARE |
SOS_LOCATION | DRIVER_DUTY_LOCATION | NOTIFICATIONS_SMS | …), noticeVersion, locale, granted/withdrawn, at, channel,
ip/device`. Notice texts are versioned templates per country and language (reuse `MessageTemplate`-style versioning).
The tracker's existing local disclosure becomes server-recorded. Withdrawal is as easy as granting and takes effect
on the next upload.

> **E2 security review (2026-11-11), DPDP notes:** consent comes from the data principal. A corporate admin may only
> withdraw on the passenger's behalf, or record a consent given offline with an evidence reference and a note (channel
> `ADMIN_RECORDED_OFFLINE`, distinct from the passenger's own `WEB` / `PASSENGER_APP`); the passenger gets an in-app
> notice (no SMS / mail provider in E2). Consent and notice rows are immutable in the database except for erasure /
> purge. Dispatchers see no home coordinates (pickup only, with routing consent) and no consent records; list rows carry
> no coordinates; admin detail reads of the home point are `ACCESS`-audited; provider reads are audited in the
> customer's log and providers cannot export passengers. An admin chooses only the initial password of an unused login;
> afterwards a one-time reset link, and every credential change / disable / unlink revokes the sessions (G5). Erasure
> on request ("Erase personal data", archived passengers) follows the L5 default, pending owner confirmation of L5.
> Addresses are geocoded only by a loopback / private-host Photon (`GEOCODER_URL`, refused otherwise).

> **Resolved in E0.5 (2026-11-11):** Lead names apply (`02` §3.1; condition C2). `ConsentRecord` is modelled as **`EmployeeTransportConsent`** (Agent 1's table with these purposes; `02` §3.1, §7.3). Likewise `SafetyPolicy*` → `TransportPolicy*`, `Incident` / `IncidentEvent` / `EscalationStep` → `TransportIncident` / `TransportIncidentEvent` / `TransportEscalationStep`, and `IncidentDelivery` → delivery states on the extended `NotificationLog`.

### 4.3 Time-window limits (enforced server-side, not only in the app)

- Employee location is accepted only inside an open window (`booking pickup − X min … boarded`, or an open incident).
  Points outside the window are rejected and not stored.
- Driver phone location is accepted only between duty start and end.
- Viewers see vehicle/passenger live location only inside the trip window (dispatch → drop + grace) or an open
  incident; enforced in the query helper and in the socket fan-out.
- Live-share-style links (pattern: `live-share.service.ts`) for escalation contacts expire at incident close + grace.

### 4.4 Regulatory considerations (flags, not advice)

| Jurisdiction | Points to raise with counsel |
|---|---|
| India, **DPDP Act 2023** and its Rules | Who is Data Fiduciary (corporate customer) vs Data Processor (provider, VeeTrax); notice content and languages; consent vs "legitimate uses" for employment purposes; children's data if students are added later; data-principal rights (access, correction, erasure, grievance) and response times; breach notification to the Board and principals; data localisation / cross-border transfer (owner's "nothing leaves the server" rule helps); retention limits ("erase when purpose served"). Also state transport / police guidance on night-drop safety for women employees (varies by state), Shops & Establishments rules. |
| United States | State comprehensive privacy laws (e.g. California CCPA/CPRA, which covers employee data, "precise geolocation" as sensitive personal information; other states mostly exempt employee data — verify per state); employee electronic-monitoring notice laws (e.g. New York Civil Rights Law §52-c, Connecticut, Delaware); state GPS-tracking statutes; biometric laws (Illinois BIPA, Texas, Washington) if selfie/face features are reused; breach-notification laws in every state. |
| Both | Gender-based assignment rules (female last-drop, female-driver preference) may raise discrimination questions in the US; keep policies configurable and per customer/country with legal sign-off before enabling (plan §10, §15). |

---

## 5. Safety policy engine — Proposed

### 5.1 Principles

Configurable per customer (and per site/country), **versioned and immutable once published**, evaluated server-side
on every assignment change, explainable (reason codes + human text), never hard-coded. Outcomes: **PASS**, **WARN**
(allowed, needs acknowledgement or override with reason), **BLOCK** (cannot publish/dispatch unless the rule is
marked overridable in that version and the override is approved).

### 5.2 Model (Agent 1 owns final schema)

| Entity | Key fields |
|---|---|
| `SafetyPolicy` | `customerCompanyId`, name, scope (sites, service zones, shift types), active version id |
| `SafetyPolicyVersion` | `version`, `status DRAFT/PUBLISHED/RETIRED`, `rules` (JSON, schema-validated), `publishedBy/At`, `legalReviewRef`, `effectiveFrom`; immutable after publish |
| `SafetyRule` (inside the JSON) | `code`, `when` (typed predicates from a registry), `outcome PASS/WARN/BLOCK`, `overridable`, `overrideRequires` (permission, second approver), `message` (i18n key) |
| `PolicyEvaluation` | `tripId`/`bookingId`, `policyVersionId`, `outcome`, `reasons[] {ruleCode, outcome, facts}`, `inputsHash`, `evaluatedAt`, `trigger` (assign, edit, re-route, driver swap, time change) |
| `PolicyOverride` | `evaluationId`, `ruleCode`, `reason` (required), `requestedBy`, `approvedBy` (≠ requester when required), `at`; audited |

**Predicate registry** (code, typed, tested; rules only compose them — no expression eval): `tripTimeWithin(window,
tz)`, `passengerAttribute(attr, op, value)` (attributes the customer chose to record, e.g. self-declared gender,
mobility need), `positionInTrip(passenger, FIRST|LAST)`, `escortAssigned()`, `driverVerified(kyc, licenceValid,
policeVerification)`, `vehicleVerified(permit, fitness, gpsOnline)`, `groupSize(op, n)`, `passengersFromDifferentCustomers()`,
`stopApproved()`, `routeDeviationAllowed(m)`, `driverAttribute(attr, op, value)`.

### 5.3 Example policies (configuration, not code)

| Example | Rule (as configured) | Outcome |
|---|---|---|
| Night drop | `tripTimeWithin(20:00–06:00, site tz) AND positionInTrip(passenger with attr X, LAST) AND NOT escortAssigned()` | BLOCK, overridable = false (customer's choice) |
| Escort requirement | `tripTimeWithin(night) AND groupSize(passengers with attr X, ≥1) AND NOT escortAssigned()` | BLOCK |
| Female-passenger last-drop | same as night drop but WARN in day hours | WARN, override by site lead with reason |
| Grouping restriction | `passengersFromDifferentCustomers()` (provider pooling) | BLOCK unless agreement allows pooling |
| Driver verification | `NOT driverVerified(policeVerification)` | BLOCK |
| GPS health | `NOT vehicleVerified(gpsOnline ≤ 5 min)` at dispatch | WARN |
| Approved stops | `NOT stopApproved()` for shuttle trips | BLOCK |

The optimiser (Agent 2) receives hard constraints from BLOCK rules and soft penalties from WARN rules; publishing
always re-evaluates (optimiser output is never trusted). Re-evaluation also on driver swap, passenger add/remove,
time shift, and live events (e.g. escort no-show → incident + WARN to dispatcher).

---

## 6. SOS and incident workflow — Proposed (answers Q11)

### 6.1 Principles

1. **Postgres first.** An SOS is committed to PostgreSQL before anything else; Valkey is an accelerator, never the
   system of record for safety events.
2. **Transactional outbox.** The incident, its first event and the outbox rows are written in one transaction.
3. **At-least-once delivery with idempotent consumers**, explicit dead-letter state, and honest status.
4. **Escalation timers live in Postgres**, not in Valkey TTLs or in-process timers.

### 6.2 Flow

```
Employee / driver app  ── POST /transport/incidents {clientIncidentId (UUID), type SOS, tripId?, lat,lng,acc,fixAt}
   (also from hardware SOS on a vehicle with an active transport trip → processor creates the incident the same way)
      │  single DB transaction:
      │    Incident(status OPEN, severity CRITICAL, customerCompanyId, providerCompanyId, tripId, lastKnownLocation+time)
      │    IncidentEvent(CREATED, actor, source)
      │    OutboxEvent(type IncidentCreated, aggregateId, payload, availableAt=now)   ← event schema v1
      │    EscalationStep rows from the customer's escalation plan (level 1 at T+0, level 2 at T+N …)
      ▼  201 {incidentId, status "RECEIVED_BY_SERVER"}   (idempotent on clientIncidentId)
Outbox relay (in the notifier process, DB poller: SELECT … FOR UPDATE SKIP LOCKED, every 1 s)
      ├─ Valkey up:   XADD vt:notify {incidentId, step}  → notifier sends
      └─ Valkey down: SOS-only direct send from the relay (push + SMS + e-mail), writes delivery rows itself
Escalation sweeper (same process, DB-driven): steps whose dueAt ≤ now and incident not acknowledged → send next level
Delivery receipts: Expo push receipts poll, SMS DLR webhook, e-mail bounce → update IncidentDelivery
Acknowledge: POST /transport/incidents/:id/ack (dispatcher, escalation contact via signed link) → stops escalation
Resolve: actions, notes, resolution code, close; evidence retained under incident retention / legal hold
```

### 6.3 Delivery-status truthfulness

| State (per recipient, per channel) | Set when | Shown to users as |
|---|---|---|
| `QUEUED` | outbox row exists | "Sending…" |
| `PROVIDER_ACCEPTED` | Expo ticket ok / SMS gateway accepted / SMTP accepted | "Sent to provider" (never "delivered") |
| `DELIVERED` | Expo receipt ok / SMS DLR delivered | "Delivered" |
| `FAILED` / `DEAD` | provider error after retries / retries exhausted | "Not delivered" + triggers next channel/level |
| `ACKNOWLEDGED` | the recipient acknowledged | "Acknowledged by <name> at <time>" |

The passenger/driver app shows: "SOS received by VeeTrax at 22:14. Notifying your security desk…" → "Security desk
acknowledged at 22:15". If no acknowledgement in N seconds, the app prompts the user to call emergency services
directly. Never "help is on the way" without an acknowledgement.

### 6.4 Changes needed in existing code (for the Lead; not done)

| Change | Where |
|---|---|
| Incident jobs must not be XACKed on failure; move to retry with backoff, then `DEAD` + System Health alert | `notifier/notifier.service.ts processAll` |
| Generic outbox/reconciler for alert → notify hop (also fixes fleet SOS): sweep `Alert` rows with `ackRequired` and no `NotificationLog` after N seconds | `processor/rules/rules-engine.ts commit` and the other `XADD vt:notify` sites |
| Implement escalation (currently `escalateAlarm` is empty) in a DB-scheduled way, reused by parking alarms | `notifier.service.ts escalateAlarm`, `ParkingSchedule.escalation` |
| Push receipts (Expo `getReceipts`) | `notifier/push.ts` |
| Exclude SOS from `ackAll`; audit every ack (`AuditService.record`) | `alerts/alerts/alerts.service.ts ack`, `ackAll` |
| ETMS SOS must not be disableable at company level, nor suppressed by maintenance / schedule / cooldown, while a transport trip is active | `alerts/logic/settings-resolution.ts`, `processor/position-processor.ts` |
| Tracker SOS wording: "received by server" instead of "sent to your company" | `apps/tracker/src/lib/strings.ts sosSent` |
| Enable Valkey AOF (`appendonly yes`, `appendfsync everysec`) — owner approval (production config) | `ops/deploy/linux/install-ubuntu.sh` |
| Incident data excluded from ordinary retention and purge | `retention/retention.service.ts`, `purge/purge-plan.ts` |

### 6.5 Escalation design

Escalation plan per customer/site (versioned like policies): level 1 dispatcher on duty (push + in-app siren), level 2
site security / transport manager (SMS + call where available), level 3 corporate escalation contacts, optional
emergency number display. Timers configurable (e.g. 60 s, 3 min, 5 min). Acknowledgement by any level stops further
levels but not the incident. Every step, send, receipt, ack and note is an `IncidentEvent` (append-only).

### 6.6 Offline fallback (device)

- SOS is stored in the device queue with `clientIncidentId` before any network call (same as `Engine.kt finishSos`
  today) and retried with backoff; duplicates collapse server-side.
- If the API is unreachable for > 10 s: full-screen fallback with **Call emergency (112 India / 911 US)**, **Call
  security desk** (number from the cached site config), **Send SMS** (opens the phone's SMS app prefilled with
  trip id, vehicle number and coordinates — sent by the user's own phone, no server involved).
- Mobile apps must never sign out or wipe on network errors (R-22) — a prerequisite for ETMS SOS.
- If PostgreSQL itself is down, the API returns 503 → same fallback; the queued SOS is delivered on recovery and
  flagged `late` with device time and server time.

### 6.7 Trip events (non-SOS)

Driver events (`PassengerPickedUp`, `TripStarted` …) use the same pattern: client UUID idempotency, Postgres write +
outbox; Valkey streams only for realtime fan-out and notifications. Outage behaviour: events are accepted while
Postgres is up; notifications catch up from the outbox after Valkey returns; no event is lost or duplicated.

---

## 7. Threat model — Proposed

### 7.1 STRIDE

| Category | Threat | Asset | Mitigation |
|---|---|---|---|
| **S**poofing | Stolen dispatcher session / refresh token from localStorage | Manifests, live location | httpOnly cookies, security headers (R-25), session-bound sockets (R-14), MFA for admin/dispatcher roles |
| S | Fake driver app / re-paired tracker identity | Trip events, passenger data | Driver = authenticated user + registered device; fix R-23; boarding OTP from passenger |
| S | GPS spoofing (mock location apps, replay) | Pickup/drop evidence, ETA, billing | Prefer hardware tracker for vehicle position; on phones check `isFromMockProvider`, speed/teleport plausibility (`roughSpikes` exists in mobile-tracker), cross-check with vehicle tracker; flag, never auto-trust |
| **T**ampering | Driver marks "picked up" without the passenger | Safety, billing | Geofence + time evidence + passenger OTP/QR; anomalies flagged |
| T | Edit of incident or policy history | Legal evidence | Append-only `IncidentEvent`, immutable policy versions, audit |
| **R**epudiation | "I never received the SOS" / "I never overrode the rule" | Accountability | Per-recipient delivery receipts and acks; override with reason + approver; audit |
| **I**nformation disclosure | Provider reads another customer's passengers | PII | Agreement-scoped helpers, dual-keyed rows, cross-tenant tests in CI |
| I | Driver scrapes passenger data | PII | Current-trip-only manifest, masked phones, rate limits, no search/export, `FLAG_SECURE`, wipe at trip end, anomaly alert on unusual access |
| I | PII in logs / notification bodies | PII | Templates with first name only; `NotificationLog.body` minimised; log redaction |
| **D**enial of service | Booking spam, OTP flooding, SOS flooding | Dispatch capacity, SMS cost | Distributed throttler in Valkey with DB fallback (R-26), per-user booking quotas via policy, SMS budget alarms |
| D | Valkey outage blocks SOS | Safety | Postgres-first + outbox + direct-send fallback (§6) |
| **E**levation of privilege | Dispatcher grants self override/PII rights | Safety, PII | Permission ceiling (R-12), immutable built-in roles, two-person rule for BLOCK overrides |
| E | Ungranted ETMS routes | Everything | CI test: every ETMS route has a grant or relation guard (W2) |

### 7.2 Abuse cases

| Abuse case | Scenario | Controls |
|---|---|---|
| Stalking via live location | Ex-partner working as dispatcher (or as escalation contact) watches an employee's position and home address | No employee phone tracking by default; live vehicle view only within trip window; home address hidden from provider roles (pickup point only); sensitive-access log visible to the corporate admin; anomaly alert on repeated views of one passenger; escalation links scoped to one incident and expiring |
| Provider over-reach | Provider keeps viewing a customer after contract end, or views HR attributes | Agreement `endAt` enforced per request; customer-side suspension; minimal projection; grants enumerated; quarterly access review report |
| Driver scraping passenger data | Driver screenshots manifests or calls passengers after hours | Masked phones / call relay; reveal only in pickup window; `FLAG_SECURE`; manifest wipe; complaints workflow |
| Booking spam | Script creates thousands of bookings; or employee books then no-shows repeatedly | Throttling per user/IP, policy quotas, cut-off times, no-show policy, CAPTCHA not needed for authenticated users but rate limits are |
| Spoofed GPS | Driver fakes arrival to mark no-show; employee fakes location in an SOS | Plausibility checks, hardware cross-check, mark "unverified location" rather than reject an SOS |
| SOS abuse | Prank or accidental SOS; fear of false alarms causes companies to disable SOS | Press-and-hold (exists, `SosButton.tsx` 2 s), cancel-with-PIN within 10 s that still notifies "cancelled by user", false-alarm resolution code and reporting, never auto-disable |

---

## 8. Open questions for the owner

1. **Provider model:** confirm a provider and a corporate customer are each a `Company`, and that a customer may
   contract **more than one** provider (rules out reusing `Partner`).
2. **Agreement approval:** must both sides approve an agreement in-app, or may the Super Admin create it on paper
   contract evidence?
3. **Prerequisite fixes:** approve fixing R-12 (permission ceiling), R-14 (socket session), R-22 (mobile sign-out) and
   the notifier ack-on-failure **before E1/E6**?
4. **Production config:** confirm `NODE_ENV=production` is set in the production `apps/api/.env` on app.veetrax.com,
   and approve enabling Valkey AOF.
5. **SMS/voice provider** for SOS escalation (DLT templates in India, 10DLC in the US); until then SOS escalation can
   only promise push + e-mail. Is a voice-call (IVR) channel in scope?
6. **Employee location:** confirm the default "no employee phone tracking" and that pickup-window sharing and SOS
   location are opt-in features.
7. **Gender-related safety rules:** which customers/countries need them; who records the attribute (self-declared?);
   legal sign-off owner.
8. **Retention:** incident retention period and legal-hold owner per country; trip-event retention beyond the
   current 180-day maximum?
9. **Super Admin access:** require reason + customer-visible log for Super Admin access to passenger PII and
   incidents?
10. **Emergency numbers / desk:** does each customer site provide a 24×7 security desk number and escalation
    contacts? Are escalation contacts users or external phone numbers only?
11. **Legal review:** who reviews DPDP notices (India) and US monitoring notices before pilot, and which US states
    are in scope first?
12. **Suspension semantics (R-21):** when a provider or customer is suspended mid-shift, do active trips and SOS keep
    working (recommended: yes for SOS)?

> **Resolved in E0.5 (2026-11-11):** Answered by decisions **approved by the owner on 2026-11-11** (README §1.1): Q1 first half by **D1** (each party is a `Company`; `Partner` stays billing-only); Q3 by **D6** (G2 notifier ack-on-failure, G5 logout / socket; R-12 as E0.5 item 0.5-9), approved as a gate, with implementation still needing separate authorisation; Q4 first half by the Lead production check (`NODE_ENV=production`, README §2); Q6 by **D4** (passenger phones not tracked continuously; opt-in, window-limited). Still open, with no answer chosen here (README §7): Q1 (several providers) and Q2 → **P1**; Q4 AOF window → **O1** (gate G4); Q5 → **C2**; Q7 → **L2**; Q8 → **L3**; Q9 → **L7**; Q10 and Q12 → **O5**; Q11 → **L1**.
