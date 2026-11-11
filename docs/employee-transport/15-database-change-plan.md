# 15 · ETMS database change plan (E0.5 deliverable 4 and 6)

| Item | Value |
|---|---|
| Status | **Plan only. Proposed, needs owner review.** No migration, schema, code or database was written, run or touched. Nothing below exists in code. |
| Phase | E0.5 (documentation and planning), README §1.1 items 4 ("finalise the database change plan from the authoritative data-model documents") and 6 ("keep the old routing branch isolated until its compatibility review") |
| Authority | D1–D8 approved 2026-11-11 (README §1.1, §5). `VALIDATION.md` condition **C2**: migrations are written from `02` §3.1 / §4 / §5 and `12`, **not** copied from the draft tables in `03` §2 / `04`. `03` / `04` are used here only as an inventory and input, together with their validation notes. |
| Code baseline | `origin/main` **f5b151b** = v1.8.0; read in the worktree `D:\Vibhav\gps-app-wt\etms` (HEAD `cd66618` = f5b151b plus the E0 docs commit, no code change). Migration head: **`20261113090000_routes_planned_trips`** (59 entries incl. `migration_lock.toml`, i.e. 58 migrations). Note: the local `main` ref in `D:\Vibhav\gps-app` is stale (`2b8bb93`, head `20261112100000_messaging_settings`); always use `origin/main` as "main". |
| Routing branch | Read only with `git -C D:\Vibhav\gps-app show / ls-tree / grep / rev-list` on `feature/routing-engine` (`19150e8`) and `feature/routing-r0` (`948cb44`). Not checked out, merged, rebased or pushed. |
| Code read | `apps/api/prisma/schema.prisma`, the migrations (routes, drivers, documents, init, inventory, SIM), `apps/api/src/purge/purge-plan.ts`, `purge.service.ts` (catalogue loader), `purge-financial.int.spec.ts`, `retention/retention.service.ts`, `access/access-rules.ts`, `access/system-roles.ts`, `packages/shared/src/permissions.ts`, `planned-trips/**`, `reports/planned-trips-report.ts`, `reports/trip-performance.ts`, `packages/shared/src/{planned-trips,history,drivers,api}.ts`, web `features/planned-trips/*`, `features/routes/*` |

Short references: `02` = [02-target-architecture.md](02-target-architecture.md), `03` =
[03-database-model-inventory-and-reuse.md](03-database-model-inventory-and-reuse.md), `04` =
[04-proposed-data-model-and-erd.md](04-proposed-data-model-and-erd.md), `05` =
[05-api-and-event-contracts.md](05-api-and-event-contracts.md), `10` =
[10-security-safety-and-privacy.md](10-security-safety-and-privacy.md), `12` =
[12-phased-implementation-plan.md](12-phased-implementation-plan.md), V = [VALIDATION.md](VALIDATION.md). **(V)** marks a
fact verified in code during this work, with its path.

---

## 1. Design rules applied to every new table

### 1.1 Repository conventions (V)

| Rule | Evidence | Applied as |
|---|---|---|
| `id String @id @default(uuid()) @db.Uuid` | every model | All ETMS tables. `OutboxEvent.id` is written by the application as a UUIDv7 (time-ordered, `05` §5.2); the column default stays `uuid()` as a fallback. |
| Tenant column `companyId String @db.Uuid` | `Driver`, `Route`, `PlannedTrip` | Customer-only and operator-only tables carry `companyId` (`02` §4.1). Dual-keyed tables carry `customerCompanyId` + `providerCompanyId` instead (D1). |
| `isActive Boolean @default(true)` on masters (archive, not delete) | `Driver`, `Route`, `Poi` | Profile, shift, schedule. Transactional rows (bookings, trips) use their own state columns, not `isActive`. |
| Times `@db.Timestamptz(3)`; `createdAt @default(now())`, `updatedAt @updatedAt` | `Driver` l.393–394, `Route`, `PlannedTrip` | Every timestamp. Service dates are `@db.Date`. |
| `createdById String? @db.Uuid` **without** FK | `PlannedTrip`, `Route` | All actor columns (`createdById`, `acknowledgedByUserId`, `outcomeByUserId`, `actorUserId`). No FK, so a user purge never deletes or blocks ETMS history. |
| Prisma enum for core lifecycles, `String` for open sets | `PlannedTripStatus` enum; `DriverAssignment.source`, `Poi.category`, `PlannedTrip.closedBy` are `String` | Enums for agreement / booking / passenger states and directions (used in partial indexes and CHECKs); `String` + CHECK for event kinds, sources, `PlannedTrip.origin`. |
| Partial unique indexes, CHECK and `EXCLUDE` constraints as raw SQL in the migration, documented with a `///` comment on the model | `migrations/20261019090000_drivers` l.43–44; `20261019170000_documents_service_reminders` l.27 (`Document_owner_check`); `DeviceAssignment` model comment | Same. Prisma cannot express them. |
| Side tables keyed by the master id | `FuelConfig(objectId @id, companyId)`, FK Cascade, `companyId` without FK | `TransportVehicleProfile`. |
| Forward-only migrations, no down files | `03` §5 (V: no down migrations in the repo) | Rollback = flags off + forward-fix migration (§9.4). |

### 1.2 Purge-planner rules (V, `apps/api/src/purge/purge-plan.ts`, `purge.service.ts`)

What the planner actually does, and the rules that follow for ETMS:

| Planner fact | Consequence | ETMS rule |
|---|---|---|
| Walks every FK child of the purged row; children with **SET NULL / SET DEFAULT** FKs are skipped and left to PostgreSQL (`planPurge`, `fk.del === 'n' \|\| 'd'`) | A SetNull FK keeps the child row alive with a NULL | Use SetNull exactly where a row must survive the parent's purge (the "keep" cases in §6). |
| RESTRICT / NO ACTION / CASCADE children are **deleted** recursively, before the parent | Restrict does **not** protect a child from a purge; it only blocks ordinary application deletes | Use Restrict where the application must not hard-delete the parent, accepting that a purge deletes the children. |
| Logical keys without FK: for `Company` every table with a column named **exactly** `companyId`; for `TrackedObject` exactly `objectId`; for `Device` exactly `deviceId`; none for `User` (`LOGICAL_KEY`, l.42) | A table is reached through the logical key only when it has that column **and no FK on that column** (`cat.fks.some(f => f.child === other && f.col === key)` skips it otherwise) | Never name an ETMS column `companyId`, `objectId` or `deviceId` unless "delete this row when that company / vehicle / device is purged" is intended. Dual-keyed tables therefore use `customerCompanyId` / `providerCompanyId` with explicit FKs and an explicit `onDelete` per side (S11). `TransportTrip` deliberately has **no** `objectId` column. |
| The catalogue reads only the **first** column of a composite FK (`a.attnum = con.conkey[1]`, `pa.attnum = con.confkey[1]`, `purge.service.ts` l.195–196) | A composite FK `(profileId, companyId) → (id, companyId)` is seen as `profileId → id`, which is the correct, narrow walk | In every composite FK, list the **row-id column first**. Put `companyId` second. Write a planner unit test that pins this (§9.6). |
| A table with a `companyId` column but a SetNull FK on it is skipped by both walks | It would survive a company purge with `companyId = NULL` | No ETMS table has a SetNull FK on a column named `companyId`. |
| Financial tables are never entered (`FINANCIAL_TABLES`) | — | No ETMS table is financial in R1. Cost records (E7) are decided under C1. |

### 1.3 CHECK constraints must survive SET NULL cascades

A CHECK that involves a column which an FK sets to NULL during a purge makes the purge transaction fail. Example
found while planning: "an `ASSIGNED` booking must have `providerCompanyId`" would abort a provider purge (SetNull on
`providerCompanyId`). Every CHECK below was tested on paper against the §6 purge matrix; CHECKs that would conflict
are replaced by transactional checks and listed as such.

### 1.4 Cross-tenant references

- **Same-owner references between ETMS tables** (profile → consent, schedule, booking; shift → schedule; schedule →
  exception; booking → trip passenger; trip → passenger, event) use **composite FKs** that include the owner column,
  so PostgreSQL itself rejects a reference to another company's row. The parent gets `@@unique([id, companyId])`
  (or the dual-key column). Prisma supports composite relations; composite FKs are used **only** with Restrict or
  Cascade (a SetNull composite FK would also null the owner column).
- **References into existing tables** (`Poi`, `User`, `TrackedObject`, `Driver`, `PlannedTrip`, `PlannedTripStop`)
  are simple FKs (or no FK where the existing table has none) plus a **transactional same-company check** in the
  service, because a composite FK would need a new unique index on the existing table. The isolation matrix (`12`
  WP 1a.3) tests each one.
- **Customer ↔ provider references** (dual-keyed rows in provider-managed mode) are validated against
  `ctx.agreements` (D1) inside the write transaction. In R1 (corporate-managed) `providerCompanyId =
  customerCompanyId` always.

### 1.5 State fields (D2)

No second trip, stop or status model. `PlannedTrip.status` / `PlannedTripStop.status` stay the only telematics
states. ETMS adds: booking state (a real column, `02` §5.2); trip milestones as **timestamps** on `TransportTrip`
(`publishedAt`, `acknowledgedAt`, `interruptedAt`, `cancelledAt`); passenger outcomes as a **per-passenger state**
on `TransportTripPassenger`; human / app events in the append-only `TransportTripEvent`. Plan §9 states are derived
(`02` §5.2). No `TransportTripStop` table: stops are `PlannedTripStop`.

### 1.6 Personal-data classes and retention

PD class as in `03` §2: **H** high (home location, health / accessibility, emergency contacts, precise location),
**M** medium (name, employee code, contact, trip history), **L** none / low. Retention values are the **recommended
defaults of owner decision L3, which is unresolved** (README §7): bookings / trips / events 1 year; consent life of
account + statutory period; incidents 7 years with legal hold. ETMS tables are **not** in `RetentionService` today
(V `retention.service.ts`); adding them is part of WP 2.6 / 6.4 once L3 is decided. Until then nothing is trimmed
automatically. Retention settings can live in `Company.settings` (JSON), so no column migration is required.

---

## 2. Entity count per phase

| Phase | New tables | Existing-table changes | Migration(s) |
|---|---|---|---|
| E0.5 (dependency, not ETMS) | 0 | `Alert.notifiedAt`; `NotificationLog` delivery columns (G2 / G3, `12` §2) | owned by the G2 / G3 patches |
| **E1a** | **2**: `TransportServiceAgreement`, `OutboxEvent` | `AuditAction += ACCESS` | `etms_accounts` |
| **E2** | **3**: `EmployeeTransportProfile`, `EmployeeTransportConsent`, `TransportVehicleProfile` | `Driver.userId` | `etms_people` |
| **E3** | **8**: `TransportShift`, `TransportSchedule`, `TransportScheduleException`, `TransportBooking`, `TransportTrip`, `TransportTripPassenger`, `TransportTripEvent`, `TransportChangeSet` | `PlannedTrip.routeId` nullable, `PlannedTrip.origin`, index `(driverId, plannedStart)`, ETMS-scoped exclusion constraints (if `btree_gist`, §8.2) | `etms_bookings_trips` + `planned_trip_origin` |
| **R1 total** | **13** | 4 existing tables (+2 in E0.5) | 4 ETMS migrations |
| E1b | 1: `TransportFleetAllocation` | possibly `TransportTrip.customerCompanyId` FK action (L5) | `etms_fleet_allocation` |
| E4 / E4b | 6 ported routing models (`RoutePlan`, `RouteAssignment`, `RoutePlanStop`, `RoutingJob`, `RoutingUsage`, `RoutePlanVersion`) + `TransportStopProfile` | `TransportTrip.routePlanId`; snapped-coordinate columns on profile / booking | `routing_engine_v2` (+ `etms_planning_links`), `etms_stop_profile` |
| E5 | 3: `TransportDriverDuty`, `TransportIncident`, `TransportIncidentEvent` (+ storage gaps, §10) | none in SQL (`DriverAssignment.source` `APP` is a string value) | `etms_driver_ops` |
| E6 | 4: `TransportPolicy`, `TransportPolicyVersion`, `TransportPolicyOverride`, `TransportEscalationStep` | `NotificationStatus` delivery values; policy columns on booking / trip passenger | `etms_safety` |
| E7 | cost tables only if C1 is approved | — | `etms_costing` (conditional) |
| E8 | none planned | `Company` country (+ site time zone) | `company_locale` |
| E9 | none planned (indexes from load tests only) | — | — |

`TransportChangeSet` is the only R1 table not named in `12` WP 3.0; it is required by `02` §5.4 / `05` §1
("unique `(companyId, idempotencyKey)` on the change set") and by V S5 ("ETMS needs its own idempotency (change-set
key)"). See §12 item C-2.

---

## 3. E1a — accounts, outbox, audit (migration `etms_accounts`)

### 3.1 `TransportServiceAgreement`

Purpose: D1 provider ↔ customer contract with closed grants. Modelled and guarded in R1, **no rows** in
corporate-managed mode (`02` §4.1); UI and approval workflow in E1b.

