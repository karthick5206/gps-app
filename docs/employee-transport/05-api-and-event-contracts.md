# 05 · ETMS API and event contracts (Lead Architect)

Status: **contract design under the architecture direction approved by the owner on 2026-11-11** (D1–D8, L4, O8, O9;
record and conditions in [README](README.md) §1.1). The contracts themselves are design, not implemented;
implementation needs separate owner authorisation, and every README §7 decision other than P7 / L4 / O8 / O9 is still
open (where a contract depends on one, the decision ID is cited). No route, DTO, channel or table below exists in code. Conventions marked **(V)** are verified in `origin/main` f5b151b. Architecture context:
[02-target-architecture.md](02-target-architecture.md). Short references: `02` = 02-target-architecture.md, `03` =
[03-database-model-inventory-and-reuse.md](03-database-model-inventory-and-reuse.md), `04` =
[04-proposed-data-model-and-erd.md](04-proposed-data-model-and-erd.md), `06`–`11` = the agent documents with those
numbers, `12` = [12-phased-implementation-plan.md](12-phased-implementation-plan.md). **R1** = first release
(E1a + E2 + E3).

---

## 1. Conventions

| Topic | Rule |
|---|---|
| Prefix and controllers | Global prefix `/api` (V `apps/api/src/main.ts` `setGlobalPrefix('api')`). One controller per resource, e.g. `@Controller('transport/bookings')` → `/api/transport/bookings`. |
| Permissions | Every route carries `@RequirePermission(menu, action)` or `@RequireAnyPermission` (V `access/decorators.ts`, `PermissionGuard`) **and**, for ETMS rows, a scope helper from `access/transport-scope.ts` (`02` §4.2). Passenger and driver routes also carry `MeTransportGuard` / `DriverIdentityGuard`. CI fails any ETMS route without both (`11` §3.1). |
| Menu keys | `etms_dashboard`, `etms_dispatch`, `etms_bookings`, `etms_passengers`, `etms_schedules`, `etms_stops`, `etms_incidents`, `etms_policies`, `etms_partners`, `etms_costing`, `etms_settings` (`07` §2.2); `etms_self` (passenger), `etms_driver` (driver); `route_plans` (ported, E4). Existing `objects`, `drivers`, `plannedTrips`, `reports`, `alerts` reused. |
| Feature gate | `TransportFeatureGuard` on every ETMS controller: 404 when `ETMS=off` or company feature `etms` absent (`07` §2.4). |
| Lists | Query DTO extends `ListQueryDto` (V `common/list-query.ts`: `q, page, pageSize ≤ 200, sort, order, status, format json/csv`); response `Paginated<T>` from `@veetracer/shared`; CSV needs `export` (V). |
| Ids and times | UUID ids; timestamps ISO-8601 UTC; service dates `YYYY-MM-DD` in the **site** time zone; every DTO with a local time also carries `timeZone`. Coordinates as `{lat, lng}` in DTOs, `[lng, lat]` only in GeoJSON paths (the share-page bug, RR-14, came from mixing these). |
| Idempotency | Header `Idempotency-Key` (UUID, client-generated) **required** on booking create, dispatch change-set publish, plan publish, incident / SOS create; stored as unique `(companyId, idempotencyKey)` on the target row (for dispatch change sets the target is the E3 ledger table `TransportChangeSet`, with a `requestHash`; for bookings `(customerCompanyId, idempotencyKey)` on `TransportBooking`; `15` §5.4, §5.8, §8.1). Repeat with same body → original response, header `Idempotent-Replay: true`. Same key, different body → 422 `IDEMPOTENCY_KEY_REUSED`. Trip events use `clientEventId` per event (§3.8). |
| Concurrency | Mutable aggregates (`TransportBooking`, `TransportTrip`, `RoutePlan`) carry `version`; writes send `expectedVersion`; mismatch → 409 `VERSION_CONFLICT` with the current version. |
| Errors | Existing shape (V `common/http-exception.filter.ts`): `{ statusCode, message, code? }`. ETMS always sets `code` (§4). Other-tenant ids → **404**, never 403 (`11` §3.2 item 7). |
| Rate limits | Booking create, OTP, SOS per user / IP through a Valkey-backed throttler with DB fallback (W7 / R-26 fix; E3). |
| Audit | Writes via `AuditService.record(ctx, …, tx)` (V); sensitive reads (home address, phone reveal, live location, manifest) write `AuditAction.ACCESS` (additive enum, `03` §3). |
| Shared types | DTO interfaces and enums in `packages/shared/src/transport.ts`, events in `packages/shared/src/transport-events.ts` (single owner: Lead; merge-gated, `12` §1). |

---

## 2. API groups and routes

Phase column = first phase that ships the route (`12`). "Perm" = `menu:action`.

### 2.1 Accounts and agreements (`transport/accounts`)

| Method + path | Perm | Purpose | Phase |
|---|---|---|---|
| `GET /api/transport/agreements` | `etms_partners:view` | List agreements where caller is provider or customer (`ListQueryDto` + `status`, `side`) | E1a (Super Admin only), E1b |
| `POST /api/transport/agreements` | `etms_partners:create` | Create DRAFT (provider or customer side; Super Admin on paper evidence if owner allows, P1) | E1b |
| `PATCH /api/transport/agreements/:id` | `etms_partners:edit` | Edit DRAFT grants / sites / validity | E1b |
| `POST /api/transport/agreements/:id/approve` | `etms_partners:edit` | Side-specific approval; ACTIVE when both approved | E1b |
| `POST /api/transport/agreements/:id/suspend` · `/end` | `etms_partners:edit` | Customer may suspend unilaterally; immediate effect (cache invalidation) | E1b |

