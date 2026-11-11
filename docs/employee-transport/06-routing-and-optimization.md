# 06 Routing and optimisation (ETMS E0, Agent 2)

Status: E0 discovery, read-only. Inspected 2026-11-11: `origin/main` = v1.8.0 (`f5b151b`, worktree
`D:\Vibhav\gps-app-wt\etms`) and the local branches `feature/routing-engine` (38 commits ahead of its merge base
`07077b6` "Merge feature/p1-design-system into release 1.3"; last commit 2026-11-09) and `feature/routing-r0` (11 docs
commits, already merged into `feature/routing-engine` by `f220ff1`). Nothing was run, built or connected to.

Labels: **Verified** = read in code, tests or docs at the cited path. **Proposed** = design for ETMS. **Estimate** = a
number not yet measured; it needs a benchmark (§7).

Short answers:
- **Q4.** In main, routing is one `RoutingService` in `apps/api/src/routing/routing.service.ts` (route, via-route,
  gap estimates over GraphHopper `/route`) plus GraphHopper `/match` in `point-quality/road-match.ts`. The only
  routing-related DB models are v1.8.0's `Route` / `RouteStop` / `RouteSchedule` / `PlannedTrip*`. The branch adds the
  `/api/routing/*` and `/api/route-plans/*` APIs (`routing-v2`), a routing worker, an OR-Tools service and six models
  (`RoutePlan`, `RouteAssignment`, `RouteStop`, `RoutingJob`, `RoutingUsage`, `RoutePlanVersion`). Its `RouteStop`
  table clashes with main's.
- **Q5.** In production today: road paths and leg times for routes, engine-capped next-stop ETA, map matching and
  Photon search / reverse geocoding. On the branch, with tests, on a dev PC only, over Valhalla: matrix, optimise
  jobs, plan editing and versions. Blocked: the branch can't merge as it is (schema clash, five conflicting files,
  migrations out of order, Valhalla-only adapter). No matrix exists in production GraphHopper. ETA calibration is
  missing for GraphHopper. Passengers, walking and safety constraints exist nowhere.

---

## 1. Verified inventory

### 1.1 Production routing (main / v1.8.0)

| Capability | Where (path + symbol) | Behaviour | Evidence |
|---|---|---|---|
| Engine selection | `apps/api/src/routing/routing.service.ts` `RoutingService` (`ROUTER_URL`, `ROUTER_ENGINE`, default `valhalla`) | Off when `ROUTER_URL` unset (`enabled`). Production: `ROUTER_ENGINE=graphhopper`, `ROUTER_URL=http://127.0.0.1:8989` | `ops/deploy/linux/maps/README.md` "API settings" |
| Point-to-point route | `RoutingService.route(from, to)` → `fetchGraphHopper` (`GET /route?profile=car`, 5 s timeout) | Returns `{m, s, shape}`; Valkey cache `route:eta:*` 60 s; null on failure | used by `live-share/live-share.service.ts:178` (delivery ETA) and the tracker |
| Gap estimates (History) | `RoutingService.estimateGaps` + `route-estimate.ts` `plausibleRoute`, `MAX_ESTIMATE_STRAIGHT_M` = 150 km | Cache `route:est:*` 30 days (misses 1 day); `POST /routing/estimate-gaps` (`routing.controller.ts`, `history:view`) | `route-estimate.spec.ts` |
| Multi-stop route | `RoutingService.routeVia(points)` → `viaGraphHopper` (one `/route` with every point) + one `/route` per consecutive pair (concurrency `LEG_CONCURRENCY` = 6); `route-via.ts` `fillLegs` splits missing legs by straight-line share | Path `[lng,lat]`, total m/s, legs. **Not cached.** Called on route save / preview only | `route-via.spec.ts`; callers `planned-trips/routes.service.ts` `create` / `update` / `previewPath` |
| Map matching | `point-quality/road-match.ts` `matchSegment` (`POST /match?profile=car`, GPX, chunks of 800 fixes, thinning 30 m / 20 s) and `distanceToRoad`; used by `point-quality.service.ts` `roadMatch` (GraphHopper only) | Snaps moving segments, labels off-road fixes | code path. GraphHopper LM is configured for `/match` (`graphhopper.yml` comment) |
| Planned-trip deviation | `planned-trips/tracker/evaluate.ts` uses `distanceToRoad` against the trip `path` snapshot; corridor `corridorM` | DEVIATION event + `ROUTE_DEVIATION` alert after `TRACKER.deviationFixes` = 2 fixes | `evaluate.spec.ts` |
| Planned-trip ETA | `evaluate.ts` (ETA block): ETA to the **next** stop = remaining path distance ÷ max(recent average speed, `TRACKER.minEtaKph` = 20 km/h), throttled to `etaEveryMs` = 60 s, **capped** by `opts.routeEta`. `tracker-engine.ts` `PlannedTripTracker.routeEtas` calls `EtaRouter.route` (= `RoutingService.route`) with a timeout | Stored on `PlannedTrip.etaNextStop` / `delaySec`, pushed as `plannedTrip.update`. With no engine the ETA still comes from distance and speed | `evaluate.spec.ts` "ETA = now + remaining distance ÷ max(…)"; `apps/api/src/processor/main.ts` passes `routing.enabled ? routing : null` |
| Geocoding | `apps/api/src/geocoding/geocoding.service.ts` `GeocodingService.reverse` (DB `AddressCache`, ~11 m key) and `search` (Photon only, 6 results, India bbox `68,6,98,37`) | Production `GEOCODER=photon`, `127.0.0.1:2322` | `photon-address.spec.ts`; maps README |
| Engines on the server | `ops/deploy/linux/maps/graphhopper.yml`, `veetrax-graphhopper.service` | GraphHopper 11.1 India, **one profile `car`** (CH + LM). `import.osm.ignored_highways: footway, construction, cycleway, path, steps, pedestrian, bridleway`. `RAM_STORE`, `-Xms2g -Xmx8g`, localhost only. Photon ≤ 3 GB, Martin < 0.5 GB | maps README table |

Gaps that matter for ETMS (Verified from code):
- **No matrix** in main. `routeVia` is the only multi-point call, and it is sequential pairwise.
- **One routing profile (`car`)**. There's no foot profile for walking to shuttle stops, and footways and pedestrian
  ways are excluded at import. There's no bus or van profile (no height, width or weight encoded values).
- **No calibration and no "no live traffic" label** on main's ETAs. The tracker ETA is a heuristic grounded in live
  speed. It is computed only when a fix arrives (`evaluate.ts`), and nothing found in that path marks it stale.
  The staleness gap is inferred from the code, not tested.
- **Bug still live in production (side finding, not fixed here):** `decodePolyline` (`routing/route-estimate.ts`)
  returns `[lng, lat]`. `RoutingService.route` hands `shape` straight to `live-share.service.ts:179`, and
  `apps/web/src/features/live-share/PublicSharePage.tsx:139` swaps it again (`eta.route.map(([la, ln]) => [ln, la])`).
  Now that GraphHopper is on, the public share page draws the ETA road with lat and lng swapped. The branch fixed this
  as RR-14 (`share-eta.ts`), but the fix never reached main.

### 1.2 v1.8.0 Routes and planned trips (the publish target)

