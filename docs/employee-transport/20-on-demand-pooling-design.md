# 20 On-demand ride pooling and live dispatch: Phase A design

Status: **design ready for owner review** (2026-11-15). Inspection and design only. There is no implementation, no
migration and no production change. It builds on the E4 redesign in progress
([doc 18](18-e4-dynamic-grouping-assessment.md), branch `feature/e4-dynamic-routing`, WP-A / WP-B / WP-S / WP-W). The
solver evidence is in [`evidence/2026-11-15-pooling/`](evidence/2026-11-15-pooling/).

Abbreviations: `S` = `apps/api/prisma/schema.prisma`, `D` = `apps/api/src/etms/dispatch`, `SH` = `packages/shared/src`.

---

## 1. Current state and gaps

### 1.1 What exists (reuse)

| Area | Today | Reference |
|---|---|---|
| Booking | `TransportBooking`: customer/provider, profile, `journey` COMMUTE \| POINT_TO_POINT, pickup/drop lat/lng (+ `poiId` for company places), window, `passengerCount` 1–6, `groupId`, status machine, idempotency key + hash, cut-off + `lateReason` | S:3316-3385, SH/transport-trips.ts:1094, `D/booking-rules.ts` |
| Booking creation | Desk + self-service (ad-hoc COMMUTE / P2P, HOME / SAVED / company / one-time map point); consent required for personal ends; per-passenger advisory lock; P2P overlap EXCLUDE | `D/bookings.service.ts:306-490`, `self-service/self-service.service.ts:278-386`, migration `20261121090000…:23` |
| Trip | `PlannedTrip` is the only status holder (SCHEDULED → STARTED → IN_PROGRESS → COMPLETED / INCOMPLETE / CANCELLED). `TransportTrip` is a 1:1 business header. `TransportTripPassenger` has its own pickup **and** drop stop per seat (`pickupSeq < dropSeq`). `TransportTripEvent` is append-only | S:2829, S:3390, S:3450, S:3490 |
| Multi-destination trips | Structurally supported (per-seat stops; door-to-door CREATE_TRIP, ADD_STOP), but only by hand | `D/change-ops.ts:40-107` |
| Vehicle reuse | Back-to-back trips allowed. Overlap is blocked by `assertFree` + DB EXCLUDE per vehicle/driver (half-open [plannedStart, plannedEnd)) | `dispatch.service.ts:1209-1218`, migration `20261116090100…:60,65` |
| Publish pipeline | Change set → `DispatchService.apply`: advisory locks per vehicle/driver, bookings + trips FOR UPDATE, version CAS, consent read inside the transaction, ledger `TransportChangeSet`, audits, route after commit | `dispatch.service.ts:798-1116` |
| E4 planning | RoutePlan / RouteAssignment / RoutePlanStop / RoutePlanVersion. The optimiser (OR-Tools CVRPTW, trip mode = one site, one direction) publishes through the **same** `apply` via the `PublishSource` hook | doc 18 §2; `plans.service.ts:480-589` |
| Driver app | Ordered stops, BOARDED / NO_SHOW / DROPPED (driver-recorded, never GPS-inferred), OTP, offline event queue, REPORT_DELAY / BREAKDOWN | `etms/driver/*`, `apps/mobile/src/features/transport/driver/*` |
| Live position | Valkey `vt:live:<objectId>`; socket fan-out `vt:plannedtrips:updates` | `redis/keys.ts:5`, `D/trip-live.ts:24` |
| Notifications | In-app row + generic push (ids only), authenticated fetch; relay with lock + high-water mark | `transport-notifications.service.ts`, `transport-notify-relay.service.ts:33` |
| Geocoding / routing | Photon + GraphHopper, both self-hosted and enforced private (`privateGeocoderProblem`) | `geocoding/geocoding.service.ts:12` |

### 1.2 Gaps against the brief

| Brief § | Requirement | Gap |
|---|---|---|
| 1.1, 3 | SHARED / PRIVATE / FLEXIBLE, accepted policy, per-booking limits | No preference field, no policy acceptance, no per-booking max wait / detour / ride (only the company `maxRideS`, used by E4 only) |
| 2.1 | Exclude bookings from a run without cancelling | No persistent hold flag (`REMOVE_PASSENGER` only returns the booking to PENDING_ASSIGNMENT) |
| 2.1, 4 | Dynamic pooling for P2P | E4 skips POINT_TO_POINT (`plan-booking-scope.ts:47`). The solver's trip mode needs one shared site. Web auto-allocate batches by office end. **P2P is stored as direction IN** (`bookings.service.ts:331`) |
| 4.1 | Pickup-before-drop, different destinations | Data model yes; **optimiser no** (no pickup-and-delivery mode) |
| 5, 5.1 | Vehicle timeline, multi-trip, turnaround, driver hours | No turnaround or deadhead buffer, no operating windows. `maintenanceSince` is ignored. `TransportDriverDuty` records start/end only; no working-hours or break model |
| 2.2, 8 | Live insertion, re-optimisation | No insertion scoring (candidates are ranked by straight line, road ETA for the top 5 only). **Trips cannot change after start** (`editable()` = SCHEDULED only, `dispatch.service.ts:863-865`) |
| 5.2, 8 | Reassignment on delay / breakdown | REPORT_DELAY / BREAKDOWN are notification overlays only. `interruptedAt` is never written. No transfer of boarded passengers |
| 9 | Compare plans, map editing, review and publish selected | Being built in E4 (WP-A alternatives + metrics, WP-B review/selected publish/undo, WP-W workspace) |
| 13 | Health / observability | No health check for the booking generator or auto-start. No dispatch job status |
| 10 | Passenger sees sharing policy, estimated pickup | `RequestRideScreen` has COMMUTE/P2P only; pickup ETA is shown only when the pickup is the next stop |