### 2.2 Passengers (`transport/passengers`)

| Method + path | Perm | Purpose | Phase |
|---|---|---|---|
| `GET /api/transport/passengers` | `etms_passengers:view` | `PassengerListQuery extends ListQueryDto { siteId?, shiftId?, pickupMode?, needsLocation? }`; projection by helper | E2 |
| `GET /api/transport/passengers/:id` | `etms_passengers:view` | Detail; FULL home address only for customer admin; reveal audited | E2 |
| `POST /api/transport/passengers` · `PATCH /:id` · `DELETE /:id` (archive) | `etms_passengers:create/edit/delete` | Manual maintenance | E2 |
| `POST /api/transport/passengers/import/preview` | `etms_passengers:create` | Upload CSV / XLSX → row results (phone per country, duplicates, unknown site, geocode confidence via Photon) | E2 |
| `POST /api/transport/passengers/import/commit` | `etms_passengers:create` | Commit selected rows; idempotent on `(companyId, employeeCode)` | E2 |
| `POST /api/transport/passengers/:id/app-access` | `etms_passengers:edit` | Create / link `User` with Passenger role and send invite; 409 `IDENTITY_IN_USE` when mobile / email belongs to another User (D5) | E2 |
| `DELETE /api/transport/passengers/:id/app-access?mode=disable\|unlink` | `etms_passengers:edit` | `disable` (default): transport role removed, or `User.isActive=false` when it has no other role; link kept. `unlink`: the same, then `profile.userId` cleared. The User is never deleted | E2 |
| `GET /api/transport/passengers/:id/consents` | `etms_passengers:view` | Consent history (read-only) | E2 |
| `GET /api/transport/passengers/:id/history` | `etms_passengers:view` | Audit trail redacted per projection (home / health / emergency values never shown; STANDARD without home fields; MINIMAL fields only for providers); audited read | E2 |
| `GET /api/transport/consent-notices` · `POST` | `etms_settings:view` or `etms_passengers:view` / `etms_settings:edit` (whole company) | Company-level versioned consent notice per purpose (`10` §4.2); grants record the current version (409 `CONSENT_NOTICE_MISSING` / `CONSENT_NOTICE_OUTDATED`) | E2 |

### 2.3 Fleet, drivers, stops

| Method + path | Perm | Purpose | Phase |
|---|---|---|---|
| `GET /api/transport/vehicles` | `objects:view` | Every own vehicle in `objectScopeWhere` with its seat profile or `null` (list query + `seats=set\|unset`) | E2 |
| `GET/PUT /api/transport/vehicles/:objectId/profile` | `objects:view` / `objects:edit` | `TransportVehicleProfile` (seats, wheelchair spaces, AC, category); object must be in `objectScopeWhere` | E2 |
| `POST /api/drivers/:id/login` · `DELETE /api/drivers/:id/login?mode=disable\|unlink` | `drivers:edit` | Create / link `User` (Driver role) to `Driver.userId`; removal modes as for passengers | E2 |
| Offices and shuttle stops | `pois:*` (existing) | Existing `Poi` endpoints with categories `OFFICE`, `SHUTTLE_STOP` | E2 |
| `GET/PUT /api/transport/stops/:poiId/profile` | `etms_stops:view/edit` | Accessible flag, boarding capacity, max walk (E4 routing input) | E4 |

### 2.4 Shifts and schedules (`transport/schedules`)

| Method + path | Perm | Purpose | Phase |
|---|---|---|---|
| `GET/POST /api/transport/shifts`, `PATCH/DELETE /:id` | `etms_schedules:*` | `TransportShift` (site, start/end local minutes, days, overnight, timeZone) | E3 |
| `GET/POST /api/transport/schedules`, `PATCH/DELETE /:id` | `etms_schedules:*` | Recurring commute per passenger (direction IN/OUT, days, pickup HOME/STOP, validity); bulk create by selection | E3 |
| `GET/POST /api/transport/schedules/:id/exceptions`, `DELETE /:id/exceptions/:date` | `etms_schedules:edit` | Skip / override a date | E3 |
| `GET /api/transport/schedules/preview?from&to` | `etms_schedules:view` | How many bookings the generator will create / skip (holiday, exception) | E3 |

### 2.5 Bookings (`transport/bookings`)

| Method + path | Perm | Purpose | Phase |
|---|---|---|---|
| `GET /api/transport/bookings` | `etms_bookings:view` | `BookingListQuery extends ListQueryDto { serviceDate, direction?, shiftId?, siteId?, bookingStatus?, source? (ADHOC/SCHEDULE), unassigned? }` | E3 |
| `GET /api/transport/bookings/:id` · `/:id/events` | `etms_bookings:view` | Detail and timeline | E3 |
| `POST /api/transport/bookings` (Idempotency-Key) | `etms_bookings:create` | Ad-hoc booking on behalf of a passenger | E3 |
| `PATCH /api/transport/bookings/:id` (`expectedVersion`) | `etms_bookings:edit` | Change window / pickup before cut-off | E3 |
| `POST /api/transport/bookings/:id/approve` · `/reject` · `/cancel` | `etms_bookings:edit` | State commands; reason required for reject / cancel | E3 |
| `POST /api/transport/bookings/bulk-approve` | `etms_bookings:edit` | Approve a wave | E3 |

Generation from schedules is a scheduler job (every 15 min, rolling 72 h horizon, idempotent on
`(scheduleId, serviceDate, direction)`, `03` §2 table 7), not an endpoint.

