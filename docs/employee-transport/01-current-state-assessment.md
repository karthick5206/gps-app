# 01 · Current-state assessment (Agent 1, Platform & Database Auditor)

Baseline: worktree `D:\Vibhav\gps-app-wt\etms` = `origin/main` **f5b151b** (tag v1.8.0). Read-only inspection, no
database or server contacted. Paths are relative to the repo root. **V** = Verified (code evidence cited),
**P** = Proposed or interpretation. Brief questions answered here: **1** (§12), **2** (§3), **6** (§9), **7** (§6).

---

## 1. Monorepo map and process topology (V)

| Unit | Path | Role |
|---|---|---|
| API | `apps/api/src/main.ts` (systemd `ops/deploy/linux/veetrax-api.service` → `dist/main.js`) | NestJS 11 HTTP + Socket.IO namespace `/live` (`apps/api/src/live/live.gateway.ts`, `LiveGateway`); schedulers (planned-trip generator, retention, reminders) |
| Gateway | `apps/api/src/gateway/main.ts` (`veetrax-gateway.service`) | TCP listeners GT06 5023, Teltonika 5027, JT808 6808, AIS-140 5030, JT1078 media 7612/attachments 7613; XADD to `vt:positions`; durable spool on Valkey outage (`gateway/spool/position-publisher.ts`) |
| Processor | `apps/api/src/processor/main.ts` (`veetrax-processor.service`) | Consumer group `processor` on `vt:positions` (`processor/stream-consumer.ts`); writes `Position` (`position-writer.ts`), live state, rules → `Alert` + XADD `vt:notify`; **planned-trip tracker** (`planned-trips/tracker/tracker-engine.ts`, kill switch `PLANNED_TRIPS=off`) |
| Notifier | `apps/api/src/notifier/main.ts` (`veetrax-notifier.service`) | Consumer group `notifier` on `vt:notify`; also runs webhook worker (`vt:webhooks`), driver-media worker (`vt:driver-media`), HTTP relay (group `relay` on `vt:positions`) |
| Summarizer | `apps/api/src/summarizer/main.ts` (`veetrax-summarizer.service`) | Every 60 s: positions → automatic `Trip` / `Stop` / `DailySummary`, late-data recompute, address fill |
| Web | `apps/web` | React 19 + Vite + Tailwind + MapLibre; nav from `MENUS` (`apps/web/src/features/shell/nav.ts`) |
| Mobile | `apps/mobile` | Expo "VeeTrax" (users sign in with User accounts; Expo push via `PushToken`) |
| Tracker | `apps/tracker` | Expo + native Android tracker engine "VeeTrax Tracker"; authenticates with `MobileTrackerSession` (device token, **not a User**) and posts to `POST /tracker/v1/positions` (`mobile-tracker/mobile-tracker.controller.ts`) which XADDs into the same `vt:positions` stream |
| Shared | `packages/shared/src` (`@veetracer/shared`) | DTOs, `permissions.ts`, `alerts.ts`, `planned-trips.ts`, `licences.ts`, i18n |

All Valkey keys live in `apps/api/src/redis/keys.ts` (`RedisKeys`). Data flow:

```
device ──TCP──> gateway ──XADD vt:positions (MAXLEN ~2,000,000, spool on outage)──> processor ──> Position (hypertable)
phone (tracker app) ──HTTPS /tracker/v1/positions──┘                          │   ├─> SET vt:live:<objectId>, PUBLISH vt:live:updates ──> API /live socket
                                                                              │   ├─> Alert + XADD vt:notify ──> notifier ──> email/SMS/push/Arattai + NotificationLog
                                                                              │   └─> PlannedTrip* updates + PUBLISH vt:plannedtrips:updates ──> socket plannedTrip.update
summarizer (DB poll) ──> Trip / Stop / DailySummary                           └─> webhooks (vt:webhooks) ──> WebhookDelivery
```

## 2. Authentication (V)