- `Route` (`companyId`, `branchId?`, `name` unique per company, `corridorM`, `path` JSON `[lng,lat]`, `distanceM`,
  `durationSec`, `isActive`)
- `RouteStop` (`routeId`, `seq`, `name`, `lat`, `lng`, `radiusM`, `offsetMin`, `waitMin`, `geofenceId?`)
- `RouteSchedule` (`days[]`, `startMin`, `objectId?`, `driverId?`, validity)
- `PlannedTrip`:
  - snapshot fields: `routeName`, `corridorM`, `path`, `plannedStart`, `plannedEnd`
  - `routeId` and `objectId` are **required**
  - live fields: `nextStopSeq`, `etaNextStop`, `delaySec`, `deviationCount`
  - `@@unique([scheduleId, plannedStart])`
- `PlannedTripStop` (planned / actual arrival and departure, status, delay)
- `PlannedTripEvent`

All of these are in `apps/api/prisma/schema.prisma`, migration `20261113090000_routes_planned_trips`. Trips are made
by `planned-trips.service.ts` `PlannedTripsService.create` / `insertTrip` from `snapshot.ts` `buildTripSnapshot`, and
by the generator `planned-trip-job.service.ts` `PlannedTripJobService.generate`, which runs every 5 min for the next
24 h and is idempotent. `docs/routes-trips/SPEC.md` §5 puts passengers and route optimisation **out of scope**.

### 1.3 `feature/routing-engine` (unreleased, local only)

| Area | What exists (path + symbol) | Tests / evidence on the branch |
|---|---|---|
| Engine adapter | `apps/api/src/routing-v2/valhalla.adapter.ts` (`route`, `matrix` → `/sources_to_targets`, `locate`, `graphStatus`). **Valhalla only.** `private-url.ts` refuses non-private engine URLs | `routing-v2.spec.ts` (33 cases incl. 1 live) |
| Routing service | `routing-v2.service.ts` `RoutingV2Service`: `capabilities`, `route` (graph-versioned Valkey cache `vt:route:v2:<graphVersion>:<sha1>`), `matrix` / `isolatedMatrix` (per-point `/locate`, disconnected-point isolation, row chunks `ROUTING_MATRIX_ROW_CHUNK` = 25 × 2), `startOptimize`, `startMatrixJob`, `buildProblem` (matrix → `OptimizerProblem`), `saveToPlan` | same; probe `docs/routing/results/api-probe-phase3.json` |
| APIs | `routing-v2.controller.ts`: `GET /routing/capabilities`; `POST /routing/routes`, `/routing/matrix` (sync ≤ 50 locations / 2,500 cells), `/routing/optimize` (202), `/routing/matrix/jobs` (202, ≤ 200 × 200); `GET /routing/jobs/:id`, `POST /routing/jobs/:id/cancel`; usage / settings. `@Controller('route-plans')`: CRUD, `:id/optimize`, `:id/history`, stops add / edit / delete, `PUT :id/sequence`, `:id/recalculate`, assignments CRUD, `:id/publish`, `:id/cancel`. `RoutingV2EnabledGuard` → 404 unless `ROUTING_ENGINE_V2=on` | `routing.int.spec.ts` (13, real PostgreSQL) |
| Jobs and worker | `jobs.service.ts`: `RoutingJob` row is the source of truth, Valkey stream `vt:routing:jobs` with a consumer group, conditional claim with lease and heartbeat, `Idempotency-Key` per company, retry with back-off, timeout, cooperative cancel, sweeper. Separate process `apps/api/src/routing-worker/main.ts` | `worker-lifecycle.spec.ts`, `worker-process.int.spec.ts` (SIGKILL → lease recovery; 5 workers → 1 execution) |
| Optimiser | `services/routing-optimizer/optimizer/solver.py` `solve` (OR-Tools 9.15, CVRPTW on a **given matrix**): multiple depots (start / end per vehicle), one capacity dimension, multiple time windows per stop, service time, vehicle shift window, `maxDurationS`, drop penalty × priority, pre-check reasons (`_pre_infeasible`), `provenOptimal` never faked. `server.py`: token ≥ 24 characters, CIDR allow-list, `OPTIMIZER_CONCURRENCY` slots then 429, body ≤ 8 MB. Solver `LIMITS` = 500 stops / 50 vehicles / 600 locations / 120 s; API `ROUTING_LIMITS` (`packages/shared/src/routing.ts`) = 150 stops / 20 vehicles / 200 locations / 60 s | `tests/test_solver.py` (8 tests), `tests/test_server.py` (4). ROUTING_PROGRESS phase 4: "pytest 16 passed". Capacity: `docs/routing/results/optimizer-capacity-phase4.jsonl` (150 stops / 20 vehicles FEASIBLE in 5 s) |
| **Not** in the solver | Pickup-and-delivery pairs, **max ride time per passenger**, vehicle–stop compatibility (`SetAllowedVehiclesForIndex`), a second capacity dimension (wheelchair), grouping or precedence rules, fleet-size cost (fixed cost per vehicle), soft time windows. Python transit callbacks, not `RegisterTransitMatrix` | code read |
| Models | `RoutePlan`, `RouteAssignment`, **`RouteStop`** (`planId`, `ref`, `demand`, `serviceS`, `timeWindows`, `sequence`, `etaS`, `unassignedReason`), `RoutingJob`, `RoutingUsage`, `RoutePlanVersion`. Enums `RoutePlanStatus` and `RoutingJobStatus`. Migrations `20261110110000_routing_engine_v2`, `20261110120000_routing_jobs_plan_versions` | applied to scratch DBs only (`production-readiness.md` R2) |
| ETA honesty | `routing-v2/eta.ts`: per-band factor. Short band (< 10 km) 1.60 from Chennai GTFS **against Valhalla free-flow**. Medium and long bands `calibrated:false`. `NO_LIVE_TRAFFIC_NOTICE` and `UNCALIBRATED_ETA_NOTICE` (`packages/shared/src/routing.ts`) | `eta-calibration.md`, screenshots 15–16 |
| Web | `apps/web/src/features/route-planner/RoutePlannerPage.tsx`, `PlanEditor.tsx`, `planner-utils.ts`. UI flag `routingV2` in `apps/web/src/lib/flags.ts` (`OFF_BY_DEFAULT`). Menu key `route_plans` | `planner-utils.test.ts` (9), flags tests |
| Other | `retention.service.ts` routing trims; `routing-v2/access.service.ts` (role presets, driver own routes, audited Super Admin support); `service-area/coverage.ts` (India polygon); `config/api-host.ts` (`API_HOST`, **not in main**: `apps/api/src/main.ts:22` still `app.listen(env.apiPort)`) | `access.spec.ts` (21), `api-host.spec.ts` |
| Ops and docs | `ops/routing/*` (Valhalla build, publish, rollback; benchmarks; E2E kit "prepared, not run"); `docs/routing/*` (R0 report, architecture, production-readiness, benchmark, risk register `ROUTING_RISK_REGISTER.md`, decision log `ROUTING_DECISION_LOG.md`) | — |