## 2. How it builds on E4

| E4 piece (in progress) | Reused for pooling |
|---|---|
| WP-S solver: rideTime cost, soft detour guard, `FLEET_TOO_SMALL` classifier | Same service and process, new mode `pdp` (§4). Strategy weights and the reason classifier are extended |
| WP-A strategies, preferences, vehicle availability windows, alternatives, compare metrics | Same strategy catalogue extended with pooling strategies (§4.6); the same alternatives endpoint makes sibling plans; the same metric definitions plus wait/detour/shared share |
| WP-B restore (undo/redo), recalculate, add/remove booking, pin passenger, availability pre-check, `GET review` + `reviewHash`, selected-routes publish | Unchanged API. A P2P plan is a RoutePlan with `scope = AREA` (§3.5); its routes split into several trips per vehicle at publish (§3.6) |
| WP-W web workspace (map, cards, drag-drop, review screen) | Same workspace; adds pickup/drop marker distinction and a per-vehicle timeline (trips in sequence) |
| E3 `DispatchService.apply` | **The only publish path**: batch publish = change set of CREATE_TRIP + ADD_PASSENGER; live decisions = the same change ops. No second trip-writing mechanism |

## 3. Domain model (additive; no new trip status model)

### 3.1 Booking ride preference and accepted limits (`TransportBooking`)

| Column | Type | Rule |
|---|---|---|
| `ridePreference` | enum `RidePreference` SHARED \| PRIVATE \| FLEXIBLE, default **FLEXIBLE** for new rows (see §8 backfill) | PRIVATE is never pooled; a FLEXIBLE booking may be served either way |
| `sharingPolicyId` / `sharingPolicyVersion` | FK `TransportSharingPolicy` + int | The policy the passenger (or desk) accepted. Required for SHARED / FLEXIBLE |
| `limits` | Json `{maxWaitS, maxDetour: {ratio, extraS}, maxRideS, arriveByS?}` | **Snapshot taken at acceptance, immutable.** Later optimisation reads it as hard constraints; a DB trigger refuses updates while status is active (same evidence-guard pattern as consent) |
| `requestedPickupAt` / `pickupWindowS` | timestamptz / int | P2P: the pickup window. COMMUTE keeps the existing `windowStart/End` (site window) |
| `holdFromPlanning` | bool default false + `holdReason`, `holdById`, `holdAt` | Dispatcher "exclude from runs" without cancelling. Audited; visible in every plan as `excluded: on_hold` |
| `assignedService` | enum SHARED \| PRIVATE, null until assigned | Records how a FLEXIBLE booking was actually served (for pricing, doc 19) |

New table **`TransportSharingPolicy`** (company, version, effective from, text key, defaults `{maxWaitS, maxDetour, maxRideS}`
per service, `allowFlexible`, status). Passengers accept a version; a new version does not change accepted bookings.

**PRIVATE semantics (owner decision P1, recommended):** whole-trip exclusivity. The vehicle carries nobody else from the
private passenger's pickup to their drop. The vehicle may serve others before and after, on separate trips.

### 3.2 Direction fix for POINT_TO_POINT

`direction` becomes nullable for `journey = POINT_TO_POINT` (today it is forced to IN, `bookings.service.ts:331`). The
partial unique / EXCLUDE constraints stay. The COMMUTE unique index already filters on journey. Reports that group by
direction treat null as "P2P".

### 3.3 Vehicle availability timeline

| Model | Fields | Source |
|---|---|---|
| `TransportVehicleAvailability` (new) | objectId, companyId, `kind` OPERATING \| DOWNTIME \| RESERVED, `startsAt`, `endsAt`, reason, createdBy | Operating windows per day (recurring rule expanded to rows by the generator), dispatcher downtime |
| derived | `TrackedObject.maintenanceSince` → DOWNTIME open-ended | existing column |
| `TransportVehicleProfile` (+cols) | `turnaroundS` (default 120), `serviceAreaIds[]` | new |
| existing | active PlannedTrips = BUSY intervals | `assertFree` |

### 3.4 Driver working hours and breaks

