# Routes & planned trips (module RTE): build spec

Design source: design document section "Routes and trips (Driver → Vehicle → Route → Trip)" (feature ids RTE-*),
"Automatic trips vs planned trips" and "Planned trip states". This spec fixes the data model and behaviour so the
database, API, processor, web and reports are built against one design. Status: approved for build 2026-11-10.

## 1. Concepts

| Term | Meaning |
|---|---|
| **Route** | Reusable plan: ordered stops (start → stops → end), each with an arrival radius and planned times relative to the trip start; a road path (GraphHopper, local) with a corridor width for deviation. |
| **Route schedule** | Days of the week + local start time (+ optional default vehicle / driver, validity dates). Generates planned trips. |
| **Planned trip** | Driver + vehicle + route + planned start. One-off (created by hand) or generated from a schedule. Holds a **snapshot** of the route (stops, path, corridor) so editing a route never alters existing trips. |
| **Planned trip stop** | Per stop of a trip: planned vs actual arrival / departure, dwell, status, delay. |
| **Trip event** | Unscheduled stop or deviation episode recorded during a trip. |

Not to be confused with the existing **automatic** `Trip` / `Stop` models (computed by the summarizer from
ignition / movement). Names below avoid those (`PlannedTrip`, `PlannedTripStop`).

## 2. Data model (Prisma, conventions as elsewhere)

UUID ids (`@db.Uuid`), `companyId` on every row, `branchId?` where relevant, `isActive` for archive (no
soft-delete column), `@db.Timestamptz(3)` timestamps, no FK on high-volume rows.