| Item | Evidence |
|---|---|
| Login | `apps/api/src/auth/auth.controller.ts`: `POST /auth/login` (email or mobile + password), `otp/request`, `otp/verify` (SMS OTP, `OtpCode`, TTL 5 min `auth.service.ts` `OTP_TTL_MS`), `refresh`, `logout`, `password/forgot|reset`, `GET /auth/me`, sessions, `push-token` |
| Tokens | `auth/token.service.ts`: access JWT 15 min (`ACCESS_TTL_SEC`), payload `AccessTokenPayload {sub, cid, sa, sid}` (`access/auth-context.ts`); rotating refresh token 30 days, SHA-256 at rest in `Session.refreshTokenHash` |
| Global guards | `access/auth.guard.ts` `JwtAuthGuard` (Bearer required unless `@Public()`; API keys `vtx_` rejected outside `/api/v1`), session revocation checked per request (`AuthContextService.fromToken`) ; `access/permission.guard.ts` `PermissionGuard` enforcing `@RequirePermission(menu, action)` / `@RequireAnyPermission` (`access/decorators.ts`); CSV export additionally needs `export` |
| `AuthContext` | `access/auth-context.ts`: `userId, homeCompanyId, companyId` (effective), `allCompanies?`, `isSuperAdmin, permissions, dataScope, branchIds, objectIds, shares?, ip, sessionId, apiKey?, licenceOverride?` |
| Company switch | `AuthContextService.forUser`: `X-Company-Id` honoured **only for Super Admin**; everyone else locked to `User.companyId`. Suspended company → 403 |
| Identity uniqueness | `User.email @unique`, `User.mobile @unique` **globally** (schema `model User`), so one phone/e-mail = one User across all tenants |
| Public API | `ApiKey` (hashed, scopes, branch limit, rate limits) for `/api/v1` (`apps/api/src/public-api`) |

## 3. Tenancy and isolation (V) — answers question 2

| Concept | Meaning in code | Evidence |
|---|---|---|
| **Tenant = `Company`** | Every operational row carries `companyId`; the user's company is the isolation boundary | `model Company` (schema l.78); `AuthContext.companyId` |
| `Partner` | **Reseller / licence-pool owner**, not an operational tenant. Every company belongs to one partner (`Company.partnerId`, Restrict). `Partner.homeCompanyId` = the reseller's own company whose admins manage the partner licence pool and price overrides. Partner users get **no** read access to their customers' vehicles or data | `model Partner` (l.55); `licences/partners.service.ts`; `auth/me.service.ts` (only looks up `partner` by `homeCompanyId`) |
| Platform company | `Company.isPlatform = true`: the Super Admin's company; all add-on features, no licences needed | `common/company-features.ts` `companyFeatures`; `licences/billing.service.ts` l.98 |
| `accountType` | `BUSINESS` / `INDIVIDUAL` / `FAMILY` (personal accounts with consented family phones). Personal accounts hide business menus (`PERSONAL_HIDDEN_MENUS` incl. `drivers`, `routes`, `plannedTrips`) | `enum AccountType`; `packages/shared/src/permissions.ts` |
| `Branch` | Sub-division inside a company; drives ASSIGNED data scope | `model Branch`, `UserBranch` |
| Add-on flags per company | `Company.settings.features` filtered by `COMPANY_FEATURES` (today only `attendanceInsightsPlus`) | `packages/shared/src/api.ts` `COMPANY_FEATURES`; `common/company-features.ts` |
| Cross-company access | Only `VehicleShare` (Super Admin grants another company view-only access to one vehicle, optional alerts, time-bounded); read paths opt in via `objectReadScopeWhere`; writes never reach shared vehicles | `model VehicleShare` (l.1208); `AuthContextService.sharesOf`; `access/access-rules.ts` `objectReadScopeWhere` |

**Isolation mechanism (verified):** application-level, not database-level. There is **no PostgreSQL row-level
security** (no `CREATE POLICY` in any migration) and no Prisma middleware or `$extends` that injects tenant filters (`apps/api/src/prisma/prisma.service.ts` is a plain `PrismaClient`). Each service builds its `where` from the
`AuthContext` with helpers in `apps/api/src/access/access-rules.ts`:

| Helper | Rule |
|---|---|
| `objectScopeWhere(ctx)` | COMPANY scope → `{companyId}`; ASSIGNED → `{companyId, OR:[branchId in ctx.branchIds, id in ctx.objectIds]}` |
| `objectReadScopeWhere` | above ∪ vehicles shared with the company (read only) |
| `branchScopeWhere`, `deviceScopeWhere`, `userScopeWhere` | same pattern for branches, devices (via open `DeviceAssignment`), users |
| `assertCanManageUserAccess` | ASSIGNED callers cannot place users outside their branches or grant COMPANY scope |
| `allCompaniesOr` | Super Admin "all companies" view on live map / lists |