### 2.6 Dispatch and trips (`transport/dispatch`, `transport/trips`)

| Method + path | Perm | Purpose | Phase |
|---|---|---|---|
| `GET /api/transport/dispatch/board?serviceDate&direction&shiftId&siteId` | `etms_dispatch:view` | Read model: unassigned bookings, draft / published trips with occupancy, vehicles available, alerts | E3 (basic), E7 (full) |
| `POST /api/transport/dispatch/candidates` | `etms_dispatch:view` | Body `{ bookingIds[] }` → candidate trips / idle vehicles with free seats, added detour and ETA **only if routing is up** (else `null` + `degraded`), policy result (E6) | E3 (seats only), E4 (detour/ETA) |
| `POST /api/transport/dispatch/change-sets` (Idempotency-Key) | `etms_dispatch:command` | Publish a batch of changes atomically (`DispatchChangeSetDto`, §3.4) | E3 |
| `GET /api/transport/trips` | `plannedTrips:view` + `etms_dispatch:view` | `TransportTripListQuery extends ListQueryDto { serviceDate, direction?, derivedState?, vehicleId?, driverId? }` | E3 |
| `GET /api/transport/trips/:id` | same | Header + `PlannedTrip` snapshot + manifest (projection by helper) | E3 |
| `POST /api/transport/trips/:id/start` · `/complete` · `/acknowledge` (`clientEventId`) | `etms_dispatch:command` | Dispatcher trip progression without a driver app (R1, `02` §5.3): wraps v1.8 `PlannedTripsService.start` / `complete` compare-and-set; acknowledge recorded on the driver's behalf (source `WEB`); 200 `ALREADY_STARTED` when GPS started it | E3 |
| `POST /api/transport/trips/:id/cancel` · `/interrupt` | `etms_dispatch:command` | Reason required; interrupt = `PlannedTrip` → INCOMPLETE + `interruptedAt` | E3 / E7 |
| `POST /api/transport/trips/:id/passengers/:passengerTripId/outcome` (`clientEventId`) | `etms_dispatch:edit` | Dispatcher records BOARDED / NO_SHOW / DROPPED while no driver app exists (source `WEB`) | E3 |
| `POST /api/transport/trips/:id/repeat?toDate` | `etms_dispatch:edit` | Copy an assignment to another service date as a **draft** change set (revalidated on publish) | E3 |

Existing `PlannedTrip` endpoints (`/api/planned-trips/*`, V `planned-trips.controller.ts`) keep working for
`origin=ROUTE`; for `origin=ETMS` the manual `PATCH` is refused with 409 `MANAGED_BY_ETMS` (changes go through change sets).

### 2.7 Routing and optimisation (`routing`, ported route-plans)

| Method + path | Perm | Purpose | Phase |
|---|---|---|---|
| `GET /api/routing/capabilities` · `GET /api/routing/health` | `etms_dispatch:view` or `route_plans:view` | `ProviderCapabilities`, `ProviderHealth`, optimiser slots (`06` §3) | E4 (health also E0.5 System Health) |
| `POST /api/route-plans` | `route_plans:create` | Plan from a booking set (`{ serviceDate, direction, siteId, shiftId, bookingIds?, scenario }`) | E4 |
| `POST /api/route-plans/:id/optimize` (Idempotency-Key) | `route_plans:command` | 202 `{ jobId }`; job in `RoutingJob` | E4 |
| `GET /api/routing/jobs/:id` · `POST /api/routing/jobs/:id/cancel` | `route_plans:view` / `command` | Status / progress / cancel (ported) | E4 |
| `GET /api/route-plans/:id` · `/history` · `PUT /:id/sequence` · stops / assignments CRUD | `route_plans:view/edit` | Ported plan editing; `RoutePlanStop` replaces branch `RouteStop` | E4 |
| `POST /api/route-plans/:id/scenarios` · `GET /api/route-plans/:id/compare` | `route_plans:command/view` | Scenario runs with identical inputs; KPIs; cost only with rate cards (`07` §5) | E4 |
| `POST /api/route-plans/:id/publish` (Idempotency-Key, `expectedVersion`) | `route_plans:command` | Revalidate, then the same publish transaction as change sets (`02` §5.4) | E4 |

### 2.8 Passenger self-service (`transport/me`, `/api/me/transport`)

All routes: `@RequirePermission('etms_self', …)` + `MeTransportGuard` (resolves `ctx.userId` → active profile).

| Method + path | Purpose | Phase |
|---|---|---|
| `GET /api/me/transport/profile` · `PATCH` | Own profile (contacts, accessibility, notification prefs; employee code read-only) | E3 read, E5 edit |
| `GET /api/me/transport/consent` · `POST` (`{ purpose, noticeVersion, granted }`) · `GET /consent/history` | Versioned consent | E3 |
| `GET /api/me/transport/trips?from&to` · `GET /trips/:id` | Own trip legs: window, vehicle plate / model / colour, driver first name, own stop only, co-rider count, ETA with `EtaModel` | E3 |
| `GET /api/me/transport/trips/:id/vehicle` | `{ visible:false }` outside the window; inside: `{ lat, lng, heading, fixAt, eta }` of the trip's vehicle only | E3 (web + mobile read-only) |
| `GET /api/me/transport/bookings` · `GET /bookings/:id` | Own bookings | E3 |
| `POST /api/me/transport/bookings` (Idempotency-Key) · `PATCH /:id` · `POST /:id/cancel` | Self-booking within policy cut-offs | E5 (after the read-only release) |
| `GET /api/me/transport/schedule` · `POST /schedule/exceptions` · `POST /schedule/change-requests` | Commute, leave days | E5 |
| `GET/POST/PATCH/DELETE /api/me/transport/places` | Saved places (search / pin / one-shot current location) | E5 |
| `POST /api/me/transport/trips/:id/confirm` (`clientEventId`, `{ kind: PICKUP\|DROP }`) | Passenger confirmation (dispute signal; driver authoritative, owner decision P5) | E5 |
| `POST /api/me/transport/trips/:id/reports` | Delay / missed pickup / concern | E5 |
| `POST /api/me/transport/sos` (Idempotency-Key) · `GET /sos/:id` | Durable SOS (§3.7) | E5 (durable), E6 (escalation) |
| `GET /api/me/transport/policy` · `GET /notifications` · `POST /data-requests` | Cut-offs and modes; inbox; DSR | E5 / E6 |