```prisma
enum PlannedTripStatus { SCHEDULED STARTED IN_PROGRESS COMPLETED INCOMPLETE CANCELLED }
enum PlannedStopStatus { PENDING ARRIVED DEPARTED SKIPPED }

model Route {
  id          String   @id @default(uuid()) @db.Uuid
  companyId   String   @db.Uuid
  branchId    String?  @db.Uuid
  name        String
  code        String?
  description String?
  corridorM   Int      @default(200)   // half-width of the deviation corridor around `path`
  path        Json?                    // [[lng,lat], ...] along roads from GraphHopper; null = straight lines between stops
  distanceM   Int?                     // of `path`
  durationSec Int?                     // GraphHopper driving time (no waits)
  isActive    Boolean  @default(true)
  createdAt   DateTime @default(now()) @db.Timestamptz(3)
  updatedAt   DateTime @updatedAt @db.Timestamptz(3)
  stops       RouteStop[]
  schedules   RouteSchedule[]
  @@unique([companyId, name])
  @@index([companyId, isActive])
}

model RouteStop {
  id         String  @id @default(uuid()) @db.Uuid
  routeId    String  @db.Uuid
  route      Route   @relation(fields: [routeId], references: [id], onDelete: Cascade)
  seq        Int                      // 0 = start, last = end
  name       String
  lat        Float
  lng        Float
  radiusM    Int     @default(100)    // arrival radius
  offsetMin  Int     @default(0)      // planned arrival, minutes after the trip's planned start (start stop: 0)
  waitMin    Int     @default(0)      // planned dwell; planned departure = arrival + wait
  geofenceId String? @db.Uuid         // optional: stop taken from a geofence / place
  @@unique([routeId, seq])
}

model RouteSchedule {
  id        String    @id @default(uuid()) @db.Uuid
  companyId String    @db.Uuid
  routeId   String    @db.Uuid
  route     Route     @relation(fields: [routeId], references: [id], onDelete: Cascade)
  days      Int[]                     // 0 = Sunday … 6 = Saturday (company timezone)
  startMin  Int                       // local minutes after midnight
  objectId  String?   @db.Uuid        // default vehicle (required to generate)
  driverId  String?   @db.Uuid        // default driver
  validFrom DateTime? @db.Date
  validTo   DateTime? @db.Date
  isActive  Boolean   @default(true)
  createdAt DateTime  @default(now()) @db.Timestamptz(3)
  updatedAt DateTime  @updatedAt @db.Timestamptz(3)
  @@index([companyId, isActive])
}

model PlannedTrip {
  id            String            @id @default(uuid()) @db.Uuid
  companyId     String            @db.Uuid
  branchId      String?           @db.Uuid
  routeId       String            @db.Uuid
  scheduleId    String?           @db.Uuid
  objectId      String            @db.Uuid
  driverId      String?           @db.Uuid
  routeName     String                         // snapshot
  corridorM     Int                            // snapshot
  path          Json?                          // snapshot [[lng,lat], ...]
  plannedStart  DateTime          @db.Timestamptz(3)
  plannedEnd    DateTime          @db.Timestamptz(3)   // last stop's planned arrival
  status        PlannedTripStatus @default(SCHEDULED)
  actualStart   DateTime?         @db.Timestamptz(3)
  actualEnd     DateTime?         @db.Timestamptz(3)
  closedBy      String?                        // AUTO | MANUAL | TIMEOUT
  cancelReason  String?
  notes         String?
  distanceKm    Float?                         // actual, start → end
  deviationCount Int              @default(0)
  maxDeviationM Int?
  nextStopSeq   Int?                           // live: next stop not yet arrived
  etaNextStop   DateTime?         @db.Timestamptz(3)  // live
  delaySec      Int?                           // live / final: latest known delay vs plan (+ late, − early)
  createdById   String?           @db.Uuid
  createdAt     DateTime          @default(now()) @db.Timestamptz(3)
  updatedAt     DateTime          @updatedAt @db.Timestamptz(3)
  stops         PlannedTripStop[]
  events        PlannedTripEvent[]
  @@unique([scheduleId, plannedStart])         // idempotent generation
  @@index([companyId, plannedStart])
  @@index([objectId, status])
  @@index([routeId, plannedStart])
}

model PlannedTripStop {
  id               String            @id @default(uuid()) @db.Uuid
  tripId           String            @db.Uuid
  trip             PlannedTrip       @relation(fields: [tripId], references: [id], onDelete: Cascade)
  seq              Int
  name             String
  lat              Float
  lng              Float
  radiusM          Int
  plannedArrival   DateTime          @db.Timestamptz(3)
  plannedDeparture DateTime          @db.Timestamptz(3)
  actualArrival    DateTime?         @db.Timestamptz(3)
  actualDeparture  DateTime?         @db.Timestamptz(3)
  status           PlannedStopStatus @default(PENDING)
  delaySec         Int?              // actualArrival − plannedArrival
  @@unique([tripId, seq])
}

model PlannedTripEvent {
  id       String      @id @default(uuid()) @db.Uuid
  tripId   String      @db.Uuid
  trip     PlannedTrip @relation(fields: [tripId], references: [id], onDelete: Cascade)
  kind     String                  // UNSCHEDULED_STOP | DEVIATION
  startAt  DateTime    @db.Timestamptz(3)
  endAt    DateTime?   @db.Timestamptz(3)
  lat      Float
  lng      Float
  data     Json?                   // DEVIATION: { maxM }, UNSCHEDULED_STOP: { durationSec }
  @@index([tripId, startAt])
}
```

Migration folder: `apps/api/prisma/migrations/20261113090000_routes_planned_trips` (after the latest,
`20261112120000_stock_supplier_payments`). Grant the new menus to system roles in the same migration (pattern:
`20261019220000_driver_events`).

## 3. Permissions and menus (`packages/shared/src/permissions.ts`)

| Menu key | Label | Group | Path | Actions | Manager | User |
|---|---|---|---|---|---|---|
| `routes` | Routes | masters | `/routes` | view, create, edit, delete, export | all | view |
| `plannedTrips` | Planned trips | main | `/planned-trips` | view, create, edit, delete, export | all | view |