| Model | Fields |
|---|---|
| `TransportDriverPolicy` (company or driver override) | `maxDutyS`, `maxDrivingS`, `breakAfterS`, `breakS`, `minRestS` |
| `TransportDriverDuty` (existing) | + planned shift `plannedStart/End` |
| derived | driving time from PlannedTrip actuals |

Assignment checks (batch and live) refuse a plan that breaks the policy (`DRIVER_HOURS`). The solver gets `maxSpanS` +
`breaks` per vehicle (§4).

### 3.5 Plan scope for P2P

`RoutePlan` gains `scope` (`SITE` = today, `AREA`), `serviceAreaId?`, `windowStart/windowEnd` (operating window).
Booking selection for AREA = P2P + COMMUTE bookings in the window and area, not on hold, eligible (consent, location),
by branch scope. Site/shift fields stay for SITE plans.

### 3.6 Plan → several trips per vehicle

`RouteAssignment` = one vehicle across the plan window. New `RoutePlanStop.tripIndex` (int) = trip boundary, where the
solver's load returns to 0. At publish each `(assignment, tripIndex)` becomes one CREATE_TRIP with its own
plannedStart/End. Back-to-back trips pass `assertFree` because the windows don't overlap and the turnaround is in the
schedule. `TransportTrip.routeAssignmentId` unique becomes unique on `(routeAssignmentId, tripIndex)` (additive column
`routeTripIndex`).

### 3.7 Live dispatch log and change history

| Model | Purpose |
|---|---|
| `TransportDispatchRequest` (new) | One per live request decision: bookingId, trigger (NEW_BOOKING, CANCEL, DELAY, BREAKDOWN, MANUAL), status QUEUED / DECIDED / APPLIED / REJECTED / FAILED, idempotency key, chosen option, alternatives considered (ids + costs), reason codes, `changeSetId`, timings |
| `TransportTripEvent` kinds (+) | `PASSENGER_INSERTED`, `STOP_RESEQUENCED`, `PASSENGER_TRANSFERRED`, `TRIP_INTERRUPTED`, `ASSIGNMENT_REOPTIMISED`. Same append-only table; each carries actor (user / SYSTEM_DISPATCH), reason, before/after stop sequence ids |
| `AuditLog` | Material changes as today (`AuditService.record(…, tx)`) |

## 4. Solver contract v3: `mode: "pdp"`

### 4.1 Shape (from the prototype, `evidence/…/pdp_proto.py`)

```json
{"schemaVersion":3,"mode":"pdp","matrix":{"durationsS":[[...]],"distancesM":[[...]]},"horizonS":86400,
 "vehicles":[{"id":"v1","startIndex":0,"availableFromS":25200,"shiftEndS":43200,"maxSpanS":18000,
   "capacity":7,"wheelchairSpaces":0,"type":"MUV","turnaroundS":120,
   "breaks":[{"earliestS":32400,"latestS":37800,"durationS":1800}],
   "onboard":[{"requestId":"r9","dropIndex":14,"dropByS":30500}]}],
 "requests":[{"id":"r1","pickupIndex":3,"dropIndex":7,"passengers":1,"preference":"SHARED",
   "pickupWindow":[27000,27900],"arriveByS":null,"maxRideS":2700,"detour":{"ratio":1.8,"extraS":900},
   "priority":1,"wheelchair":0,"allowedVehicleIds":null,
   "committed":{"vehicleId":"v2","pickupWindow":[27300,27900]}}],
 "options":{"strategy":"BALANCED","weights":{"vehicle":3600,"time":1,"distance":0,"wait":1,"rideTime":1},
   "timeLimitS":10,"warmStart":{"v1":["P:r1","D:r1"]},"insertOnly":false}}
```

**Output:** per vehicle, `trips[]` (split where the load returns to 0). Per stop: arrival, start, load, onboard
request ids, and the request's wait / ride / detour and `servedAs` (SHARED \| PRIVATE). Also `unserved[]` with
reason codes, and `commitmentViolations[]`, which must be empty or the job fails (never written).

### 4.2 Modelling decisions