Example of a feature applying it: `planned-trips/planned-trips.service.ts` l.92–94 (trip list restricted to
visible objects), l.302 (vehicle must be in `objectScopeWhere`). Consequence: **every new ETMS query must apply the
scope explicitly**; a missed `companyId` filter is a cross-tenant leak. Several high-volume tables have no FKs at all
(`Position`, `Alert`, `AlertRead`, `PlannedTrip` columns `companyId/objectId/routeId/driverId`).

## 4. Roles, permissions, menus (V)

- Catalogue: `packages/shared/src/permissions.ts` — `ACTIONS = view|create|edit|delete|export|command`; `MENUS`
  (menu key → group, path, allowed actions, `superAdminOnly`, `partnerOnly`). 43 menus incl. v1.8.0 `routes` (masters)
  and `plannedTrips` (main). `sa_*` menus are Super Admin only.
- Roles are per company (`model Role`, `RolePermission {roleId, menu, actions[]}`, `UserRole`); `Role.dataScope`
  COMPANY | ASSIGNED; a user's effective scope is COMPANY if any role has it (`access-rules.ts` `resolvePermissions`).
- `SYSTEM_ROLES` (`permissions.ts`): **Admin** (all non-platform menus, COMPANY), **Manager** (ASSIGNED, broad),
  **User** (ASSIGNED, tracking), **Viewer** (ASSIGNED, live only). Created per company by `ensureSystemRoles`
  (`access/system-roles.ts`, called from `masters/companies/companies.service.ts` and `mobile-tracker/self-service.ts`);
  it **does not add new menus to existing roles**, so each feature migration backfills `RolePermission` (e.g.
  `prisma/migrations/20261113090000_routes_planned_trips/migration.sql` l.171–177).
- No driver, employee/passenger, dispatcher, provider or customer role exists. There is no permission concept for
  "own records only" beyond ASSIGNED branch/object scope.

> **Validation note (E0 review):** `ensureSystemRoles` has a third caller not listed here: `apps/api/src/signup/signup.service.ts` (self-signup). The conclusion (no backfill of new menus to existing roles) is unaffected.

## 5. Person concepts that exist today (V)

| Concept | Model | Login? | Notes |
|---|---|---|---|
| Web/mobile user | `User` (l.134) | Yes (password / OTP, JWT) | `companyId`, roles, branches, objects, `managerId`, `PushToken[]`. **Users are free** — no USER licence seat needed (`licences/billing.service.ts` l.158; `SEAT_LICENCE_TYPES` in `packages/shared/src/licences.ts` excludes USER) |
| Driver | `Driver` (l.378) | **No** (no `userId`) | `companyId, branchId, name, mobile, employeeId, licenseNo, licenseExpiry, rfidTag, isActive`; `@@unique([companyId, employeeId])`, `@@unique([companyId, rfidTag])`; `DriverAssignment` (who drove which vehicle, partial unique open row, `drivers/driver-sessions.ts` `switchDriverTx`); `Document` (driver documents with expiry reminders); `DriverEvent` (ADAS/DMS) |
| Staff attendance "employee" | `TrackedObject` with `type = PERSON` + a phone `Device` (protocol `mobile`) | Tracker app session only | `AttendanceSettings`, `AttendanceDay`, `AttendanceSelfie`, `AttendanceOuting` keyed by `objectId` (`attendance/attendance.service.ts` l.240, l.486). The person is a **tracked object**, not a User |
| Phone tracker | `Device` + `MobileTrackerCode` + `MobileTrackerSession` + `TrackerEvent` | Device token | `Device.trackingRequired`; continuous tracking by design — semantics opposite to ETMS passenger privacy |
| Family member | `TrackedObject` PERSON in a `FAMILY` company, added with OTP consent (`MobileTrackerCode.purpose = FAMILY_ADD`) | — | `mobile-tracker/family.service.ts` |

None of these is a passenger. A passenger must be (a) a `User` for app login, push and auth, plus (b) a customer-owned
transport profile. Re-using `TrackedObject PERSON` would make every passenger a continuously tracked object and is
rejected (P, see `03`).