### 2.9 Driver API (`transport/driver-api`, `/api/driver/v1`)

All routes: `@RequirePermission('etms_driver', …)` + `DriverIdentityGuard`; trips not assigned → 404. Default window
`plannedStart ∈ [now − 12 h, now + 36 h]` (`09` §3).

| Method + path | Purpose | Phase |
|---|---|---|
| `GET /api/driver/v1/me` | Driver, company, bound vehicle, policies, document status | E5 |
| `GET /duty/current` · `POST /duty/start` (online only) · `POST /duty/end` | Duty; start may call `switchDriverTx` with new source `APP` (owner decision P5) | E5 |
| `GET /checklists/template` | Pre-trip checklist template (customer-defined) | E5 |
| `GET /trips?from&to` · `GET /trips/:id` | Published, assigned trips; manifest via `PassengerForDriverDto` | E5 |
| `POST /trips/:id/start` (online only) | All `09` §4.3 blocks; compare-and-set `SCHEDULED → IN_PROGRESS`; 200 `ALREADY_STARTED` if GPS started it | E5 |
| `POST /trips/:id/events` | Batch ≤ 50 events, per-event outcome (§3.8) | E5 |
| `POST /sos` (Idempotency-Key) | Fast path, ahead of the queue | E5 |
| `GET /sync?since=<cursor>` | Changed / revoked trips and event outcomes | E5 |
| `GET /trips/history` · `GET /me/documents` | Counts-only history; own `Document`s | E5 |

### 2.10 Safety (`transport/safety`)

| Method + path | Perm | Purpose | Phase |
|---|---|---|---|
| `GET /api/transport/incidents` (`?open=1` polled every 15 s when the socket is down, `07` §4.2) · `GET /:id` | `etms_incidents:view` | List / detail with last-known location snapshot | E5 |
| `POST /api/transport/incidents` (Idempotency-Key) | `etms_incidents:edit` | Dispatcher-raised incident | E5 |
| `POST /api/transport/incidents/:id/ack` · `/escalate` · `/resolve` | `etms_incidents:edit` / `command` | Ack (note required), escalate, resolve (outcome code); each writes `TransportIncidentEvent` + audit | E5 (ack), E6 |
| `GET /api/public/transport/incidents/:token` · `POST …/ack` | `@Public()`, signed expiring token | Escalation-contact view of one incident (LiveShare pattern) | E6 |
| `GET/POST /api/transport/policies`, `POST /:id/versions`, `POST /versions/:vid/publish` | `etms_policies:view/edit` | Versioned policies, immutable once published | E6 |
| `POST /api/transport/policies/evaluate` | `etms_dispatch:view` | Dry-run evaluation for a candidate assignment | E6 |
| `POST /api/transport/policy-overrides` | `etms_dispatch:command` (+ second approver when required) | WARN overrides; BLOCK only when the version marks the rule overridable | E6 |

### 2.11 Analytics

Existing `/api/reports` with new types in a "Employee transport" category (plan §14; `07` §3); KPIs on
`GET /api/transport/dashboard` (`etms_dashboard:view`). E7.

---

## 3. DTO sketches