> **Validation note (E0 review):** Test counts are copied from the branch's own docs, not recounted: `routing-v2.spec` now has 36 `it`/`test` lines (doc 33), `planner-utils` 10 (doc 9); `tests/test_solver.py` 8 + `tests/test_server.py` 4 = 12, which does not match the quoted "pytest 16 passed". Treat these as the branch's claims, to be re-run in the E4 compatibility review.

> **Validation note (E0 review):** Path drift: on `feature/routing-engine` the risk register and decision log are at the **repo root** (`ROUTING_RISK_REGISTER.md`, `ROUTING_DECISION_LOG.md`, also `RISK_REGISTER.md`, `DECISION_LOG.md`), not under `docs/routing/`; `docs/routing/production-readiness.md` exists (its R2 is in §8, not §7). Also: `GET /routing/capabilities` on the branch has no `RoutingV2EnabledGuard`, so not every v2 route returns 404 when `ROUTING_ENGINE_V2` is off.

**Readiness gaps the branch states about itself** (`docs/routing/production-readiness.md` §7–§8, `ROUTING_PROGRESS.md`):
- the verdict is **"NOT production-ready"**
- the routing host isn't approved and the E2E benchmark was prepared but not run (H1, H2)
- medium and long ETA bands aren't calibrated (E3 FAILED)
- the geocoder fails G4 and G6 and isn't integrated
- host firewall and WireGuard are pending (S4)
- the Valhalla map-matching adapter (`trace_route`) was never written
- the share page and History were never switched to v2
- CSV export with attribution is missing