## 6. Notifications (V) — answers question 7

### 6.1 Pipeline
- Producers XADD `vt:notify` with either `alertId` (processor rules, `alerts/offline-alerts.service.ts`,
  `attendance/attendance.service.ts` l.743, `documents/reminders.service.ts` l.115) or `logIds` (pre-rendered
  `NotificationLog` rows in status QUEUED: `alerts/notify-queue.service.ts` `NotifyQueueService.enqueueMessages`).
- `notifier/notifier.service.ts` `NotifierService`: consumer group, `XAUTOCLAIM` of stale entries, concurrency;
  `handleAlert` resolves recipients per channel from `AlertSetting`/`RecipientList` (`RecipientExpander`), renders
  `MessageTemplate` (company → system fallback, versioned in `MessageTemplateVersion`, DLT fields), sends, writes one
  `NotificationLog` per recipient. Platform switches in `MessagingSettings` (SMS, e-mail, WhatsApp, Arattai).
- Retry: `notifier/retry.ts` `withRetries` — **3 in-process attempts, back-off 1 s / 3 s**. Then status FAILED; the
  stream entry is XACKed regardless. Re-delivery guard: alert jobs skip if any `NotificationLog` exists for that alert.
- **No dead-letter queue, no persistent retry schedule, no delivery receipts (DLR), no provider message id stored**
  (`NotificationLog` has `provider` name only; Smartping returns `transactionId` in `SmsResult.messageId` but the
  notifier discards it), no dedupe key for non-alert messages, no sweeper for rows left QUEUED if the XADD after
  the DB transaction fails (`enqueueMessages`).
- `NotificationLog` (l.1023): `companyId, alertId?, channel, recipient, templateId?, subject, body, status
  QUEUED|SENT|FAILED|SKIPPED, error, provider, sentAt`. Retention: deleted with company retention and a global limit
  (`retention/retention.service.ts` l.126, l.175).
- The alert path is coupled to `Alert`, which requires a non-null `objectId` (vehicle/object) and is deleted by
  retention after `Company.retentionDays` — fine for "vehicle late" style events, not for durable booking/SOS records.

### 6.2 Channel status

| Channel | Implementation | Code state | Production state |
|---|---|---|---|
| E-mail (SMTP) | `auth/mailer.service.ts` `MailerService` via `SMTP_URL` | Implemented | **Not configured** (per Lead / brief). In production with no provider, `send()` logs "NOT DELIVERED" and **returns normally**, so the notifier records **SENT** with provider `mailer` |
| E-mail (Zoho CPaaS / ZeptoMail) | `auth/zoho-mail.ts` (`ZOHO_MAIL_KEY`, takes precedence) | Implemented, unit-tested (`zoho-mail.spec.ts`) | Not configured |
| SMS Smartping (India DLT) | `notifier/sms.ts` `SmartpingSmsProvider` (`SMS_PROVIDER=smartping`) | Implemented, tested (`sms.spec.ts`); requires DLT template ids | Not configured |
| SMS MSG91 / Gupshup | `Msg91SmsProvider` | **Stub** — throws "not implemented yet" | — |
| SMS console (default) | `ConsoleSmsProvider` | Dev provider; production withholds content (`production-echo.spec.ts`) | **Active by default**; returns success → logs **SENT** with provider `console` although nothing was delivered |
| US SMS | — | **None** (no Twilio etc.); Smartping normalises 10-digit numbers to `+91` | — |
| Arattai (Zoho) | `notifier/arattai.ts`, OAuth in `MessagingSettings` | Implemented (OTP + one alert template) | Off by default (`arattaiEnabled=false`) |
| WhatsApp | enum `WHATSAPP` only | **Not implemented** (always SKIPPED) | — |
| Expo push | `notifier/push.ts` `ExpoPushProvider` (`PUSH_PROVIDER`, optional `EXPO_ACCESS_TOKEN`) | Implemented; tokens per `User` + `Session` (`PushToken`), invalid tokens pruned; parking alarm channel | Enabled by default (needs no secret); only reaches **User** sessions of `apps/mobile`, not the tracker app |
| In-app (socket) | `live/live.gateway.ts` `/live` namespace, channels `vt:alerts`, `vt:alerts:state`, `vt:plannedtrips:updates` | Implemented | Live; requires `live_map:view` or `alerts:view` at handshake |
| Webhooks | `webhooks/*`, `WebhookEndpoint`/`WebhookDelivery` | Implemented with **persistent retries** 60 s…6 h (`WEBHOOK_RETRY_DELAYS_SEC`), dedupe key, auto-disable after 50 failures, 30-day log | Live for companies with endpoints; events `alert.created, trip.completed, vehicle.status_changed, geofence.enter/exit, fuel.event` |