Hidden for personal accounts (`PERSONAL_HIDDEN_MENUS`), like other business features.

## 4. Behaviour

### 4.1 Routes
- Create / edit: name, code, branch, description, corridor (m, 50–2000), ordered stops (≥ 2) with name, position,
  radius (20–2000 m), arrival offset (min, non-decreasing along the route, start = 0) and wait (min).
- **Road path:** on save, if the routing engine is enabled, `RoutingService.routeVia(points)` (new: GraphHopper
  `/route?profile=car` with all stops as `point` params, `points_encoded=true`) fills `path`, `distanceM`,
  `durationSec`. Engine off or no route: `path = null` (straight lines are used for display and deviation).
  `POST /routes/preview-path` returns the same for the editor without saving. "Suggest times" in the editor fills
  arrival offsets from the GraphHopper leg times.
- Copy (`POST /routes/:id/copy` → "<name> (copy)"), archive (`isActive=false`), delete (only without planned trips;
  otherwise archive). Editing never changes existing planned trips (they hold a snapshot).
- Audit-logged like other masters.

### 4.2 Schedules and trip generation
- A route has 0..n schedules (days, start time, default vehicle / driver, validity).
- **Generator** (API process, `@Interval` 5 min, Valkey lock `vt:plannedtrips:generator:lock`, kill switch
  `PLANNED_TRIP_JOB=off`): for each active schedule with a vehicle, creates the trips whose planned start falls in the
  next 24 h (company timezone), idempotent by `@@unique([scheduleId, plannedStart])`. Archived routes generate nothing.
- **One-off trip:** `POST /planned-trips` with route, vehicle, driver?, planned start.
- Creating a trip copies the route snapshot: `routeName`, `corridorM`, `path`, and one `PlannedTripStop` per stop
  with `plannedArrival = plannedStart + offsetMin`, `plannedDeparture = plannedArrival + waitMin`;
  `plannedEnd` = last stop's planned arrival.
- Edit allowed while SCHEDULED (vehicle, driver, planned start → times recomputed). Cancel with reason (SCHEDULED /
  STARTED / IN_PROGRESS). Manual start / complete (override) with audit.

### 4.3 Live tracking (processor)
Hook: `PositionProcessor.handle`, next to `evaluateRules`, same valid / non-late `RuleInput`s. New
`PlannedTripTracker` modelled on `RulesEngine` / `RulesBatch`: per-object state in Valkey `vt:ptrip:<objectId>`
(MGET at batch start, SET on commit), active trips per company cached and invalidated via the existing pub/sub
(`rulesInvalidate` with reason `planned-trips`), DB statements returned into `writeBatch`. Kill switch
`PLANNED_TRIPS=off`. Pure decision logic in `planned-trips/evaluate.ts` (unit-tested), I/O separate.

A vehicle has at most one active trip (STARTED / IN_PROGRESS); a SCHEDULED trip is a candidate from
`plannedStart − 60 min` to `plannedEnd + 120 min`.

