# 09 · Driver App (E0, Agent 5)

Scope: the driver side of brief questions 3 (Expo hosting) and 10 (driver permissions). Baseline: worktree
`D:\Vibhav\gps-app-wt\etms` = v1.8.0 (`f5b151b`). Sections are tagged **Verified** (a code path cited as
`path` › `symbol`) or **Proposed** (design, not built). Nothing here has been run or tested on a device.

---

## 1. Verified current state

### 1.1 Driver data model

| Item | Evidence | Notes for ETMS |
|---|---|---|
| `Driver` | `apps/api/prisma/schema.prisma` › `model Driver` | `companyId` (required), `branchId?`, `name`, `mobile?` (**not unique**), `employeeId?` (unique per company), `licenseNo?`, `licenseExpiry?`, `rfidTag?` (unique per company, `normalizeRfidTag`), `isActive`, `licenseNotifiedState`. Relations: `company`, `branch`, `assignments`, `documents`, `driverEvents`. **No `userId` and no relation to `User`.** |
| Driver ↔ vehicle sessions | `schema.prisma` › `model DriverAssignment`; `apps/api/src/drivers/driver-sessions.ts` › `switchDriverTx`, `endRfidSession` | Who drove which `TrackedObject` (`objectId`) and when. `source` = `MANUAL` or `RFID`. At most one open row per vehicle and per driver (partial unique indexes). Out-of-order points never close a session before it opened (`close()` clamp). |
| RFID identification | `apps/api/src/processor/driver-identification.ts` › `DriverIdentification.apply` | An RFID / iButton id in `attributes.driverId` puts the matching driver on the vehicle; ignition off ends an RFID session. This shows **physical presence** of a driver in a vehicle, and ETMS can reuse it as a pre-trip check. |
| Driver documents | `schema.prisma` › `model Document` (`driverId?`, `expiresOn`, `notifiedState`) | Licence and other documents with expiry reminders already exist. Reuse them for "Profile and Documents" and for the verification gate. |
| Driver events (ADAS / DMS) | `schema.prisma` › `model DriverEvent`, `DriverEventMedia` | These are events that **devices** raise (camera / DMS alerts) about driver behaviour. They are a different concept from driver-reported trip events, so do not reuse this table for those. |
| Driver APIs | `apps/api/src/drivers/drivers.controller.ts` › `@Controller('drivers')` | Admin CRUD, `GET assignments`, `POST assign`, `POST bulk`, `GET :id/history`; every route is guarded by `drivers` / `live_map` / `objects` permissions. **No driver-self endpoint.** |

### 1.2 Can a driver log in today? **No.**

- `packages/shared/src/permissions.ts` › `SYSTEM_ROLES` has only **Admin, Manager, User, Viewer**. There is no Driver role.
  `DataScope` is only `'COMPANY' | 'ASSIGNED'` (branches ∪ mapped objects, `apps/api/src/access/access-rules.ts` ›
  `objectScopeWhere`). No scope exists of the form "trips assigned to me".
- Nothing in `schema.prisma` links `Driver` and `User`. `User.mobile` is **globally `@unique`** while `Driver.mobile` is not.
- Mobile login already supports e-mail + password and **OTP by mobile**: `apps/mobile/src/app/login.tsx` → `/auth/otp/request`,
  `/auth/otp/verify`; `apps/api/src/auth/auth.service.ts` › `requestOtp`, `verifyOtp` (looks up `User` by `mobile`, 5-min
  code, 30 s resend interval, 5 attempts, single use). OTP needs SMS or Arattai configured (`OTP_UNAVAILABLE` otherwise).
- Workaround that is possible today, and why it is wrong: give a driver a `User` with the `User` role and ASSIGNED scope
  on the vehicle. The person then sees the vehicle's **live map, history, alerts and every planned trip of that vehicle**
  (`apps/api/src/planned-trips/planned-trips.service.ts` › `scopeWhere` filters by `objectId`, not by driver). That is
  far too much access, so do not use it.

> **Corrected in E0.5 (2026-11-11):** The OTP bullet said "10-min code". Re-verified at v1.8.0: `apps/api/src/auth/auth.service.ts` l.29 `OTP_TTL_MS = 5 * 60_000` (5 minutes; used for `expiresAt` at l.89), `OTP_RESEND_MS = 30_000` (l.30), `OTP_MAX_ATTEMPTS = 5` (l.31). This now agrees with `08` §3.

### 1.3 Trip infrastructure that can be reused (v1.8.0)

| Capability | Evidence |
|---|---|
| `PlannedTrip` statuses `SCHEDULED → STARTED → IN_PROGRESS → COMPLETED / INCOMPLETE / CANCELLED` | `schema.prisma` › `enum PlannedTripStatus`; `docs/routes-trips/SPEC.md` §3 |
| Stop statuses `PENDING / ARRIVED / DEPARTED / SKIPPED` with planned and actual times plus delay | `schema.prisma` › `enum PlannedStopStatus`, `model PlannedTripStop` |
| **GPS-driven** start, stop arrival, deviation, ETA and delay from the **vehicle's device** stream | `apps/api/src/planned-trips/tracker/evaluate.ts` › `evaluateTrip` (STARTED when inside start radius, IN_PROGRESS on leaving it, ordered stop arrival / departure, skipped stops); `tracker-engine.ts` |
| Manual start / complete / cancel (override, compare-and-set, audited) | `planned-trips.service.ts` › `start`, `complete`, `cancel`, private `close` (`updateMany where status = from`, else `ConflictException('The trip changed meanwhile')`) |
| Pure transition rules | `apps/api/src/planned-trips/trip-rules.ts` › `canStartTrip`, `canCompleteTrip`, `canCancelTrip`, `isNotStarted`, `isTimedOut` |
| One active trip per vehicle | `service.start` checks `ACTIVE_PLANNED_TRIP_STATUSES` (`packages/shared/src/planned-trips.ts`) |
| Trip events table | `model PlannedTripEvent` (`kind` = `UNSCHEDULED_STOP` / `DEVIATION`, required `lat/lng`, `data Json`). It holds only machine-detected episodes and has no actor, source or idempotency key. |
| Alerts | `TRIP_NOT_STARTED`, `TRIP_STOP_LATE`, `TRIP_STOP_SKIPPED`, `ROUTE_DEVIATION`, `TRIP_COMPLETED` (SPEC §3) |