| Topic | Decision |
|---|---|
| Pairs | `AddPickupAndDelivery` + same vehicle + pickup cumul ≤ drop cumul + both stops active or both dropped |
| Max wait | Pickup window = `[requested, requested + maxWaitS]` (hard) |
| Max ride / detour | Hard: `drop − (pickup + service) ≤ min(maxRideS, max(direct×ratio, direct+extraS))` from the booking snapshot. Soft `rideTime` / detour costs from WP-S for comfort strategies |
| Seats | Load dimension (+n pickup, −n drop); start load = onboard passengers |
| **PRIVATE (whole trip)** | Trip-boundary model. A "depot-return" pseudo-node per trip slot: each vehicle route is a sequence of trip slots and the load must be 0 at slot boundaries. A PRIVATE request owns its slot: an `Exclusive` dimension where a private pickup adds capacity C and its drop releases C; together with the trip-index dimension (a cumul that increments at each slot boundary and must be equal at pickup and drop of every request), no other request's pickup can share the private's slot. The prototype implemented on-board exclusivity only (capacity-1000 trick); the slot model is WP-P2's first task, with a checker test |
| Turnaround | Exact: a slot boundary adds `turnaroundS` transit (the prototype approximated it with pickup service time) |
| FLEXIBLE | Solved as SHARED-eligible; labelled PRIVATE if alone on its trip. Pricing uses `assignedService` |
| **Priority / fairness** | The prototype dropped **all 9 private requests**: they consume a whole vehicle for the same drop penalty. Rule: drop penalty × `priority` (default PRIVATE = 3, FLEXIBLE = 1.5, SHARED = 1, configurable per company / service), plus a waiting-time escalation (a request unserved in earlier runs gains priority). Committed requests ×1000 and must never be dropped |
| Driver | `maxSpanS` (span bound) + `SetBreakIntervalsOfVehicle`. A checker must verify break placement (not verified in the prototype) |
| Start | Current position (GPS index) + `availableFromS` = max(now, current trip's last drop ETA + turnaround) |
| Live | Warm start from current routes (`ReadAssignmentFromRoutes` → `SolveFromAssignmentWithParameters`); a cold start with tight committed windows found no first solution. `insertOnly: true` = cheapest feasible insertion only (no re-sequencing of committed stops) |
| Unserved codes | `PICKUP_WINDOW`, `VEHICLE_TIME`, `MAX_RIDE`, `CAPACITY`, `PRIVATE_NEEDS_EMPTY_VEHICLE`, `DRIVER_HOURS`, `NO_COMPATIBLE_VEHICLE`, `NOT_SELECTED` (search limit; same rule as WP-S `TIME_LIMIT`) |

### 4.3 Prototype results (SYNTHETIC city: 20×20 km, straight line ×1.35 at 25 km/h + 30 s per leg; not a road network)

| Case | Result |
|---|---|
| Acceptance case 1: 2 × 7-seaters, 50 requests over 4 h (30 shared / 9 private / 11 flexible) | 12 served; v1 made 4 trips and v2 made 6; avg wait 3.5 min (max 11.6), avg ride 27.5 (max 60.8), 183 km, 25 % of served riders shared, **0 violations** (independent checker). 2 vans cannot carry 50 random P2P requests in 4 h; unserved reasons: 19 window + vehicle time, 15 window, 4 max ride. **All 9 private unserved** (see priority rule) |
| Same requests, 5 vans | 27 served in 22 trips, avg wait 3.2, avg ride 29.6, 37 % shared, 0 violations, no private with a co-rider |
| Incompatible directions (3 NE + 3 SW, same area/time, 2 vans) | One van per direction; no mixed trip |
| Strategies (5 vans) | Balanced 27 served / 427 km / wait 3.2; Max utilisation 25 / 372 km / 56 % shared; Shortest distance 28 / 420 km / max ride 93; Fastest pickup wait **2.7**; Comfort max ride **58** |
| Live insertion at t = 2 h (18 committed, 2 onboard) | New shared request inserted; no committed passenger moved; 0 violations. Re-solve 5 s; **cheapest insertion 3.5 ms**, same vehicle |
| Scale: 200 requests × 10 vehicles | Build 0.2 s; 10 s guided search: 63 served, 32 trips; peak memory 132 MB |

**Limitations:** on-board exclusivity only, approximate turnaround, breaks unchecked, heuristic reasons, synthetic matrix,
pickup windows ±5 min hard in live mode (production takes them from the booking's stored commitment).

### 4.4 Strategies (pooling)

| Strategy | Weights (start values; tune on staging with real matrices) |
|---|---|
| Balanced pooling | vehicle 3600, time 1, wait 1, rideTime 1 |
| Maximum utilisation | vehicle 20000, time 1 |
| Shortest fleet distance | vehicle 2000, distance 1 |
| Fastest passenger pickup | vehicle 1800, time 1, wait 3 |
| Passenger comfort | vehicle 1800, time 1, rideTime 2 + detour guard |
| Minimum vehicles | vehicle 50000, time 1 |

Preferences (occupancy, max wait, max detour, max ride, max stops per trip, vehicle class, group-together, pins/locks) are
objectives or **tightenings** only. They can never exceed a booking's accepted limits or the company policy (WP-A rule).

## 5. Live dispatch architecture

### 5.1 Flow

```
booking created / cancelled / REPORT_DELAY / REPORT_BREAKDOWN / dispatcher action
  → TransportDispatchRequest (idempotency key, QUEUED) + XADD vt:etms:dispatch (generic ids only)
  → DispatchWorker (api process; consumer group; per-company Valkey lock; kill switch ETMS_LIVE_DISPATCH=off)
      1. snapshot: candidate vehicles (area, capability, availability timeline, driver hours, live position)
      2. fast path: cheapest feasible insertion (pdp insertOnly, ms) over SCHEDULED + eligible active trips + idle vehicles
      3. decide per policy (auto-assign / propose to dispatcher); record alternatives + reasons
      4. apply through DispatchService.apply as a change set (ADD_PASSENGER / ADD_STOP / CREATE_TRIP), same locks,
         version CAS and consent read; status APPLIED, or REJECTED with a reason (booking stays visible as unassigned)
      5. notify after commit (generic push; details by authenticated fetch)
  → async re-optimisation every N min / on demand: pdp warm start over unpublished + published-not-started work,
     committed requests pinned; result = proposal (dispatcher) or auto-apply within policy
```

### 5.2 Commitment protection per trip state

| State | What may change automatically | Rule |
|---|---|---|
| Unpublished (plan / draft) | Anything | Free re-optimisation |
| Published, not started (SCHEDULED) | Insert passengers, re-sequence pending stops, reassign vehicle | Every committed passenger keeps their committed pickup window and accepted limits (the solver enforces them as hard; the apply step re-checks). Change notification to the affected people |
| Active (STARTED / IN_PROGRESS) | Insert a pickup + drop **after** the current position; re-sequence **pending** stops only | **New, controlled extension of `editable()`**: allowed ops ADD_PASSENGER/ADD_STOP/REMOVE_PASSENGER (pending only) when a re-simulation from the live position keeps every onboard drop within its `dropBy` and every pending pickup within its committed window. Visited stops are immutable. Driver app receives a `ROUTE_UPDATED` event and must acknowledge it |
| Completed / incomplete / cancelled | Nothing | Immutable |

### 5.3 Reassignment on delay or breakdown

| Trigger | Action |
|---|---|
| REPORT_DELAY or tracker `delaySec` > threshold | Evaluation job: re-simulate the trip from the live position; if a commitment breaks, look for an insertion of the affected *pending* passengers into other vehicles. Policy per company: `PROPOSE` (dispatcher confirms) or `AUTO` (within limits) |
| REPORT_BREAKDOWN | Write `TransportTrip.interruptedAt` + `TRIP_INTERRUPTED` event; pending passengers → re-dispatch (as above); **onboard passengers → dispatcher incident** (pickup at the current location by another vehicle is proposed, never auto-applied) |
| Vehicle downtime added | Future assignments of that vehicle are evaluated the same way |

Passenger cancellation: seat released in the same transaction (today); pending stops removed. The re-optimisation may
shorten the trip; nobody else's commitment may be worsened.

### 5.4 Reliability

- **Idempotency:** a key per dispatch request and per change set (existing ledger).
- **Concurrency:** one decision per company at a time, plus the advisory locks per vehicle/driver in `apply`. Duplicate
  booking assignment is prevented by bookings FOR UPDATE + the status check.
- **Recovery:** QUEUED requests are re-read on start (pending entries claimed via XAUTOCLAIM).
- **Notifications:** failures never roll back an assignment. "Assigned" is reported only after the commit.
- **Health:** checks `pipeline.etms-dispatch` (lag, failures), `pipeline.etms-booking-generator`, `pipeline.etms-autostart`,
  plus job status in System Health.

## 6. API contracts (additions)

| Endpoint | Change |
|---|---|
| `GET /me/transport/sharing-policy` | Current policy version + defaults + limits per service |
| `POST /me/transport/requests`, desk `POST /transport/bookings` | + `ridePreference`, `acceptedPolicyVersion` (required for SHARED/FLEXIBLE), optional tighter `limits`. The server snapshots the limits; the response returns the snapshot and an `estimate` (pickup window) when available |
| `PATCH /transport/bookings/:id/hold` | `{hold, reason}`; `etms_dispatch:edit`; audited |
| `POST /transport/route-plans` | + `scope: AREA`, `serviceAreaId`, `windowStart/End`; P2P bookings accepted |
| `POST /transport/dispatch/live/decide` | Dispatcher "find a vehicle" for a booking: returns ranked feasible options (insertion cost, ETA, affected passengers); `apply: true` executes the chosen option via a change set |
| `GET /transport/dispatch/live/requests` | Live decision log (filters, reasons) |
| `PUT /transport/vehicles/:id/availability` | Operating windows / downtime |
| `PUT /transport/driver-policy` | Working-hour policy |
| Driver `GET /driver/v1/trips/:id` | + `routeVersion`. New event `ROUTE_ACK`; `ROUTE_UPDATED` push (generic) |
| Passenger `GET /me/transport/trips/:id` | + estimated pickup (always, not only when next), `servedAs` |

All new routes go into the isolation matrix (company, branch, role, ownership).

## 7. UI / UX

| Surface | Change |
|---|---|
| Dispatcher batch (E4 workspace, WP-W) | Plan scope AREA + window; P2P bookings; pickup ▲ / drop ▼ markers; per-vehicle **timeline** of sequential trips; wait / detour / shared columns; hold toggle on bookings |
| Dispatcher live board (E3 Daily transport) | Incoming requests lane, decision status, "Find vehicle" (ranked options with impact), proposals to confirm (delay/breakdown), live map with vehicles and trip progress |
| Passenger app (`RequestRideScreen`) | Shared / Private / Flexible selector with the policy text and limits; acceptance checkbox stored with the version; shows the estimated pickup window and "shared ride" / "private ride" once assigned |
| Driver app (`DriverTripScreen`) | Route-updated banner + acknowledge; inserted stops highlighted; trips listed in sequence for the duty |

## 8. Migration impact (all additive)

| Change | Backfill |
|---|---|
| `TransportBooking.ridePreference` | Existing COMMUTE bookings → **SHARED** (they are pooled today). Existing P2P → **PRIVATE** (dispatched alone today; avoids silently pooling someone who never accepted sharing). Owner decision P3 |
| `limits` Json | null for existing rows → the solver applies the company policy (as today) |
| `holdFromPlanning` | false |
| `direction` nullable for P2P | Existing P2P rows keep IN (history); new ones null |
| New tables | Policy, vehicle availability, driver policy, dispatch request: empty |
| `RoutePlan.scope` | `SITE` |
| `RoutePlanStop.tripIndex`, `TransportTrip.routeTripIndex` | 0 |
| Event kinds | Enum extension |

No data rewrite, no status change. Rollback = feature flag off; the columns stay.

## 9. Test plan (risk-based, per the testing policy)

| # | Acceptance criterion | Level |
|---|---|---|
| 1 | 50 requests, 2 vehicles, groups + sequential trips | Solver pytest (synthetic) + one db-test publish of a 2-vehicle multi-trip plan |
| 2 | Different pickups/drops pooled | Solver pytest |
| 3 | Incompatible directions separated | Solver pytest |
| 4 | Private exclusive (whole trip) | Solver pytest + independent checker; apply-time re-check unit test |
| 5 | Flexible either way | Solver pytest (`servedAs`) |
| 6 | Automatic shared within accepted limits | Unit (limits snapshot immutable, trigger) + solver |
| 7 | Precedence | Checker in every solver test |
| 8 | Capacity never exceeded | Checker + existing DB CHECK `occupiedSeats ≤ seatCapacity` |
| 9 | Next trip only after previous + repositioning | Solver pytest (turnaround) + db-test (`assertFree`) |
| 10 | Live insertion keeps commitments | Unit (insertion + re-simulation) + one db-test through `apply` |
| 11 | Delay triggers evaluation | Unit (evaluation job decision) |
| 12 | Cancellation updates the plan safely | db-test |
| 13 | Manual changes audited, confirmation invalidated | Covered by E4 WP-B tests (reviewHash) + one db-test for live board edits |
| 14 | Infeasible request gets a reason, stays visible | Unit + db-test |
| 15 | Isolation across bookings, dispatch, trips, mobile | Isolation matrix entries (existing harness) |
| 16 | E2E booking → pickup → drop → completion | Existing `etms-e2e` / e5-sim harness, one scenario per mode (batch, live) |
| 17 | Batch and live share the same records | db-test: live insert into a batch-published trip |

Not planned: load or soak tests (the scale is known from the prototype). Benchmarks on staging stay under the E4 gates (B1–B6).

## 10. Phased plan (parallel workstreams)

| WS | Phase | Scope | Owns (files) | Depends on |
|---|---|---|---|---|
| **P-B1** booking foundation | B | Preference, policy + acceptance, limits snapshot + trigger, hold flag, P2P direction fix, API + self-service + desk | `etms/dispatch/bookings*`, `self-service/*`, schema (bookings, policy), shared transport-trips | – |
| **P-B2** solver pdp | B | Contract v3, slot model (whole-trip private), turnaround, priority rules, breaks checker, insertion fast path, reasons, pytest + checker | `services/routing-optimizer` (new `pdp.py`) | WP-S merged |
| **P-C1** availability + driver hours | C | Vehicle availability timeline, maintenance downtime, driver policy, checks in `apply` and in the solver input | `etms/dispatch/availability*`, schema | P-B1 |
| **P-C2** AREA plans | C | RoutePlan scope AREA, P2P selection, pdp mapping, trip split at publish (`tripIndex`), metrics (wait/detour/shared) | `routing-jobs/*`, `etms/planning/*` | E4 WP-A/B merged, P-B2 |
| **P-C3** web batch | C | Workspace additions (markers, timeline, hold) | `apps/web/src/features/transport/planning/*` | E4 WP-W, P-C2 |
| **P-D1** live dispatch | D | Dispatch request log, worker, fast insertion, decide endpoint, controlled active-trip edits, delay/breakdown evaluation, health checks | `etms/dispatch/live/*`, `dispatch.service.ts` (`editable()` extension) | P-B2, P-C1 |
| **P-D2** live board web | D | Requests lane, decisions, proposals | `apps/web/src/features/transport/dispatch/*` | P-D1 |
| **P-E1** mobile | E | Passenger preference + policy acceptance + estimates; driver route updates + ack | `apps/mobile/src/features/transport/*` | P-B1, P-D1 |
| **P-E2** QA + security/privacy | E (and per WS) | Independent review per WS; isolation matrix; consent; E2E per mode | – | each WS |

**Gates:** the E4 activation gates still apply (three switches, readiness, Python 3.14, C3 staging, B1–B6, R-5).
- No external routing or geocoding; GraphHopper and Photon stay self-hosted.
- Live dispatch gets its own company switch (`etms.liveDispatch`, default off) and an env kill switch.
- Mobile store builds need EAS (O12).
- No deployment without approval.

### Owner decisions needed

| # | Decision | Recommendation |
|---|---|---|
| P1 | PRIVATE exclusivity: whole trip vs while on board | Whole trip |
| P2 | Default sharing limits (max wait / detour / ride) per service | 15 min / max(1.8×, +15 min) / company max ride |
| P3 | Backfill of existing bookings | COMMUTE → SHARED, P2P → PRIVATE |
| P4 | Live auto-assign vs propose for SCHEDULED and ACTIVE trips | Auto for unpublished + SCHEDULED within limits; propose for ACTIVE |
| P5 | Active-trip edits allowed at all (`editable()` extension) | Yes, pending stops only, with driver acknowledgement |
| P6 | Priority weights PRIVATE / FLEXIBLE / SHARED | 3 / 1.5 / 1 |
| P7 | Driver working-hour defaults | Company policy (none assumed) |
| P8 | Onboard transfer on breakdown | Dispatcher-only (never automatic) |

---

## 11. Implementation notes: backend B–D (branch `feature/etms-pool-be`, 2026-11-15)

Owner approved P1–P8 as recommended. Migration `20261129090000_etms_pooling_core`. Shared contracts:
`packages/shared/src/transport-pooling.ts` (+ additive fields in `transport-trips.ts`, `routing.ts`, `transport-driver.ts`,
`transport-adhoc.ts`). Code: `apps/api/src/etms/pooling/*`, `routing-jobs/{pdp-contract,pdp-problem,area-runner}.ts`,
`planning/plan-trip-split.ts`, hooks in `DispatchService.apply`, bookings, plans, self-service, driver, health.

### Endpoints

| Endpoint | Permission |
|---|---|
| `PATCH /transport/bookings/:id/hold` | etms_dispatch edit |
| `GET /transport/sharing-policy` · `PUT` (new version) | etms_bookings view · etms_settings edit + whole-company |
| `GET /me/transport/sharing-policy` | etms_self view (passenger profile required) |
| `GET /transport/pooling/settings` · `PUT` | etms_dispatch view · etms_settings edit + whole-company |
| `PUT /transport/driver-policy` | etms_settings edit + whole-company |
| `GET` / `PUT /transport/vehicles/:objectId/availability` | objects view / edit |
| `POST /transport/dispatch/live/decide` (Idempotency-Key when `apply`) | etms_dispatch command |
| `GET /transport/dispatch/live/requests` | etms_dispatch view |
| `POST /driver/v1/trips/:id/route-ack` | etms_driver edit (own trip) |
| `POST /transport/route-plans` `scope: AREA` + `windowStart/End` (+ depot) | etms_planning create (unchanged) |

Booking create (desk, group, `POST /me/transport/requests`) accepts `ridePreference`, `acceptedPolicyVersion`, `limits`;
every booking DTO returns `ridePreference`, `sharingPolicyVersion`, `limits`, `assignedService`, `holdFromPlanning`,
`holdReason`, `holdAt`. Driver trip detail: `routeVersion`, `routeAckPending`. Passenger trip: `estimatedPickupAt`,
`servedAs`.

### Deviations from the design (and why)

| Design | Implemented | Reason |
|---|---|---|
| §3.1 `requestedPickupAt` / `pickupWindowS` | P2P keeps `windowStart/End`; pickup window = `[windowStart, min(windowEnd, windowStart + maxWaitS)]` | No new time columns; the existing window already is the requested pickup time |
| §3.1 acceptance required for SHARED / FLEXIBLE | Required for **point-to-point** SHARED / FLEXIBLE; COMMUTE is SHARED by default without acceptance | Commute rides are pooled by definition (P3); existing web / mobile clients keep working |
| §3.1 policy "per service" | `TransportSharingPolicy` versions hold `limits.SHARED` / `limits.FLEXIBLE`; version 0 = built-in default (no row) | Every company has a policy from day one |
| P1 whole-trip | A booking's **group** (`groupId`, group booking) counts as one party | Colleagues booked together must ride together |
| §3.2 P2P direction | Booking `direction` null for new P2P; `TransportTrip.direction` stays non-null (P2P / live trips carry the change set's direction, IN by default) | Avoids a nullable trip direction across every trip reader |
| §3.3 `serviceAreaIds` | Not added; AREA plans are scoped by window + branch | No service-area model exists yet |
| §3.3 turnaround default 120 | `turnaroundS` nullable: enforced at publish only when set; planners / insertion use 120 when null | Back-to-back trips published today must keep working |
| §3.4 `TransportDriverPolicy` table + driver override, `TransportDriverDuty.plannedStart/End` | Company policy in `Company.settings.etmsPooling.driverHours`; no per-driver override; duty derived from planned trips | Task scope (company settings); P7 = none by default |
| §5.1 Valkey stream `vt:etms:dispatch` | `TransportDispatchRequest` rows are the queue (like `RoutingJob`); worker every 5 s with per-company Valkey locks | Recovery is "re-read QUEUED rows"; no consumer-group state |
| §5.1 solver insertOnly | Optimiser asked for the trip choice (synthetic matrix), the placement is realised by the in-process slack model; the in-process cheapest insertion is the fallback (circuit 10 min after PDP_UNSUPPORTED) | Existing stops never move, so the E3 ADD_STOP rule and committed windows hold by construction |
| §5.2 committed windows on SCHEDULED trips | Insertion only uses slack: committed stop times never change (stricter than "within window") | Re-sequencing published stops would need a REORDER op (deferred) |
| §5.3 breakdown onboard → "incident" | A PROPOSED `TransportDispatchRequest` with reason `ONBOARD_TRANSFER` per boarded passenger | `TransportIncident` is the SOS model (CHECK kind = SOS) |
| §5.3 cancellation "pending stops removed" | Seat released (as before) + the booking leaves every unpublished plan (version + 1, version row); published trip stops stay | No REMOVE_STOP op; nobody's times move |
| §3.7 event kinds | `PASSENGER_INSERTED`, `ROUTE_UPDATED`, `ROUTE_ACK`, `TRIP_INTERRUPTED` written; the others listed in the shared enum only | Re-sequencing / transfer ops are deferred |
| Notifications `ROUTE_UPDATED` push | Existing relay: `PASSENGER_INSERTED` / `ROUTE_UPDATED` → driver `TRIP_CHANGED` (generic push) | No new notification kind (CHECK) |
| §4.2 unserved codes | Mapped onto the existing `OPTIMIZE_UNASSIGNED_REASONS`; the solver code is kept in the job result | Web reason labels unchanged |

### Solver v3 merge (WS P-B2)

- API side: `routing-jobs/pdp-contract.ts` (types), `pdp-problem.ts` (`buildPdpProblem`, `verifyPdp`, `mapPdpResult`,
  strategy weights §4.4), `area-runner.ts` (AREA optimise job), `OptimizerClient.solvePdp` (same POST `/optimize`).
- Stop kinds accepted as `PICKUP` / `DROP` or `P` / `D`; per-vehicle `trips[].index` is the trip slot; `startS` = service
  start (pickup window checked on it); ride = drop arrival − (pickup start + `serviceS`, default 60).
- Until the solver answers v3: AREA optimise → job FAILED `PDP_UNSUPPORTED` (final); live dispatch → in-process.
- Live onboard passengers (`vehicles[].onboard`) may appear as D stops without a request; the checker allows them.

### Deferred

Web / mobile screens (P-C3, P-D2, P-E1), REORDER / transfer ops, periodic warm-start re-optimisation (§5.1 async),
per-driver hour overrides and breaks in the solver input, service areas, staging benchmarks (E4 gates B1–B6).

### Independent review fixes (2026-11-15)

| # | Fix |
|---|---|
| 4 | Migration `20261129090100_etms_pooling_review_fixes`: legacy P2P rows (no limits) seated with another party → FLEXIBLE; P1 binds only PRIVATE rows with a limits snapshot (`effectivePreference`), so trips carrying legacy riders stay editable |
| 5 | The vehicle timeline (maintenance / downtime / operating hours / turnaround) runs only when pooling is in use (live / AREA publish, company live switch) or the vehicle has availability / a turnaround configured, and never on a driver change (driver hours still apply when a policy exists) |
| 1 | Insertion: pickups never before now; pending stops judged on the trip's live delay (`delaySec`); a started trip that cannot reach its first pending stop takes nobody; reachability re-checked inside the publish transaction (`PublishSource.reachable`) |
| 2 | No live insertion on a started trip while its driver has not acknowledged the last change (option reason `ROUTE_ACK_PENDING`, apply refused); passengers see `routePending` (tentative); unacknowledged changes older than 3 min become a PROPOSED request `ROUTE_ACK_OVERDUE` |
| 3 | Delay / breakdown children retry their own re-seat (no re-evaluation of the trip, no duplicate onboard proposals); the trip version is re-read before each re-seat |
| 6 | Decisions round personal points (4 decimals unless a whole-company role of the customer) and are ACCESS-audited |
| 7 | Releasing a hold re-queues the booking for live dispatch |
| 8 | Full options are stored on the request; `apply` with `requestId` + `optionId` applies the option shown; option ids no longer depend on times |
| 9 | `assignedService` recomputed after a seat release (SKIP LOCKED); AREA trips checked on on-board load (and on total seats, the E3 occupancy backstop — the solver should cap a trip's riders at the seats); concurrent decide with one key replays; the log's alternatives respect vehicle scope |