| Rule | Behaviour |
|---|---|
| Start | SCHEDULED → **STARTED** when the vehicle is inside the start stop radius (or within it in the window); → **IN_PROGRESS** when it leaves the start radius (`actualStart` = leaving time, start stop `actualDeparture`). Leaving without having been seen inside (e.g. first fix already outside, moving away along the route) also starts it if within 2 × radius. |
| Stop arrival | Entering a stop radius (in order; a later stop may be reached first → earlier PENDING stops become **SKIPPED**): `actualArrival`, `delaySec`, status ARRIVED. Leaving: `actualDeparture`, DEPARTED. |
| Complete | Arrival at the last stop → **COMPLETED** (`closedBy=AUTO`, `actualEnd`). |
| Incomplete | Not completed by `plannedEnd + 120 min` (or a newer trip of the same vehicle starts) → **INCOMPLETE** (`closedBy=TIMEOUT`), PENDING stops → SKIPPED. Done by a sweeper in the API (same job as the generator). |
| Not started | SCHEDULED and no start by `plannedStart + 30 min` → alert `TRIP_NOT_STARTED` (once). |
| Deviation | IN_PROGRESS and distance to the path (or straight legs) > `corridorM` for ≥ 2 consecutive fixes → DEVIATION event opens (alert `ROUTE_DEVIATION`); back inside → event closes with `maxM`. `deviationCount`, `maxDeviationM` updated. |
| Unscheduled stop | IN_PROGRESS, speed < 3 km/h for ≥ 5 min outside every stop radius → UNSCHEDULED_STOP event (duration on resume). |
| Late at stop | Arrival `delaySec` > the alert setting's threshold (default 10 min) → alert `TRIP_STOP_LATE`. Skipped stop → alert `TRIP_STOP_SKIPPED`. |
| ETA / delay | On each evaluation (throttled to once per 60 s per trip): ETA to the next stop = now + remaining path distance to it ÷ max(recent average speed, 20 km/h), capped by the routing engine when enabled (`RoutingService.route`, cached 60 s). `delaySec` = ETA − planned arrival of that stop. Stored on the trip, pushed to the web over the socket (`plannedTrip.update`). |

Distance to path uses `distanceToRoad` from `point-quality/road-match.ts` (coordinates `[lng,lat]`) with the last
matched index as hint.

### 4.4 Alerts (end-to-end as in the alert-type checklist)
New codes in `packages/shared/src/alerts.ts`, category "Trips", default enabled, cooldowns per trip:
`ROUTE_DEVIATION` (WARNING, param `minDistanceM` default = route corridor), `TRIP_STOP_LATE` (WARNING, param
`lateMin` default 10), `TRIP_STOP_SKIPPED` (WARNING), `TRIP_NOT_STARTED` (WARNING, param `graceMin` default 30),
`TRIP_COMPLETED` (INFO, default off). System templates, icons (web + mobile), hi / ta labels.

### 4.5 Web
- **Masters → Routes:** list (name, code, stops, distance, schedules, status), editor dialog: map (MapLibre, same
  basemap) with click-to-add / drag stops, place search, stop table (name, radius, arrival offset, wait), road path
  preview, corridor shown as a band, "Suggest times", schedules tab (days, time, vehicle, driver, validity).
- **Tracking → Planned trips:** day view list with filters (date, route, vehicle, driver, status) and status chips;
  "New trip"; row actions start / complete / cancel; **trip detail**: header (route, vehicle, driver, status,
  planned vs actual start / end, delay), stop timeline (planned vs actual arrival / departure, dwell, on-time /
  late / early / skipped), events (deviations, unscheduled stops), map with planned path + corridor + stops over the
  actual track (positions history API for the trip window) with playback reusing the History player.
- Live: the list updates from the socket (`plannedTrip.update`).

### 4.6 Reports (`REPORT_TYPES`)
- `trip_performance`: per route / driver / vehicle for a date range: trips (completed / incomplete / cancelled),
  on-time % (a stop is on time when |delay| ≤ 5 min), average start delay, average stop delay, skipped stops,
  planned vs actual km, deviations.
- `planned_trips`: one row per trip with all times.
Golden test files updated.

## 5. Out of scope here (later)
Passengers / attendance per stop (P2), parent / employee apps, driver app trip screen, truck / bus routing
profiles, route optimisation, delivery-person routes.

## 6. Tests
- Unit: `planned-trips/evaluate.spec.ts` (start / arrive / skip / complete / deviation / unscheduled stop / ETA),
  generator (days, timezone, DST-free IST, validity, idempotency), snapshot copy, routeVia decoding.
- DB test `planned-trips.db-test.ts` (manual, empty migrated DB) for create → track → complete.
- Web: pure helpers (`*.test.ts`).