Gaps: `PlannedTrip.driverId` and `RouteSchedule.driverId` are **plain UUID columns with no `@relation` and no index**, so
"my trips today" needs an index such as `(driverId, plannedStart)`. `SPEC.md` §5 lists the "driver app trip screen" and
passengers as out of scope. `apps/mobile` has **no** planned-trip screen; it appears only in report definitions
(`apps/mobile/src/features/reports/report-defs.ts`).

### 1.4 Mobile foundations (`apps/mobile`, "VeeTrax", `com.sasvata.veetrax`, iOS + Android, v0.6.9)

| Foundation | Evidence |
|---|---|
| expo-router with auth-guarded stack | `apps/mobile/src/app/_layout.tsx` › `RootStack` (`Stack.Protected guard={signedIn}`) |
| Role-based menus (client-side only) | `apps/mobile/src/app/(tabs)/more.tsx` (`can('drivers')`, …), `useAuth().can` |
| Token storage | `apps/mobile/src/lib/session.ts`: access token kept **in memory**, refresh token and company in **SecureStore** |
| API client | `apps/mobile/src/lib/api.ts` › `api`, `ApiError`, 401 refresh, `X-Company-Id` |
| Push incl. high-priority SOS channel | `apps/mobile/src/features/notifications/push.ts` › `ensureChannels` (`sos` channel, bypass DND), `registerForPush`; native `apps/mobile/modules/veetrax-alarm` |
| i18n (shared resources, hi / ta) | `apps/mobile/src/lib/i18n.ts` (`i18nResources` from `@veetracer/shared`) |
| Maps (MapLibre; **default styles are external OpenFreeMap**, self-hosted only if `EXPO_PUBLIC_MAP_STYLE_*` is set at build time, which no mobile build does yet: gate G8) | `apps/mobile/src/features/map/FleetMap.tsx`, `basemap.ts`; `apps/mobile/src/lib/config.ts` `MAP_STYLE` |
| Realtime socket | `apps/mobile/src/features/live/realtime.ts` |
| **Precedent for external navigation** | `apps/mobile/src/app/sos/[id].tsx` › `openDirections` (`google.navigation:` / `maps://`, web Google Maps fallback); `attendance-day.tsx` › `openMap` (Google Maps URL) |

> **Corrected in E0.5 (2026-11-11):** The Maps row said "MapLibre, self-hosted tiles". Re-verified at v1.8.0: `apps/mobile/src/lib/config.ts` l.8–10 `MAP_STYLE` defaults to `tiles.openfreemap.org` and `apps/mobile/eas.json` sets no `EXPO_PUBLIC_MAP_STYLE_*`, so mobile builds fetch external tiles today (as `08` §1.4 says). Only the production **web** build is configured for self-hosted Martin tiles (`VITE_MAP_STYLE_*`, `ops/deploy/linux/maps/README.md` l.15). Fixing the mobile builds is gate **G8** (`12` §2.1). Retained from the E0 review: the realtime socket accepts `live_map:view` **or** `alerts:view` (`live.gateway.ts` l.70).

No background location, no SQLite and no offline queue exist in `apps/mobile` (`package.json` has no `expo-sqlite` or
`expo-location`).

### 1.5 Tracker app (`apps/tracker`, `com.sasvata.veetrax.tracker`, Android only, v1.5.0) as a pattern

| Pattern | Evidence | Reuse for driver events? |
|---|---|---|
| Separate device auth: OTP activation → opaque token, a new activation revokes old tokens | `docs/mobile-tracker/API.md` §1–2; `apps/tracker/src/app/activate.tsx` | No. The token identifies a **device**, not a person, so it cannot be used for driver identity. |
| Native SQLite queue (WAL), primary key = fix time `t`, `CONFLICT_IGNORE`, cap 50 000, **oldest dropped** | `.../trackerengine/PointQueue.kt` › `add`, `peek`, `remove`, `CAP` | Copy the idempotent-key and FIFO ideas. **Do not** copy the silent drop-oldest: losing a "boarded" or "SOS" event is unacceptable. |
| Upload oldest-first batches; delete from queue **only after 2xx**; exponential backoff 5 s → 10 min; stop on 401 / 403 | `.../trackerengine/Uploader.kt` › `drain`, `send`, `backoff` | Yes. This is the confirm-before-delete pattern. |
| Every non-2xx answer is retried (comment: "a proxy or a server bug must never cost points") | `Uploader.kt` › `send` (`else -> backoff("Rejected…")`) | Partly. Driver events need a **terminal REJECTED** outcome (409 / 422 with a code) shown to the driver, otherwise a rule violation would retry forever. Note: `apps/tracker/README.md` says "other 4xx drop the batch", which contradicts the code. That is a doc drift. |
| Server-side idempotency via `createMany … skipDuplicates` | `apps/api/src/mobile-tracker/mobile-tracker.service.ts` (tracker events, ~L477 / L594 / L604) | Yes. Use a unique key plus insert-or-return. |
| SOS sent immediately, alone, bypassing backoff, kept if offline | `Engine.kt` › `sendSos`, `finishSos`; `apps/tracker/src/components/SosButton.tsx` (`HOLD_MS = 2000`) | Yes. Hold-to-trigger, jump the queue, persist. |
| Phone readiness checks (permissions, notifications, battery optimisation) | `apps/tracker/src/components/ChecksCards.tsx` › `useChecks` | Yes, for the "notification and connectivity checks" duty step. |
| Server moves only to allow-listed domains | `docs/mobile-tracker/API.md` §5; `ServerMove.kt` | Only relevant if the driver shell ever runs in the tracker binary. |