```ts
// packages/shared/src/transport.ts (Proposed)
export type BookingStatus = 'REQUESTED' | 'PENDING_ASSIGNMENT' | 'ASSIGNED' | 'CONFIRMED'
  | 'REJECTED' | 'CANCELLED' | 'EXPIRED' | 'WAITLISTED' | 'FAILED';
export type Direction = 'IN' | 'OUT';                 // IN = to site (login), OUT = from site (logout)
export interface GeoPoint { lat: number; lng: number; label?: string; poiId?: string }

// 3.1 booking create (web on behalf, or passenger app from E5)
export interface CreateBookingDto {
  passengerId: string;                 // ignored on /api/me/transport (taken from the guard)
  serviceDate: string;                 // YYYY-MM-DD in site time zone
  direction: Direction;
  shiftId?: string;
  pickup: GeoPoint; drop: GeoPoint;    // home pickup stays on the booking, never a Poi
  windowStart?: string; windowEnd?: string;   // ISO; derived from shift when absent
  passengerCount?: number;             // default 1, policy-limited
  note?: string;
}
export interface BookingDto {
  id: string; version: number; status: BookingStatus; source: 'ADHOC' | 'SCHEDULE';
  passenger: PassengerRef; serviceDate: string; direction: Direction; timeZone: string;
  pickup: GeoPoint; drop: GeoPoint; windowStart: string; windowEnd: string;
  cutoffAt: string | null; tripId: string | null; customerCompanyId: string; providerCompanyId: string | null;
  allowedActions: ('edit' | 'cancel' | 'approve' | 'reject')[];   // computed server-side
}

// 3.2 projections chosen by passengerProjection(), never by controllers
export interface PassengerRef { id: string; displayName: string }          // "Asha K."
export interface PassengerForDriverDto { passengerTripId: string; displayName: string; stopSeq: number;
  pickupLabel: string; accessibility: boolean; status: PassengerStatus; phone?: string /* policy + window only */ }

// 3.3 ETA always with provenance (06 §3)
export interface EtaValue { at: string | null; model: EtaModel | null; degraded?: DegradedReason; staleSinceS?: number }

// 3.4 dispatch change set (E3)
export interface DispatchChangeSetDto {
  serviceDate: string; direction: Direction;
  changes: (
    | { op: 'CREATE_TRIP'; tempId: string; objectId: string; driverId?: string; plannedStart: string;
        stops: { seq: number; point: GeoPoint; plannedArrival: string; radiusM?: number }[] }
    | { op: 'ADD_PASSENGER'; tripId: string /* or tempId */; bookingId: string; pickupSeq: number; dropSeq: number }
    | { op: 'REMOVE_PASSENGER'; passengerTripId: string; reason: string }
    | { op: 'REORDER_STOPS'; tripId: string; seqs: number[] }
    | { op: 'REASSIGN_VEHICLE'; tripId: string; objectId: string }
    | { op: 'REASSIGN_DRIVER'; tripId: string; driverId: string | null }
  )[];
  expectedVersions: Record<string, number>;   // tripId → version
  reason?: string;
}
export interface ChangeSetResult { trips: { id: string; version: number }[]; bookings: { id: string; status: BookingStatus }[];
  warnings: PolicyReason[] }

// 3.5 passenger trip leg (E3)
export interface MeTripDto { id: string; serviceDate: string; direction: Direction; timeZone: string;
  window: { start: string; end: string }; derivedState: string; vehicle: { plate: string; model?: string; colour?: string };
  driverFirstName?: string; myStop: { seq: number; label: string; plannedAt: string; eta: EtaValue };
  coRiders: number; liveVisible: boolean; deskPhone?: string }

// 3.6 vehicle-in-window (E3)
export type MeVehicleDto = { visible: false; reason: 'OUTSIDE_WINDOW' | 'NO_FIX' }
  | { visible: true; lat: number; lng: number; heading?: number; fixAt: string; eta: EtaValue };

// 3.7 SOS (E5)
export interface CreateSosDto { tripId?: string; fix?: { lat: number; lng: number; accuracyM?: number; at: string };
  note?: string }                      // Idempotency-Key = clientIncidentId
export interface SosReceipt { incidentId: string; status: 'RECEIVED_BY_SERVER'; receivedAt: string;
  acknowledgement: { by: string; at: string } | null }

// 3.8 driver / passenger / dispatcher trip events (one command handler)
export type TripEventType = 'ACKNOWLEDGE' | 'CHECKLIST_SUBMIT' | 'ARRIVED' | 'BOARDED' | 'NO_SHOW' | 'DEPARTED'
  | 'DROPPED' | 'REPORT_DELAY' | 'REPORT_OBSTRUCTION' | 'REPORT_BREAKDOWN' | 'REPORT_INCIDENT'
  | 'REQUEST_ASSISTANCE' | 'COMPLETE_TRIP' | 'CORRECT_OUTCOME' | 'PASSENGER_CONFIRM';
export interface TripEventDto { clientEventId: string /* UUIDv7, made at tap time */; seq: number;
  type: TripEventType; occurredAt: string; clockOffsetMs?: number; stopSeq?: number; passengerTripId?: string;
  reasonCode?: string; pin?: string; etaMin?: number; note?: string; fix?: { lat: number; lng: number; accuracyM?: number } }
export interface TripEventBatchDto { tripId: string; events: TripEventDto[] }   // ≤ 50, FIFO
export interface TripEventOutcome { clientEventId: string;
  outcome: 'ACCEPTED' | 'DUPLICATE' | 'REJECTED' | 'LATE' | 'RETRY';
  code?: ErrorCode; serverTime: string; verified?: 'gps' | 'unverified_location' }
```

`START_TRIP`, `duty/start`, booking create / cancel and SOS are never part of an offline batch (`09` §4.4).

---

## 4. Error codes

| HTTP | `code` | Meaning |
|---|---|---|
| 400 | `VALIDATION_FAILED` | DTO validation (class-validator) |
| 401 | (existing) | token missing / expired |
| 403 | `FORBIDDEN_GRANT` | menu permission or agreement grant missing |
| 403 | `NOT_A_PASSENGER` · `DRIVER_INACTIVE` | relationship guard failed |
| 403 | `CONSENT_REQUIRED` | purpose needs a current consent |
| 404 | `NOT_FOUND` | also for other-tenant / unassigned ids |
| 404 | `ETMS_DISABLED` | flag or company feature off (body only in non-production logs; response is plain 404) |
| 409 | `VERSION_CONFLICT` | `expectedVersion` mismatch |
| 409 | `CAPACITY_EXCEEDED` · `VEHICLE_BUSY` · `DRIVER_BUSY` | publish checks |
| 409 | `BOOKING_DUPLICATE` | active booking exists for passenger + date + direction (partial unique index) |
| 409 | `AFTER_CUTOFF` · `INVALID_STATE` | state machine |
| 409 | `NOT_AT_STOP` · `UNRESOLVED_PASSENGERS` · `PASSENGERS_ON_BOARD` · `OUT_OF_ORDER` · `CONFLICT` · `TRIP_CLOSED` · `NOT_ASSIGNED` | trip events (`09` §4.4, §6.4) |
| 409 | `MANAGED_BY_ETMS` | manual edit of an `origin=ETMS` planned trip |
| 409 | `IDENTITY_IN_USE` | mobile / email already belongs to another User (D5) |
| 409 | `AGREEMENT_INACTIVE` | agreement suspended / ended / outside validity |
| 422 | `POLICY_BLOCKED` | safety policy BLOCK (reasons in body) (E6) |
| 422 | `IDEMPOTENCY_KEY_REUSED` | same key, different body |
| 422 | `OUTSIDE_COVERAGE` · `POINT_NOT_ON_ROAD` | routing locate result for pickup points |
| 429 | `RATE_LIMITED` · `OPTIMIZER_BUSY` | with `Retry-After` |
| 503 | `ROUTING_UNAVAILABLE` · `OPTIMIZER_UNAVAILABLE` · `STORE_UNAVAILABLE` | degraded; with `Retry-After` |