| Column | Prisma type | Null | Notes |
|---|---|---|---|
| `id` | `String @id @default(uuid()) @db.Uuid` | no | |
| `providerCompanyId` | `String @db.Uuid` | no | FK `Company`, **Restrict** |
| `customerCompanyId` | `String @db.Uuid` | no | FK `Company`, **Restrict** |
| `status` | `TransportAgreementStatus @default(DRAFT)` | no | enum `DRAFT, ACTIVE, SUSPENDED, ENDED` |
| `validFrom` | `DateTime @db.Timestamptz(3)` | no | |
| `validTo` | `DateTime? @db.Timestamptz(3)` | yes | open-ended when null |
| `grants` | `TransportGrant[] @default([])` | no | closed enum `VIEW_BOOKINGS, MANAGE_DISPATCH, VIEW_PASSENGER_MINIMAL, VIEW_PASSENGER_CONTACT, MANAGE_SCHEDULES, RECEIVE_INCIDENTS, MANAGE_INCIDENTS, VIEW_REPORTS, OVERRIDE_SAFETY_WARN` (`10` §2.2 item 3) |
| `siteIds` | `String[] @db.Uuid` | no (default `{}`) | customer `Poi` ids (OFFICE); array, no FK; validated on write |
| `dataProfile` | `TransportDataProfile @default(MINIMAL)` | no | enum `MINIMAL, STANDARD` |
| `approvedByCustomerAt` / `approvedByProviderAt` | `DateTime? @db.Timestamptz(3)` | yes | |
| `approvedByCustomerUserId` / `approvedByProviderUserId` | `String? @db.Uuid` | yes | no FK |
| `suspendedAt`, `endedAt` | `DateTime? @db.Timestamptz(3)` | yes | |
| `statusReason` | `String?` | yes | suspend / end reason |
| `version` | `Int @default(1)` | no | optimistic concurrency |
| `createdById` | `String? @db.Uuid` | yes | no FK |
| `createdAt`, `updatedAt` | `DateTime @db.Timestamptz(3)` | no | |

- **Indexes:** `@@index([providerCompanyId, status])` (loads `ctx.agreements`, `02` §4.2); `@@index([customerCompanyId, status])`.
- **Unique (raw SQL, recommended, depends on P1):** one live agreement per pair:
  `CREATE UNIQUE INDEX "TransportServiceAgreement_live_pair_key" ON "TransportServiceAgreement" ("providerCompanyId", "customerCompanyId") WHERE "status" IN ('DRAFT','ACTIVE','SUSPENDED');`
- **CHECK (raw SQL):** `CHECK ("providerCompanyId" <> "customerCompanyId")` (corporate-managed mode has no row, D1);
  `CHECK ("validTo" IS NULL OR "validTo" > "validFrom")`; `CHECK ("version" >= 1)`. "ACTIVE requires both approvals"
  is **not** a CHECK because P1 (Super Admin approval on paper) is open; the E1b service enforces the chosen rule.
- **Owner columns / purge:** no `companyId` column → not reached by the logical key. Reached through **both** FKs
  (Restrict → walked): purging either party deletes the agreement; children (`TransportBooking.agreementId`,
  `TransportTrip.agreementId`) are SetNull and survive.
- **PD:** L. **Retention:** contract life + 7 years (L3 default; commercial). **State:** `status` column (a contract
  lifecycle, not a trip state).
- `Company` gets two named back-relations (`agreementsAsProvider`, `agreementsAsCustomer`).

### 3.2 `OutboxEvent`

Purpose: durable domain events written in the same transaction as the state change; relayed by the notifier
(`05` §5.2, `10` §6.1). Agent 1 (schema owner) finalises; columns from `05` §5.2.

| Column | Prisma type | Null | Notes |
|---|---|---|---|
| `id` | `String @id @default(uuid()) @db.Uuid` | no | writer supplies UUIDv7; = envelope `id`, consumer dedupe key |
| `companyId` | `String @db.Uuid` | no | fan-out room / owner; **no FK** on purpose (logical key, see below) |
| `customerCompanyId`, `providerCompanyId` | `String? @db.Uuid` | yes | consumer scope tags; **no FK** |
| `type` | `String` | no | e.g. `transport.booking.assigned` |
| `schemaVersion` | `Int @default(1)` | no | |
| `aggregateType` | `String` | no | `booking`, `trip`, `incident`… |
| `aggregateId` | `String @db.Uuid` | no | |
| `aggregateVersion` | `Int?` | yes | |
| `class` | `OutboxClass` | no | enum `SAFETY, OPERATIONAL, INFO` |
| `payload` | `Json` | no | ids only, no free-text PII (`05` §5.2) |
| `correlationId` | `String?` | yes | request / change-set / job id |
| `causationId` | `String? @db.Uuid` | yes | |
| `idempotencyKey` | `String?` | yes | client key when one exists |
| `occurredAt` | `DateTime @db.Timestamptz(3)` | no | business time |
| `createdAt` | `DateTime @default(now()) @db.Timestamptz(3)` | no | = `recordedAt` |
| `availableAt` | `DateTime @default(now()) @db.Timestamptz(3)` | no | retry back-off |
| `attempts` | `Int @default(0)` | no | |
| `lastError` | `String?` | yes | |
| `publishedAt`, `deadAt` | `DateTime? @db.Timestamptz(3)` | yes | |

- **Indexes:** raw partial `CREATE INDEX "OutboxEvent_pending_idx" ON "OutboxEvent" ("class", "availableAt") WHERE "publishedAt" IS NULL AND "deadAt" IS NULL;`
  (relay poll, `SKIP LOCKED`); `@@index([aggregateType, aggregateId, createdAt])`; `@@index([createdAt])` (trim).
- **CHECK:** `CHECK ("attempts" >= 0)`; `CHECK (NOT ("publishedAt" IS NOT NULL AND "deadAt" IS NOT NULL))`.
- **Owner columns / purge:** `companyId` without FK → deleted by the **logical key** when that company is purged
  (intended: outbox rows are transient). Rows tagged with the *other* party keep a dangling scope id until trimmed;
  the payload carries ids only, so no personal data remains. SAFETY rows are copied into `TransportIncidentEvent`
  before trimming (E5, `05` §5.2).
- **PD:** L. **Retention:** published rows trimmed after 7 days (`05` §5.2); `DEAD` rows kept until resolved
  (technical, proposed 30 days). **State:** delivery timestamps only.

### 3.3 `AuditAction += ACCESS` (existing enum)

`ALTER TYPE "AuditAction" ADD VALUE 'ACCESS';` (enum at `schema.prisma` l.45, 7 values today). Additive. The new
value must not be **used** in the same migration (V S10); there is no backfill. Note: `AuditLog` is not trimmed by
retention (V `01` §4 / `retention.service.ts`), so ACCESS volume (every home-address / phone / live-location reveal,
`05` §1) grows the table permanently; L3 should cover the sensitive-access log period (`10` §4.1 "≥ 1 year").

---

## 4. E2 — people, capacity, driver login (migration `etms_people`)

### 4.1 `EmployeeTransportProfile` (customer-owned)

| Column | Prisma type | Null | Notes |
|---|---|---|---|
| `id` | `String @id @default(uuid()) @db.Uuid` | no | |
| `companyId` | `String @db.Uuid` | no | **customer**; FK `Company` **Restrict** |
| `branchId` | `String? @db.Uuid` | yes | FK `Branch` **SetNull** (ASSIGNED / SITE scope, same pattern as `Driver.branchId`) |
| `userId` | `String? @unique @db.Uuid` | yes | passenger login; FK `User` **SetNull** (D5; HR import precedes activation) |
| `employeeCode` | `String` | no | |
| `displayName` | `String` | no | name snapshot (a `User` may not exist yet) |
| `mobile`, `email` | `String?` | yes | contact for invite / import; **not** unique (D5 uniqueness lives on `User`) |
| `homeAddress` | `String?` | yes | original text |
| `homeLat`, `homeLng` | `Float?` | yes | original point (Photon result or confirmed pin), 6 decimals (`02` §7.2) |
| `homeGeocodeSource` | `String?` | yes | `PHOTON`, `PIN`, `IMPORT` |
| `homeGeocodeConfidence` | `Float?` | yes | Photon confidence |
| `officePoiId` | `String? @db.Uuid` | yes | FK `Poi` **SetNull**; same-company check in service |
| `defaultStopPoiId` | `String? @db.Uuid` | yes | FK `Poi` **SetNull**; same-company check in service |
| `accessibility` | `Json @default("{}")` | no | PD H (health) |
| `preferences` | `Json @default("{}")` | no | |
| `emergencyContacts` | `Json @default("[]")` | no | ≤ 3, PD H |
| `isActive` | `Boolean @default(true)` | no | archive on exit |
| `anonymisedAt` | `DateTime? @db.Timestamptz(3)` | yes | marker for the WP 2.6 erasure routine; semantics are owner decision **L5** |
| `createdById` | `String? @db.Uuid` | yes | |
| `createdAt`, `updatedAt` | `DateTime @db.Timestamptz(3)` | no | |

- **Unique:** `@@unique([companyId, employeeCode])` (import idempotency, `05` §2.2); `userId @unique` (NULLs
  distinct); `@@unique([id, companyId])` (target of composite FKs).
- **Indexes:** `@@index([companyId, isActive])`, `@@index([companyId, officePoiId])`.
- **CHECK:** `CHECK (("homeLat" IS NULL) = ("homeLng" IS NULL))`;
  `CHECK ("homeLat" IS NULL OR ("homeLat" BETWEEN -90 AND 90 AND "homeLng" BETWEEN -180 AND 180 AND NOT ("homeLat" = 0 AND "homeLng" = 0)))` (`02` §7.2);
  `CHECK (CASE WHEN jsonb_typeof("emergencyContacts") = 'array' THEN jsonb_array_length("emergencyContacts") <= 3 ELSE false END)`.
- **Deliberately absent:** road-snapped home point (added in E4 with `RoutingProvider.locate`; V §5 notes E2 runs
  without a road check); a default shift (shifts arrive in E3; the schedule links the shift); any gender / sensitive
  attribute (owner decision **L2**, E6 at the earliest).
- **Purge:** customer purge → reached through the `companyId` FK (Restrict → walked) → deleted with its children.
  User purge → `userId` SetNull → profile **survives with its personal data**; the WP 2.6 erasure routine is
  required for data-subject requests (`03` §4, L5).
- **PD:** H. **Retention:** while employed + grace, then erase / anonymise (L3 / L5).

### 4.2 `EmployeeTransportConsent` (customer-owned, append-only)

Name per `02` §3.1 (Agent 1's table, Agent 6's purposes).

| Column | Prisma type | Null | Notes |
|---|---|---|---|
| `id` | `String @id @default(uuid()) @db.Uuid` | no | |
| `companyId` | `String @db.Uuid` | no | customer |
| `profileId` | `String @db.Uuid` | no | composite FK `(profileId, companyId)` → profile `(id, companyId)`, **Restrict** |
| `subjectUserId` | `String? @db.Uuid` | yes | the `User` who granted (no FK) |
| `purpose` | `String` | no | open set: `PICKUP_LOCATION_SHARE`, `SOS_LOCATION`, `NOTIFICATIONS_SMS`, `TRANSPORT_PROFILE`… (`10` §4.2) |
| `noticeVersion` | `String` | no | |
| `locale` | `String?` | yes | |
| `granted` | `Boolean` | no | false = withdrawal row |
| `channel` | `String` | no | `WEB`, `PASSENGER_APP`, `ADMIN_ON_BEHALF` |
| `appVersion`, `ip` | `String?` | yes | evidence |
| `occurredAt` | `DateTime @default(now()) @db.Timestamptz(3)` | no | |

- **Indexes:** `@@index([profileId, purpose, occurredAt(sort: Desc)])` (current consent per purpose).
- **FK choice:** `03` §2 proposed Cascade. Changed to **Restrict**: consent is evidence and must not disappear when an
  application path hard-deletes a profile (profiles are archived, `isActive`). A purge still deletes consents
  (Restrict children are walked), which is correct for a company purge.
- **Purge:** customer purge → via profile composite FK (planner sees `profileId → id`) and via the `companyId`
  logical key (no FK on `companyId` itself) → deleted. User purge → untouched (no FK to `User`).
- **PD:** M. **Retention:** life of account + statutory period (L3). **State:** append-only rows; current consent =
  latest row per purpose.

### 4.3 `TransportVehicleProfile` (operator-owned side table)

| Column | Prisma type | Null | Notes |
|---|---|---|---|
| `objectId` | `String @id @db.Uuid` | no | FK `TrackedObject` **Cascade** (`FuelConfig` pattern) |
| `companyId` | `String @db.Uuid` | no | operator; **no FK** (`FuelConfig` pattern); set from the vehicle in the service |
| `seats` | `Int` | no | passenger seats, driver excluded |
| `wheelchairSpaces` | `Int @default(0)` | no | |
| `hasAc` | `Boolean?` | yes | |
| `category` | `String?` | yes | open set (`SEDAN`, `SUV`, `VAN`, `TEMPO_TRAVELLER`, `BUS`…) |
| `notes` | `String?` | yes | |
| `createdAt`, `updatedAt` | `DateTime @db.Timestamptz(3)` | no | |