> **Corrected in E0.5 (2026-11-11):** The queue row said "cap 20 000". Re-verified at v1.8.0: `apps/tracker/modules/veetrax-tracker/android/.../trackerengine/PointQueue.kt` l.18 `const val CAP = 50_000` (oldest rows above `CAP` trimmed, l.49–54). The design conclusion (do not copy drop-oldest) stands. Retained from the E0 review: `DriverAssignment.source` is a `String` column (`schema.prisma` l.408 block), with the `MANUAL | RFID` union only in `packages/shared/src/drivers.ts`; adding `APP` needs no migration.

### 1.6 Command safety (Q-01)

`DECISION_LOG.md` › Q-01 / D-104: engine stop only when online, telemetry ≤ 60 s old, speed ≤ 20 km/h; **never queued**;
re-validated before execution. In `SYSTEM_ROLES`, `live_map.command` is held only by Admin (comment in the Manager role).
**The driver app must have no command capability at all.** The same principle, "never queue a safety-critical action and
re-validate on the server", carries over to the driver workflow (§4.4).

---

## 2. Hosting recommendation (brief Q3, driver side): **Proposed**

**Recommendation: build a driver shell inside `apps/mobile`.** It is a separate expo-router route group selected by the
server-reported identity and enforced by the server. Keep `apps/tracker` as the phone-as-GPS-device engine only.
Consider a separate binary only if the owner requires dedicated-device / kiosk mode (§2.3).

| Criterion | Shell in `apps/mobile` | Shell in `apps/tracker` | Separate binary |
|---|---|---|---|
| Auth | Reuses `User` login (OTP by mobile already exists) and session refresh | The tracker token is device identity (wrong subject); a user login would have to be added | Would need the `apps/mobile` auth copied |
| Foundations (API client, SecureStore, push + SOS channel, i18n, MapLibre, theme) | All present (§1.4) | No push, no Firebase, no EAS project (`apps/tracker/README.md`) | Duplicated or extracted into packages first |
| Platforms | iOS + Android | Android only (native Kotlin engine) | Either |
| Store | No new listing. Play data-safety and iOS review notes need updating. No background-location declaration needed (see below) | It holds the background-location declaration; adding trip UI widens its review surface | New listings, review, signing and support for both stores |
| Reuse-first rule (brief §3.4) | ✔ | ✘ mixes device identity and person identity | ✘ duplicates foundations |

### 2.1 Background location: the driver phone does **not** need to track

**Verified:** the planned-trip tracker evaluates the **vehicle's** position stream (`evaluateTrip` per `objectId`, fed by
the processor from the vehicle's device). Start, stop arrival, deviation and ETA already work with no phone at all.

**Proposed:**

- The driver shell uses **no background location**. Optionally it asks for *while-in-use* location to attach a phone fix to
  an SOS or as a fallback "in motion" signal. Event validation always uses the **vehicle's** telemetry (§4.4).
- For a vehicle without a GPS device (e.g. a contracted cab), install **`apps/tracker` on a phone assigned to the vehicle**
  (`docs/mobile-tracker/API.md`: device assigned to a vehicle). Location then reaches the same pipeline and nothing is
  duplicated. The two apps can live on the same phone; the existing deep link is `veetrax-tracker://`
  (`apps/mobile/src/app/(tabs)/more.tsx`).

### 2.2 Shell mechanics (Proposed)

- `/auth/me` gains `driver: { id, companyId } | null`. `_layout.tsx` adds `Stack.Protected guard={isDriverOnly}` around a
  `(driver)` group, and the existing `(tabs)` group is guarded by `!isDriverOnly`. A user who is both an admin and a driver
  gets a "Driver mode" switch. The client guard only controls navigation; the server is the authority (§3).
- Driver screens call only `/api/driver/v1/*`, a separate controller namespace in the spirit of `/api/tracker/v1`.

### 2.3 Shared or kiosk phones

| Model | Proposal |
|---|---|
| Personal phone (default) | OTP login per driver. The session persists (refresh token in SecureStore). |
| Vehicle-resident shared phone | OTP login at **duty start**, logout at duty end. **Logout is blocked while the event queue is not empty** (the driver gets a "Sync now" action, and the dispatcher can see pending-sync state). The queue and manifest cache are keyed by `userId` and wiped on logout after the queue drains. |
| Locked-down kiosk (Android dedicated device / MDM) | Out of E1–E3 scope. If the owner requires it, that is the one case that might justify a separate thin binary. Open question Q5. |

---