---

## 5. Event contracts

### 5.1 Transport layers (existing names kept)

| Purpose | Mechanism | Name | Status |
|---|---|---|---|
| Positions | Valkey stream | `vt:positions` | Existing (V) — ETMS reads nothing new from it; the tracker does |
| Planned-trip live updates | Pub/sub → socket `plannedTrip.update` | `vt:plannedtrips:updates` | Existing (V `RedisKeys.plannedTripUpdates`) — reused unchanged for ETMS trips |
| Alerts | Pub/sub `vt:alerts`, `vt:alerts:state`; stream `vt:notify` | — | Existing (V) |
| Notification jobs | Valkey stream, group `notifier` | `vt:notify` | Existing; new job kind `{ outboxId }` beside `{ alertId }` / `{ logIds }` |
| **Durable domain events** | PostgreSQL table | `OutboxEvent` | **New** (E1a) |
| ETMS realtime fan-out | Pub/sub → socket `transport.*` events | `vt:transport:updates` | **New** (`RedisKeys.transportUpdates`) |
| Optimiser jobs | Valkey stream + group (ported) | `vt:routing:jobs` | Ported (E4); `RoutingJob` row is source of truth |
| Agreement / policy cache invalidation | Pub/sub | `vt:cache:invalidate` | Existing (V `RedisKeys.cacheInvalidate`) |
| Webhooks | Stream | `vt:webhooks` | Existing; new event types in E8 |

No second broker (plan §11 "no second event infrastructure"): the outbox makes Valkey's at-most-once hop safe.

### 5.2 `OutboxEvent` table (Proposed, Agent 1 to finalise)

| Column | Type | Notes |
|---|---|---|
| `id` | UUID (v7, time-ordered) | = envelope `id` |
| `companyId` | UUID | room / owner for fan-out (operator or customer) |
| `customerCompanyId`, `providerCompanyId` | UUID? | scope for consumers |
| `type`, `schemaVersion` | text, int | e.g. `transport.booking.assigned`, 1 |
| `aggregateType`, `aggregateId`, `aggregateVersion` | text, UUID, int? | |
| `class` | enum `SAFETY` \| `OPERATIONAL` \| `INFO` | relay priority; SAFETY polled every 1 s and eligible for direct send |
| `payload` | JSONB | envelope `data`; ids, no free-text PII |
| `availableAt`, `attempts`, `lastError`, `publishedAt`, `deadAt` | | retry 1 s → 5 min, `DEAD` after N attempts + System Health CRITICAL for SAFETY |
| index | partial `(class, availableAt) WHERE publishedAt IS NULL AND deadAt IS NULL` | |
| retention | published rows trimmed after 7 days; SAFETY rows copied into `TransportIncidentEvent` before trimming | |

Writers insert the outbox row **in the same transaction** as the state change. The relay (notifier process, `SELECT …
FOR UPDATE SKIP LOCKED`, `10` §6.2) publishes and stamps `publishedAt`; consumers are idempotent on `id`.

E0.5 does not create this table: it fixes the existing alert path with `Alert.notifiedAt` + a sweeper and
`NotificationLog` retry columns (`12` §2). ETMS events use `OutboxEvent` from E1a.

### 5.3 Envelope (v1)

```ts
export interface TransportEvent<T = unknown> {
  v: 1;                                  // schema version of the envelope + type
  id: string;                            // UUIDv7, = OutboxEvent.id, dedupe key for consumers
  type: TransportEventType;              // dotted, past tense
  occurredAt: string;                    // business time (device time for app events, corrected)
  recordedAt: string;                    // server commit time
  companyId: string;                     // fan-out room
  customerCompanyId: string | null;
  providerCompanyId: string | null;
  aggregate: { type: 'booking' | 'trip' | 'plan' | 'incident' | 'schedule' | 'agreement'; id: string; version?: number };
  actor: { type: 'USER' | 'PASSENGER' | 'DRIVER' | 'DISPATCHER' | 'SYSTEM' | 'DEVICE'; userId?: string; driverId?: string };
  source: 'WEB' | 'PASSENGER_APP' | 'DRIVER_APP' | 'PROCESSOR' | 'SCHEDULER' | 'API' | 'OPTIMIZER';
  correlationId: string;                 // request id / change-set id / job id
  causationId?: string;                  // id of the event that caused this one
  idempotencyKey?: string;               // client key when one exists
  data: T;
}
```

Versioning: additive fields within `v`; consumers ignore unknown fields; a breaking change bumps `v`, producers write
both versions for one release; types and `v` live in `packages/shared/src/transport-events.ts` with a contract test
that freezes each type's JSON shape (golden file).