- **Indexes:** `@@index([companyId])`. **CHECK:** `CHECK ("seats" BETWEEN 1 AND 100)`; `CHECK ("wheelchairSpaces" >= 0)`.
- **Purge:** vehicle purge → FK Cascade (walked) → deleted. Company purge → `companyId` logical key → deleted.
- **PD:** L. **Retention:** master. Why a side table and not a `TrackedObject` column: §7.3.

### 4.3a `TransportConsentNotice` (customer-owned, immutable versions; added 2026-11-11, E2 gap 2)

`10` §4.2 asks for versioned notice texts. A small table, not `Company.settings`: every version must stay readable as
evidence for the consents given against it, and JSON settings are overwritten in place. Added to `etms_people` before
that migration shipped.

| Column | Prisma type | Null | Notes |
|---|---|---|---|
| `id` | `String @id @default(uuid()) @db.Uuid` | no | |
| `companyId` | `String @db.Uuid` | no | customer; FK `Company` **Restrict** |
| `purpose` | `String` | no | same set as consent purposes |
| `seq` | `Int` | no | 1, 2, … per (company, purpose) |
| `version` | `String` | no | `"v" + seq`; stored in `EmployeeTransportConsent.noticeVersion` |
| `title`, `body` | `String` | no | plain text shown before a grant |
| `locale` | `String @default("en")` | no | one locale per version in E2 |
| `effectiveFrom` | `DateTime @db.Timestamptz(3)` | no | current = highest `seq` with `effectiveFrom ≤ now` |
| `createdById` | `String? @db.Uuid` | yes | no FK |
| `createdAt` | `DateTime @db.Timestamptz(3)` | no | |

- **Indexes:** `@@unique([companyId, purpose, seq])`. **CHECK:** `seq ≥ 1 AND version = 'v' || seq AND` non-blank
  `title` / `body`.
- **Rules (service):** rows are never updated; publishing creates the next `seq`; `effectiveFrom` not in the past; a
  grant records the current version (409 `CONSENT_NOTICE_MISSING` / `CONSENT_NOTICE_OUTDATED`).
- **Purge:** company purge → `companyId` FK (Restrict, walked) → deleted. **PD:** L. **Retention:** life of the
  consents that cite it (L3).

### 4.4 Existing-table change in E2

`Driver.userId` (§7.2). `Poi` categories `OFFICE` / `SHUTTLE_STOP` need **no migration**: `Poi.category` is a
`String @default("OTHER")` (V `schema.prisma` l.883, S9); the values are code constants / lookup data.

---

## 5. E3 — schedules, bookings, trips (migrations `etms_bookings_trips` and `planned_trip_origin`)

### 5.1 `TransportShift` (customer-owned)

| Column | Prisma type | Null | Notes |
|---|---|---|---|
| `id` | `String @id @default(uuid()) @db.Uuid` | no | |
| `companyId` | `String @db.Uuid` | no | customer; FK `Company` **Restrict** |
| `sitePoiId` | `String? @db.Uuid` | yes | office `Poi`; FK **SetNull**; same-company check in service |
| `name` | `String` | no | |
| `startMin`, `endMin` | `Int` | no | local minutes after midnight (login / logout) |
| `overnight` | `Boolean` | no | must equal `endMin < startMin` (CHECK) |
| `days` | `Int[]` | no | 0 = Sunday … 6 (same convention as `RouteSchedule.days`, V) |
| `timeZone` | `String` | no | IANA; defaults to `Company.timezone` at creation (site time zone arrives in E8) |
| `isActive` | `Boolean @default(true)` | no | |
| `createdById` | `String? @db.Uuid` | yes | |
| `createdAt`, `updatedAt` | `DateTime @db.Timestamptz(3)` | no | |

- **Unique:** `@@unique([companyId, name])`, `@@unique([id, companyId])`. **Index:** `@@index([companyId, isActive])`.
- **CHECK:** `CHECK ("startMin" BETWEEN 0 AND 1439 AND "endMin" BETWEEN 0 AND 1439 AND "startMin" <> "endMin")`;
  `CHECK ("overnight" = ("endMin" < "startMin"))`; `CHECK (cardinality("days") > 0 AND "days" <@ ARRAY[0,1,2,3,4,5,6])`.
- **Purge:** customer purge → `companyId` FK → deleted (schedules first, they are Restrict children).
- **PD:** L. **Retention:** master.

### 5.2 `TransportSchedule` (customer-owned)

| Column | Prisma type | Null | Notes |
|---|---|---|---|
| `id` | `String @id @default(uuid()) @db.Uuid` | no | |
| `companyId` | `String @db.Uuid` | no | customer (no direct FK; covered by the composite FKs and the logical key) |
| `profileId` | `String @db.Uuid` | no | composite FK `(profileId, companyId)` → profile, **Cascade** |
| `shiftId` | `String @db.Uuid` | no | composite FK `(shiftId, companyId)` → shift, **Restrict** (archive shifts, do not delete) |
| `direction` | `TransportDirection` | no | enum `IN` (to site, login), `OUT` (from site, logout) |
| `days` | `Int[]` | no | subset of the shift's days |
| `pickupMode` | `TransportPickupMode` | no | enum `HOME, STOP` |
| `stopPoiId` | `String? @db.Uuid` | yes | FK `Poi` **SetNull**; required for `STOP` by the service, **not** by a CHECK (§1.3: SetNull would break it) |
| `validFrom` | `DateTime @db.Date` | no | |
| `validTo` | `DateTime? @db.Date` | yes | |
| `isActive` | `Boolean @default(true)` | no | |
| `version` | `Int @default(1)` | no | |
| `createdById` | `String? @db.Uuid` | yes | |
| `createdAt`, `updatedAt` | `DateTime @db.Timestamptz(3)` | no | |

- **Unique:** `@@unique([id, companyId])`. No uniqueness on (profile, direction): split weekday patterns are
  legitimate; duplicates are stopped at booking level (§5.4 partial unique).
- **Indexes:** `@@index([companyId, isActive])`, `@@index([profileId])`, `@@index([shiftId])`.
- **CHECK:** `CHECK ("validTo" IS NULL OR "validTo" >= "validFrom")`; `CHECK (cardinality("days") > 0 AND "days" <@ ARRAY[0,1,2,3,4,5,6])`.
- **Purge:** customer purge → via profile / shift composite FKs and the `companyId` logical key → deleted. Bookings
  that came from it keep living (`TransportBooking.scheduleId` SetNull) until the booking walk deletes them too.
- **PD:** M. **Retention:** master (life of the commute).

### 5.3 `TransportScheduleException` (customer-owned)

| Column | Prisma type | Null | Notes |
|---|---|---|---|
| `id` | `String @id @default(uuid()) @db.Uuid` | no | |
| `companyId` | `String @db.Uuid` | no | customer |
| `scheduleId` | `String @db.Uuid` | no | composite FK `(scheduleId, companyId)` → schedule, **Cascade** |
| `date` | `DateTime @db.Date` | no | service date, site time zone |
| `kind` | `TransportExceptionKind` | no | enum `SKIP, OVERRIDE` |
| `override` | `Json?` | yes | pickup / window override |
| `reason` | `String?` | yes | |
| `createdById` | `String? @db.Uuid` | yes | |
| `createdAt` | `DateTime @default(now()) @db.Timestamptz(3)` | no | |

- **Unique:** `@@unique([scheduleId, date])`. **CHECK:** `CHECK (("kind" = 'OVERRIDE') = ("override" IS NOT NULL))`.
- **Purge:** via schedule Cascade and the `companyId` logical key. **PD:** M. **Retention:** 1 year (L3).

### 5.4 `TransportBooking` (dual-keyed; customer is the data owner)

| Column | Prisma type | Null | Notes |
|---|---|---|---|
| `id` | `String @id @default(uuid()) @db.Uuid` | no | |
| `customerCompanyId` | `String @db.Uuid` | no | FK `Company` **Restrict** |
| `providerCompanyId` | `String? @db.Uuid` | yes | FK `Company` **SetNull**; null until assignment (`02` §4.1); = customer in R1 |
| `agreementId` | `String? @db.Uuid` | yes | FK agreement **SetNull** |
| `profileId` | `String @db.Uuid` | no | composite FK `(profileId, customerCompanyId)` → profile `(id, companyId)`, **Restrict** (history kept) |
| `scheduleId` | `String? @db.Uuid` | yes | FK schedule **SetNull** (same company by construction in the generator) |
| `shiftId` | `String? @db.Uuid` | yes | FK shift **SetNull** |
| `source` | `TransportBookingSource` | no | enum `ADHOC, SCHEDULE` (`05` §3.1 `BookingDto.source`) |
| `serviceDate` | `DateTime @db.Date` | no | site time zone |
| `direction` | `TransportDirection` | no | |
| `timeZone` | `String` | no | snapshot |
| `pickupLabel`, `dropLabel` | `String?` | yes | |
| `pickupLat`, `pickupLng`, `dropLat`, `dropLng` | `Float?` | yes | original points; null = "needs location" |
| `pickupPoiId`, `dropPoiId` | `String? @db.Uuid` | yes | FK `Poi` **SetNull** |
| `windowStart`, `windowEnd` | `DateTime @db.Timestamptz(3)` | no | |
| `passengerCount` | `Int @default(1)` | no | policy-limited |
| `status` | `TransportBookingStatus @default(REQUESTED)` | no | enum `REQUESTED, PENDING_ASSIGNMENT, ASSIGNED, CONFIRMED, REJECTED, CANCELLED, EXPIRED, WAITLISTED, FAILED` (`05` §3; `VALIDATING` is not persisted, `02` §5.2) |
| `statusReason` | `String?` | yes | reject / cancel / fail reason |
| `cutoffAt` | `DateTime? @db.Timestamptz(3)` | yes | |
| `version` | `Int @default(1)` | no | `expectedVersion` (`05` §1) |
| `idempotencyKey` | `String?` | yes | `Idempotency-Key` header |
| `idempotencyHash` | `String?` | yes | request-body hash → 422 `IDEMPOTENCY_KEY_REUSED` on mismatch |
| `note` | `String?` | yes | free text (PD risk; UI warns) |
| `createdById` | `String? @db.Uuid` | yes | |
| `createdAt`, `updatedAt` | `DateTime @db.Timestamptz(3)` | no | |

- **Unique:** `@@unique([customerCompanyId, idempotencyKey])`; `@@unique([scheduleId, serviceDate, direction])`
  (generator idempotency; NULL `scheduleId` rows are distinct); `@@unique([id, customerCompanyId])`.
- **Partial unique (raw):** no double booking:
  `CREATE UNIQUE INDEX "TransportBooking_active_passenger_day_key" ON "TransportBooking" ("profileId", "serviceDate", "direction") WHERE "status" NOT IN ('CANCELLED','REJECTED','EXPIRED','FAILED');`
  (→ 409 `BOOKING_DUPLICATE`, `05` §4).
- **Indexes:** `@@index([customerCompanyId, serviceDate, status])`, `@@index([providerCompanyId, serviceDate])`,
  `@@index([profileId, serviceDate])`, `@@index([agreementId])`.
- **CHECK:** `CHECK ("windowEnd" > "windowStart")`; `CHECK ("passengerCount" >= 1)`; `CHECK ("version" >= 1)`;
  `CHECK (("pickupLat" IS NULL) = ("pickupLng" IS NULL) AND ("dropLat" IS NULL) = ("dropLng" IS NULL))`;
  `CHECK ("status" NOT IN ('ASSIGNED','CONFIRMED') OR ("pickupLat" IS NOT NULL AND "dropLat" IS NOT NULL))`;
  `CHECK ("source" = 'SCHEDULE' OR "scheduleId" IS NULL)`. **Not** a CHECK (would break purges, §1.3): "assigned ⇒
  provider set", "SCHEDULE ⇒ scheduleId set".
- **Purge:** customer purge → `customerCompanyId` FK and profile FK (both walked) → deleted, after its trip-passenger
  rows. Provider purge → `providerCompanyId` SetNull, `agreementId` SetNull → **booking survives** (customer data;
  status stays as it was; the service shows "provider removed").
- **PD:** M, H through home pickup coordinates. **Retention:** 1 year (L3). **State:** `status` column (D2 allows
  a real booking state; `02` §5.2).

### 5.5 `TransportTrip` (dual-keyed; operator owns the row; 1:1 business header of a `PlannedTrip`)