**Answer Q7:** implemented and operational today = in-app socket, Expo push, webhooks. E-mail (SMTP/Zoho), SMS
(Smartping) and Arattai are implemented but not configured in production; MSG91 is a stub; WhatsApp and US SMS do
not exist. The status in `NotificationLog` is **not trustworthy for e-mail/SMS** in the current production config
(false SENT), which violates the plan's "never claim delivery" rule (§10 of the source plan).

## 7. Audit (V)

`audit/audit.service.ts` `AuditService.record(ctx, entry, tx?)` / `recordSystem`: writes `AuditLog` (l.600:
`companyId?, userId?, action CREATE|UPDATE|DELETE|LOGIN|LOGIN_FAILED|LOGOUT|PASSWORD_RESET, entity, entityId,
changes Json, ip, createdAt`). Field diff `diffSnapshots`, secrets masked (`SECRET_FIELDS`). Can run inside the
caller's transaction. No READ/ACCESS action (needed for "audit sensitive access" — P: add enum value
`ACCESS`, additive). AuditLog is not trimmed by retention (no entry in `retention.service.ts`).

## 8. Billing and annual device licensing (V)

- `LicenceType`: USER (legacy, now free), GPS_DEVICE, DASHCAM, FUEL_SENSOR, MOBILE_TRACKER, API_ACCESS.
- `LicenceSeat` (l.1627): 12 months from activation; company pool or partner pool; subject `userId | deviceId |
  fuelObjectId` (unique, SetNull on delete → seat reused). Reminders D30…D0 (`licences/licence-reminders.service.ts`).
- `LicenceOrder` (l.1660): Razorpay (`licences/razorpay.ts`, `razorpayOrderId/PaymentId` unique) or offline
  (CASH/UPI/BANK_TRANSFER/CHEQUE, `UpiPaymentClaim`); `Invoice`/`CreditNote` with gap-free FY counters, GST.
- `LicencePolicyService` locks live updates for vehicles with expired seats (`licences/licence-policy.service.ts`;
  used by `LiveGateway`).
- Financial tables are protected from purge (`purge/financial-guard.ts` `FINANCIAL_TABLES`).
- **ETMS impact:** passengers and drivers as `User`s cost no seat; trip vehicles already need a GPS_DEVICE (or
  MOBILE_TRACKER) seat. Any ETMS pricing would be a new `LicenceType` value (additive enum) — owner decision; E0 does
  not change licensing.

## 9. GPS telemetry path and storage (V) — basis for question 6

| Store | Evidence | Notes |
|---|---|---|
| `vt:positions` stream | `redis/keys.ts` `positionsStream`, `DEFAULT_POSITIONS_STREAM_MAXLEN = 2_000_000` | Groups `processor`, `relay` |
| `Position` | schema l.559; Timescale hypertable on `fixTime` (`migrations/20261018002831_init/migration.sql` l.509) | PK `(deviceId, fixTime)`, index `(objectId, fixTime DESC)`; **no FKs, no companyId** |
| Live state | `vt:live:<objectId>` (`LiveObject` in `packages/shared/src/tracking.ts`), set `vt:live:company:<id>`, pub/sub `vt:live:updates` | `LiveObject` exposes `simNumber`, battery etc. — too much for passengers |
| History API | `GET /objects/:id/history?from&to` (`history/history.controller.ts` l.68, `history` or `objects` view) | track for a time window |
| Planned-trip tracking | `planned-trips/tracker/tracker-engine.ts`, state `vt:ptrip:<objectId>`; writes `PlannedTrip`/`PlannedTripStop`/`PlannedTripEvent`; socket `plannedTrip.update` | derived facts only (actual arrival, delay, ETA, deviations) |
| Public live link | `LiveShare` (l.1142): hashed token, expiry, optional destination ETA | precedent for time-boxed external viewing |
| Retention | `retention/retention.service.ts`: Position, Trip, Stop, Alert, NotificationLog… older than `Company.retentionDays` (default 90, min 30) deleted | **PlannedTrip is not trimmed** |