### 5.4 Event catalogue (plan §11 names → types)

| Plan name | `type` | Producer | Consumers | Class | Phase |
|---|---|---|---|---|---|
| BookingCreated | `transport.booking.created` | bookings, scheduler | socket, notify (ack to passenger) | INFO | E3 |
| — | `transport.booking.changed` / `.approved` / `.rejected` | bookings | socket, notify | INFO | E3 |
| BookingCancelled | `transport.booking.cancelled` | bookings | socket, notify, dispatch | OPERATIONAL | E3 |
| BookingAssigned | `transport.booking.assigned` | dispatch | socket, notify (passenger) | OPERATIONAL | E3 |
| ScheduleInstanceGenerated | `transport.schedule.generated` (one per run, counts) | scheduler | socket | INFO | E3 |
| RoutePublished | `transport.trip.published` / `.changed` / `.cancelled` | dispatch / route-plans | socket, notify (passengers, driver E5) | OPERATIONAL | E3 |
| OptimizationRequested / Completed | `transport.plan.optimize.requested` / `.completed` / `.failed` | route-plans / worker | socket (`transport.plan.changed`) | INFO | E4 |
| DriverAcknowledged | `transport.trip.acknowledged` | driver-api | socket, notify (dispatcher if late) | OPERATIONAL | E5 |
| TripStarted / TripCompleted | `transport.trip.started` / `.completed` / `.interrupted` | trips (driver / GPS reconciliation) | socket, notify (passengers), webhooks (E8) | OPERATIONAL | E3 (GPS-derived), E5 |
| PassengerPickedUp / DroppedOff | `transport.passenger.boarded` / `.dropped` / `.no_show` | trips | socket (`transport.trip.manifest`), notify | OPERATIONAL | E3 (dispatcher), E5 |
| VehicleDelayed | `transport.trip.delayed` | trips (driver report) + processor alert mirror | socket, notify | OPERATIONAL | E5 |
| SafetyPolicyBlocked | `transport.policy.blocked` / `.overridden` | dispatch | socket, audit | OPERATIONAL | E6 |
| IncidentCreated / SOSActivated | `transport.incident.created` (`kind: SOS \| BREAKDOWN \| …`) | safety | socket (`transport.sos`), notify, escalation | **SAFETY** | E5 |
| — | `transport.incident.acknowledged` / `.escalated` / `.resolved` | safety | socket, notify | SAFETY | E5 / E6 |
| — | `transport.agreement.changed` | accounts | cache invalidation | INFO | E1b |

Processor-side GPS facts stay on `vt:plannedtrips:updates` (no change to the tracker). ETMS reconciles them into
derived state when reading; a `transport.trip.started` event for GPS-started trips is produced by a small listener in
the API process on that channel and deduplicated by `(tripId, type)`.

### 5.5 Socket events (`/live` namespace, `live.gateway.ts` conventions)

| Event | Payload (small; clients refetch details) | Permission + scope | Phase |
|---|---|---|---|
| `plannedTrip.update` (existing) | `PlannedTripLiveUpdate` | `plannedTrips:view` + object scope (V) | reused |
| `transport.booking.update` | `{ id, status, tripId?, version }` | `etms_bookings:view` + transport scope | E3 |
| `transport.trip.manifest` | `{ tripId, version, stops:[{ seq, boarded, noShow, pending }], occupied, capacity }` (counts; names only via REST) | `etms_dispatch:view` + scope | E3 |
| `transport.plan.changed` | `{ planId \| tripId, version, byName }` | `etms_dispatch:view` / `route_plans:view` | E3 / E4 |
| `transport.sos` | `{ incidentId, kind, tripId?, vehicle?, raisedAt, status }` — emitted immediately, not batched | `etms_incidents:view` + scope | E5 |
| `routing:health` | `{ engine, reachable, optimiser:{ slots, busy } }` every 60 s or on change | `etms_dispatch:view` | E4 |

Rules: rooms assigned server-side (no client subscribe, V `live.gateway.ts`); socket closed on logout / session revoke
(R-14 fix in E0.5) before any ETMS event is added; pushes during a disconnect are lost by design, so every client
invalidates its caches on reconnect (V `use-planned-trips.ts`) and the SOS lane polls REST while disconnected.

Mobile: the passenger shell polls `GET /api/me/transport/trips/:id` and `/vehicle` every 10–15 s while the trip screen
is open (E3–E5); push (Expo, D7 / L4 approved 2026-11-11, `02` §8) carries `{ kind, tripId }` only: generic text, no names, addresses or
coordinates; details are fetched through the authenticated APIs above. The driver shell uses `GET /api/driver/v1/sync` plus
push; a driver-scoped room for the bound vehicle (`transport.driver.vehicle`) is an E5 option, not a requirement.

### 5.6 Notification jobs

| Job | Shape on `vt:notify` | Ledger |
|---|---|---|
| Alert (existing) | `{ alertId }` | `NotificationLog` (V) |
| Pre-rendered (existing) | `{ logIds }` via `NotifyQueueService.enqueueMessages` | `NotificationLog` (V) |
| ETMS event (new) | `{ outboxId }` → notifier renders templates per recipient, writes `NotificationLog` with new `purpose`, `refType`, `refId`, `dedupeKey = outboxId:recipient:channel`, `providerMessageId`, `attempts`, `nextAttemptAt` (`03` §3) | extended `NotificationLog`; statuses `QUEUED → SENT (provider accepted) → DELIVERED (receipt, E6)`, `FAILED`, `SKIPPED (not configured)`, `DEAD` |

