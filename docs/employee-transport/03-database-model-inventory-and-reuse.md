# 03 · Existing database model inventory, reuse matrix, new tables and migrations (Agent 1)

Answers brief questions **8** (§2–3) and **6** (§7). **V** = verified in `origin/main` f5b151b; **P** = proposed.
Schema: `apps/api/prisma/schema.prisma` (line numbers below refer to it). Nothing here has been applied anywhere.

## 1. Reuse matrix

| Concept | Existing model (path / line) | Decision | Reason |
|---|---|---|---|
| Tenant | `Company` (l.78) | **Reuse** | Isolation unit of every service (`access/access-rules.ts`) |
| Reseller | `Partner` (l.55) | **Do not use** for providers | Licence-pool / pricing concept, no data access |
| Sub-unit / depot | `Branch` (l.115) | Reuse | ASSIGNED scope already understands branches |
| Login identity | `User` (l.134), `Session`, `PushToken` | **Reuse** | Passengers, drivers, dispatchers sign in as users; users are free (V `billing.service.ts` l.158) |
| Roles | `Role`/`RolePermission` + `SYSTEM_ROLES` (`packages/shared/src/permissions.ts`) | **Extend** | New menus (`etms_*`) and system roles Employee / Driver / Dispatcher; behind feature flag |
| Passenger | — (`TrackedObject PERSON` is a tracked asset) | **New** `EmployeeTransportProfile` | Customer-owned, links to `User`, no continuous tracking |
| Vehicle | `TrackedObject` (l.299) | **Reuse** | `vehicleType` CAR/VAN/BUS/SCHOOL_BUS/AUTO… exists |
| Vehicle capacity / accessibility | — (`customFields` JSON untyped) | **New side table** `TransportVehicleProfile(objectId PK)` | Same pattern as `FuelConfig` / `ParkingSchedule` (objectId PK, cascade); avoids touching the hot `TrackedObject` |
| GPS device | `Device`, `DeviceAssignment` (l.245, l.363) | Reuse via vehicle | ETMS never references devices directly |
| Driver | `Driver` (l.378), `DriverAssignment`, `Document` | **Extend** `Driver.userId` (nullable, unique, FK SetNull) | Driver app login; documents/expiry already exist |
| Driver duty / availability | — | New `TransportDriverDuty` (E5) | No duty concept exists |
| Office site | `Poi` (l.878), category `OFFICE` | **Reuse** | Non-personal place with radius |
| Shuttle stop | `Poi`, category `SHUTTLE_STOP` + side table | **Reuse + extend** `TransportStopProfile(poiId PK)` | Keeps one place registry |
| Home pickup | — | Column group on profile / booking | Personal data must not become a `Poi` |
| Reusable fixed route | `Route`, `RouteStop`, `RouteSchedule` (l.2649–2717) | **Reuse** for fixed shuttles | Already generates trips |
| Vehicle run (execution, telemetry) | `PlannedTrip`, `PlannedTripStop`, `PlannedTripEvent` (l.2719–2800) | **Reuse + extend** (`routeId` nullable, `origin`) | Processor tracker, alerts, socket, reports already work (V `planned-trips/tracker/`) |
| Transport trip (business) | — | **New** `TransportTrip` 1:1 to `PlannedTrip` | Business lifecycle, customer/agreement, capacity |
| Passengers on trip | — | **New** `TransportTripPassenger` | Spec §5 excluded passengers |
| Trip app events | `PlannedTripEvent` is GPS-only | **New** `TransportTripEvent` | Idempotent, actor/source, append-only |
| Agreement | `VehicleShare` (l.1208) is only a precedent | **New** `TransportServiceAgreement` | Two-party contract with scope and status |
| Fleet allocation | — | New `TransportFleetAllocation` (E2) | Provider vehicles/drivers per agreement |
| Shift | `AttendanceSettings.shifts` JSON (different feature) | **New** `TransportShift` | Row-level, per site |
| Recurring commute | — | **New** `TransportSchedule` + `TransportScheduleException` | |
| Schedule instance | — | **Folded into** `TransportBooking` (`scheduleId`,`serviceDate`) | Avoids a third table; idempotency by unique key |
| Booking | — | **New** `TransportBooking` | |
| Consent | — | **New** `EmployeeLocationConsent` | Privacy evidence |
| Emergency contacts, preferences | — | JSON columns on profile | ≤3 contacts; no query need |
| Incident / SOS | `Alert` (l.984, `SOS` type) | **Reuse for delivery + new** `TransportIncident`, `TransportIncidentAction` | Alert is retention-deleted, needs objectId, no lifecycle |
| Safety policy | — | New `TransportPolicy` + `TransportPolicyVersion` (E6) | Versioned, explainable |
| Policy evaluation | — | Columns on booking / trip passenger (`policyVersionId`, `policyResult`, `policyReasons`) | Avoid a high-volume table until needed |
| Optimisation job, plan, versions | `RoutingJob`, `RoutePlan`, `RoutePlanVersion` on `feature/routing-engine` (unmerged) | **Reuse after merge** | No ETMS job table |
| Notifications | `vt:notify`, `NotificationLog` (l.1023), `MessageTemplate` (l.1043) | **Reuse + extend** `NotificationLog` | See §3.3 |
| Audit | `AuditLog` (l.600) | **Reuse + extend** enum `AuditAction += ACCESS` | Sensitive-access audit |
| Lookups (no-show reasons, incident types) | `Lookup` (l.541) | Reuse | System rows + company rows |
| Billing / licensing | `LicenceSeat`, `LicenceOrder`, `Invoice` | **Untouched** | Annual device model preserved |
| Feature flag | `Company.settings.features` / `COMPANY_FEATURES` (`packages/shared/src/api.ts` l.68) | **Extend** values `etms`, `etmsProvider` | Per-company flag + env kill switch `ETMS=off` |