## 10. v1.8.0 Routes and planned trips (V)

Spec `docs/routes-trips/SPEC.md` (approved 2026-11-10). Models (schema l.2632–2800): `Route` (company-owned
reusable plan, `corridorM`, `path`, `@@unique([companyId,name])`), `RouteStop` (`routeId, seq, lat, lng, radiusM,
offsetMin, waitMin, geofenceId?`), `RouteSchedule` (days, `startMin`, default vehicle/driver, validity),
`PlannedTrip` (vehicle + driver + route snapshot + `plannedStart/End`, status SCHEDULED→STARTED→IN_PROGRESS→
COMPLETED|INCOMPLETE|CANCELLED, live `nextStopSeq/etaNextStop/delaySec`, `@@unique([scheduleId, plannedStart])`),
`PlannedTripStop` (planned vs actual arrival/departure, status PENDING|ARRIVED|DEPARTED|SKIPPED), `PlannedTripEvent`
(UNSCHEDULED_STOP | DEVIATION). Only child FKs exist (stops/events/schedules cascade from parent); `PlannedTrip`
has **no FK** to `Company`, `Route`, `TrackedObject` or `Driver`. Generator every 5 min for the next 24 h
(`planned-trips/planned-trip-job.service.ts`). Alerts ROUTE_DEVIATION, TRIP_STOP_LATE, TRIP_STOP_SKIPPED,
TRIP_NOT_STARTED, TRIP_COMPLETED (`packages/shared/src/alerts.ts`). Menus `routes`, `plannedTrips`. **Spec §5: no
passengers, no driver app trip screen, no optimisation.**

## 11. Other reusable building blocks (V)

`Poi` (company places with radius — office sites, shuttle stops), `Geofence`, `Lookup` (company-configurable codes,
system rows `companyId null`), `Document` (driver/vehicle documents + expiry reminders), `DriverAssignment`,
`MessageTemplate` (+versions, DLT), `ApiKey`/webhooks, `Company.settings.features` (per-company feature flags),
`RoutingService` (`apps/api/src/routing/routing.service.ts`, GraphHopper; Agent 2), `GeocodingService` (Photon).

## 12. Answer to question 1 — reusable models

| Need | Reuse | Fit |
|---|---|---|
| Tenant | `Company` (+ `Branch`) | Yes. `Partner` is a reseller, **not** a transport provider |
| User / auth | `User`, `Session`, `Role`, `RolePermission`, guards | Yes (needs new roles/menus; global email/mobile uniqueness is a constraint) |
| Employee | none fits — `TrackedObject PERSON` is a tracked asset | New customer-owned transport profile linked to `User` |
| Vehicle | `TrackedObject` (VEHICLE, `vehicleType` CAR/VAN/BUS/…) | Yes; no seat capacity column (side table proposed) |
| Device | `Device`, `DeviceAssignment` | Yes, referenced only through the vehicle |
| Driver | `Driver`, `DriverAssignment`, `Document` | Yes; needs a nullable link to `User` for the driver app |
| Notification | `vt:notify`, `NotifierService`, `NotificationLog`, `MessageTemplate`, `PushToken` | Yes, with additive gaps (purpose/ref, dedupe, provider id, honest status, retry) |
| Audit | `AuditService`/`AuditLog` | Yes (+ ACCESS action) |
| Billing | `LicenceSeat`/`LicenceOrder`/`Invoice` | Untouched; integrate later |
| Trips | `PlannedTrip` family | Yes as the execution/telemetry record (see `03`) |

## 13. Open questions for the owner

1. Confirm production env: `SMS_PROVIDER`, `SMTP_URL`/`ZOHO_MAIL_KEY` unset? Then the false-SENT behaviour (§6.2) must
   be fixed before any ETMS safety message relies on SMS/e-mail.
2. US SMS provider (none exists) — which, and is a paid provider acceptable later?
3. Is an employee allowed to be a passenger in two corporate customers with the same mobile? (`User.mobile` is
   globally unique.)
4. Should ETMS data have its own retention, separate from `Company.retentionDays` (Position is deleted after 30–180 days)?