| Column | Prisma type | Null | Notes |
|---|---|---|---|
| `id` | `String @id @default(uuid()) @db.Uuid` | no | |
| `plannedTripId` | `String? @unique @db.Uuid` | yes | FK `PlannedTrip` **SetNull** (D2): vehicle purge deletes the `PlannedTrip`, the header survives |
| `providerCompanyId` | `String @db.Uuid` | no | operator (= `PlannedTrip.companyId`); FK `Company` **Restrict** |
| `customerCompanyId` | `String? @db.Uuid` | yes | FK `Company` **SetNull**; always set on write; null only after a customer purge (L5 recommended default, `02` §4.3) |
| `agreementId` | `String? @db.Uuid` | yes | FK agreement **SetNull** |
| `serviceDate` | `DateTime @db.Date` | no | board queries |
| `direction` | `TransportDirection` | no | |
| `shiftId` | `String? @db.Uuid` | yes | FK shift **SetNull** (customer master; survives as null) |
| `sitePoiId` | `String? @db.Uuid` | yes | FK `Poi` **SetNull** (board filter `siteId`, `05` §2.6) |
| `seatCapacity` | `Int` | no | snapshot of `TransportVehicleProfile.seats` at publish / vehicle change |
| `occupiedSeats` | `Int @default(0)` | no | sum of active passengers' `seats`; DB capacity backstop (§8.3) |
| `version` | `Int @default(1)` | no | re-publish needs `expectedVersion` |
| `publishedAt` | `DateTime? @db.Timestamptz(3)` | yes | milestone |
| `acknowledgedAt` | `DateTime? @db.Timestamptz(3)` | yes | milestone (dispatcher on behalf in R1, source `WEB`) |
| `acknowledgedByUserId` | `String? @db.Uuid` | yes | no FK |
| `acknowledgedSource` | `String?` | yes | `WEB`, `DRIVER_APP` |
| `interruptedAt` | `DateTime? @db.Timestamptz(3)` | yes | milestone |
| `interruptReason` | `String?` | yes | |
| `cancelledAt` | `DateTime? @db.Timestamptz(3)` | yes | mirrors the v1.8 cancel for derived state |
| `cancelReason` | `String?` | yes | |
| `createdById` | `String? @db.Uuid` | yes | |
| `createdAt`, `updatedAt` | `DateTime @db.Timestamptz(3)` | no | |

- **No status enum** (D2; V S6; validation note in `03` §2 / `04` §6). No `objectId` / `driverId` columns: vehicle
  and driver are read from `PlannedTrip` (§1.2 naming rule; a column named `objectId` would make a vehicle purge
  delete the header). `routePlanId` (named in `02` §5.1) is **added in E4** together with its FK target.
- **Unique:** `plannedTripId @unique`; `@@unique([id, providerCompanyId])` (target of composite FKs).
- **Indexes:** `@@index([providerCompanyId, serviceDate])`, `@@index([customerCompanyId, serviceDate])`, `@@index([agreementId])`.
- **CHECK:** `CHECK ("seatCapacity" >= 1)`; `CHECK ("occupiedSeats" >= 0 AND "occupiedSeats" <= "seatCapacity")`;
  `CHECK ("version" >= 1)`; `CHECK ("acknowledgedAt" IS NULL OR "publishedAt" IS NOT NULL)`. **Not** a CHECK: "no
  agreement ⇒ provider = customer" (the agreement SetNull during a customer purge would abort it, §1.3).
- **Purge:** provider purge → `providerCompanyId` FK (walked) → deleted with passengers and events. Customer purge →
  `customerCompanyId` SetNull, agreement deleted → `agreementId` SetNull → **header survives anonymised** (L5
  default); passenger rows are deleted through the booking walk; `occupiedSeats` keeps the historical count. Vehicle
  purge → `plannedTripId` SetNull → header and passengers survive. In R1 provider = customer, so a company purge
  deletes the header through `providerCompanyId`.
- **PD:** L. **Retention:** 1 year (L3). **State:** milestones as timestamps (§1.5).

### 5.6 `TransportTripPassenger` (dual-keyed; customer data on an operator trip)

| Column | Prisma type | Null | Notes |
|---|---|---|---|
| `id` | `String @id @default(uuid()) @db.Uuid` | no | `passengerTripId` in the API |
| `tripId` | `String @db.Uuid` | no | composite FK `(tripId, providerCompanyId)` → trip `(id, providerCompanyId)`, **Cascade** |
| `bookingId` | `String @db.Uuid` | no | composite FK `(bookingId, customerCompanyId)` → booking `(id, customerCompanyId)`, **Restrict** |
| `customerCompanyId` | `String @db.Uuid` | no | FK `Company` **Restrict** |
| `providerCompanyId` | `String @db.Uuid` | no | FK `Company` **Restrict** |
| `pickupStopId`, `dropStopId` | `String? @db.Uuid` | yes | FK `PlannedTripStop` **SetNull** (README §6: FK plus seq snapshot) |
| `pickupSeq`, `dropSeq` | `Int` | no | snapshot so events can address `(tripId, seq)` (`09` §4.1) |
| `seats` | `Int @default(1)` | no | = booking `passengerCount` at assignment |
| `status` | `TransportPassengerStatus @default(PENDING)` | no | enum `PENDING, BOARDED, NO_SHOW, DROPPED, CANCELLED` |
| `boardedAt`, `droppedAt`, `noShowAt` | `DateTime? @db.Timestamptz(3)` | yes | |
| `noShowReason` | `String?` | yes | `Lookup` code |
| `cancelReason` | `String?` | yes | |
| `outcomeSource` | `String?` | yes | `WEB`, `DRIVER_APP` |
| `outcomeByUserId` | `String? @db.Uuid` | yes | no FK |
| `outcomeAt` | `DateTime? @db.Timestamptz(3)` | yes | |
| `createdAt`, `updatedAt` | `DateTime @db.Timestamptz(3)` | no | |

- **Partial unique (raw):** one active seat per booking:
  `CREATE UNIQUE INDEX "TransportTripPassenger_active_booking_key" ON "TransportTripPassenger" ("bookingId") WHERE "status" <> 'CANCELLED';`
- **Indexes:** `@@index([tripId, status])`, `@@index([bookingId])`, `@@index([customerCompanyId, createdAt])`.
- **CHECK:** `CHECK ("seats" >= 1)`; `CHECK ("pickupSeq" >= 0 AND "dropSeq" > "pickupSeq")`;
  `CHECK ("status" <> 'BOARDED' OR "boardedAt" IS NOT NULL)`; `CHECK ("status" <> 'DROPPED' OR "droppedAt" IS NOT NULL)`;
  `CHECK ("status" <> 'NO_SHOW' OR "noShowAt" IS NOT NULL)`;
  **GPS is never proof of boarding** (`02` §5.3), enforced in the database:
  `CHECK ("status" NOT IN ('BOARDED','DROPPED','NO_SHOW') OR "outcomeSource" IN ('WEB','DRIVER_APP'))`. The
  processor writes no passenger state; a passenger confirmation (E5) is an event, not a status (P5 default: driver
  authoritative). If the owner gives passengers authority under P5, a forward migration relaxes this CHECK.
- **Purge:** customer purge → booking composite FK and `customerCompanyId` FK (walked) → deleted. Provider purge →
  trip Cascade and `providerCompanyId` FK → deleted. Vehicle purge → `PlannedTripStop` rows deleted → stop FKs set
  NULL, seqs kept.
- **PD:** M. **Retention:** 1 year (L3). **State:** per-passenger state (D2).

### 5.7 `TransportTripEvent` (dual-keyed, append-only)