Several of these premises are now stale. The branch assumed a 4 GB production server ("never the 4 GB production
server", RD-10) and the public Nominatim (RR-01). Production now runs self-hosted GraphHopper and Photon on a
27 GiB server.

### 1.4 Feature status table

| Feature | Production (v1.8.0) | Branch (test evidence) | Blocked / note |
|---|---|---|---|
| Point-to-point route + geometry | **Works** (GH `/route`, `RoutingService.route`) | Works on Valhalla (`routing-v2.spec.ts`, probe) | — |
| Multi-stop route with legs | **Works** (`routeVia`, `route-via.spec.ts`) | Works (`recalculate`, Valhalla chunks of 25) | GH legs cost N extra calls; uncached |
| Distance / time matrix | **Absent** | Works on Valhalla ≤ 200 × 200 async (50 × 50 p50 0.64–1.04 s, dev PC) | **Blocked for GH**: open-source GH has no matrix endpoint (§2.2) |
| VRP optimisation (OR-Tools) | Absent | Works for CVRPTW (pytest; 150 stops / 20 vehicles FEASIBLE in 5 s) | Needs a matrix; lacks ETMS constraints (§1.3 "Not in the solver") |
| Background jobs, progress, cancel, retry | Absent (only the planned-trip generator job) | Works (unit + real-process tests) | Valkey-dependent like the rest of the platform |
| Plan editing, versions, publish | Absent | Works into `RoutePlan` / `RouteAssignment` (int tests) | Publishes into branch tables, **not** into v1.8.0 `Route` / `PlannedTrip` |
| Map matching | **Works** (GH `/match`, point quality) | Not written for Valhalla (benchmarked only) | — |
| Live trip progress, deviation, stop arrival | **Works** (`PlannedTripTracker`, `evaluate.spec.ts`, `tracker-engine.spec.ts`) | n/a (branch based on 1.3, before routes-trips) | Reuse for ETMS (§5) |
| Next-stop ETA | **Works**, heuristic + GH cap, unlabelled | Calibrated short band (Valhalla-specific factor), labels | Factors don't transfer to GH; no live traffic anywhere |
| ETA to a passenger's own stop (n stops ahead) | Absent | Absent (`etaS` per plan stop is plan time, not live) | New work |
| Reverse / forward geocoding | **Works** (Photon 1.3) | Evaluated, not integrated (G4 and G6 fail) | Owner accepted Photon for production. Pickup-address quality stays a risk |
| Walking distance, foot routing | Absent (`car` only, footways ignored at import) | Valhalla `pedestrian` costing exposed in `ROUTING_COSTINGS` | Needs a GH `foot` profile and a graph rebuild (§2.4) |
| Bus / van restrictions | Absent | `truck` costing in Valhalla | Needs GH custom model + encoded values + rebuild |
| Usage metering, quotas | Absent | Works (`RoutingUsage`) | — |
| Per-company routing permissions | `routes` / `plannedTrips` menu keys | `route_plans` key + role presets | Must be reconciled (conflict in `permissions.ts`) |
| Infeasibility explanations | n/a | Per-stop reason codes (9 values `OptimizeUnassignedReason`) | Too coarse for ETMS (§4.6) |

> **Validation note (E0 review):** "Owner accepted" is not backed by a recorded decision in the repo; what is verified is the deployment (`ops/deploy/linux/maps/README.md`: `GEOCODER=photon`, `127.0.0.1:2322`) and the owner's self-hosting rule (brief §1).

---

## 2. Engine strategy for ETMS (Proposed)

### 2.1 Facts that drive the choice

| Factor | GraphHopper 11.1 (production) | Valhalla 3.9.1 (branch) | OR-Tools 9.15 |
|---|---|---|---|
| Already in production | **Yes**: route, match, tracker cap, routes editor | No. Dev PC only, never on any server | No |
| Memory (India) | heap ≤ 8 GB (`-Xmx8g`, `RAM_STORE`); exact resident size not recorded in repo | Serve ≥ 6 GB (OOM at 4 GB, RR-30b); build peak ≤ 6 GB with `VALIDATE_THREADS=2`; 4.59 GB tiles on disk (`ROUTING_PROGRESS` R8) | 71 MB peak RSS for 40–100 stops (`benchmark.md` §5); grows with N (§7) |
| Route / match | Yes (CH / LM) | Yes (route, `trace_route` p95 45 ms) | n/a |
| Many-to-many matrix | **No endpoint in open-source GH** (§2.2) | **Yes** `/sources_to_targets` | Consumes a matrix |
| Pedestrian profile | Possible (`foot`), needs config change + re-import | Built-in costing on the same tiles | n/a |
| Licence | Apache-2.0 | MIT | Apache-2.0 |
| "Nothing leaves the server" | Yes (localhost) | Yes if co-hosted on loopback | Yes (loopback service) |
| ETA consistency with live tracker | Same engine as `RoutingService.route` | Different speeds → plan ETA ≠ tracker ETA | n/a |

**Production RAM budget (Estimate).** 27 GiB minus GraphHopper 8, Photon 3, Martin 0.5, PostgreSQL + TimescaleDB,
Valkey and five Node services leaves roughly 6–10 GiB. The exact PostgreSQL `shared_buffers` and RSS figures weren't
inspected (no server access). Agent 7 / the owner must confirm. Valhalla would take about 6 GB of that headroom, plus
a rebuild peak of about 6 GB, for an engine that duplicates GraphHopper.

### 2.2 Does self-hosted open-source GraphHopper have a matrix API?

**Source knowledge (to verify against the release JAR, not the internet):**
- GraphHopper's **Matrix API is part of the commercial GraphHopper Directions API**.
- The open-source `graphhopper-web` server exposes `/route`, `/match` (map-matching module, merged into the main
  repository since 1.0), `/isochrone`, `/spt`, `/nearest`, `/info`, `/health` and a few more, but **no
  `/matrix`**.
- Open-source core also doesn't ship a CH many-to-many algorithm.

The repo agrees: `graphhopper.yml` says "the API uses /route and /match", and no code calls a GH matrix.

Verify on the server without any outbound call:
- `curl -s http://127.0.0.1:8989/matrix` → expect 404
- list `com/graphhopper/resources/*Resource.class` inside `graphhopper-web-11.1.jar`

Ways to get a matrix with GraphHopper:

| Option | How | Cost / effort | Verdict |
|---|---|---|---|
| **M1. N×M `/route` calls** (`calc_points=false`, `instructions=false`, CH) | Pool of parallel requests from the routing worker, cached per graph version by point pair | Each CH query is a few ms on loopback (Estimate 2–10 ms). Full 200×200 = 40k calls ≈ 20–100 s at 4–6 in flight. Grows N², so it needs **sparsification** (k-nearest + depot legs) and **caching** (stable home / stop locations) | **Start here**: no new engine, no Java, same speeds as the tracker |
| M2. Custom matrix endpoint in GH JVM | Small extra Dropwizard resource built against GH 11.1 core, one-to-many Dijkstra / bucket CH over the loaded graph, shipped as a custom `graphhopper-web` build | 1–2 weeks Java + rebuild on every GH upgrade. Fast (one graph load, no HTTP per cell) | Only if M1 benchmarks fail the targets in §7 |
| M3. `/spt` (shortest-path tree) per source | One call per source returns reachable nodes with time / distance; targets must be matched to nodes | Approximate (snap mismatch). Output heavy | Not recommended |
| M4. Valhalla `/sources_to_targets` beside GH | Branch code, measured | +6 GB RAM, second graph pipeline, two ETA models | Fallback only |
| M5. OSRM `/table` | Fastest matrix | Third engine, not in repo | Rejected (reuse-first) |

### 2.3 Options

| | A. GH for route / matrix / match + OR-Tools VRP | B. Keep Valhalla (branch) + OR-Tools | C. Both behind an adapter |
|---|---|---|---|
| Memory | +0 for engines; OR-Tools worker 0.5–3 GB (§7) | +6 GB serve, +6 GB peak while rebuilding, +4.6 GB disk | as B, plus GH stays |
| Capability | Matrix via M1/M2 (slower than Valhalla); foot / bus need GH config | Native matrix, pedestrian, truck | Best of both |
| ETA consistency | One engine for plan, tracker and share page | Plan ETAs (Valhalla) vs live ETAs (GH) disagree unless the tracker also moves | Must choose one "ETA of record" |
| Licensing / sovereignty | OK | OK | OK |
| Effort | Adapter + GH matrix builder (≈ 1–2 weeks) + solver extensions | Rebase branch, provision Valhalla on prod, re-run branch benchmarks, port map matching (RR-10) | Highest: two pipelines, two runbooks, two refreshes |
| Ops | Already in runbook `ops/deploy/linux/maps/` | New runbook and refresh (weekly build per RD-11) | Both |

### 2.4 Recommendation

**Option A, behind the `RoutingProvider` adapter (§3), with Valhalla kept as a written fallback but not deployed.**

> **Validation note (E0 review):** D3 (owner instruction 2026-11-11) puts **Valhalla out of scope**, including as a parked fallback; if the GraphHopper matrix fails benchmarks, the fallback is the custom GH endpoint (M2), then an owner decision. Related existing fact: main's `RoutingService` still defaults `ROUTER_ENGINE` to `valhalla` when unset (`apps/api/src/routing/routing.service.ts` l.22); production sets `graphhopper`. The E4 adapter should make GraphHopper the only supported value.

1. GraphHopper stays the only road engine for route, legs, map matching and **matrix**. Start with M1 (`/route`
   fan-out with a sparse k-nearest matrix and a graph-versioned cache). If the §7 benchmarks miss the targets, build
   M2. Add a Valhalla provider only if M2 also misses them, and only with owner approval and measured RAM.
2. Salvage the OR-Tools service from the branch, feed it the GraphHopper matrix and extend it for ETMS (§4).
   `solver.py` is already engine-agnostic: `matrix.durationsS` / `distancesM` with `None` meaning forbidden.
3. **Follow-up GraphHopper config changes**, each needing a re-import (about 30–60 min of routing downtime per the
   maps README) and owner approval:
   - a `foot` profile (`foot_access`, `foot_average_speed`), with `footway`, `path`, `steps` and `pedestrian` removed
     from `import.osm.ignored_highways`. This also grows the `car` graph's base storage
   - optionally a `van` / `bus` custom model with `max_height`, `max_width` and `max_weight` encoded values
   - Memory impact: **Estimate +20–40 %**, to be measured on a non-production machine first
4. ETA of record = GraphHopper free-flow plus a **new** calibration fitted against GH, not the branch's Valhalla
   factor 1.60. Until then every ETA carries `calibrated:false` and "no live traffic" (reuse the branch's
   `NO_LIVE_TRAFFIC_NOTICE` and `UNCALIBRATED_ETA_NOTICE`).

---

## 3. `RoutingProvider` adapter contract (Proposed)

Business modules (ETMS planning, dispatcher, tracker) depend only on this interface. GraphHopper is the first
implementation. `RoutingService` in main becomes a thin wrapper over it, keeping the `route` / `routeVia` /
`estimateGaps` signatures so v1.8.0 callers stay unchanged. Optimisation runs through a separate `OptimizerProvider`
(OR-Tools service), because it's a different process with different scaling.

```ts
// packages/shared (types) + apps/api/src/routing/provider/* (implementations). Proposed, not code.
export type LngLat = [number, number];                 // GeoJSON order everywhere
export interface Pt { lat: number; lng: number; ref?: string }

export type RoutingProfile = 'car' | 'van' | 'bus' | 'foot';
export type DegradedReason =
  | 'ENGINE_DISABLED' | 'ENGINE_UNREACHABLE' | 'ENGINE_TIMEOUT' | 'GRAPH_REBUILDING'
  | 'PROFILE_NOT_AVAILABLE' | 'OUTSIDE_COVERAGE' | 'POINT_NOT_ON_ROAD' | 'NO_ROUTE' | 'LIMIT_EXCEEDED';

/** Every number a user may see carries its provenance. There's never a straight-line or invented fallback. */
export interface EtaModel {
  source: 'engine_free_flow' | 'engine_calibrated' | 'live_heuristic';
  calibrated: boolean;
  liveTraffic: false;
  graphVersion: string | null;          // OSM extract date + engine version, e.g. "gh-11.1/india-2026-11-10"
}

export type Result<T> =
  | { ok: true; value: T; eta: EtaModel; attribution: string }
  | { ok: false; degraded: DegradedReason; message: string; retryAfterS?: number };   // no partial numbers

export interface RouteLeg { fromIndex: number; toIndex: number; distanceM: number; durationS: number }
export interface RouteResult {
  path: LngLat[];                        // road geometry
  distanceM: number; durationS: number;
  legs: RouteLeg[];                      // one per consecutive pair, never proportionally guessed
  snapped: { index: number; snapDistanceM: number }[];
}

export interface MatrixRequest {
  sources: Pt[]; targets: Pt[]; profile: RoutingProfile;
  /** Sparse mode: only these (source, target) pairs; the rest are returned as null (forbidden arc). */
  pairs?: [number, number][];
  departAt?: string;                     // ISO; ignored by free-flow engines but recorded
}
export interface MatrixResult {
  durationsS: (number | null)[][];       // null = no route / not requested (never estimated)
  distancesM: (number | null)[][];
  invalid: { side: 'source' | 'target'; index: number; reason: DegradedReason }[];
  cells: { requested: number; computed: number; cached: number };
}

export interface MapMatchResult { path: LngLat[]; matchedDistanceM: number; offRoadIndexes: number[] }

export interface ProviderCapabilities {
  engine: 'graphhopper' | 'valhalla';
  engineVersion: string; graphVersion: string | null;
  profiles: RoutingProfile[];
  matrix: { native: boolean; maxSyncCells: number; maxAsyncCells: number };
  mapMatching: boolean; isochrone: boolean;
  coverage: 'india';                      // US later: separate graph, separate capability
}
export interface ProviderHealth { reachable: boolean; latencyMsP50?: number; checkedAt: string; degraded?: DegradedReason }

export interface RoutingProvider {
  capabilities(): Promise<ProviderCapabilities>;
  health(): Promise<ProviderHealth>;
  route(points: Pt[], opts: { profile: RoutingProfile; geometry: boolean }): Promise<Result<RouteResult>>;
  matrix(req: MatrixRequest, onProgress?: (done: number, total: number) => Promise<void>): Promise<Result<MatrixResult>>;
  mapMatch(trace: { lat: number; lng: number; t: number; acc?: number }[], profile: RoutingProfile): Promise<Result<MapMatchResult>>;
  locate(points: Pt[], profile: RoutingProfile): Promise<Result<{ onRoad: boolean; snapDistanceM: number }[]>>;
}

// ---- optimisation (OR-Tools service; jobs persisted in RoutingJob, run by the routing worker) ----
export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export interface OptimizeJobRef { jobId: string; idempotencyKey?: string }
export interface OptimizeJobStatus {
  jobId: string; state: JobState; progress: number;            // 0..100 (matrix phase + solve phase)
  phase: 'matrix' | 'assign_stops' | 'solve' | 'route_legs' | 'done';
  attempts: number; cancelRequested: boolean;
  result?: PlanProposal; error?: { code: DegradedReason | 'OPTIMIZER_BUSY' | 'OPTIMIZER_UNAVAILABLE' | 'INVALID_INPUT'; message: string };
}

export interface OptimizerProvider {
  submit(problem: EtmsProblem, opts: { idempotencyKey: string; timeLimitS: number; companyId: string }): Promise<OptimizeJobRef>;
  status(jobId: string, companyId: string): Promise<OptimizeJobStatus>;
  cancel(jobId: string, companyId: string): Promise<OptimizeJobStatus>;
  health(): Promise<{ reachable: boolean; slots: number; busy: number; ortoolsVersion: string }>;
}

/** Output before publishing (the branch's RoutePlan concept). Distances and times are re-routed per leg with
 *  RoutingProvider.route after solving (branch rule RD-39: displayed numbers never come from matrix cells). */
export interface PlanProposal {
  status: 'FEASIBLE' | 'OPTIMAL' | 'NO_SOLUTION' | 'INVALID_INPUT';
  provenOptimal: boolean;
  trips: {
    vehicleId: string; driverId?: string; direction: 'PICKUP' | 'DROP';
    stops: { seq: number; pointId: string; plannedArrival: string; plannedDeparture: string;
             board: string[]; alight: string[]; load: number }[];
    result: RouteResult | null;          // null if re-routing failed → trip flagged, not published
    eta: EtaModel;
  }[];
  unassigned: Unassigned[];
  kpis: { vehicles: number; totalDistanceM: number; avgRideS: number; maxRideS: number;
          avgWalkM?: number; occupancyPct: number; costEstimate?: number | null };   // null without configured inputs
  violations: { kind: string; tripIndex?: number; passengerId?: string; detail: string }[]; // soft only
}
```

**Degraded mode rules (Proposed, aligned with plan §3.2 / §7):**
1. When `Result.ok === false` the caller shows "routing unavailable (reason)" and **never** substitutes a
   straight-line distance, a proportional split (`fillLegs` does this today for route legs, so ETMS must not use it
   for user-facing numbers) or a default speed.
2. Bookings, rosters and manual dispatch never wait on routing. A trip published manually without a road path keeps
   `path = null`, as v1.8.0 already allows, and is labelled "no road ETA".
3. The live tracker's `live_heuristic` ETA may be shown to staff with that label. Employees see it only when the
   last fix is under N minutes old (proposed 3 min); otherwise "ETA unavailable". This needs the staleness rule in
   §1.1.
4. Every optimise job is revalidated before publishing: vehicle, driver, passengers and agreement are still valid,
   and the graph version is unchanged or legs are re-routed.

---

## 4. Problem formulations (Proposed)

### 4.1 Common inputs

| Input | Source (proposed owner of data) | Hard / soft |
|---|---|---|
| Passenger home / approved pickup point, destination site, shift start / end | Passenger profile + booking (Agent 1 models) | data |
| Direction: **login** (homes → site, arrive before shift start) / **logout** (site → homes, depart after shift end) | Booking / roster | data |
| Vehicles: type, seats, wheelchair spaces, escort / guard on board, operating zone, start depot / garage, availability window | Vehicle + provider masters (reuse `TrackedObject` / vehicle masters per Agent 1) | hard |
| Drivers: qualification, duty limit, rest | Driver master (reuse) | hard |
| Shuttle stops: location, accessible flag, max boarding, dwell | New stop master (or v1.8.0 geofence/place) | hard / data |
| Policy: max walk (m), max ride (min), max pickup delay, gender / night rules, first-pickup / last-drop rules | Customer policy per service agreement | hard |
| Cost: per-km, per-vehicle-day, per-hour | Provider config. If absent, no cost KPI | soft objective |

**Hard constraints** (never relaxed by the solver):
- seat capacity, wheelchair spaces and vehicle accessibility
- vehicle–passenger compatibility (zone, agreement, vehicle type)
- driver duty and availability
- arrival at site ≤ shift start − buffer (login) / departure ≥ shift end (logout)
- max ride time
- safety-policy rules (§4.5)

**Soft objectives** (weighted, configurable):
- fleet count (fixed cost per vehicle)
- total distance or time
- passenger ride time
- walking distance
- empty km (garage legs)
- early arrival / waiting

### 4.2 Door-to-door

A capacitated VRP with time windows per direction and site.

- **Nodes:** one node per passenger pickup (login) or drop (logout). Co-located passengers within a few metres
  merge into one node with demand = headcount and `board[]` listing them.
- **Login.** Each vehicle starts at its garage (or anywhere, start-free) and **ends at the site**. Site window:
  `[shiftStart − maxEarly, shiftStart − buffer]`. Pickup windows come from the policy: earliest pickup ≥
  shiftStart − maxRide − slack.
  - Max ride time per passenger (hard): ride = site arrival of the vehicle − pickup time. Recommended modelling:
    solve the login as the **reverse** of a drop problem on the **transposed** matrix. Vehicles then start at the
    site and the ride-time bound becomes `Cumul(node) − Cumul(Start(v)) ≤ maxRide`, a per-node constraint OR-Tools
    supports directly. Arrival times are then shifted back from the site deadline.
  - Must be prototyped and unit-tested before it's trusted.
- **Logout.** Vehicles start at the site at `shiftEnd + release`. `Cumul(node) − Cumul(Start) ≤ maxRide` applies
  directly.
- **Multiple sites or mixed directions in one vehicle:** pickup-and-delivery pairs (`AddPickupAndDelivery` plus
  same-vehicle and precedence constraints). This is out of the first release.
- **Individual journeys** (policy "no pooling" or special needs): the passenger node may only be served by a
  vehicle that gets no other node. Model: give the node demand = vehicle capacity on a dedicated vehicle type, or use
  allowed-vehicles to a single-occupancy class.

### 4.3 Roadside shuttle: two stages

**Stage 1, passenger → stop assignment.** This is a capacitated facility-location problem (p-median with
coverage).

- **Candidates.** Approved shuttle stops within `maxWalkM` of each passenger by **foot-network distance**. Prefilter
  candidates by straight line, then confirm with the foot matrix. Straight line is only a filter and is never shown.
- **Constraints (hard):**
  - walk ≤ `maxWalkM`
  - accessible stop for passengers who need one
  - stop boarding capacity
  - a passenger with no feasible stop gets `NO_STOP_WITHIN_WALK` and is offered door-to-door if policy allows
- **Objective:** minimise Σ walk + λ × (number of opened stops) + μ × (detour of opened stops from the corridor).
  Solve with OR-Tools CP-SAT / MIP, or a greedy + local search; sizes are small (stops × passengers ≤ about 10⁵
  pairs).
- **Without a GH `foot` profile**, walking distance can't be routed. In that case only fully manual stop assignment
  (dispatcher picks the stop) is honest; the system would not display a computed walking distance.

**Stage 2, VRP over opened stops.** The §4.2 model with nodes = opened stops, demand = assigned headcount, service
time = dwell (fixed + per-boarding seconds), time windows from the earliest-shift passenger at that stop.

Optional iteration: re-assign passengers whose stop was left unserved, then re-solve. Cap at 2 iterations.

### 4.4 Mixed fleet

- **Heterogeneous vehicles in one solve:** per-vehicle capacity, fixed cost per vehicle type (`SetFixedCostOfVehicle`)
  and allowed-vehicles per node, e.g. narrow-lane homes → car / van only. Narrow lanes need a GH `van` / `bus`
  profile to be detected; otherwise it's a dispatcher-maintained flag on the pickup point.
- **Scenario comparison (plan §13):** run the same input as cars-only, vans-only, shuttle and mixed, with identical
  matrices, policies and time limits. Compare the `PlanProposal.kpis`. No cost figure without configured cost
  inputs. ETAs labelled uncalibrated until GH calibration exists.

### 4.5 Safety-policy hooks (hard constraints, configurable per customer agreement)

| Policy (examples; owner / Agent 6 to confirm the legal list) | Modelling |
|---|---|
| Night window: a female passenger may not be first picked up / last dropped unless an escort is on board | Escort is a vehicle attribute. For vehicles without an escort, forbid `Next(node) == End(v)` (logout) / `Next(Start(v)) == node` (login) for flagged nodes: `solver.Add(...)` on `NextVar` with `VehicleVar` |
| Escort seat consumes capacity | Reduce the vehicle's seat capacity by 1 when the escort flag is set |
| Grouping restrictions (e.g. certain passengers not in the same vehicle, or must ride together) | Same-vehicle / different-vehicle constraints on `VehicleVar` |
| Wheelchair | Second capacity dimension (wheelchair spaces) + allowed-vehicles |
| Max ride time | §4.2 per-node bound |
| Driver duty | Vehicle span upper bound (already `maxDurationS` in `solver.py`) + break intervals later |
| Service agreement / zone | Allowed-vehicles per node, computed before solving |

Each rule is a named, versioned **policy hook**: a pure function from passenger/vehicle data to solver constraints,
plus a validator that re-checks the published trip. It's unit-tested in isolation, and the dispatcher's manual
edits are re-validated against the same rules.

### 4.6 Explaining unassigned passengers

Extend the branch's `OptimizeUnassignedReason` from per-stop to **per-passenger** reasons, with structured details:

| Reason code | Detected | Detail payload |
|---|---|---|
| `NO_STOP_WITHIN_WALK` | Stage 1 | nearest stop + foot distance |
| `NOT_ON_ROAD` / `OUTSIDE_COVERAGE` | locate (branch has these) | snap distance |
| `NO_COMPATIBLE_VEHICLE` | pre-check (accessibility, zone, agreement, type) | which attribute failed |
| `SHIFT_WINDOW_UNREACHABLE` | pre-check (direct ride from garage / site misses the window) | direct time vs window |
| `MAX_RIDE_UNACHIEVABLE` | pre-check (direct ride > max ride) | direct time vs limit |
| `SAFETY_RULE` | pre-check or post-solve: only possible position is forbidden (e.g. last drop without escort) | rule id |
| `CAPACITY_EXHAUSTED` | post-solve: feasible alone, dropped for capacity | fleet seats vs demand |
| `TIME_LIMIT` | post-solve: solver didn't place it in time | suggestion: longer limit / more vehicles |
| `ROUTING_UNAVAILABLE` | matrix cell `null` from a degraded engine | degraded reason |

The branch's `_pre_infeasible` in `solver.py` is the right pattern. It's extended per constraint above.

---

## 5. Integration with v1.8.0 Routes / PlannedTrip (Proposed)

**Recommendation: publish into `PlannedTrip` / `PlannedTripStop` and reuse the tracker. Do not create parallel trip
tables for vehicle movement. Add passenger and plan linkage in new tables.** The DB design itself belongs to Agent 1
(`03-database-model-inventory-and-reuse.md`); these are the routing-side requirements.

| Concern | v1.8.0 today | ETMS need | Proposal |
|---|---|---|---|
| Trip skeleton | `PlannedTrip` (vehicle, driver, planned start / end, snapshot path, stops) | Same | **Reuse** |
| Required `routeId` | Required FK to a master `Route` (unique name per company, shown in Masters → Routes) | Daily optimised trips aren't masters | Option 1: generated `Route` with `source='ETMS'` (hidden from Masters by default) per recurring roster pattern, which fits `RouteSchedule` for stable rosters. Option 2: relax `PlannedTrip.routeId` to nullable (a widening change) and add `routePlanId`. **Prefer option 1 for recurring rosters and option 2 for daily ad-hoc plans**; Agent 1 decides |
| Stop times | `RouteStop.offsetMin` / `waitMin`; snapshot copies to `PlannedTripStop.plannedArrival` / `plannedDeparture` | Optimiser times per stop | Write `PlannedTripStop` directly from `PlanProposal.trips[].stops` via `insertTrip`-like code; the snapshot builder already accepts per-stop offsets |
| Passengers per stop | None | Manifest: who boards / alights at which seq, booking id, boarding status (boarded / no-show), OTP / check-in | **New table** (e.g. `TransportTripPassenger(tripId, stopSeq, passengerId, bookingId, action, status, …)`), keyed to `PlannedTripStop` by `(tripId, seq)` |
| Direction / shift | None | login / logout, shift id, site | New nullable columns on `PlannedTrip` or a 1:1 `TransportTripMeta` |
| Plan → trips | None | Proposal, versions, publish, audit | Salvage the branch's `RoutePlan` + `RoutePlanVersion` concepts, renamed (§6). Publishing creates `PlannedTrip`s in one transaction and calls `PlannedTripsService.invalidate(companyId)` |
| Idempotent publish | Generator uses `@@unique([scheduleId, plannedStart])` | Re-publish must not duplicate | Unique `(routePlanId, planVersion, vehicleId, direction)` or the publish key on the new meta table |

> **Validation note (E0 review):** Two corrections. (1) `PlannedTrip.routeId` is a required column (`schema.prisma` l.2723) but **not an FK**: `PlannedTrip` has no relation to `Route` (`01` §10), so `DROP NOT NULL` is DDL-trivial and the risk is the ~72 code references in 15 files (`03` §3). (2) Option 1 relies on `Route.source='ETMS'`, a column that does not exist on `Route`. Adopted: nullable `routeId` + `origin` for ETMS trips; fixed shuttles keep real `Route`s; door-to-door rosters via "repeat to date" drafts (README §6, owner decision P2).

**Live progress reuse (Verified mechanism, Proposed extension):**
- `PlannedTripTracker` (processor) already gives arrival / departure per stop radius, skipped stops, deviation
  against the snapshot path, unscheduled stops, next-stop ETA and delay, and alerts `TRIP_STOP_LATE` /
  `TRIP_STOP_SKIPPED` / `ROUTE_DEVIATION` / `TRIP_NOT_STARTED`. It consumes the **existing validated fix stream**,
  so ETMS needs no second telemetry path (brief question 6).
- Extensions needed:
  - **ETA to every downstream stop** for the employee app: next-stop ETA + planned leg durations from the snapshot,
    labelled `live_heuristic` + uncalibrated
  - **staleness** (no fix for N min → ETA null)
  - **door-to-door radius** defaults (the 100 m `radiusM` default is tight for gated communities; per-stop radius
    from the pickup point)
  - **boarding events from the driver app**, which aren't GPS-derived and must not be inferred from radius entry
- Deviation corridor: `corridorM` per trip still applies. Door-to-door trips in narrow streets may need a smaller
  corridor; that's tuning, not new code.

---

## 6. Salvage from `feature/routing-engine` and what to drop (Proposed)

**Merge reality (Verified):**
- `git merge-tree origin/main feature/routing-engine` reports conflicts in five files:
  - `apps/api/prisma/schema.prisma`
  - `apps/web/src/features/shell/nav.ts`
  - `ops/deploy/windows/deploy-release.ps1`
  - `packages/shared/src/index.ts`
  - `packages/shared/src/permissions.ts`
- The branch migration `20261110110000_routing_engine_v2` runs `CREATE TABLE "RouteStop"`, and main's
  `20261113090000_routes_planned_trips` already created `"RouteStop"`. On a production database the branch migration
  **would fail**.
- Both branch migrations are timestamped before main's later migrations (`20261112*`, `20261113090000`), so they
  must be re-timestamped.
- The branch base is release 1.3 (78 main commits behind).

| Item | Decision | Why |
|---|---|---|
| `services/routing-optimizer` (solver, server security, slots / 429, pytest) | **Salvage** and extend (§4) | Engine-agnostic, tested, secure-by-default |
| `RoutingJob` + `jobs.service.ts` + `routing-worker` process (claim / lease / idempotency / cancel / sweeper) | **Salvage** | Exactly what plan §7 "recoverable, idempotent optimisation jobs" needs; real-process tests |
| `RoutingUsage` metering, `ROUTING_LIMITS` pattern, error codes, capabilities shape | **Salvage** (adapt to `RoutingProvider`) | Fits §3 |
| `eta.ts` labelling (`NO_LIVE_TRAFFIC_NOTICE`, `UNCALIBRATED_ETA_NOTICE`, `calibrated:false`) | **Salvage labels; drop the 1.60 factor** | Factor fitted against Valhalla free-flow; invalid for GH |
| `private-url.ts`, optimiser token + allow-list, `API_HOST` (`config/api-host.ts`) | **Salvage** (API_HOST as its own small PR; RR-41 notes it changes bind defaults; production Caddy proxies to localhost) | Security hardening independent of routing |
| `share-eta.ts` RR-14 fix | **Salvage immediately** (live bug, §1.1) | Production now has GH on |
| India coverage polygon (`service-area/coverage.ts`) | Salvage | Cheap input validation |
| `access.service.ts` (`route_plans` presets, driver own routes, audited support) | Salvage concepts; **reconcile** with v1.8.0 `routes` / `plannedTrips` menu keys and Agent 6's ETMS permission model | `permissions.ts` conflict |
| `RoutePlan` / `RouteAssignment` / `RoutePlanVersion` | Salvage the **design**, re-model under new names (e.g. `TransportPlan`, `TransportPlanVehicle`, `TransportPlanVersion`) and point publishing at `PlannedTrip` | Plan-before-publish is right. Its own assignment / stop tables duplicate `PlannedTrip` after publish |
| Branch `RouteStop` model | **Drop / rename** (e.g. `TransportPlanStop`) | Name and table clash with v1.8.0 `RouteStop` |
| `valhalla.adapter.ts`, `ops/routing/*` Valhalla pipeline, Valhalla proxy | **Park** (keep on the branch as the M4 fallback reference; don't merge) | Second engine; not needed unless GH matrix fails |
| Web route planner (`RoutePlannerPage.tsx`, `PlanEditor.tsx`) | Salvage UI pieces (map colouring per vehicle, job progress / cancel, edit history) into the ETMS dispatcher (Agent 3) | Built for generic stops, not passengers |
| Geocoder evaluation corpus (`ops/routing/geocoder/*`) | Keep as test data for pickup-address QA | Photon is already in production; G4 / G6 findings still apply to address quality |
| E2E hosting benchmark kit, hosting-options, cost-estimate | Drop | Premise (separate paid routing host) superseded by the 27 GiB server |

> **Validation note (E0 review):** Contradicts D3 and is internally inconsistent with this doc's own R-2 (which names only `RouteStop` as the clash). D3 keeps `RoutePlan`, `RouteAssignment`, `RoutePlanVersion`, `RoutingJob`, `RoutingUsage` and renames **only the conflicting `RouteStop`** (working name `RoutePlanStop`), and only after reviewing schema ownership, migration history and FK dependencies (`02` §3.1; `12` §7 WP 4.0). "Park" for the Valhalla adapter is replaced by "out of scope" (D3).

**Rebase plan (Proposed; do not start in E0):**
1. Cut a new branch from `origin/main` (v1.8.0). **Don't rebase the 38 commits.** Cherry-pick or port by area in
   this order: (a) RR-14 share-eta fix; (b) `API_HOST`; (c) optimiser service as-is; (d) `RoutingProvider` + GH
   implementation wrapping current `RoutingService` (no behaviour change, existing specs green); (e) GH matrix
   builder M1 + cache; (f) jobs / worker / usage with the new table names; (g) ETMS plan models (Agent 1's migration,
   new timestamp after `20261113090000`).
2. Keep everything behind flags that default off: `ROUTING_ENGINE_V2` on the API (or a new `ETMS_ROUTING` flag) and
   `routingV2` / ETMS on the web.
3. Leave the original branch untouched as an archive. Push it to a private remote ref only if the owner approves;
   today it exists only on the dev PC (**risk: single copy**).

**Risks:**
- R-1: losing the only copy of the branch (local-only)
- R-2: schema clash merged by mistake (RouteStop)
- R-3: GH `/route` fan-out too slow or too CPU-heavy on the shared 6 vCPU server, competing with live tracking
  ETAs and map matching
- R-4: GH re-import for the foot / van profiles = 30–60 min without routing, and unknown extra RAM
- R-5: OR-Tools Python callbacks too slow above ~500 nodes
- R-6: safety-policy constraints mis-modelled (hard rules silently soft)
- R-7: uncalibrated ETAs presented as commitments to employees
- R-8: OSM pickup-point quality in Indian residential areas (RR-04)

---

## 7. Capacity on the production server (Estimates, to be benchmarked)

Assumptions:
- 6 vCPU shared with API, processor, gateway, PostgreSQL, GH and Photon
- OR-Tools routing search is effectively **single-threaded per solve**
- a solve holds its slot for the whole time limit (branch P4.2: capacity = slots × 3600 / limit)
- matrix built by M1 at 4 requests in flight with 2–10 ms per CH query (unmeasured)

| Passengers in one planning window (one site, one direction) | Nodes per solve | Full matrix cells | M1 full matrix time (Estimate) | Sparse k=40 + depot legs | Matrix JSON | Solver RAM (Estimate) | Time limit |
|---|---|---|---|---|---|---|---|
| 200 door-to-door | ~200 | 40k | 20–100 s | ~8.4k calls, 5–20 s | ~0.6 MB | < 300 MB | 30–60 s |
| 500 door-to-door | ~500 | 250k | 2–10 min | ~21k calls, 15–55 s | ~3.5 MB | 0.3–1 GB | 60–120 s |
| 1,000 door-to-door | split into 3–5 zones of ≤ 300 | 5 × 90k | 2–8 min total | ~42k calls | ≤ 1.3 MB per zone | ≤ 0.5 GB per zone | 60 s per zone |
| 2,000 shuttle (→ ~150–300 opened stops) | ≤ 300 stops | 90k | 1–4 min | ~12k calls | ~1.3 MB | < 0.5 GB | 60 s |
| 2,000 door-to-door | zones of ≤ 300 (7+) | — | cache-dominated | ~84k calls first run; mostly cached on later days | — | sequential, 1 slot | 60 s per zone |

Notes:
- The existing solver caps (`LIMITS` 600 locations; server `MAX_BODY` 8 MB) fit a 600 × 600 matrix (~5 MB JSON).
  Anything larger must be decomposed, which is also better for solution quality within the time limits.
- Matrix cells for **stable** home and stop locations are cacheable per graph version (Estimate: > 90 % hit rate on
  daily re-plans). Only new or changed passengers cost new GH calls. Proposed cache: Valkey hash per
  `(graphVersion, profile)`, or a PostgreSQL table if Valkey memory matters.
- **Production limits (Proposed):**
  - optimiser `OPTIMIZER_CONCURRENCY=1` (at most 2), as a systemd unit with `CPUQuota=150%`, `MemoryMax=3G`, `Nice=10`
  - matrix fan-out ≤ 4 in flight, paused when GH p95 for `/route` exceeds a threshold, to protect tracker ETAs,
    History and map matching
  - planning windows scheduled off-peak where possible (night before)
- Switching `solver.py` from Python callbacks to `RegisterTransitMatrix` should cut solve overhead substantially
  for N > 300. This is an Estimate and needs a benchmark (B5 below).

**Benchmark plan.** Run all of these on a non-production machine with the same GH 11.1 India graph and config, using
synthetic passengers only. Production runs only with owner approval, off-peak, and read-only against GH.

| ID | Benchmark | Pass target (proposed) |
|---|---|---|
| B1 | GH `/route` latency, `calc_points=false`, urban pairs Chennai / Bengaluru / Delhi NCR, c1 / c4 / c8 | p95 < 20 ms at c4 |
| B2 | M1 full matrix 100 / 200 / 400 nodes; CPU-seconds per matrix | 200 × 200 < 60 s |
| B3 | M1 sparse k = 20 / 40 / 60: solution-quality loss vs full matrix (OR-Tools objective) | < 3 % worse |
| B4 | OR-Tools solve, door-to-door 100 / 200 / 300 / 500 nodes, 10 / 30 / 60 / 120 s, RSS and objective curve | 300 nodes FEASIBLE, 0 hard-constraint violations in 60 s |
| B5 | Python callback vs `RegisterTransitMatrix` | measure |
| B6 | Mixed load: B2 running while replaying tracker ETA + map-matching traffic at production rates | tracker `route` p95 not > 2× baseline |
| B7 | Stage-1 stop assignment, 2,000 passengers × 300 stops (needs `foot` profile) | < 60 s |
| B8 | GH re-import with `foot` (+ `van`) profiles: build time, heap needed, graph size | fits within `-Xmx8g` + 2 GB, or owner decides |
| B9 | ETA calibration for GH (consented staff drives per branch `eta-test-drive-programme.md`) | per-band MAPE reported; bands without data stay uncalibrated |

---

## 8. Open questions for the owner

1. **Engine:** do you approve GraphHopper as the only road engine for ETMS (Option A), with Valhalla parked as a
   written fallback? Valhalla is deployed only if the GH matrix benchmarks fail.
2. **GH profiles:** may we plan a GH re-import to add a `foot` profile (walking to shuttle stops) and possibly a
   `van` / `bus` profile? It means 30–60 min without routing during the off-peak re-import, plus extra RAM measured
   first on a non-production machine.
3. **Headroom:** how much RAM and CPU may an OR-Tools worker use on the production server (proposed ≤ 3 GB,
   ≤ 1.5 cores)? Or should optimisation run on another machine you own?
4. **Branch custody:** may `feature/routing-engine` / `feature/routing-r0` be pushed to a private remote ref as an
   archive? Today they exist only on the dev PC.
5. **Live bug:** fix the public share-page ETA line (lat and lng swapped, RR-14) in a v1.8.x patch, separate from
   ETMS?
6. **Safety rules:** which night-shift / women-safety rules are mandatory for India customers (first pickup / last
   drop, escort, OTP)? Which US rules apply? They become hard constraints (§4.5).
7. **ETA promises:** what may employees see while ETAs are uncalibrated: a time with the "estimate, no live traffic"
   label, a window (e.g. ±10 min), or nothing until calibration?
8. **Recurring rosters vs daily plans:** publish stable rosters as generated `Route` + `RouteSchedule` (reusing the
   v1.8.0 generator) and daily changes as one-off trips? Or always daily trips from a plan?
9. **Walking distances without a foot profile:** if (2) is refused, is manual stop assignment by dispatchers
   acceptable for the first release?
10. **Planning cadence:** night-before batch only, or also intra-day re-optimisation (ad-hoc bookings, no-shows)?
    This sets the matrix-latency target.