## 3. Driver identity and permissions (brief Q10, driver side): **Proposed**

1. **Linkage:** additive `Driver.userId String? @unique @db.Uuid` (relation to `User`, `onDelete: SetNull`). The driver's
   login is an ordinary `User` (`companyId` = the driver's company, `mobile` = the OTP number). Admins create or link it
   from Masters → Drivers. One `User` maps to at most one `Driver`. Because `User.mobile` is globally unique, a person
   who drives for two companies cannot have two logins. See open question Q3 (provider-managed drivers serving several
   customers belong to the **provider** tenant, which fits the model).
2. **Role:** a new system role **"Driver"** with one new menu key, e.g. `driver_duty: ['view','edit']`, and **no other
   keys**: no `live_map`, `history`, `plannedTrips` or `commands`. Caveat (Verified): the Admin role is built from **all**
   `MENUS` (`SYSTEM_ROLES[0]`, `Object.fromEntries(MENUS…)`), so Admins would hold `driver_duty` too. **Every driver
   endpoint must therefore also resolve `Driver` where `userId = ctx.userId` and `isActive`, and return 403 otherwise.**
   The permission alone is not enough.
3. **Scope:** a new data path keyed by driver identity, not `DataScope`. Each `/driver/v1` query is
   `companyId = ctx.companyId AND driverId = me.driverId AND plannedStart within [now − 12 h, now + 36 h]` (window as a
   policy parameter), plus the trip's ETMS passenger rows. Trip detail returns **404** (not 403) for trips not assigned to
   the driver.
4. **Minimum passenger data** (DTO, server-side projection, never filtering on the client): display name (first name +
   initial), pickup point label and coordinates, booking state, accessibility flag, and a boarding-PIN check result. A
   phone number is returned **only** when policy allows and only while the passenger's stop is the current stop and they
   have not boarded (§7). No employee id, home address text beyond the pickup point, or department.
5. **Reassignment:** if dispatch moves a trip to another driver, the old driver's next sync gets the trip as `REVOKED`
   and the app wipes its cached manifest. Queued events for it are rejected with code `NOT_ASSIGNED` and kept as late
   audit records (§6.4).
6. **Pre-trip identity checks** reuse existing data: `Driver.isActive`, `licenseExpiry` / `Document.expiresOn` not
   expired, and, where the vehicle has an RFID reader, the open `DriverAssignment` for the vehicle matching the trip's
   driver (`source = RFID`).

> **Resolved in E0.5 (2026-11-11):** **D5, approved by the owner on 2026-11-11** (README §1.1, §5), adopts items 1 and 3–5: driver = additive `Driver.userId` + Driver role, relationship-based access on `/api/driver/v1/*`, one login per person for E1–E3. Two names differ from item 2: the menu key is **`etms_driver`** (Lead naming, `02` §3.1), not `driver_duty`; and the Driver role is a per-company role template seeded only when `etms` is enabled (`12` WP 1a.2), not a global system role. The final template set is owner decision **P6** and multi-company drivers are **P3** (both Open).

---

## 4. Duty and trip workflow

### 4.1 State mapping: plan §9 vs v1.8.0 `PlannedTrip` (Verified left side, Proposed right side)

Design rule: **do not grow `PlannedTripStatus`** with driver sub-states. The processor tracker ranks only
`SCHEDULED / STARTED / IN_PROGRESS` (`evaluate.ts` › `OPEN`, `RANK`), and both the INCOMPLETE sweeper and the alerts key
off these values. Add **additive sub-state fields and an event log** instead.

| Plan §9 trip state | v1.8.0 equivalent | What is new (Proposed) |
|---|---|---|
| `PLANNED` | `SCHEDULED` | none |
| `PUBLISHED` | — (SCHEDULED trips are visible as soon as they are created) | `publishedAt` (nullable). The driver API lists only published trips. |
| `DRIVER_ACKNOWLEDGED` | — | `acknowledgedAt`, `acknowledgedBy`. Event `ACKNOWLEDGE`. Feeds a "not acknowledged by T−X" alert (Agent 6/7). |
| `DRIVER_EN_ROUTE` | `STARTED` (inside start radius) → `IN_PROGRESS` (left start), set by GPS or manual start | Driver event `START_TRIP` applies the existing `start` semantics (compare-and-set SCHEDULED → IN_PROGRESS) after the §4.3 guards. "En route" = IN_PROGRESS and next stop is a pickup. |
| `ARRIVED_AT_PICKUP` | `PlannedTripStop.status = ARRIVED` (GPS) | Driver event `ARRIVED` confirms or supplies the arrival (§4.4). Both GPS and driver sources are recorded. |
| `BOARDING` | — | Stop-level sub-state: ARRIVED with per-passenger outcomes `BOARDED / NO_SHOW` pending. Derived, not stored as a trip status. |
| `IN_PROGRESS` | `IN_PROGRESS` | none |
| `ARRIVED_AT_DROPOFF` | Drop stop `ARRIVED` | Per-passenger `DROPPED`. |
| `COMPLETED` | `COMPLETED` (`closedBy` AUTO / MANUAL / TIMEOUT) | Driver event `COMPLETE_TRIP`. New `closedBy` value `DRIVER`, or MANUAL with actor = driver. |
| (not in plan) | `INCOMPLETE` (timeout sweeper) | Keep it, and add it to the ETMS vocabulary. |
| `CANCELLED` | `CANCELLED` | Dispatcher only, never the driver. |
| `DELAYED` | `delaySec` (live) + `TRIP_STOP_LATE` | An **overlay**, not a state. Driver event `REPORT_DELAY {reasonCode, etaMin}`. |
| `NO_SHOW` | — | **Passenger-level** outcome, not a trip state. |
| `BREAKDOWN` | — | Overlay: an open incident on an IN_PROGRESS trip (the vehicle may still move or be replaced). |
| `EMERGENCY` | — | Overlay: open SOS incident (§7.3). |
| `INTERRUPTED` | — | New **terminal** trip outcome, set by the dispatcher when a breakdown or emergency ends the run. Passengers are transferred to a replacement trip (Lead / Agent 1 decide whether this is a status or `closedBy` + reason). |

> **Resolved in E0.5 (2026-11-11):** This mapping is the basis of **D2, approved by the owner on 2026-11-11** (README §1.1, §5): `PlannedTripStatus` is preserved unchanged and the plan §9 states are derived from `PlannedTrip` / `PlannedTripStop` statuses, `TransportTrip` milestone timestamps and per-passenger states (`02` §5.2). It supersedes the `TransportTrip` business-status enum proposed in `03` §2 / `04` §6. `INTERRUPTED` is recorded as `PlannedTrip` → `INCOMPLETE` (`closedBy = MANUAL`) plus `TransportTrip.interruptedAt` + reason, not as a new status (`02` §5.2). In R1 (D8) the dispatcher, not a driver app, sends these commands.

Whether ETMS trips **are** `PlannedTrip` rows or a new `transport_trip` that references one is decided by Agent 1 and the
Lead. This mapping holds either way, because the driver events address `(tripId, stopSeq, passengerTripId)`.

### 4.2 Duty flow (Proposed)

`OFF_DUTY → CHECKS_PENDING → ON_DUTY (vehicle bound) → [trip loop] → OFF_DUTY`. Duty is a lightweight record
(`transport_driver_duty`: driver, vehicle, start, end, checks result). Starting duty with a vehicle **may** call the
existing `switchDriverTx` with `source = 'APP'`. That is a new value of `DriverAssignmentSource`, so the existing driver
sessions stay the single source of "who drives which vehicle". Open question Q4.

### 4.3 Pre-trip checks (Proposed; policy-configurable per plan §10)

| Check | Source | Failure |
|---|---|---|
| Driver active, licence and documents valid | `Driver.isActive`, `licenseExpiry`, `Document.expiresOn` | **Block** |
| Trip assigned to me, published, SCHEDULED, within the start window | trip row | **Block** |
| Vehicle has no other active trip | existing check in `service.start` | **Block** |
| Vehicle telemetry fresh (e.g. ≤ 5 min) | vehicle last position | Policy: warn or block ("trip will not be tracked") |
| RFID matches the trip driver (if the vehicle has a reader) | `DriverAssignment` open, `source = RFID` | Policy: warn or block |
| Vehicle checklist (tyres, lights, first-aid, fire extinguisher, cleanliness; customer-defined) | driver form | Any "fail" item marked critical → **Block** + dispatcher alert |
| Phone readiness (notifications on, battery not optimised, online now) | pattern from `ChecksCards.tsx` | Warn |
| Safety-policy evaluation still passes (escort, late-night rules) | policy engine (Agent 6) | **Block** |

The checklist result is a server record. `START_TRIP` is accepted **only** if the server holds a passing checklist for
this duty, vehicle and trip window.

### 4.4 Driver-emittable events and server validation (Proposed)

Mobile clients never set states; they submit **events**, and the server's trip service decides (plan §9).

| Event | Offline-queueable? | Server validation (in addition to identity / scope §3) |
|---|---|---|
| `ACKNOWLEDGE` | Yes | Trip published, SCHEDULED, not already acknowledged (an ack that arrives again is idempotent). |
| `CHECKLIST_SUBMIT` | Yes, but `START_TRIP` waits for its ack | Template version current; a critical fail raises an alert. |
| `START_TRIP` | **No: online only, confirmed before the UI proceeds** (same spirit as Q-01: safety-gated, never queued) | All §4.3 blocks; compare-and-set `SCHEDULED → IN_PROGRESS`; audit with actor and source. If GPS already moved the trip to STARTED / IN_PROGRESS, return 200 `ALREADY_STARTED`. |
| `ARRIVED {stopSeq}` | Yes | Trip IN_PROGRESS; stop not DEPARTED or SKIPPED. Vehicle's fix nearest to `occurredAt` within `k × radiusM` (e.g. k = 3) → `verified`. No fix within ±2 min → accept as `unverified_location` (flagged for the dispatcher, never silently trusted). Clearly far away → 409 `NOT_AT_STOP`. |
| `BOARDED {passengerTripId, pin?}` | Yes | Passenger belongs to this trip and stop. The stop is ARRIVED (GPS or driver). PIN matches if the policy requires it. Capacity not exceeded. No conflicting `NO_SHOW` already accepted. |
| `NO_SHOW {passengerTripId, reasonCode}` | Yes | Stop ARRIVED **and** `occurredAt − arrival ≥ policy.minWaitMin`; no `BOARDED` accepted. A notification to the passenger / dispatcher follows (Agent 4/6). |
| `DEPARTED {stopSeq}` | Yes | Every passenger at the stop has an outcome, or the dispatcher has overridden. Otherwise 409 `UNRESOLVED_PASSENGERS`. GPS departure stays authoritative for times. |
| `DROPPED {passengerTripId}` | Yes | Passenger BOARDED; the stop is their drop stop (an early drop needs a reason code and is flagged). |
| `REPORT_DELAY / REPORT_OBSTRUCTION {reasonCode, etaMin?}` | Yes | Trip open. Creates an overlay and an alert. |
| `REPORT_BREAKDOWN / REPORT_INCIDENT {reasonCode, note?, photo?}` | Yes (photo uploads afterwards) | Trip or duty open. Creates an **incident** (Agent 6 entity) and an alert. |
| `REQUEST_ASSISTANCE` | Yes | Alert to the dispatcher. |
| `SOS` | Separate fast path (§7.3) | Always accepted from an authenticated driver; durable incident first. |
| `COMPLETE_TRIP` | Yes, but the UI shows "Completed – waiting to sync" until the ack | Trip STARTED / IN_PROGRESS. Passengers still BOARDED but not DROPPED → 409 `PASSENGERS_ON_BOARD` (the dispatcher can override). Then the existing `close` compare-and-set. |
| ~~Commands / engine stop~~ | Never | Not exposed (Q-01). |

Every accepted event records `actorUserId`, `driverId`, `source = DRIVER_APP`, `occurredAt` (device), `receivedAt` (server),
`clientEventId`, `deviceId` (install), and the validation outcome. Proposed storage is a new append-only
`transport_trip_events` table. `PlannedTripEvent` is not used because it has no actor or idempotency columns and requires
`lat/lng`; adding to it is the alternative that Agent 1 decides.

---

## 5. Screen map (Proposed)

```
(driver)                       ← Stack.Protected guard={isDriver}
├─ (tabs)
│  ├─ duty            Duty dashboard: duty state, bound vehicle, next trip card, checks status,
│  │                  sync banner (online / offline · N pending · N rejected), Start / End duty
│  ├─ trips           Assigned trips (today + next 24 h): time, route name, stop / passenger counts, ack badge
│  ├─ inbox           Driver notifications (assignment, change, cancel, dispatcher messages)
│  └─ more            History · Profile & documents · Language · Phone checks · Sign out
├─ checks/[dutyId]    Pre-trip vehicle + duty checklist
├─ trip/[id]          Trip detail: ordered stops, counts, vehicle, Acknowledge, Start trip (gated)
├─ trip/[id]/run      Stop-by-stop: current stop card, Navigate ↗, Arrived, passenger list, Depart
├─ trip/[id]/stop/[seq]  Pickup / drop list for the stop: Boarded (PIN) / No-show (reason) / Dropped
├─ incident/new       Delay · Obstruction · Breakdown · Incident · Request assistance (reason codes, photo)
├─ sos                Hold-to-send SOS + call dispatcher / emergency number (full screen)
└─ history/[id]       Completed trip summary: times, distance, counts only (no passenger names)
```

| Screen | Data / API (`/api/driver/v1`) |
|---|---|
| duty | `GET /me` (driver, company, vehicle, policies), `GET /duty/current`, `POST /duty/start` (online), `POST /duty/end` |
| trips | `GET /trips?from&to` (published, assigned, window) |
| trip, run, stop | `GET /trips/:id` (snapshot stops, minimal passengers, sub-state, `version`); `POST /trips/:id/events` (batch, idempotent); live vehicle status through a **driver-scoped** socket room for the bound vehicle only (the existing `realtime` socket is gated on `live_map`) |
| checks | `GET /checklists/template`, events `CHECKLIST_SUBMIT` |
| incident, sos | events / `POST /sos` |
| history | `GET /trips/history` (counts only) |
| profile | `GET /me/documents` (read-only view of `Document` where `driverId = me`) |
| sync | `GET /sync?since=<cursor>`: changed or revoked trips, event outcomes |

### 5.1 In-motion restrictions

Motion = the **bound vehicle's** speed from the server (driver-scoped live feed). When that is stale, the phone's
while-in-use GPS speed is used if permitted; with neither, the app assumes stationary but shows the small UI. The policy
threshold defaults to **> 10 km/h = moving**, with the release at < 5 km/h for 10 s.

While moving: only **Navigate**, **SOS**, **Call dispatcher** (hands-free hint) and a read-only next-stop card are
available. No passenger list, no text entry, no forms. **Arrived** is enabled only once stationary. Large touch targets,
high contrast, voice prompts (reuse `expo-speech` as in `features/notifications/voice.ts`).

### 5.2 Turn-by-turn navigation

- **Proposed default:** hand off to an external navigation app with a coordinate-only intent. On Android use
  `geo:<lat>,<lng>?q=<lat>,<lng>(<stop label>)`, which lets the driver choose Google Maps, OsmAnd or Organic Maps. On iOS
  use `maps://?daddr=`. The precedent is `apps/mobile/src/app/sos/[id].tsx` › `openDirections`. The label is the stop
  name or "Pickup 3", **never a passenger name**.
- **In-app turn-by-turn** on self-hosted GraphHopper (which produces instructions) is possible later but costly (rerouting,
  voice, safety review). It is not in E1–E3. In-app, show only a route preview on MapLibre with the trip `path` snapshot.
- ⚠ **Flag for the owner:** "nothing leaves the server" governs **our** server's calls (routing, geocoding, tiles). If the
  driver opens Google Maps, the **phone** sends the stop coordinates (often a passenger's home pickup point) to Google.
  This is a privacy decision, not a technical one. Options: allow any app / allow only OSM-based apps (`geo:` with an
  allow-list or an OsmAnd-specific intent) / in-app only. Open question Q1.

> **Validation note (E0 review):** The cited precedent is not a `geo:` chooser: `apps/mobile/src/app/sos/[id].tsx` `openDirections` uses `google.navigation:` (straight into the Google Maps app) / `maps://` with a web Google Maps fallback, and `attendance-day.tsx` `openMap` opens a Google Maps URL. So the existing fleet app already hands coordinates to Google. The driver hand-off is correctly an **owner decision** (README §7 L6), and the existing SOS / attendance links should be included in that decision.

> **Update in E0.5 (2026-11-11):** For the existing links the owner has decided **O9 (approved 2026-11-11)**: preserve the existing Google Maps hand-offs during E0.5 and introduce no new external sharing of passenger or driver location by default (README §1.1). The driver navigation hand-off proposed above is a **new** ETMS flow, so it stays **Open as owner decision L6**; until L6 is decided, the default under O9 is no external hand-off.

---

## 6. Offline event sync design (Proposed, built on the tracker patterns in §1.5)

### 6.1 Local store

- An SQLite queue in `apps/mobile` (`expo-sqlite`, as `apps/tracker/src/lib/db.ts` uses). Tables `event_queue(clientEventId PK,
  userId, tripId, seq, type, payload, occurredAt, state, attempts, lastError, serverOutcome)` and `trip_cache`.
- **Secure storage:** queued events contain IDs and codes only, with no names or phones. The passenger manifest cache is the
  sensitive part. Keep it encrypted (SQLCipher-enabled SQLite **or** AES with a key held in `expo-secure-store`; the Expo
  SDK 58 support must be verified per `apps/mobile/AGENTS.md`), or keep it in memory only and re-fetch. Wipe it on trip
  close, reassignment, logout, and at `plannedEnd + 2 h`.
- **No silent drop.** Unlike `PointQueue.CAP`, the driver queue never deletes unsent events. Above a soft limit the app
  shows a blocking "Sync required" banner.

### 6.2 Idempotency

- `clientEventId` = UUIDv7 generated **when the driver taps**, before any network call. The server holds a unique
  `(companyId, clientEventId)` (insert … `ON CONFLICT DO NOTHING`, then return the stored outcome). A repeat send returns
  the **original** outcome (200 with `duplicate: true`). This mirrors `skipDuplicates` in
  `mobile-tracker.service.ts` and the `t` primary key of `PointQueue`.
- `seq`: a monotonic counter per (install, trip), so the server can detect gaps and reorder.

### 6.3 Upload loop (from `Uploader.drain` / `send`)

FIFO per trip, oldest first, batches of ≤ 50. **Delete from the queue only after the server's per-event answer**
(confirm-before-delete). Per-event outcome:

| Server answer | Client state | Retry? |
|---|---|---|
| 200 `ACCEPTED` / `DUPLICATE` | CONFIRMED | — |
| 409 / 422 with `code` (e.g. `NOT_AT_STOP`, `TRIP_CLOSED`, `NOT_ASSIGNED`, `UNRESOLVED_PASSENGERS`) | **REJECTED**, with a reason the driver can see and act on | No (terminal) |
| 401 | Pause; refresh the session; if refresh fails, keep the queue and ask the **same** user to sign in again | After login |
| 403 `DRIVER_INACTIVE` | Pause, show "contact dispatcher" | Hourly, like the tracker's INACTIVE handling |
| Network / 408 / 429 / 5xx / unknown | PENDING | Backoff 5 s → 5 min (shorter cap than the tracker's 10 min because events are operational) |

Triggers: on enqueue, when the app comes to the foreground, on a connectivity-change event, and every 30 s while a trip is
open. No background task is needed in E1. Events wait in the queue until the app is next opened, which is acceptable
because the vehicle's GPS keeps tracking the trip on the server meanwhile.

### 6.4 Server reconciliation and out-of-order handling

1. Events are **appended first, then evaluated**. A rejected event is still stored (`outcome = REJECTED`, reason) so the
   trip can be reconstructed and audited. Late events after trip close are kept as `LATE` and never change the state.
2. **Order:** the server evaluates a batch in `(occurredAt, seq)` order. If `seq` reveals a gap (an earlier event has not
   arrived yet) for events that depend on it (e.g. `BOARDED` before its stop's `ARRIVED`), the server first checks the
   GPS-derived stop state. If GPS already marks the stop ARRIVED, it accepts; otherwise it returns 409 `OUT_OF_ORDER`
   (retryable by the client after its earlier events are sent). Because the client sends FIFO, this case arises only after
   a reinstall or a crash.
3. **Clock:** `occurredAt` must be ≤ server time + 2 min and ≥ `plannedStart − startWindow`. The client also sends
   `clockOffsetMs`, estimated from the server's `Date` header at the last sync. The server stores both raw and corrected
   times.
4. **Conflicts:** the first accepted passenger outcome wins (`BOARDED` vs `NO_SHOW`). A later contradiction is REJECTED as
   `CONFLICT` and raises a dispatcher review item. Corrections are a separate `CORRECT_OUTCOME` event, allowed within N
   minutes and while the trip is open. Dispatcher actions (cancel, reassign) always win over queued driver events.
   GPS-derived stop times stay authoritative for timing; driver events are authoritative for **passenger** outcomes.
5. **Sync down:** `GET /sync?since=cursor` returns trip changes and each pending event's outcome, so a reinstalled app or a
   second login on another phone converges.

### 6.5 Never show unconfirmed as confirmed

Each event and screen shows one of three states: **Pending** (clock icon, "waiting for network"), **Confirmed** (tick,
server time), **Rejected** (red, reason, next action). The local projection lets the driver continue (e.g. go to the next
stop after marking boarded offline), but every derived badge reads "not yet synced". Trip completion, SOS delivery and
dispatcher acknowledgement are **never** shown as done before a server ack. Offline mode never skips a server-side gate:
`START_TRIP` and `duty/start` are online-only, and every queued event is fully re-validated on arrival.

---

## 7. Driver privacy and safety (Proposed)

### 7.1 Passenger minimisation

| Context | Shown |
|---|---|
| Trip list | Counts only (stops, passengers) |
| Door-to-door current stop | First name + initial, pickup point, accessibility flag, booking note (customer-controlled) |
| Shuttle stop | Expected count and boarded count. Names only when policy requires a per-person check (PIN or name list) |
| Phone number | Policy-gated: only for the current stop, only before the passenger boards, ideally via a **masked or relayed call** (not available today; it needs a paid telephony provider, so it is out of scope under the no-paid-infra rule). Fallback: "call dispatcher" |
| After the passenger boards / drops / is marked no-show | Name collapses to "Passenger 3 ✓" |
| After trip completion | Manifest wiped from the device. The server API returns counts only (`history`). Retention is per customer policy (Agent 6) |

Also: navigation labels never contain names (§5.2). Screenshot blocking on manifest screens (`expo-screen-capture`; verify for
SDK 58). No passenger data in crash logs or analytics. Server access logs record driver reads of manifests (plan §10
"audit sensitive access").

### 7.2 Distraction and safety

In-motion lock (§5.1). Checklist blocks (§4.3). Incident reporting works with reason codes and one tap. No commands (Q-01).

### 7.3 Driver SOS

- UI: a full-screen SOS reached in one tap from every driver screen, **hold 2 s** (from `SosButton.tsx`).
- Fast path: `POST /api/driver/v1/sos {clientEventId, tripId?, phoneFix?}`, sent immediately and ahead of the queue (as in
  `Engine.sendSos`). The server **persists a durable incident first**, then raises an emergency alert on the existing
  pipeline: `isAlarmAlert` (`packages/shared/src/parking.ts`), the push `sos` channel in `push.ts`, and the full-screen alarm
  `apps/mobile/src/app/sos/[id].tsx` on dispatcher and admin phones. Context = trip, vehicle, and the **vehicle's** last fix
  with its timestamp (plus the phone fix if available).
- Offline: the event stays queued and retries every 5–10 s while the app is open. At the same moment, the screen offers
  **Call dispatcher** (`tel:`), **Call emergency** (112 India / 911 US by company country), and **SMS dispatcher**
  (`sms:` with trip code, vehicle and coordinates). States: "Not sent yet" → "Received by VeeTrax" (server ack) →
  "Acknowledged by <dispatcher>" (only after an ack event, pulled through `/sync` or pushed). The app never claims delivery
  without the server ack (plan §10).
- Durability through a cache or queue outage is a question for Agents 6/7 (brief Q11). This design needs the incident row
  in PostgreSQL before any Valkey publish.

---

## 8. Open questions for the owner

| # | Question | Default if unanswered |
|---|---|---|
| Q1 | Can drivers hand stop coordinates to **Google Maps** (third party, phone-side), or only OSM-based apps, or in-app only? | `geo:` chooser, no names in labels |
| Q2 | Is a **driver login** (a `User` per driver via `Driver.userId`) acceptable, and does it consume a `USER` licence seat (`LicenceType.USER`)? D-106 says no commercial rule is assumed. | Driver users don't consume seats in E1 testing |
| Q3 | Can one person drive for **several companies or providers** (global `User.mobile` uniqueness blocks a second login)? | One company per driver login |
| Q4 | Should starting duty in the app write a `DriverAssignment` (new source `APP`), and which source wins against RFID / MANUAL? | Yes; an RFID session overrides |
| Q5 | Are **shared vehicle phones / kiosk mode** required at launch? (They decide whether a separate binary is ever needed.) | No; personal phones, blocked logout while events are pending |
| Q6 | Boarding verification: **PIN** from the employee app, a name tick, or nothing (per customer policy)? | Policy flag, default name tick |
| Q7 | Passenger **phone visibility** to drivers without a masked-call provider: allow (policy-gated) or dispatcher-relay only? | Dispatcher relay only |
| Q8 | No-show minimum wait and the pickup-arrival tolerance (`k × radiusM`): customer-configurable defaults? | 5 min, k = 3 |
| Q9 | iOS driver support at launch, or Android first? (`apps/mobile` builds both; the tracker fallback is Android only.) | Both for the shell |
| Q10 | Should telemetry freshness at trip start **block** or **warn**? | Warn + dispatcher alert |

> **Resolved in E0.5 (2026-11-11):** The cross-agent dependency below is settled by **D2, approved 2026-11-11** (reuse `PlannedTrip`; ETMS events in `TransportTripEvent`); the driver login itself (Q2, first half) by **D5, approved 2026-11-11**. Still open, with no answer chosen here (README §7): Q1 → **L6** (O9 keeps only the *existing* hand-offs); Q2 licence-seat part → **C1**; Q3 → **P3**; Q4–Q8 and Q10 → **P5**; Q9 → **O6**.

Cross-agent dependencies: whether the trip entity reuses `PlannedTrip` and where event storage lives (Agent 1 / Lead);
incident and SOS durability (Agents 6, 7); the employee-side PIN and no-show notification (Agent 4); dispatcher override
and review UI (Agent 3).