---

## 6. Authorisation matrix (owner condition D)

Consistent with [10-security-safety-and-privacy.md](10-security-safety-and-privacy.md) §2.3 (Agent 6), reduced to the
roles in scope and mapped to the routes above. Scope legend from `10` §2.3: **OWN** own record; **ASSIGNED** trips
assigned to the caller; **SITE** caller's branches / sites; **COMPANY** caller's company; **AGR(g)** customers in an
active agreement granting *g*, limited to its sites; **PLAT** all companies with reason + audit; — none. Actions: V view,
C create, E edit, D delete / cancel, X export, A acknowledge / approve, O override. Phase in brackets when later than R1.

| Resource | System admin (Super Admin) | Corporate admin | Corporate dispatcher | Passenger | Driver [E5] | Provider admin [E1b] |
|---|---|---|---|---|---|---|
| Company feature `etms`, role templates | V/E PLAT | V | — | — | — | — |
| Service agreement | V/E PLAT (reason) | V/A/suspend COMPANY [E1b] | V COMPANY | — | — | V/C(draft)/A COMPANY |
| Employee transport profile (PII) | V PLAT (reason, `ACCESS` audit) | V/C/E/D/X COMPANY (FULL) | V/E SITE (home address masked) | V/E OWN | V ASSIGNED: first name, pickup point, trip window only | V AGR(`VIEW_PASSENGER_MINIMAL`), MINIMAL |
| Consent records | V PLAT (reason) | V COMPANY | — | V/C (grant / withdraw) OWN | — | — |
| Shift / recurring schedule | V PLAT | V/C/E/D COMPANY | V/C/E/D SITE | V OWN [E5: C/E/D exceptions OWN] | — | V AGR(`MANAGE_SCHEDULES`) |
| Booking | V PLAT | V/C/E/D/X COMPANY | V/C/E/D SITE | V OWN [E5: C/D OWN within policy] | — | V/X AGR(`VIEW_BOOKINGS`) |
| Dispatch change set / publish / trip progression | — (support only via audited company switch) | V/E/O COMPANY | V/E SITE (`etms_dispatch:command` to publish / progress) | — | — | V/E AGR(`MANAGE_DISPATCH`) |
| Transport trip + manifest | V PLAT | V/X COMPANY | V/E SITE (passenger outcomes) | V OWN leg only (vehicle, driver first name, own stop, co-rider count) | V/E(events) ASSIGNED | V/C/E AGR(`MANAGE_DISPATCH`) |
| Vehicle live position | V PLAT | V own fleet; trips carrying its employees, trip window | same, SITE | V own trip's vehicle, window only (`MeVehicleDto`) | V own bound vehicle | V own fleet |
| Passenger phone location | — | — (none collected in R1) | — | own device only | — | — |
| Incident / SOS [E5] | V PLAT (reason) | V/A/E/close COMPANY | V/A/E SITE | C (raise), V OWN | C (raise), V OWN | V/A AGR(`RECEIVE_INCIDENTS` / `MANAGE_INCIDENTS`) |
| Safety policy [E6] | V PLAT | V/C/E/publish COMPANY | V COMPANY | — | — | V AGR(any) |
| Reports | V PLAT | V/X COMPANY | V SITE | V own history | V own duty summary | V/X AGR(`VIEW_REPORTS`), aggregated, no home addresses |
| Audit / sensitive-access log | V PLAT | V COMPANY (incl. Super Admin and provider access to its data) | — | V own access log (DSR, E6) | — | V COMPANY |

### 6.1 Enforcement checks per request

| Check | Applies to | Mechanism | Failure |
|---|---|---|---|
| Cross-company isolation | every ETMS route | `transportReadScope` / `transportWriteScope` (`02` §4.2); `ctx.companyId` never switched for non-Super-Admin users (V `AuthContextService.forUser`) | 404 `NOT_FOUND` |
| Agreement-scoped provider access [E1b] | provider roles | `ctx.agreements` with grant + site + validity checked per request | 404 / 409 `AGREEMENT_INACTIVE` |
| Menu permission | every route | `@RequirePermission` (V `PermissionGuard`); CI completeness guard | 403 `FORBIDDEN_GRANT` |
| Booking ownership | `/api/me/transport/*` | `MeTransportGuard`: `booking.profileId = me.profileId` | 404 |
| Trip assignment | `/api/driver/v1/*` [E5]; passenger trip routes | driver: `trip.driverId = me.driverId` inside the window; passenger: a non-cancelled `TransportTripPassenger` for the caller's profile | 404 |
| Live-location window | `/me/transport/trips/:id/vehicle`, driver manifest | server-computed window (dispatch → drop + grace) | `{ visible:false }` |
| SOS access [E5] | incidents | raise: authenticated passenger / driver (own trip or none); view / ack: incident scope (customer + operator + escalation link); ETMS SOS never disableable while a trip is active (`10` §6.4) | 404 |
| Audit logging | sensitive reads and every write | `AuditService.record` + `AuditAction.ACCESS` for home address, phone reveal, live location, manifest; SOS acks audited (E0.5); Super Admin reads of passenger PII need a reason header (unresolved owner decision) | — |

**Differences from `10` §2.3:** the provider dispatcher, escalation contact and corporate-manager columns are omitted
(not in R1 scope; they follow `10` §2.3 unchanged in their phase). Corporate dispatcher "dispatch / publish /
progression" in R1 corresponds to Agent 6's corporate-managed `+C/E` on transport trips.