> **Resolved in E0.5 (2026-11-11):** The Roles row above (and the `SYSTEM_ROLES` row in §3) are superseded by **D5, approved by the owner on 2026-11-11** (README §1.1, §5): the role is **Passenger**, not Employee. Agent 1's original text is kept for the record; the schema owner follows `02` / `12`, not this row (condition C2). The final template set and group placement remain owner decision **P6** (Open). E0 review detail: D5 names the role **Passenger** (not Employee), and `12` WP 1a.2 seeds Corporate admin / Dispatcher / Passenger / Driver as **role templates only when `etms` is enabled for a company**, explicitly *not* added to the global `SYSTEM_ROLES` (`ensureSystemRoles` would otherwise create them in every company). The flag name is `etms` (`02` §3.1).

> **Resolved in E0.5 (2026-11-11):** Lead names apply (`02` §3.1; condition C2): the consent table is **`EmployeeTransportConsent`** (renamed because Agent 6's purposes include non-location ones; `12` WP 2.0), which also applies to row 3 of §2 and to `04` §3 / §9. Likewise the Incident row's `TransportIncidentAction` is replaced by append-only **`TransportIncidentEvent`** + `TransportEscalationStep` (`02` §3.1), and the Fleet allocation row's phase is **E1b**, not E2 (`12` §6; see the note after §2).

## 2. Genuinely required new tables (answer to question 8)

Conventions (V, from existing models): `id String @id @default(uuid()) @db.Uuid`; `companyId @db.Uuid`;
`isActive Boolean @default(true)` for masters (archive, not delete); `createdAt/updatedAt @db.Timestamptz(3)`;
`createdById String? @db.Uuid` without FK; status as Prisma enum for core lifecycles, `String` for open sets;
partial unique indexes written as raw SQL in the migration (V `migrations/20261019090000_drivers/migration.sql`
l.43–44); JSON for small structured blobs. PD = personal-data class: **H** high (home location, health/accessibility,
contacts), **M** medium (name, employee code, trip history), **L** none/low.

**Minimum set for E1–E3 (10 tables):**

| # | Table | Key columns | Owner / FKs (delete) | Unique / indexes | Retention | PD |
|---|---|---|---|---|---|---|
| 1 | `TransportServiceAgreement` | id, providerCompanyId, customerCompanyId, status DRAFT/ACTIVE/SUSPENDED/ENDED, validFrom, validTo, scope JSON (sites, services, data fields), createdById, timestamps | both companies: FK → Company **Restrict** both | unique (providerCompanyId, customerCompanyId, validFrom); idx (customerCompanyId, status); CHECK provider ≠ customer | life of contract + 7 y (commercial) | L |
| 2 | `EmployeeTransportProfile` | id, companyId (customer), userId?, employeeCode, name snapshot, homeLat/homeLng/homeAddress, defaultStopPoiId?, officePoiId?, shiftId?, accessibility JSON, preferences JSON, emergencyContacts JSON, status ACTIVE/INACTIVE/PENDING, isActive, timestamps | FK userId → User **SetNull** (unique); FK companyId → Company Restrict; Poi/Shift FKs SetNull | unique (companyId, employeeCode); unique (userId); idx (companyId, isActive) | while employed; erase/anonymise on exit | **H** |
| 3 | `EmployeeLocationConsent` | id, companyId, profileId, purpose, textVersion, granted bool, at, source, appVersion | FK profileId Cascade | idx (profileId, at desc) | as long as profile + legal period | M |
| 4 | `TransportShift` | id, companyId, sitePoiId?, name, startMin, endMin, days Int[], overnight, timezone?, isActive | FK companyId Restrict; site SetNull | unique (companyId, name) | master | L |
| 5 | `TransportSchedule` | id, companyId, profileId, shiftId, direction IN/OUT, days Int[], pickupMode HOME/STOP, stopPoiId?, validFrom/To Date, isActive | FK profile Cascade, shift Restrict | idx (companyId, isActive); idx (profileId) | master | M |
| 6 | `TransportScheduleException` | id, scheduleId, date Date, kind SKIP/OVERRIDE, override JSON, reason, createdById | FK schedule Cascade | unique (scheduleId, date) | 1 y | M |
| 7 | `TransportBooking` | id, companyId (customer), profileId, scheduleId?, serviceDate Date, direction, pickupLat/Lng/Label, pickupPoiId?, dropLat/Lng/Label, dropPoiId?, windowStart/End Timestamptz, passengerCount, status (enum §9 of plan), agreementId?, idempotencyKey?, policyVersionId?, policyResult?, policyReasons JSON?, cancelReason, createdById, timestamps | FK profile Restrict (keeps history); schedule SetNull; agreement **SetNull** | unique (companyId, idempotencyKey); unique (scheduleId, serviceDate, direction); **partial unique** (profileId, serviceDate, direction) WHERE status NOT IN (CANCELLED, REJECTED, EXPIRED, FAILED); idx (companyId, serviceDate, status); idx (companyId, windowStart) | ETMS retention (default 1 y, owner) | M (H via pickup) |
| 8 | `TransportTrip` | id, plannedTripId, companyId (operator), customerCompanyId, agreementId?, routePlanId?, status (business enum), seatCapacity, version, publishedAt, acknowledgedAt, acknowledgedByUserId, cancelReason, timestamps | FK plannedTripId → PlannedTrip **SetNull** (see §4); customerCompanyId → Company Restrict; agreement SetNull | unique (plannedTripId); idx (companyId, status); idx (customerCompanyId, createdAt) | ETMS retention | L |
| 9 | `TransportTripPassenger` | id, tripId, companyId (customer), bookingId, pickupStopId, dropStopId, status PENDING/BOARDED/NO_SHOW/DROPPED/CANCELLED, boardedAt, droppedAt, noShowReason, updatedByUserId | FK trip Cascade; booking Restrict; stops → PlannedTripStop SetNull | **partial unique** (bookingId) WHERE status <> 'CANCELLED' (one active seat per booking); idx (tripId, status) | ETMS retention | M |
| 10 | `TransportTripEvent` | id, tripId, companyId, kind, actorType DRIVER/EMPLOYEE/DISPATCHER/SYSTEM, actorUserId?, source, clientEventId?, occurredAt (device), receivedAt, lat?, lng?, passengerId?, data JSON | FK trip Cascade | unique (tripId, clientEventId); idx (tripId, occurredAt) | ETMS retention; append-only | M |

> **Resolved in E0.5 (2026-11-11):** Two columns here are superseded by approved decisions (README §1.1, §5; Agent 1's original table is kept for the record). (1) `TransportTrip.status (business enum)`: **D2, approved 2026-11-11**, preserves `PlannedTripStatus` as the only trip lifecycle and derives the plan §9 states (`02` §5.1–5.2); `TransportTrip` records milestones as timestamps (`publishedAt`, `acknowledgedAt`, `interruptedAt`) and passengers carry per-passenger states; no status enum. (2) Table 7 (`TransportBooking`) carries only the customer `companyId`; **D1, approved 2026-11-11**, requires both `customerCompanyId` and `providerCompanyId` on dual-keyed rows, provider nullable until assignment (`02` §4.1). Retained from the E0 review (informational), note for the schema owner: the purge planner's logical key matches only a column named exactly `companyId` (`apps/api/src/purge/purge-plan.ts` `LOGICAL_KEY`, l.42), so dual-keyed rows without a `companyId` column are reached only through explicit FKs; decide this per table when 3.0 is written (`03` §4 rule).

**Needed in later phases (not E1–E3):** `TransportVehicleProfile` (E2), `TransportStopProfile` (E2),
`TransportFleetAllocation` (E2), `TransportDriverDuty` (E5), `TransportIncident` + `TransportIncidentAction` (E6,
longer retention, legal hold flag, last-known location snapshot so it survives Position retention),
`TransportPolicy` + `TransportPolicyVersion` (E6). Cost records (E7) only after owner decision.

> **Resolved in E0.5 (2026-11-11):** Phases follow `12`: `TransportFleetAllocation` is created in **E1b** (provider UI, after E3), not E2, because R1 is corporate-managed only under **D8, approved 2026-11-11**, and needs no provider fleet allocation (`12` §6). `TransportVehicleProfile` is **E2**, needed for R1 capacity checks (README §6). `TransportIncidentAction` is replaced by `TransportIncidentEvent` + `TransportEscalationStep` (`02` §3.1).

**Not created (deliberately):** booking-passengers, schedule-instances, trip-stops (= `PlannedTripStop`),
trip-versions (= `RoutePlanVersion` + `AuditLog`), optimisation jobs (= `RoutingJob`), vehicle/driver duplicates,
any GPS/position table, any notification table.

## 3. Extensions to existing tables (all additive)

| Table | Change | Risk |
|---|---|---|
| `PlannedTrip` | `routeId` → nullable; add `origin String @default("ROUTE")` | `DROP NOT NULL` is backward compatible; ~71 `routeId` references in 15 files (`planned-trips/*.ts`, `reports/planned-trips-report.ts`, `reports/trip-performance.ts`, web `features/planned-trips`, `packages/shared/src/planned-trips.ts`) must tolerate null. Tracker engine does not read `routeId` (V grep) |
| `Driver` | `userId String? @unique @db.Uuid`, FK → User SetNull | none |
| `NotificationLog` | `purpose String?`, `refType String?`, `refId String? @db.Uuid`, `dedupeKey String? @unique`, `providerMessageId String?`, `attempts Int @default(0)`, `nextAttemptAt Timestamptz?` + index (status, nextAttemptAt) | needs notifier code; also fix false SENT for console/no-provider (`01` §6.2) |
| `AuditAction` enum | add `ACCESS` | enum ADD VALUE is additive (not inside a transaction on old PG; PG 18 fine) |
| `COMPANY_FEATURES` / `MENUS` / `SYSTEM_ROLES` (code) | `etms`, `etmsProvider`; menus `etms_*`; roles Employee/Driver/Dispatcher | **Do not** backfill `RolePermission` to existing roles (unlike the routes migration l.171) while flags are off |

> **E0.5 Lead note (2026-11-11):** Superseded for implementation by `15` (database change plan, condition C2). The
> `PlannedTrip` change ships as its own migration `planned_trip_origin` together with WP 3.1, and the reference count
> is **72 lines in 15 files** excluding specs (79 / 18 including them), of which 4 need a code change (`15` §7.1). The
> E3 tables include **`TransportChangeSet`** (`15` §5.8). The `trip-performance.ts` "No driver" label bug is scheduled for
> WP 3.1 (`12` §5).

## 4. Tenant purge and company delete (V) and implications

**How it works today:** `apps/api/src/purge/purge.service.ts` `PurgeService` (Super Admin only, `purge.controller.ts`)
for kinds `device | object | user | company` (`purge-plan.ts` `PURGE_KINDS`). `planPurge` reads the live catalogue
(`loadCatalog`: `pg_constraint` FKs + `information_schema.columns`) and walks:
- every FK child of the target (children first); **SET NULL / SET DEFAULT FKs are skipped** (left to PostgreSQL);
  RESTRICT / NO ACTION / CASCADE children are deleted recursively;
- **logical keys without FK**: for `Company` every table having a column named exactly `companyId`, for
  `TrackedObject` every table with `objectId`, for `Device` every table with `deviceId` (`LOGICAL_KEY`); none for `User`;
- financial tables are never entered (`financial-guard.ts`; paid orders block the delete → 409);
- extra SQL for `RawPacket` / `RelayTarget`; live keys cleared (`clearLive`). All in one transaction.
Retention (`retention/retention.service.ts`) separately trims Position/Trip/Stop/Alert/NotificationLog by
`Company.retentionDays`; it does **not** touch `PlannedTrip` or `Route`.

**Implications for ETMS (P, must be tested in E1 per plan §8 "test tenant purge"):**

| Case | Behaviour if designed as in §2 | Rule |
|---|---|---|
| Purge customer company | Profiles, bookings, schedules (FK/`companyId`) deleted; `TransportServiceAgreement` deleted (Restrict FK walked) → `TransportTrip.agreementId` SetNull (provider trip header survives); `TransportTripPassenger.companyId` = customer → deleted via logical key. `TransportTrip.customerCompanyId` FK Restrict → **provider's trip headers are deleted** | Decide: keep provider trip headers (then `customerCompanyId` FK SetNull) or delete (Restrict). Recommended SetNull + anonymised counts for provider billing |
| Purge provider company | Its `PlannedTrip`s (logical `companyId`), `TransportTrip`s, events deleted; agreement deleted; customer bookings keep living (`agreementId` SetNull) | Customer-owned rows must never have a Restrict/Cascade FK to provider-owned rows |
| Purge a vehicle (`object`) | `PlannedTrip` has a bare `objectId` → deleted → with `TransportTrip.plannedTripId` **SetNull** the business header and passengers survive | Never name an ETMS column `objectId`/`companyId`/`deviceId` unless purge-by-that-key is intended; use FK with explicit `onDelete` |
| Purge a user (passenger) | Only FK children; `EmployeeTransportProfile.userId` SetNull → profile survives with PD | Need an explicit ETMS **erasure/anonymisation** routine (data-subject request) — purge alone is not enough |
| Retention | Position deleted after 30–180 days; ETMS tables untouched unless added | Add ETMS tables to `RetentionService` with their own setting; incidents with legal hold |

## 5. Migration chain conventions (V)

- Prisma 6 (`apps/api/package.json` `prisma ^6.19.3`), `migration_lock.toml` provider postgresql, 58 migration directories
  `YYYYMMDDHHMMSS_snake_name/migration.sql`, latest `20261113090000_routes_planned_trips`.
- Forward-only: **no down migrations** in the repo; rollback = forward-fix migration + restore from backup.
- Generated SQL plus hand-written additions (partial unique indexes, CHECK constraints, data backfills such as the
  `RolePermission` insert in the routes migration).
- Deployed by `ops/deploy/linux/release.sh` l.42 `npx prisma migrate deploy` during release.
- Timescale: `Position` hypertable created conditionally in the init migration (l.509).
- ETMS (P): one migration per phase, names after the current head (e.g. `202612xxxxxxxx_etms_accounts`), additive
  only, no backfill of permissions, tested on a fresh DB and on a production-like copy, plus a purge test.

> **E0.5 Lead note (2026-11-11):** "One migration per phase" has a documented exception: E3 has two migrations,
> `etms_bookings_trips` (WP 3.0) and `planned_trip_origin` (WP 3.1, same PR) (`12` §1, `15` §9.1). "Tested on a
> production-like copy" means synthetic, volume-scaled data unless the owner decides otherwise (README §7 L8).
> `btree_gist` is available on production but not installed and needs superuser (owner decision O16).

## 6. `feature/routing-engine` schema conflict (V) and resolution (P)

Evidence: `git show feature/routing-engine:apps/api/prisma/schema.prisma`; merge-base with main `07077b6`
(2026-11-09, before v1.8.0). The branch adds `RoutePlan`, `RouteAssignment`, **`RouteStop`**, `RoutingJob`,
`RoutingUsage`, `RoutePlanVersion`, enums `RoutePlanStatus`, `RoutingJobStatus`, relations on `Company` and `User`;
migrations `20261110110000_routing_engine_v2` (`CREATE TABLE "RouteStop"` with `planId, companyId, assignmentId,
ref, demand, serviceS, timeWindows, sequence, etaS, unassignedReason`) and `20261110120000_routing_jobs_plan_versions`.

Conflicts:
1. **Model/table name clash**: main already has `model RouteStop` / table `"RouteStop"` (v1.8.0, `routeId, seq,
   radiusM, offsetMin, waitMin`). Prisma schema will not compile with two models; the branch migration's
   `CREATE TABLE "RouteStop"` fails on any database at v1.8.0 (production included).
2. **Migration ordering**: branch timestamps `20261110110000/120000` sort **before** main's already-deployed
   `20261112…` and `20261113090000`. Applying an older-named migration after newer ones breaks lexical = apply order
   and makes `prisma migrate dev` report history drift.
3. Schema file diverged (main added stock, SIM, messaging, routes since the merge base).

Resolution (recommended):
- Rename the branch model to **`RoutePlanStop`** (table `"RoutePlanStop"`), relations `RoutePlan.stops` /
  `RouteAssignment.stops` keep their field names; update `apps/api/src/routing-v2/**` references.
- **Squash and re-time** the two branch migrations into one new migration named after main's head
  (e.g. `202611xx…_routing_engine_v2`), regenerated against main's schema; delete the old two (they were never
  deployed — branch is local-only per brief §1).
- Rebase/merge main into the branch first; the purge planner covers the new tables automatically via their
  `companyId` FKs (comment on the branch says so); confirm `RoutingJob`/`RoutingUsage` FKs to `Company` are
  Restrict (walked by purge) — they are.
- ETMS depends on this only from E4; E1–E3 must not wait for it (optimiser optional, manual dispatch first).

> **Resolved in E0.5 (2026-11-11):** The bullet "Rebase/merge main into the branch first" is superseded by **D3, approved by the owner on 2026-11-11** (README §1.1, §5) and `12` §1 / §7. Agent 1's original reasoning is kept for the record. The old branch stays isolated until its compatibility review (E0.5 item 6). Likewise "Reuse after merge" in the §1 optimisation row means reuse after that selective port. The routing work is ported **selectively onto a fresh branch from main after a compatibility review**, never by rebasing or merging `feature/routing-engine`; the `RouteStop` → `RoutePlanStop` rename happens only after that review of schema ownership, migration history and FK dependencies. The migration facts above are correct (verified: branch migrations `20261110110000_routing_engine_v2`, `20261110120000_routing_jobs_plan_versions`; main has `20261110090000`, `20261110100000` before them and `20261112090000`…`20261113090000` after them; merge-base `07077b6`).

## 7. Question 6 — using telemetry without duplicating it (V + P)

**Yes.** Verified facts: `Position` is keyed `(deviceId, fixTime)` with index `(objectId, fixTime DESC)`; live
state per object in `vt:live:<objectId>`; the processor already turns positions into trip facts on `PlannedTrip`/
`PlannedTripStop` (`actualArrival`, `delaySec`, `etaNextStop`, `distanceKm`, deviations) and publishes
`vt:plannedtrips:updates`. ETMS therefore stores **no positions**; it references telemetry by
`PlannedTrip.objectId` + trip time window, and reads:

| Need | Source (no copy) |
|---|---|
| Live vehicle for dispatcher | `vt:live:<objectId>` via existing live API/socket (scope: operator company) |
| Live vehicle for passenger | New narrow endpoint/socket event that returns only lat/lng/heading/ETA of **the trip's vehicle**, only while the passenger has an active `TransportTripPassenger` and inside the trip window (pattern: `LiveShare`); never `LiveObject` (contains `simNumber`, battery…) |
| Arrival / pickup times, delay | `PlannedTripStop` (processor) + `TransportTripEvent` (driver confirmation) |
| Replay / evidence | `GET /objects/:id/history?from&to` on the trip window |
| Vehicle without hardware tracker | Driver phone as a `mobile` protocol `Device` fitted to the vehicle → same `vt:positions` path (needs MOBILE_TRACKER seat) |

Caveats: (1) Position retention (30–180 days) erases evidence — incidents must snapshot location/time at creation
and support a legal-hold export; (2) `Position` has no `companyId`; every read must first authorise the object
(as `history.controller.ts` does); (3) employee phone locations for pickup are one-off booking data, not telemetry.

## 8. Open questions for the owner

1. Approve `PlannedTrip.routeId` nullable + `origin` (needed for option C in `03`)?
2. ETMS retention defaults (bookings/trips 1 year? incidents 3–7 years?) and legal hold for incidents.
3. On customer purge, keep provider's anonymised trip headers (SetNull) or delete them?
4. Data-subject erasure: anonymise profile and booking addresses in place, keep trip statistics?
5. Merge order: will `feature/routing-engine` be rebased with the `RoutePlanStop` rename before ETMS E4?
6. Should `NotificationLog` become the ETMS delivery ledger (extend, recommended) — confirms no second notification table.

> **Resolved in E0.5 (2026-11-11):** Q1 is answered by **D2, approved 2026-11-11** (`PlannedTrip.routeId` nullable + `origin`). Q5 is answered by **D3, approved 2026-11-11**: no rebase; selective port onto a fresh branch from main after the compatibility review, and the `RouteStop` rename only after that review. Q6 follows the Lead design (`NotificationLog` extended, `02` §3.1 / §3.2). Still open, with no answer chosen here (README §7): Q2 → **L3**; Q3 and Q4 → **L5**.