| Column | Prisma type | Null | Notes |
|---|---|---|---|
| `id` | `String @id @default(uuid()) @db.Uuid` | no | |
| `tripId` | `String @db.Uuid` | no | composite FK `(tripId, providerCompanyId)` → trip, **Cascade** |
| `providerCompanyId` | `String @db.Uuid` | no | FK `Company` **Restrict** |
| `customerCompanyId` | `String? @db.Uuid` | yes | FK `Company` **SetNull** (trip-level events survive a customer purge as anonymised history) |
| `passengerTripId` | `String? @db.Uuid` | yes | FK `TransportTripPassenger` **Cascade** (passenger events go with the customer's data) |
| `kind` | `String` | no | `05` §3.8 `TripEventType` + `PUBLISHED`, `CHANGED`, `CANCELLED`, `INTERRUPTED`, `STARTED`, `COMPLETED` |
| `actorType` | `String` | no | `DISPATCHER`, `DRIVER`, `PASSENGER`, `SYSTEM` |
| `actorUserId`, `actorDriverId` | `String? @db.Uuid` | yes | no FK |
| `source` | `String` | no | CHECK `WEB`, `DRIVER_APP`, `PASSENGER_APP`, `SYSTEM` |
| `outcome` | `String @default("ACCEPTED")` | no | CHECK `ACCEPTED`, `DUPLICATE`, `REJECTED`, `LATE` (`02` §5.1) |
| `clientEventId` | `String? @db.Uuid` | yes | idempotency |
| `clientSeq`, `stopSeq` | `Int?` | yes | |
| `reasonCode` | `String?` | yes | |
| `occurredAt` | `DateTime @db.Timestamptz(3)` | no | device / business time |
| `receivedAt` | `DateTime @default(now()) @db.Timestamptz(3)` | no | server time |
| `lat`, `lng` | `Float?` | yes | optional fix (PD H) |
| `data` | `Json @default("{}")` | no | |

- **Unique:** `@@unique([tripId, clientEventId])`. **Indexes:** `@@index([tripId, occurredAt])`, `@@index([providerCompanyId, receivedAt])`.
- **CHECK:** source and outcome sets as above; `CHECK (("lat" IS NULL) = ("lng" IS NULL))`.
- **Append-only:** enforced by the command handler (no update / delete paths). A `BEFORE UPDATE OR DELETE` trigger
  is possible but the repo uses no triggers (V: none in the migrations) and a purge must still delete rows; not
  recommended for R1.
- **Purge:** provider purge → trip Cascade + FK → deleted. Customer purge → passenger events deleted (Cascade from
  passenger rows), trip-level events kept with `customerCompanyId` NULL. GPS-derived facts stay on
  `PlannedTripEvent` / `PlannedTripStop` (no copy).
- **PD:** M (H when a location is attached). **Retention:** 1 year (L3).

### 5.8 `TransportChangeSet` (operator-owned; idempotency ledger and drafts)

Required by `02` §5.4 / `05` §1 / V S5; see §12 C-2.

| Column | Prisma type | Null | Notes |
|---|---|---|---|
| `id` | `String @id @default(uuid()) @db.Uuid` | no | `correlationId` of the resulting events |
| `companyId` | `String @db.Uuid` | no | the dispatching (operator) company; FK `Company` **Restrict** |
| `idempotencyKey` | `String?` | yes | required for publish; null for server-held drafts |
| `requestHash` | `String?` | yes | 422 `IDEMPOTENCY_KEY_REUSED` on mismatch |
| `status` | `TransportChangeSetStatus` | no | enum `DRAFT` (repeat-to-date, `05` §2.6), `PUBLISHED`, `REJECTED` |
| `serviceDate` | `DateTime @db.Date` | no | |
| `direction` | `TransportDirection` | no | |
| `draft` | `Json?` | yes | `DispatchChangeSetDto` of a DRAFT only (contains pickup points, PD H); cleared on publish |
| `result` | `Json?` | yes | `ChangeSetResult` (ids and versions only) for replay |
| `createdById` | `String? @db.Uuid` | yes | |
| `createdAt` | `DateTime @default(now()) @db.Timestamptz(3)` | no | |
| `publishedAt` | `DateTime? @db.Timestamptz(3)` | yes | |

- **Unique:** `@@unique([companyId, idempotencyKey])`. **Index:** `@@index([companyId, serviceDate, status])`.
- **CHECK:** `CHECK ("status" <> 'PUBLISHED' OR ("idempotencyKey" IS NOT NULL AND "publishedAt" IS NOT NULL))`.
- **Purge:** company purge → FK → deleted. **PD:** H for DRAFT rows, L otherwise. **Retention:** drafts until the
  service date + 7 days; published rows 30 days (replay window). Proposed; technical, not an L3 item.
- Whether drafts are held server-side (vs. returned to the client only) is a Lead / UX choice; the table supports
  both.

### 5.9 Existing-table changes in E3

`PlannedTrip.routeId` nullable, `PlannedTrip.origin`, index `PlannedTrip(driverId, plannedStart)`, and the
ETMS-scoped exclusion constraints: §7.1 and §8.2.

---

## 6. Purge treatment matrix (R1 tables)

"Del" = deleted by the purge; "Keep" = survives (SetNull); "—" = not affected. Corporate-managed R1: customer =
provider = one company, so a company purge deletes every R1 row. The provider / customer columns matter from E1b.

| Table | Owner column(s) | Reached by | Purge customer company | Purge provider company | Purge vehicle (`object`) | Purge user |
|---|---|---|---|---|---|---|
| `TransportServiceAgreement` | `providerCompanyId`, `customerCompanyId` (FK Restrict) | FK | Del | Del | — | — |
| `OutboxEvent` | `companyId` (no FK) | logical key | Del if `companyId` = it | Del if `companyId` = it | — | — |
| `EmployeeTransportProfile` | `companyId` (FK Restrict) | FK | Del | — | — | Keep, `userId` NULL (erasure routine needed) |
| `EmployeeTransportConsent` | `companyId` (no FK) | profile FK + logical key | Del | — | — | — |
| `TransportVehicleProfile` | `companyId` (no FK), `objectId` (FK Cascade) | logical key / FK | — | Del | Del | — |
| `TransportShift` | `companyId` (FK Restrict) | FK | Del | — | — | — |
| `TransportSchedule` | `companyId` (no FK) | composite FKs + logical key | Del | — | — | — |
| `TransportScheduleException` | `companyId` (no FK) | schedule FK + logical key | Del | — | — | — |
| `TransportBooking` | `customerCompanyId` (Restrict), `providerCompanyId` (SetNull) | FK | Del | Keep, provider / agreement NULL | — | — |
| `TransportTrip` | `providerCompanyId` (Restrict), `customerCompanyId` (SetNull) | FK | Keep, customer / agreement NULL (L5) | Del | Keep, `plannedTripId` NULL | — |
| `TransportTripPassenger` | both (Restrict) | FK | Del | Del | Keep, stop FKs NULL | — |
| `TransportTripEvent` | `providerCompanyId` (Restrict), `customerCompanyId` (SetNull) | FK | passenger events Del, trip events Keep | Del | — | — |
| `TransportChangeSet` | `companyId` (FK Restrict) | FK | Del if dispatcher company | Del | — | — |
| `PlannedTrip` (existing) | `companyId`, `objectId` (no FK) | logical keys | — (R1: Del) | Del | Del | — |

Rule check against `03` §4: customer-owned rows never have a Restrict / Cascade FK to provider-owned rows (booking →
provider is SetNull; passenger rows are customer data and go with either side by design).

---

## 7. Changes to existing tables (all additive)

### 7.1 `PlannedTrip.routeId` nullable + `origin`

**DDL (migration `planned_trip_origin`, §9):**

```sql
ALTER TABLE "PlannedTrip" ALTER COLUMN "routeId" DROP NOT NULL;            -- metadata only
ALTER TABLE "PlannedTrip" ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'ROUTE'; -- fast default, no rewrite (PG ≥ 11)
ALTER TABLE "PlannedTrip" ADD CONSTRAINT "PlannedTrip_origin_check" CHECK ("origin" IN ('ROUTE','ETMS'));
ALTER TABLE "PlannedTrip" ADD CONSTRAINT "PlannedTrip_route_origin_check" CHECK ("origin" = 'ETMS' OR "routeId" IS NOT NULL);
CREATE INDEX "PlannedTrip_driverId_plannedStart_idx" ON "PlannedTrip"("driverId", "plannedStart");
```

Prisma: `routeId String? @db.Uuid`, `origin String @default("ROUTE")`, `@@index([driverId, plannedStart])`. There is
no FK from `PlannedTrip` to `Route` (V F1), so nothing else changes. `@@unique([scheduleId, plannedStart])` is
unaffected (ETMS rows have `scheduleId NULL`, V S5). Existing rows get `origin = 'ROUTE'` and keep their `routeId`;
the second CHECK guarantees that every ROUTE trip keeps a route.

**Code references.** `git grep -n routeId` over `apps/api/src`, `apps/web/src`, `packages/shared/src` gives **79
lines in 18 files**. V's figure "**72 lines in 15 files**" excludes the three `*.spec.ts` files (7 lines) and
includes `trip-format.test.ts`; both are listed below. No reference exists in `apps/mobile`, `apps/tracker`, the
processor, or the tracker engine (V `planned-trips/tracker/*`). Most references are to `RouteStop.routeId`,
`RouteSchedule.routeId` or a local route-id variable and **need no change**.

Legend: **N** no change; **T** type becomes `string | null` (no logic change); **C** code change.

| # | File : line | Reference | Kind | Required change |
|---|---|---|---|---|
| 1 | `apps/api/src/planned-trips/planned-trip-job.service.ts:132` | `routeId: s.routeId` (from a `RouteSchedule`) | N | Generator creates ROUTE trips only; set `origin: 'ROUTE'` explicitly via `insertTrip` (#7) |
| 2 | `apps/api/src/planned-trips/planned-trips.dto.ts:11` | list filter `routeId?` | N | Filter still valid (ETMS trips never match a route id) |
| 3 | `apps/api/src/planned-trips/planned-trips.dto.ts:24` | create DTO `routeId!` | N | Manual create stays route-based |
| 4 | `apps/api/src/planned-trips/planned-trips.service.ts:71` | `NewTripInput.routeId: string` | N | Stays non-null: `insertTrip` remains the ROUTE path; ETMS publish uses a new `insertEtmsTrip` (`02` §5.4) |
| 5 | `…/planned-trips.service.ts:103` | `filters.push({ routeId: q.routeId })` | N | — |
| 6 | `…/planned-trips.service.ts:129`, `:139` | `create()` from a route | N | — |
| 7 | `…/planned-trips.service.ts:164` | `insertTrip` data `routeId` | N | Add `origin: 'ROUTE'` next to it (explicit; default also covers it) |
| 8 | `…/planned-trips.service.ts:334` | summary `routeId: t.routeId` | T | Follows `PlannedTripSummaryDto` (#27); also return `origin` |
| 9 | `apps/api/src/planned-trips/routes.service.ts:143`, `:144` | `RouteStop` delete / create | N | — |
| 10 | `…/routes.service.ts:161` | `plannedTrip.count({ routeId: id })` before route delete | N | ETMS trips have NULL `routeId` and are never counted |
| 11 | `…/routes.service.ts:172` | stop clone strips `routeId` | N | — |
| 12 | `…/routes.service.ts:202`, `:203`, `:207`, `:208`, `:213`, `:229`, `:230`, `:231`, `:254`, `:255`, `:256`, `:299`, `:300`, `:393` | `RouteSchedule` methods / DTO | N | — (14 lines) |
| 13 | `apps/api/src/reports/planned-trips-report.ts:31` | `select { routeId: true }` | T | — |
| 14 | `…/planned-trips-report.ts:72` | `routeIds = [...new Set(facts.map(f => f.routeId))]` | **C** | Filter out `null` before the set |
| 15 | `…/planned-trips-report.ts:74` | `route.findMany({ id: { in: routeIds } })` | **C** | Receives only non-null ids (follows #14) |
| 16 | `apps/api/src/reports/trip-performance.ts:21` | `PerfTripInput.routeId: string` | T | `string \| null` |
| 17 | `…/trip-performance.ts:42` | `TripFacts.routeId: string` | T | `string \| null` |
| 18 | `…/trip-performance.ts:115` | copy `routeId` | T | — |
| 19 | `…/trip-performance.ts:201` | `groupKey` returns `f.routeId` for ROUTE | **C** | Null key now also means "no route". **Bug to fix with it:** `nameOf` (l.234, no `routeId` token, so not in the count) returns `'No driver'` for every null key, also when grouping by ROUTE. Return a ROUTE-specific label (e.g. "Employee transport (no route)") |
| 20 | `…/trip-performance.ts:275` | `plannedTripRow` `routeId` | T | follows #28 |
| 21 | `apps/web/src/features/planned-trips/PlannedTripsPage.tsx:185`, `:201`, `:219`, `:267` | route filter state / Combobox | N | Filter unchanged. Separate (non-`routeId`) change: show an origin badge and hide edit actions for `origin = 'ETMS'` |
| 22 | `apps/web/src/features/planned-trips/TripDialogs.tsx:38`, `:76`, `:97`, `:125` | create dialog state / validation / submit | N | Create stays route-based |
| 23 | `…/TripDialogs.tsx:56` | `setRouteId(trip.routeId)` in the edit dialog | **C** | Never open the edit dialog for an ETMS trip (link to the transport trip detail); type already `string \| null` |
| 24 | `apps/web/src/features/planned-trips/use-planned-trips.ts:27`, `:52` | list filter | N | — |
| 25 | `apps/web/src/features/routes/RouteEditor.tsx:64`, `:65`, `:66`, `:165`, `:168`, `:207`, `:208`, `:241`, `:366`, `:370` | Route master editor id | N | — (10 lines) |
| 26 | `apps/web/src/features/routes/SchedulesPanel.tsx:85`, `:109`, `:182`, `:186`, `:191`, `:268`; `apps/web/src/features/routes/api.ts:18`, `:20`, `:21`, `:22` | `RouteSchedule` UI / queries | N | — (10 lines) |
| 27 | `packages/shared/src/planned-trips.ts:184` | `PlannedTripSummaryDto.routeId: string` | T | `string \| null`; add `origin: 'ROUTE' \| 'ETMS'` |
| 28 | `packages/shared/src/history.ts:340` | `PlannedTripReportRow.routeId: string` | T | `string \| null` (CSV / report golden unchanged while fixtures hold no ETMS rows) |
| 29 | `packages/shared/src/planned-trips.ts:79`, `:221`, `:240` | `RouteScheduleDto`, `PlannedTripCreateInput`, list filters | N | — |
| 30 | `apps/web/src/features/planned-trips/trip-format.test.ts:26` | fixture | **C** (test) | Add a null-route ETMS fixture |
| 31 | `apps/api/src/planned-trips/planned-trip-job.spec.ts:20`, `:52` | fixtures | N | — (spec, outside the 72) |
| 32 | `apps/api/src/reports/planned-trips-report.spec.ts:17`; `trip-performance.spec.ts:13`, `:72`, `:73`, `:128` | fixtures | **C** (test) | Add null-route cases incl. ROUTE grouping label (spec, outside the 72) |

Summary: of 79 lines, **4 need a code change** (#14, #15, #19, #23), **8 a type change only** (#8, #13, #16, #17,
#18, #20, #27, #28), **6 are test fixtures that gain null-route cases** (#30 in `trip-format.test.ts`, #32 in
`planned-trips-report.spec.ts` and `trip-performance.spec.ts`), and the remaining **61 are unchanged**. Non-`routeId` changes in the same WP 3.1: `PlannedTripsService.update` refuses `origin = 'ETMS'` with 409
`MANAGED_BY_ETMS` (`05` §2.6); recommended also for `cancel` (passenger rows must be cancelled in the same
transaction through `/api/transport/trips/:id/cancel`; Lead to confirm); `nameOf` label (#19).

**Why a separate migration that lands with WP 3.1:** after `prisma generate`, `routeId` is `string | null` in the
Prisma client, so lines #8, #13, #16–18 fail `tsc` until 3.1 is merged. The schema change therefore ships in the
same PR as WP 3.1 (§9.1), not in 3.0. The rule "3.1 merges before 3.4" (`12` §5) is kept: no `NULL` `routeId` row is
written before 3.4 (publish) exists.

**Rollback constraint:** once any `origin = 'ETMS'` row exists, application code older than WP 3.1 must not run
against the database (it assumes a non-null `routeId`). Rolling back the application below 3.1 is only safe while
no ETMS trip exists, or after ETMS trips are deleted (destructive, owner approval).

### 7.2 `Driver.userId`

```sql
ALTER TABLE "Driver" ADD COLUMN "userId" UUID;
CREATE UNIQUE INDEX "Driver_userId_key" ON "Driver"("userId");
ALTER TABLE "Driver" ADD CONSTRAINT "Driver_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

Prisma: `userId String? @unique @db.Uuid` + `user User? @relation(fields: [userId], references: [id], onDelete:
SetNull)`; back-relation `driver Driver?` on `User`. Nullable, no default: no rewrite, no backfill. Same-company rule
(`User.companyId = Driver.companyId`) is a transactional check in `POST /api/drivers/:id/login` (`05` §2.3). Purge:
user purge → SetNull (driver keeps working via RFID); company purge → both deleted (the planner skips the SetNull
edge; PostgreSQL nulls it when the user row goes first). PD: M (links identity).

### 7.3 Seat capacity: `TrackedObject` column vs side table

| Option | For | Against | Verdict |
|---|---|---|---|
| A. `TrackedObject.seats Int?` (+ wheelchair, AC) | One join less | Touches the hot, widely selected master (V `schema.prisma` l.299, 30+ relations); fleet customers without ETMS get transport columns; no place for later ETMS vehicle attributes | Not recommended |
| B. `TrackedObject.customFields` JSON | No migration | Untyped, no CHECK, not indexable (`03` §1) | Rejected |
| **C. `TransportVehicleProfile(objectId PK)` side table** | `FuelConfig` / `ParkingSchedule` precedent; additive; Cascade on vehicle purge; operator-owned | One extra row per ETMS vehicle | **Recommended** (`02` §3.1, `03` §1, `12` WP 2.0) |

The trip snapshots capacity (`TransportTrip.seatCapacity`), so a later profile edit never changes a published trip
without a re-publish.

### 7.4 New roles and menus

**No schema migration** is involved in either option: `Role` / `RolePermission` are data (V `schema.prisma`
l.165–190), menu keys are code (`packages/shared/src/permissions.ts` `MENUS`), and the feature flag is a value in
`COMPANY_FEATURES` (V `packages/shared/src/api.ts` l.68). Migrations must **not** backfill `RolePermission` (unlike
`20261113090000_routes_planned_trips` l.170–178).

| Option | Description | Assessment |
|---|---|---|
| A. Global `SYSTEM_ROLES` (`03` §1 / §3, `04` §3: Employee / Driver / Dispatcher) | Add to `SYSTEM_ROLES`; `ensureSystemRoles` creates them | `ensureSystemRoles` runs for **every** new company (V callers: `masters/companies/companies.service.ts` l.97, `signup/signup.service.ts` l.108, `mobile-tracker/self-service.ts` l.77), so every fleet / personal / family account would get ETMS roles; contradicts D5 ("Passenger") and `12` WP 1a.2 |
| **B. Per-company templates seeded when `etms` is enabled** (`12` WP 1a.2, README §6 R1, P6 default) | Corporate admin, Dispatcher, Passenger, Driver created idempotently in the enabling transaction; no backfill to existing roles | Recommended. Contained to ETMS customers; matches the feature-flag model |
| C. No roles; relationship guards only | Passenger / driver access only through `MeTransportGuard` / `DriverIdentityGuard` | Rejected: menus and the CI completeness guard (`05` §1) need permissions |

Related finding (V `permissions.ts` l.134–142): the built-in **Admin** role is built from **all** non-Super-Admin
`MENUS` when a company is created, while existing companies get nothing (no backfill). Adding `etms_*` keys to
`MENUS` would therefore give every *new* company's Admin the ETMS menus (hidden only by the feature gate) and no
existing company's Admin. Recommended with option B: exclude feature-gated menus (`MenuDef.requires.companyFeature`,
`02` §3) from the Admin auto-set and grant them through the Corporate-admin template on enable.

Option B is already the recorded direction (D5 role names; `02` §3.1 row "Passenger / driver role", updated in
E0.5; `12` WP 1a.2). **Still needs owner confirmation (P6, open):** the final template set, whether templates carry
`isSystem = true` (not deletable) or are ordinary editable roles, and the Admin auto-menu handling above.

### 7.5 `DriverAssignment.source` value `APP` (E5)

`DriverAssignment.source` is a `String` (V `schema.prisma` l.416, comment "MANUAL … or RFID"). Adding `APP` is a
TypeScript change only: `packages/shared/src/drivers.ts` l.3 `DriverAssignmentSource = 'MANUAL' | 'RFID'` → add
`'APP'`. **No migration** (V S8; `12` WP 5.0 corrected). Optional later hardening, not required: a CHECK on the set.
Whether duty start writes a `DriverAssignment` at all is owner decision P5.

### 7.6 E0.5 dependencies on existing tables (not part of the ETMS migrations)

- `Alert.notifiedAt Timestamptz?` (G2) and `NotificationLog` columns `attempts`, `nextAttemptAt`,
  `providerMessageId`, `dedupeKey @unique` (G3), plus `purpose`, `refType`, `refId` that ETMS uses from E3 (`05`
  §5.6, `03` §3). Recommendation: add all seven `NotificationLog` columns in the single G3 migration so the table is
  altered once.
- **Backfill caution for the G2 owner:** existing `Alert` rows will have `notifiedAt = NULL`; a sweeper that
  re-queues `notifiedAt IS NULL` rows of the last 24 h would re-notify alerts already sent before the deploy. Either
  a bounded backfill in the migration (`UPDATE "Alert" SET "notifiedAt" = "createdAt" WHERE "notifiedAt" IS NULL AND
  "createdAt" > now() - interval '25 hours'`) or a cutover timestamp in the sweeper is needed. This is the only
  backfill identified in the whole plan, and it is outside ETMS.

---

## 8. Concurrency and integrity rules

### 8.1 Summary

| Invariant | Database mechanism | Transactional mechanism | Error |
|---|---|---|---|
| No double booking (passenger, date, direction) | Partial unique `TransportBooking_active_passenger_day_key` | — | 409 `BOOKING_DUPLICATE` |
| Double submit = one booking | `@@unique([customerCompanyId, idempotencyKey])` + `idempotencyHash` | replay returns the stored row | 200 replay / 422 `IDEMPOTENCY_KEY_REUSED` |
| Generator idempotent | `@@unique([scheduleId, serviceDate, direction])` | `INSERT … ON CONFLICT DO NOTHING` | — |
| One active seat per booking | Partial unique `TransportTripPassenger_active_booking_key` | moving a passenger = cancel old row + insert new row in one transaction | 409 `CONFLICT` |
| Publish once per key | `@@unique([companyId, idempotencyKey])` on `TransportChangeSet` | replay returns `result` | 200 replay |
| No vehicle double assignment | ETMS-scoped `EXCLUDE` on `PlannedTrip` (§8.2, needs `btree_gist`) | advisory lock per vehicle + overlap query across **all** origins | 409 `VEHICLE_BUSY` |
| No driver double assignment | ETMS-scoped `EXCLUDE` on `PlannedTrip.driverId` (§8.2) | advisory lock per driver + overlap query | 409 `DRIVER_BUSY` |
| No capacity over-allocation | `CHECK (occupiedSeats <= seatCapacity)` on `TransportTrip` | `SELECT … FOR UPDATE` on the trip, then update `occupiedSeats` | 409 `CAPACITY_EXCEEDED` |
| Lost update on a trip / booking | `version` columns | `expectedVersion` compare-and-set | 409 `VERSION_CONFLICT` |
| No cross-tenant reference (same owner) | composite FKs (§1.4) | — | FK violation → 404 by the service |
| No cross-tenant reference (into existing tables, customer ↔ provider) | — | same-company / `ctx.agreements` checks in the write transaction; isolation matrix | 404 `NOT_FOUND` / 409 `AGREEMENT_INACTIVE` |
| GPS never proof of boarding | CHECK on `TransportTripPassenger.outcomeSource` | processor has no write path to passengers | — |
| ROUTE trips keep a route | `PlannedTrip_route_origin_check` | — | — |

### 8.2 Exclusion constraints and `btree_gist`

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE "PlannedTrip" ADD CONSTRAINT "PlannedTrip_etms_vehicle_overlap_excl"
  EXCLUDE USING gist ("objectId" WITH =, tstzrange("plannedStart", "plannedEnd", '[)') WITH &&)
  WHERE ("origin" = 'ETMS' AND "status" IN ('SCHEDULED','STARTED','IN_PROGRESS'));
ALTER TABLE "PlannedTrip" ADD CONSTRAINT "PlannedTrip_etms_driver_overlap_excl"
  EXCLUDE USING gist ("driverId" WITH =, tstzrange("plannedStart", "plannedEnd", '[)') WITH &&)
  WHERE ("origin" = 'ETMS' AND "driverId" IS NOT NULL AND "status" IN ('SCHEDULED','STARTED','IN_PROGRESS'));
```

- **Why only ETMS rows:** v1.8 has **no** planning-time overlap rule (V `planned-trips.service.ts`: `create` /
  `update` / the generator check nothing; only `start` refuses a second *active* trip, l.235–239). Production data
  may already contain overlapping scheduled ROUTE trips, and a table-wide constraint would make the v1.8 generator
  fail. Scoped to `origin = 'ETMS'`, the constraint matches zero existing rows, so adding it is instant and changes
  no v1.8 behaviour. ETMS vs ROUTE overlaps are caught by the transactional check (§8.4).
- **Availability:** `btree_gist` is a contrib extension (uuid support since PG 10) and a *trusted* extension since
  PG 13, so a database owner with `CREATE` can install it without superuser. Neither its presence on the production
  PostgreSQL 18 host or the test instance nor the migration role's privilege can be verified from the repo (the
  repo creates only `timescaledb`, conditionally, `20261018002831_init` l.505–510). Read-only
  check for ops: `SELECT name, default_version, installed_version FROM pg_available_extensions WHERE name =
  'btree_gist';`.
- **Lead answer (E0.5 integration, 2026-11-11):** on production PostgreSQL **18.6**, `btree_gist` is **available
  (version 1.8) but not installed**; TimescaleDB **2.31.0** is installed. Creating `btree_gist` on production **needs
  superuser** (the migration role cannot), so it must be created either by a migration run by a superuser deploy user or
  by the install script (`ops/deploy/linux/install-ubuntu.sh`, as `postgres`). Which path is used is owner decision
  **O16** (README §7; an extension install is an infrastructure change). Availability on the test instance and in the CI
  image is checked in WP 1a.3.
- **Recommendation:** include the constraints only if `btree_gist` is available on production, the test instance
  and CI; otherwise omit them and rely on §8.4 alone. **Do not** use a conditional `DO $$ … IF EXISTS` block (the
  Timescale pattern): it would give environments different integrity rules.

### 8.3 Capacity backstop

`TransportTrip.occupiedSeats` is changed only by the trip command handler, in the same transaction as the
passenger-row change, after `SELECT … FOR UPDATE` on the trip. The CHECK makes over-allocation impossible even if a
code path forgets the lock. `REASSIGN_VEHICLE` re-snapshots `seatCapacity` from the new vehicle's profile; the CHECK
rejects a smaller vehicle. Capacity is the conservative total (all passengers counted for the whole trip), which is
exact for login (IN) and logout (OUT) trips. A DB invariant test asserts `occupiedSeats = SUM(seats) of non-cancelled
passengers` after every concurrency test. Alternative (not recommended for R1): a deferred constraint trigger
computing the sum; the repo has no triggers.

### 8.4 Publish transaction order (extends `02` §5.4)

1. `pg_advisory_xact_lock(hashtextextended('etms:object:' || objectId, 0))` for every vehicle, then every driver, in
   sorted order (deadlock-free; hash collisions only over-serialise).
2. Overlap query: active `PlannedTrip` (any origin) for the vehicle / driver whose `[plannedStart, plannedEnd)`
   overlaps → 409.
3. `SELECT … FOR UPDATE` on bookings (sorted by id); status check.
4. `SELECT … FOR UPDATE` on touched `TransportTrip` rows (sorted); `expectedVersion` check.
5. Inserts / updates; `occupiedSeats` update; booking states; events; audit; outbox; `TransportChangeSet` row.
6. Commit → `PlannedTripsService.invalidate(companyId)`.

Recommended for WP 3.1: v1.8 `PlannedTripsService.create` / `update` and the generator take the same advisory lock,
so a ROUTE trip created at the same moment cannot slip past step 2. Without it, a race window remains between ROUTE
and ETMS trips of one vehicle.

`REORDER_STOPS` on a published trip updates `PlannedTripStop.seq` **in place** (two-phase renumber, because
`PlannedTripStop_tripId_seq_key` is not deferrable) and the passengers' `pickupSeq` / `dropSeq` in the same
transaction. Deleting and re-creating stops would null the passengers' stop FKs.

---

## 9. Migration sequence

### 9.1 Order and names

Rule: the folder timestamp is the authoring time but **must sort after the current head of `origin/main` when the
PR merges**; if another migration lands first, the PR re-dates its folder before merge (never after it was applied
anywhere shared). Today's head is `20261113090000_routes_planned_trips`, which is itself dated ahead of today
(2026-11-11), so every new folder must start at `20261113090001` or later. The names below are indicative.

| # | Folder (indicative) | Phase / WP | Content | Gate |
|---|---|---|---|---|
| 0a | `20261114090000_alert_notified_at` | E0.5 G2 | `Alert.notifiedAt` (+ index / bounded backfill, §7.6) | per-patch owner approval |
| 0b | `20261114100000_notification_log_delivery` | E0.5 G3 | seven `NotificationLog` columns, `dedupeKey` unique, index `(status, nextAttemptAt)` | per-patch owner approval |
| 1 | `202612xxhhmmss_etms_accounts` | E1a WP 1a.0 | enums `TransportAgreementStatus`, `TransportGrant`, `TransportDataProfile`, `OutboxClass`; tables `TransportServiceAgreement`, `OutboxEvent`; `ALTER TYPE "AuditAction" ADD VALUE 'ACCESS'` | merge-gated |
| 2 | `…_etms_people` | E2 WP 2.0 | `EmployeeTransportProfile`, `EmployeeTransportConsent`, `TransportVehicleProfile`; `Driver.userId` | merge-gated |
| 3 | `…_etms_bookings_trips` | E3 WP 3.0 | enums `TransportDirection`, `TransportPickupMode`, `TransportExceptionKind`, `TransportBookingSource`, `TransportBookingStatus`, `TransportPassengerStatus`, `TransportChangeSetStatus`; the eight E3 tables | merge-gated |
| 4 | `…_planned_trip_origin` | E3 WP 3.1 (same PR) | §7.1 DDL; two exclusion constraints only if `btree_gist` is installed everywhere (O16 decides how it is created) | merge-gated, with WP 3.1 code |

Dependencies inside the sequence: 2 needs nothing from 1 except ordering; 3 needs 2 (profile FKs) and `Poi`; 4 needs
3 only for the exclusion constraints' purpose. `12` §1 says "one migration per phase"; E3 deliberately has two (§7.1,
§12 C-1); `12` §1 now records this as a documented exception (Lead, E0.5).

### 9.2 Data backfills

None in the ETMS migrations: `origin` is filled by the column default without a table rewrite; `Driver.userId` starts
NULL; no `RolePermission` rows; no role templates (seeded by code on enable, WP 1a.2); no agreements (R1). The only
identified backfill is the E0.5 G2 `Alert.notifiedAt` question (§7.6).

### 9.3 Locks and duration

Every statement on an existing table is metadata-only or touches a small table: `DROP NOT NULL`, `ADD COLUMN …
DEFAULT` (constant), nullable `ADD COLUMN`, unique index on `Driver`, CHECKs on `PlannedTrip` (small, v1.8 since
2026-11-11; validate with `NOT VALID` + `VALIDATE CONSTRAINT` if the production-like rehearsal shows a long scan),
ETMS-scoped `EXCLUDE` (zero matching rows). New FKs reference `Company`, `User`, `Branch`, `Poi`, `TrackedObject`,
`PlannedTrip`, `PlannedTripStop` from empty tables (brief `SHARE ROW EXCLUSIVE` on the referenced table). The
rehearsal (§9.5) records the lock wait and duration of each statement.

### 9.4 Rollback and forward-fix per migration

The repo is forward-only. General rollback = **switch off** (`ETMS=off`, company feature `etms`, web flag), keep the
schema. A defect is fixed by a new forward migration. Dropping objects is destructive and needs owner authorisation
(README §1.1 "destructive database changes" not authorised). Last resort: restore from the G7 backup.

| # | Switch-off effect | Forward-fix examples | Full revert (owner-authorised forward migration) |
|---|---|---|---|
| 1 `etms_accounts` | No reads / writes; agreements empty in R1; outbox drains or stops | change an index or CHECK | drop the two tables and four enums; `AuditAction.ACCESS` stays (PostgreSQL cannot drop an enum value; harmless if unused) |
| 2 `etms_people` | Profiles / consents / vehicle profiles unread; `Driver.userId` ignored by fleet code | relax a CHECK, add a column | drop the three tables; drop `Driver.userId` (destructive if links exist) |
| 3 `etms_bookings_trips` | No bookings generated, no publish | add index, adjust CHECK sets | drop the eight tables and seven enums (destructive once data exists) |
| 4 `planned_trip_origin` | ETMS trips keep running in the tracker unless cancelled; ROUTE unchanged | drop the exclusion constraints if they misbehave (non-destructive) | `SET NOT NULL` on `routeId` is only possible after every `origin = 'ETMS'` trip is deleted (destructive); application rollback below WP 3.1 is unsafe once ETMS trips exist (§7.1) |

### 9.5 Tests per migration

| Test | Where | Pass criteria |
|---|---|---|
| Fresh database | CI job with PostgreSQL 18 + TimescaleDB service container (`12` WP 1a.3) and a scratch `_test` database: `prisma migrate deploy` from zero | all 58 + new migrations apply; `prisma validate`; `prisma migrate diff --from-migrations … --to-schema-datamodel …` shows only the documented raw-SQL objects (partial indexes, CHECKs, EXCLUDE) |
| Raw-SQL object inventory | same | a query on `pg_indexes` / `pg_constraint` finds every partial unique, CHECK and EXCLUDE named in §3–§5 / §7–§8 |
| Production-like copy | rehearsal database restored from the G7 backup (`veetrax_restore_test` pattern) — **where it may run is open question Q8** | `migrate deploy` of the pending migrations succeeds; per-statement lock / duration logged; v1.8 smoke (planned-trips list, generator run, TRIP_PERFORMANCE / PLANNED_TRIPS reports) unchanged; report goldens unchanged |
| Constraint behaviour | DB-gated int spec (`purge-financial.int.spec.ts` pattern, env URL ending in `_test`) | each CHECK / partial unique / composite FK rejects a crafted bad row; cross-company composite FK insert fails |
| Concurrency | same | 2 parallel publishes for one vehicle and overlapping windows → exactly one succeeds; N parallel `ADD_PASSENGER` beyond capacity → `occupiedSeats ≤ seatCapacity` and invariant sum holds; double booking submit → 1 row; generator twice → 0 new rows |
| Tenant purge (§9.6) | DB-gated `purge-etms.int.spec.ts` + `purge-plan.spec.ts` cases | §6 matrix holds row by row |
| Regression | `ci.yml` api + web suites with ETMS flags off **and** on (`12` §3 exit criteria) | green |

### 9.6 Tenant-purge tests

1. **Planner unit tests** (`purge-plan.spec.ts` style, synthetic catalogue): composite FK seen as `profileId → id`
   (first column); `TransportTrip` not reached from `TrackedObject` (no `objectId` column); SetNull edges skipped;
   no ETMS table has a SetNull FK on a column named `companyId`.
2. **Reachability lint** (DB-gated): every table whose name starts with `Transport` or `EmployeeTransport`, plus
   `OutboxEvent`, is reached from a `company` purge plan (either a `companyId` column or an FK chain).
3. **Corporate-managed company purge:** seed the full R1 graph (profiles, consents, shifts, schedules, exceptions,
   bookings, trips with `PlannedTrip` + stops, passengers, events, change sets, vehicle profiles, outbox) → purge →
   zero rows of that company in every table; another company's identical graph untouched.
4. **Vehicle purge:** `PlannedTrip` and stops gone; `TransportTrip.plannedTripId` NULL; passengers present with stop
   FKs NULL and seqs intact; `TransportVehicleProfile` gone.
5. **User purge:** profile present with `userId` NULL; `Driver.userId` NULL; no ETMS row deleted (documents the
   need for the WP 2.6 erasure routine).
6. **Provider-managed fixture (agreement modelled, E1b semantics):** provider purge → agreement gone, customer
   bookings present with `providerCompanyId` / `agreementId` NULL, provider trips / passengers / events gone;
   customer purge → agreement gone, provider `TransportTrip` present with `customerCompanyId` / `agreementId` NULL,
   passengers and passenger events gone, trip-level events present.
7. **Financial guard unchanged:** the existing R-36 int spec still passes with ETMS tables present.

---

## 10. Later phases (outline, E1b and E4–E9)

Each line is an outline for the phase's x.0 migration, written then from `02` / `12` and that phase's decisions.

| Phase | Entity / change | Key points to decide in its x.0 |
|---|---|---|
| E1b | `TransportFleetAllocation(id, agreementId FK Cascade, providerCompanyId FK Restrict, customerCompanyId FK SetNull, objectId? FK TrackedObject Cascade, driverId? FK Driver Cascade, validFrom, validTo, createdById, timestamps)` | CHECK at least one of vehicle / driver; exclusion on overlapping allocation per vehicle (if `btree_gist`); `objectId` has an FK, so the logical key does not apply. If L5 = "delete provider headers", flip `TransportTrip.customerCompanyId` to Restrict here. Super Admin reason header uses `AuditAction.ACCESS` (no new table unless the owner prefers a separate sensitive-access log, L7). |
| E4 | Ported `RoutePlan`, `RouteAssignment`, `RoutePlanStop` (renamed), `RoutingJob`, `RoutingUsage`, `RoutePlanVersion` — only after the §11 review | Regenerated, re-dated migration `routing_engine_v2`; tenancy (`companyId` = operator; passenger stops carry customer data → customer column or customer-scoped stops), `assigneeUserId` vs `Driver.userId` (D5); `TransportTrip.routePlanId` FK SetNull (`etms_planning_links`) |
| E4 | Snapped coordinates on profile and booking: `…SnappedLat`, `…SnappedLng`, `snapDistanceM`, `graphVersion` (`02` §7.2) | nullable, additive |
| E4b | `TransportStopProfile(poiId PK FK Poi Cascade, companyId, accessible, boardingCapacity, maxWalkM)` | owner decision O3; stop ownership P1 |
| E5 | `TransportDriverDuty(id, companyId operator, driverId FK Driver Cascade, objectId? FK TrackedObject SetNull, startedAt, endedAt, source)` | partial unique open duty per driver; whether duty writes `DriverAssignment` (P5) |
| E5 | `TransportIncident` (+ append-only `TransportIncidentEvent`) | **Must survive ordinary purge and retention** (`10` §4.1, §6.4): no `companyId` / `objectId` / `deviceId` columns, `customerCompanyId` / `providerCompanyId` / `tripId` FKs **SetNull**, `legalHold`, last-known location snapshot (Position retention). Keeping incidents after a customer purge is an owner / legal decision (L3, L5) |
| E5 gaps | Storage not named in `02` / `12`: passenger saved places (`05` §2.8 `/places`), schedule change requests (`/schedule/change-requests`), driver checklist templates (`/checklists/template`) | name and design in WP 5.0 (Lead + schema owner) |
| E6 | `TransportPolicy`, `TransportPolicyVersion` (immutable after publish), `TransportPolicyOverride`, `TransportEscalationStep` (DB-scheduled escalation) | policy columns on booking / passenger (`policyVersionId`, `policyResult`, `policyReasons`); `NotificationStatus` += `DELIVERED`, `DEAD` (`SKIPPED` exists, V l.722–727); escalation-plan storage per site is not named in `02` (gap); sensitive attribute column only if L2 approves |
| E7 | Rate cards / cost records | only if C1 approves costing; decide whether they are "financial" for the purge guard |
| E8 | `Company.country`, site time zone (`Poi` or a site table) | merge-gated 8.0; `TransportShift.timeZone` already per row |
| E9 | none planned | indexes from load tests; retention jobs for ETMS tables (L3) |

---

## 11. Routing-branch compatibility review plan (execute before E4; nothing done now)

### 11.1 Inventory (V, read with `git show` / `ls-tree` / `grep` / `rev-list`)

| Fact | Value |
|---|---|
| Branches | `feature/routing-engine` = `19150e8`; `feature/routing-r0` = `948cb44` (an ancestor of `feature/routing-engine`; no migrations of its own) |
| Merge-base with `origin/main` | `07077b6`; branch **38 commits ahead, 78 behind** `origin/main` |
| Remote copies | `git branch -r --contains feature/routing-engine` → **none** (single local copy) |
| Upstream setting | `feature/routing-engine` tracks **`origin/main`** (`git for-each-ref … %(upstream)`): a `git pull` on it would merge main into it, a careless push could target main |
| Working trees | `feature/routing-engine` is checked out in `D:/Vibhav/gps-app/.claude/worktrees/agent-ae5a7738419cf355c`, `feature/routing-r0` in `…/agent-a8909a5041d444892`; `.claude/` is untracked in the main repo |
| Size | 202 files, +28,469 / −20 lines since the merge-base |
| Migrations | `20261110110000_routing_engine_v2` (creates enums `RoutePlanStatus`, `RoutingJobStatus`; tables `RoutePlan`, `RouteAssignment`, **`RouteStop`**, `RoutingJob`, `RoutingUsage`); `20261110120000_routing_jobs_plan_versions` (`ALTER TYPE "RoutingJobStatus" ADD VALUE 'CANCELLED'`, `RoutingJob` lease / retry columns, `RoutePlanVersion`, unique `(companyId, idempotencyKey)`, index `(status, lockedUntil)`) |
| Schema | six models at branch `schema.prisma` l.2192–2350; relations added on `Company` (`routePlans`, `routingJobs`, `routingUsage`) and `User` (`RoutePlanCreatedBy`, `RouteAssignee`) |

| Model | Owner column / FKs (onDelete) | Purge behaviour on main's planner |
|---|---|---|
| `RoutePlan` | `companyId` FK Company **Restrict**; `createdById` FK User **SetNull** | company purge deletes (walked) |
| `RouteAssignment` | `planId` FK **Cascade**; `companyId` (no FK); `objectId`, `driverId` (no FK, "logical keys"); `assigneeUserId` FK User **SetNull** | **vehicle purge deletes assignments** via `objectId` logical key; their stops' `assignmentId` → NULL |
| `RouteStop` (branch) | `planId` FK **Cascade**; `assignmentId` FK **SetNull**; `companyId` (no FK) | company purge via plan and logical key |
| `RoutingJob` | `companyId` FK **Restrict**; `planId` FK **SetNull** | company purge deletes |
| `RoutingUsage` | PK `(companyId, day)`, FK **Restrict** | company purge deletes |
| `RoutePlanVersion` | `planId` FK **Cascade**; `companyId` (no FK) | company purge deletes |

### 11.2 The `RouteStop` clash (V S1)

Main: `model RouteStop` / table `"RouteStop"` (`routeId, seq, name, lat, lng, radiusM, offsetMin, waitMin,
geofenceId`, V `schema.prisma` l.2674, created by `20261113090000_routes_planned_trips`). Branch: `model RouteStop`
(`planId, companyId, assignmentId, ref, name, lat, lng, demand, serviceS, timeWindows, sequence, etaS,
unassignedReason`). Consequences: the two schemas cannot be combined (duplicate model); the branch migration's
`CREATE TABLE "RouteStop"` fails on every v1.8 database; the Prisma client accessor `prisma.routeStop` means two
different things. Branch code using the accessor / type (`git grep`): `apps/api/src/routing-v2/plans.service.ts`,
`routing-v2.service.ts`, `routing-v2.controller.ts`, `routing-v2.dto.ts`, `plan-history.ts`, `access.spec.ts`,
`routing.int.spec.ts`, `apps/web/src/features/route-planner/PlanEditor.tsx`, `packages/shared/src/routing.ts`.

### 11.3 Review steps

| Step | Action | Output |
|---|---|---|
| R0 | **Custody first** (§11.6): owner approves and performs the local custody step | bundle path, SHA-256, tip SHAs recorded |
| R1 | Freeze the inventory: re-record tip SHAs, merge-base, ahead / behind counts, and ask the Lead to run `git -C <each routing worktree> status --short` (not run in E0.5) to find uncommitted work | inventory table |
| R2 | **Ownership review per model** (schema owner + routing agent): D1 tenancy (plan = operator's artefact; passenger stops carry customer data → customer column or customer-scoped rows?); D2 (a published plan creates `PlannedTrip` + `TransportTrip`; `RouteAssignment` must not become a second execution record); D5 (`assigneeUserId` vs `Driver.userId`); purge (is "vehicle purge deletes plan assignments" wanted?); retention (branch edits `retention.service.ts`); menu key `route_plans` vs main's `routes` / `plannedTrips` and `etms_*` (`02` §3.1) | port / adapt / drop per model |
| R3 | **Migration history:** the branch migrations are never applied to a shared database. Any local database that ran them is dropped / reset, not migrated. Regenerate **one** migration `<ts>_routing_engine_v2` against main's schema with `prisma migrate diff`, dated after main's head at that time; `RoutingJobStatus` created with `CANCELLED` directly (no `ADD VALUE`); index and constraint names regenerated for the renamed table | regenerated SQL for review |
| R4 | **FK dependency map** (below): confirm no new FK points into main's `RouteStop`, `Route`, `PlannedTrip*`; confirm every new table is reachable by the purge planner and that the `objectId` logical key on `RouteAssignment` is intended | signed map |
| R5 | **Rename candidates:** only the clashing `RouteStop` → **`RoutePlanStop`** (working name, D3): table, PK `RoutePlanStop_pkey`, FKs `RoutePlanStop_planId_fkey` / `_assignmentId_fkey`, indexes `RoutePlanStop_planId_ref_key` / `_assignmentId_idx`, Prisma accessor `prisma.routePlanStop`, relation fields `RoutePlan.stops` / `RouteAssignment.stops` unchanged (`03` §6), the nine code files in §11.2. Check every other branch name against main: `RoutePlan`, `RouteAssignment`, `RoutingJob`, `RoutingUsage`, `RoutePlanVersion`, `RoutePlanStatus`, `RoutingJobStatus` — none exists on main today; re-check at review time. Not renamed to `TransportPlan*` (D3, README §6) | rename list |
| R6 | **Conflicting files** (`06` §6, `git merge-tree`): `apps/api/prisma/schema.prisma`, `apps/web/src/features/shell/nav.ts`, `ops/deploy/windows/deploy-release.ps1`, `packages/shared/src/index.ts`, `packages/shared/src/permissions.ts`; plus `retention.service.ts`, `routing.service.ts`, `app.module.ts`, `main.ts`, `access-rules.spec.ts` touched by the branch | per-file port note |
| R7 | **Tests** (V C4: re-run, do not quote): in a **disposable clone made from the bundle in an off-repo directory** (the original branch and worktree are not touched): run the branch's Jest, integration and `pytest` suites and record counts; then on the fresh port branch from main: fresh-DB migrate, drift check, planner tests for the six tables, isolation matrix incl. `route_plans`, routing corpus, and the R1 manual-dispatch E2E with the optimiser **stopped** (`12` §7 exit criteria) | test evidence |
| R8 | Written report with port / adapt / drop per area (`12` §7 prep step 1); owner reviews before WP 4.0 | report |

FK dependency map of the branch models (all point to `Company` / `User` or to each other; none to main's routing
tables):

```
Company ─Restrict─< RoutePlan ─Cascade─< RouteAssignment ─SetNull─< RouteStop→RoutePlanStop
   │                    │  └─Cascade─< RouteStop→RoutePlanStop (planId)
   │                    ├─Cascade─< RoutePlanVersion
   │                    └─SetNull─< RoutingJob (planId)
   ├─Restrict─< RoutingJob (companyId)
   └─Restrict─< RoutingUsage
User ─SetNull─< RoutePlan.createdById ; User ─SetNull─< RouteAssignment.assigneeUserId
logical (no FK): RouteAssignment.objectId / driverId / companyId ; RouteStop.companyId ; RoutePlanVersion.companyId
future (E4): TransportTrip.routePlanId ─SetNull→ RoutePlan
```

### 11.4 What stays out of scope

Valhalla adapter and pipeline (D3: out of scope); the 1.60 ETA factor (`06` §6); the hosting benchmark kit.

### 11.5 Isolation and custody risk

- The branch exists **only on this PC** (no remote contains it); a disk failure, a mistaken `git branch -D`, or a
  repository re-clone loses 38 commits of work. Branch refs live in `D:\Vibhav\gps-app\.git`; the two agent
  worktrees under `.claude/worktrees/` hold only checkouts (removing them loses uncommitted changes there, not the
  commits).
- Its upstream is `origin/main`, which makes accidental `pull` / `push` against main more likely. **Lead check
  (2026-11-11):** both branches are local only, upstream `origin/main`, and `push.default` is unset, so git's default
  `simple` mode **refuses** a push whose local and upstream names differ; a plain `git push` from the branch therefore
  fails rather than updating main, but an explicit refspec would still push.
- Owner instruction for E0.5: **keep it isolated, do not push, do not merge.** V condition C4 and README O7 previously
  recommended "archive to a private remote ref"; in E0.5 the Lead reworded both to an **off-repo `git bundle` custody
  copy (recommended, not done; owner to approve)**, consistent with the instruction (README O7).

### 11.6 Recommended custody step (recommendation only; not performed)

1. Create a self-contained bundle **outside the repository**, e.g. on a second physical disk:
   `git -C D:\Vibhav\gps-app bundle create <off-repo-path>\routing-engine-<date>.bundle feature/routing-engine feature/routing-r0`
2. `git bundle verify <bundle>`; record the bundle's SHA-256 and the two tip SHAs (`19150e8`, `948cb44`) in the
   evidence folder (paths and hashes only, no bundle in Git).
3. Optionally encrypt the bundle with the owner-held key (O8 key custody) before it leaves the PC; scan it for
   secrets (e.g. optimiser tokens) before any off-site copy; no upload anywhere without owner approval.
4. Optionally (owner action) `git -C D:\Vibhav\gps-app branch --unset-upstream feature/routing-engine` to remove the
   `origin/main` tracking.

This keeps the branch unpushed and unmerged while removing the single-copy risk.

---

## 12. Contradictions and gaps: resolved here or left open

| # | Item | Resolution |
|---|---|---|
| C-1 | `12` §1 "one migration per phase" vs the Prisma type change breaking `tsc` in the `routeId` files | **Resolved, Lead-confirmed (E0.5):** E3 has two migrations; `planned_trip_origin` ships with WP 3.1 (§7.1). `12` §1 / §5 and `02` §3.1 updated. |
| C-2 | `02` §5.4 / `05` §1 require a unique `(companyId, idempotencyKey)` "on the change set", but `12` WP 3.0 names no change-set table | **Resolved, Lead-confirmed (E0.5):** `TransportChangeSet` (§5.8) added to `12` WP 3.0, `02` §3.1 / §5.4, `05` §1. Server-side drafts stay a Lead / UX choice at WP 3.4. |
| C-3 | `03` §2 consent FK Cascade vs consent as evidence | **Resolved:** Restrict (purge still deletes). |
| C-4 | Dual keys vs purge logical key (V S11) | **Resolved per table** (§1.2, §6). |
| C-5 | `03` §2 / `04` §6 trip business-status enum | **Resolved by D2:** none; timestamps + derived states. |
| C-6 | `03` §2 `TransportTrip.customerCompanyId` Restrict vs `02` §4.3 SetNull | **SetNull** (recommended L5 default); **left open** for the owner (Q2); irrelevant in R1. |
| C-7 | `03` §2 trip `companyId (operator)` vs `02` dual keys | `providerCompanyId` + `customerCompanyId`. |
| C-8 | `03` §2 agreement unique `(provider, customer, validFrom)` | Partial unique on live agreements; **depends on P1** (Q6). |
| C-9 | `02` §5.1 lists `TransportTrip.routePlanId` (E3 record) while `RoutePlan` arrives in E4 | Column added in E4 with its FK. |
| C-10 | `03` §2 profile `shiftId` (shift table is E3, profile E2) | Dropped; the schedule links the shift. |
| C-11 | "~71" (`02`, `03`, `12`) vs "72 in 15" (V) `routeId` references | Both reconciled: 72 lines / 15 files excl. `*.spec.ts`; 79 / 18 incl. them; 4 code + 8 type-only changes (§7.1). |
| C-12 | New defect found: `trip-performance.ts` `nameOf` labels every null group key "No driver" | Fix with WP 3.1 (§7.1 #19). **Lead-confirmed:** in `12` WP 3.1 scope and E3 exit criteria. |
| C-13 | `03` §2 lists `TransportVehicleProfile` / fleet allocation in E2 | E2 / E1b as README §6. |
| C-14 | Table-wide overlap constraint would break v1.8 (no overlap rule today) | ETMS-scoped `EXCLUDE` + transactional check (§8.2). |
| C-15 | CHECKs proposed in drafts that would abort purges (assigned ⇒ provider; no agreement ⇒ same company; STOP ⇒ stopPoiId) | Replaced by transactional checks (§1.3). |
| C-16 | V C4 / README O7 "push to a private remote ref" vs owner instruction "do not push" | **Wording resolved (Lead, E0.5):** C4 and O7 now say off-repo `git bundle` custody copy, recommended, not done. Custody itself stays owner decision O7 (Q9). |
| C-17 | E5 / E6 storage not named in `02` / `12` (saved places, schedule change requests, checklist templates, escalation plans) | **Left open** for WP 5.0 / 6.0 (technical, Lead + schema owner). |
| C-18 | Local `main` ref stale (`2b8bb93`) | Use `origin/main` as main everywhere. |

---

## 13. Open questions (owner decisions only)

| # | Decision | Why it matters here | Recommended default (not decided) |
|---|---|---|---|
| Q1 | **L3** retention periods for ETMS tables (bookings, trips, passengers, events, exceptions, consent, sensitive-access audit) | Retention jobs and erasure design (WP 2.6, 6.4); no automatic trimming until decided | README §7 L3 default |
| Q2 | **L5** purge / erasure semantics: keep provider trip headers anonymised on customer purge (`customerCompanyId` SetNull) or delete them; anonymise profiles / bookings in place on a data-subject request; incidents surviving a company purge (E5) | FK actions on `TransportTrip`, `TransportTripEvent`, `TransportIncident`; `anonymisedAt` | SetNull + anonymise in place (README §7 L5) |
| Q3 | **`btree_gist`** — *availability answered by the Lead (§8.2): available on production 18.6 (1.8), not installed, needs superuser.* Remaining decision (**README O16**): may it be created, and by which path (superuser deploy-user migration or install script)? | Enables the DB-level double-assignment constraints (§8.2) | Create it via the install script as `postgres` (explicit, reviewed infra step), then the migration only adds the constraints; otherwise transactional checks only |
| Q4 | **P6** final role-template set (per-company templates are the recorded D5 / `12` direction, not global `SYSTEM_ROLES`); templates `isSystem` or editable; Admin auto-menus for feature-gated keys | §7.4 (no migration either way) | Corporate admin, Dispatcher, Passenger, Driver; exclude gated menus from the Admin auto-set |
| Q5 | **P2** one customer per trip in R1 (pooling later via passenger rows) | `TransportTrip.customerCompanyId` stays on the header; capacity semantics | One customer per trip (README §7 P2) |
| Q6 | **P1** agreement model: one live agreement per provider–customer pair? Must ACTIVE require both approvals, or may the Super Admin activate on paper evidence? | Partial unique and any approval CHECK on `TransportServiceAgreement` | One live agreement per pair; both approve in-app |
| Q7 | **P5** passenger self-confirm authority | CHECK limiting outcome sources to `WEB` / `DRIVER_APP` | Driver / dispatcher authoritative; passenger confirmation is an event only |
| Q8 | **(README L8)** **Migration rehearsal on a production-like copy:** may a restored production backup be used (real personal data) and where (only on the production host, then dropped), or must rehearsal use synthetic, volume-scaled data only (`12` §1 data rule)? | §9.5 production-like test | Restore-drill database on the production host, read by the migration only, dropped afterwards — or synthetic only if the owner prefers. *Lead note (E0.5): this option touches production and conflicts with `12` §1 ("production never used for tests") and `16` §8 S2; README L8 therefore lists **synthetic, volume-scaled data** as the recommended default and a production copy only with explicit owner approval.* |
| Q9 | **(README O7)** **O7 / C4** custody of `feature/routing-engine` / `feature/routing-r0`: local off-repo bundle (no push) vs private remote ref; who holds the copy and the key; unset the `origin/main` upstream | §11.5–11.6 | Off-repo encrypted bundle on a second medium now; any remote copy only with explicit owner approval |
| Q10 | **L2** sensitive passenger attribute (gender-related safety rules) | No such column is planned in R1; E6 adds one only after legal sign-off | Off by default (README §7 L2) |

Nothing in this document authorises implementation, a migration run, an extension install or any change to the
routing branch. The owner reviews the E0.5 deliverables before authorising implementation (README §1.1).
