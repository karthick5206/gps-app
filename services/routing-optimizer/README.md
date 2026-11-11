# routing-optimizer

OR-Tools vehicle-routing solver for VeeTrax ETMS (E4: WP 4.3a port, WP 4.3 extensions, WP 4.4 corpus). It solves
vehicle routing on a **matrix the caller supplies**. It never calls a routing engine: the API builds the matrix from
GraphHopper (ETMS README §5 D3: GraphHopper is the only road engine; Valhalla is out of scope). Ported from
`feature/routing-engine` with `valhalla.py`, `cli.py --valhalla` and the bench's Valhalla mode removed (doc 17 §5.1).

Manual dispatch never depends on this service. When it is stopped, busy or failing, the API reports the optimiser as
unavailable; it never substitutes a heuristic plan or invented times.

## Run

Python **3.14** is required (`ortools==9.15.6755` is the release with cp314 wheels). Dependencies are pinned with
sha256 hashes in `requirements.lock` (`requirements.txt` / `requirements-dev.txt` are the human-edited top-level pins).
WP 4.3 / 4.4 added no dependency.

```bash
python3.14 -m venv ~/.venvs/routing-optimizer
~/.venvs/routing-optimizer/bin/pip install --require-hashes --no-deps --only-binary=:all: -r requirements.lock

# tests (no network), including the 36-scenario corpus
~/.venvs/routing-optimizer/bin/python -m pytest

# corpus runner: PASS/FAIL + timing per scenario, "CORPUS n/n PASS"; exit 1 on any FAIL
~/.venvs/routing-optimizer/bin/python -m corpus_run [--only 09] [--json results.json] [--record]

# HTTP server, loopback only by default
OPTIMIZER_TOKEN=$(cat ~/.config/veetrax/optimizer.token) ~/.venvs/routing-optimizer/bin/python -m optimizer.server

# one-off solve from a file (or - for stdin); exit 0 = FEASIBLE/OPTIMAL, 2 = otherwise
~/.venvs/routing-optimizer/bin/python -m optimizer.cli problem.json --pretty

# solver timing on synthetic matrices (benchmark input only, never an ETA); --matrix adds a GraphHopper-built one
~/.venvs/routing-optimizer/bin/python -m bench_optimizer [--matrix matrix.json]
```

`./run.sh` (WSL) does the venv, the locked install and starts the server; `./run.sh test` runs pytest and
`./run.sh corpus` the corpus runner. It keeps a generated token in `~/.config/veetrax/optimizer.token` (mode 0600,
outside the repository).

### Server settings

| Variable | Default | Meaning |
|---|---|---|
| `OPTIMIZER_TOKEN` | none (**required**) | ≥ 24 characters, or the server refuses to start. Every request sends `Authorization: Bearer <token>` (constant-time compare). |
| `OPTIMIZER_HOST` / `--host` | `127.0.0.1` | Bind address. A non-loopback bind must be set explicitly. |
| `OPTIMIZER_PORT` / `--port` | `8090` | |
| `OPTIMIZER_ALLOW` | `127.0.0.1/32,::1/128` | Source CIDR allow-list; others get 403 before the body is read. |
| `OPTIMIZER_CONCURRENCY` | `2` | Solves at once; further requests get 429 (the caller retries later). The slot is taken before the body is read. |
| `OPTIMIZER_RESULT_GRACE_S` | `30` | A solve that has not answered after `timeLimitS` + this is killed (workers terminated, pool rebuilt) and answered 503. |
| `OPTIMIZER_MAX_CONNECTIONS` | `16` | Handler threads at most; further connections are closed at once. Every connection has a 30 s socket timeout. |

Endpoints: `GET /health` → `{ok, ortools, limits, slots, busy}`; `POST /optimize` (body ≤ 8 MB) → the result below,
HTTP 400 (JSON, `INVALID_INPUT`) for any malformed request (bad `Content-Length`, invalid or more than 32 levels deep
JSON, wrong option types, input that made the worker raise), **503** if the solver worker process died (e.g. killed by
`MemoryMax`) or overran its time limit (the pool is rebuilt for the next request), JSON 500 for anything else, 200
otherwise. A request is never answered by dropping the connection. The access log has one line per request and never logs bodies or
headers.

Each solve runs in a **worker process** (`spawn`, pool size = `OPTIMIZER_CONCURRENCY`, recycled every 50 solves).
The solver registers C++ transit matrices (`RegisterTransitMatrix`), and OR-Tools then holds the GIL for the whole
search; solving inside the HTTP process would stall `/health` and the 429 path.

## Input / output contract (v2)

**Versioning.** Input `schemaVersion` is optional: `1` (default, the P3 contract) or `2`; anything else is
`INVALID_INPUT`. Every result carries `schemaVersion: 2`. v2 is **additive**: a v1 problem solves exactly as before
(same model, same semantics), and the result only gains fields. The one visible change for v1 callers: each
`unassigned` entry gains `code` (and `passengerIds` / `detail` when relevant). The v2 fields below may be sent with
either `schemaVersion`; send `2` so logs show which contract the caller used.

Times are integer seconds from a plan epoch the caller chooses (the API uses "seconds since plan start"); all must
be within `[0, horizonS]`.

### Problem

```jsonc
{
  "schemaVersion": 2,
  "matrix": {                                         // REQUIRED; built by the API from GraphHopper
    "durationsS": [[0, 420, null], [400, 0, 380], [null, 390, 0]],  // n x n, n <= 600; null = no road (forbidden arc)
    "distancesM": [[0, 3100, null], [2900, 0, 2500], [null, 2600, 0]] // optional, same shape
  },
  "horizonS": 86400,                                  // optional, default 24 h

  // v2: one site, one direction (doc 06 §4.2). Omit "trip" for the v1 generic VRP.
  "trip": {
    "direction": "IN",            // "IN" = login (homes -> site), "OUT" = logout (site -> homes)
    "siteIndex": 0,               // matrix index of the site
    "siteWindow": [27000, 28200], // IN: allowed site ARRIVAL [shiftStart - maxEarly, shiftStart - buffer]
                                  // OUT: allowed site DEPARTURE [shiftEnd + release, latest departure]
    "maxRideS": 5400              // optional default max ride per stop (doc 06 §4.1 policy "max ride")
  },

  "vehicles": [{                                      // 1..50
    "id": "v1",
    "startIndex": 3,              // garage / current position; null = open start (route begins at first pickup).
                                  // Missing = 0 (v1 default) -- in trip mode always send it explicitly.
    "endIndex": 3,                // v1 / OUT: where the route ends; null = open end (ends at the last drop).
                                  // Missing = startIndex (v1 default). IN: ignored (the route ends at the site).
    "capacity": 6,                // seats for passengers; omitted = unlimited
    "type": "suv6",               // v2: matched against stop.allowedVehicleTypes
    "wheelchairSpaces": 1,        // v2: second capacity (doc 06 §4.5), default 0
    "escort": false,              // v2: escort / guard on board
    "escortUsesSeat": true,       // v2: default true -> usable seats = capacity - 1 when escort is true
    "timeWindow": [0, 36000],     // availability: IN = garage departure >= start, site arrival <= end;
                                  // OUT = at the site no earlier than start + deadhead, route end <= end
    "maxDurationS": 7200,         // route-duration cap (driver duty). IN: garage departure -> site arrival;
                                  // OUT: site departure -> route end (deadhead to the site not included)
    "fixedCost": 20000,           // v2: cost when the vehicle is used; default options.weights.vehicle
    "distanceWeight": 2,          // v2: per-vehicle override of options.weights.distance
    "timeWeight": 0               // v2: per-vehicle override of options.weights.time
  }],

  "stops": [{                                         // 0..500; one node per pickup (IN) / drop (OUT)
    "id": "s1", "locationIndex": 1,
    "passengerIds": ["emp1", "emp2"], // v2: co-located passengers merged into one node (doc 06 §4.2)
    "demand": 2,                  // seats; default = len(passengerIds), else 0 (v1)
    "serviceS": 60,               // boarding / alighting time, default 0
    "timeWindows": [[600, 1200]], // optional; real (forward) pickup / drop times, one or more
    "priority": 1,                // drop-penalty weight (>= 1)
    "maxRideS": 4800,             // v2: overrides trip.maxRideS; needs trip
    "wheelchair": 1,              // v2: wheelchair spaces needed, default 0
    "allowedVehicleIds": ["v1"],  // v2: only these vehicles (unknown ids simply never match)
    "allowedVehicleTypes": ["car4", "suv6"], // v2: e.g. narrow lanes (doc 06 §4.4)
    "requiresEscort": false,      // v2: only vehicles with escort=true (doc 10 §5.3 "escort requirement")
    "escortIfFirstOrLast": false, // v2: not the FIRST pickup (IN) / LAST drop (OUT) of a vehicle without escort
                                  //     (doc 06 §4.5 / doc 10 §5.3 "night drop"); needs trip
    "pinnedVehicleId": "v1",      // v2: keep this assignment (manual edit); reported if impossible
    "customerId": "acme",         // v2: one customer per vehicle unless options.allowMixedCustomers (P2, R1)
    "exclusive": false            // v2: individual journey, no pooling (doc 06 §4.2)
  }],

  "options": {
    "timeLimitS": 10,             // 1..120; covers the WHOLE solve (model build + search)
    "objective": "time",          // v1 only, used when "weights" is absent: "time" | "distance"
    "weights": {                  // v2 (P6: no overall winner without configured weights). Cost =
      "vehicle": 20000,           //   sum(vehicle fixed cost) + sum(distance * distanceM + time * durationS per arc)
      "distance": 1,              //   + routeDuration * route span (incl. waiting).
      "time": 0,                  // At least one of distance / time / routeDuration > 0; distance needs distancesM.
      "routeDuration": 0          // "vehicles first, then distance": make vehicle >> distance x typical route m.
    },
    "allowMixedCustomers": false, // v2
    "deterministic": false,       // v2: true -> greedy descent to a local optimum (reproducible), see below
    "seed": 7,                    // v2: solver.ReSeed(seed); reported, but routing search has little randomness
    "localSearch": "guided",      // "guided" (default) | "greedy" | "tabu" | "annealing"; anything else = OR-Tools default
    "firstSolution": "path_cheapest_arc", // v2: | "parallel_cheapest_insertion" | "savings" | "automatic"
    "solutionLimit": null,
    "transit": "matrix"           // v2: "matrix" (default, C++ transit matrices) | "callback" (P3 Python callbacks, B5 only)
  }
}
```

Hard constraints are never relaxed: a stop is either served with every constraint satisfied or reported in
`unassigned`. Drop penalties are raised automatically above any possible routing cost, so a passenger is never
dropped to save a vehicle or distance; a pinned stop costs 100 x more to drop than a free one.

**How the trip directions are modelled** (doc 06 §4.2, "must be prototyped and unit-tested"): `OUT` routes start
at the site; `IN` is solved as the reverse of a drop problem on the transposed matrix, with vehicles starting at the
site at model time `R = T - t` (`T` = latest allowed arrival). In both, a stop's ride time is
`Cumul(stop) - Cumul(Start(v))`, enforced by a `Ride` dimension whose slack is tied to the time slack. Ride time is
measured as **IN**: site arrival − pickup service start (includes the passenger's own boarding time and any waiting);
**OUT**: drop service start − site departure.

### Result

```jsonc
{
  "schemaVersion": 2,
  "trip": { "direction": "IN", "siteIndex": 0, "siteWindow": [27000, 28200] },   // v2, only for trip problems
  "status": "FEASIBLE",            // FEASIBLE | OPTIMAL | NO_SOLUTION | INVALID_INPUT
  "provenOptimal": false,          // true only when OR-Tools proves it (status OPTIMAL)
  "solverStatus": "ROUTING_SUCCESS", // or NOT_RUN when nothing passed the pre-checks
  "objective": 1234,
  "objectiveBreakdown": { "vehiclesUsed": 3, "totalDistanceM": 41200, "totalDurationS": 9100, "fixedCost": 60000,
                          "dropPenalty": 0 },        // v2
  "weights": { "vehicle": 20000, "distance": 1, "time": 0, "routeDuration": 0 },  // v2, null without weights
  "routes": [{
    "vehicleId": "v1",
    "startS": 25100,               // garage departure (IN, v1) / site departure (OUT); open start = first pickup
    "endS": 28200,                 // site arrival (IN) / arrival at endIndex or last drop (OUT, v1)
    "durationS": 3100, "distanceM": 15600, "load": 5,
    "seats": 5, "escort": true, "wheelchairLoad": 0, "fixedCost": 20000,          // v2
    "siteArrivalS": 28200, "waitBeforeSiteS": 0,     // v2, IN only
    "siteDepartureS": 64800, "deadheadToSiteS": 600, // v2, OUT only (instead of the two above)
    "locationSequence": [3, 7, 9, 0],                // real (forward) order; open start/end omitted
    "stops": [{ "stopId": "s1", "locationIndex": 7, "passengerIds": ["emp1"], "arrivalS": 25500,
                "serviceStartS": 25500, "waitS": 0, "departureS": 25560, "load": 1,
                "onBoard": 1, "rideS": 2700, "maxRideS": 5400 }]   // onBoard / rideS / maxRideS: v2, trip only
  }],
  "unassigned": [{ "stopId": "s9", "reason": "max_ride_unachievable", "code": "MAX_RIDE_UNACHIEVABLE",
                   "passengerIds": ["emp9"], "detail": { } }],
  "unusableVehicles": [{ "vehicleId": "v7", "reason": "availability_outside_site_window" }],   // v2
  "stats": { "wallTimeMs": 1012, "timeLimitS": 10, "stops": 2, "vehicles": 1, "vehiclesUsable": 1,
             "matrixNullCells": 0, "stoppedBy": "local_optimum", "deterministic": true, "searchTimeLimitMs": 9990 },
  "note": "Best solution found within the time limit; not proven optimal."
}
```

- Every stop appears **exactly once**: in a route or in `unassigned`. `INVALID_INPUT` adds `error`; a problem without a
  matrix is always refused.
- `load` is the cumulative seats served (v1 meaning); `onBoard` is the occupancy after the stop (OUT counts down).
- `distanceM` is `null` when no `distancesM` was sent. Times in the result come from matrix cells; the API re-routes
  each leg with the routing provider before showing distances or times to users (doc 06 §3, rule RD-39).
- `unusableVehicles` reasons: `invalid_availability_window` (v1), `availability_outside_site_window`,
  `cannot_reach_site` (OUT: null cell from `startIndex` to the site).

**Unassigned reasons** (`reason` keeps the P3 names; `code` is the doc 06 §4.6 code; (ext) = added to that table):

| `reason` | `code` | When | `detail` |
|---|---|---|---|
| `invalid_time_window` | `INVALID_TIME_WINDOW` (ext) | every window has start > end | — |
| `no_vehicle_available` | `NO_COMPATIBLE_VEHICLE` | no usable vehicle at all | `{failed: ["availability"]}` |
| `demand_exceeds_vehicle_capacity` | `NO_COMPATIBLE_VEHICLE` | demand > every vehicle's seats | `{failed: ["seats"]}` |
| `no_compatible_vehicle` | `NO_COMPATIBLE_VEHICLE` | ids / types / seats / wheelchair rule out every vehicle | `{failed: [...]}` |
| `safety_rule` | `SAFETY_RULE` | `requiresEscort` and no escort vehicle (pre-check); or `escortIfFirstOrLast` dropped with no escort vehicle allowed (post-solve) | `{rule}` |
| `pinned_assignment_infeasible` | `PINNED_ASSIGNMENT_INFEASIBLE` (ext) | pinned vehicle missing, unusable, incompatible or cannot serve it | `{pinnedVehicleId, failed}` |
| `unreachable_location` | `ROUTING_UNAVAILABLE` | null matrix cells cut the stop off from every vehicle / the site | — |
| `time_window_unreachable` | `SHIFT_WINDOW_UNREACHABLE` | even a direct trip misses the stop / site window | — |
| `max_ride_unachievable` | `MAX_RIDE_UNACHIEVABLE` | even the direct ride exceeds the max ride | — |
| `exceeds_max_route_duration` | `MAX_ROUTE_DURATION` (ext) | even a direct trip exceeds `maxDurationS` | — |
| `not_scheduled_capacity_or_time` | `CAPACITY_EXHAUSTED` | dropped by the solver; total demand > total seats | — |
| ″ | `TIME_LIMIT` | dropped; the search stopped on the time limit (more time / vehicles may help) | — |
| ″ | `NOT_SCHEDULED` (ext) | dropped; feasible alone but not together with the others (windows, ride, mixing) | — |
| `no_solution_found` | `NO_SOLUTION` / `TIME_LIMIT` (ext) | OR-Tools found no solution at all | — |

`NO_STOP_WITHIN_WALK` and `NOT_ON_ROAD` / `OUTSIDE_COVERAGE` are produced by the API before the solve (stage 1 /
locate), never by this service.

### Determinism, time limit, degraded matrices

- `timeLimitS` bounds the whole call; the search gets what is left after building the model.
- `deterministic: true` uses greedy descent to the first local optimum. Same input + same OR-Tools build ⇒ the same
  result (`stats.deterministic: true`, `stoppedBy: "local_optimum"`). If the clock stops it first, `deterministic`
  is reported `false`. Guided local search (the default) improves until the time limit, so results depend on CPU
  speed. The corpus uses deterministic mode except scenario 34.
- `null` cells are forbidden arcs. Stops that no vehicle can reach are reported `ROUTING_UNAVAILABLE` before the
  search; the rest are solved normally (`stats.matrixNullCells` counts the nulls). Corpus 15 / 16 cover islands and 5 %
  random nulls.

### Re-checking a result

`optimizer.verify(problem, result) -> [violations]` re-checks a result against the **raw** problem, recomputing
every time from the matrix: each stop once, seats (incl. escort seat), wheelchair spaces, windows, site window, max
ride, route duration, availability / deadhead, allowed vehicles, pinning, escort rules, exclusive, customer mixing.
The API should mirror it when it re-validates published trips (doc 06 §4.5: "optimiser output is never trusted").

## Constraints: implemented vs deferred

| Constraint (source) | Status |
|---|---|
| Login / logout direction, site arrival / departure window (doc 06 §4.1–4.2) | Implemented (`trip`) |
| Pickup / drop time windows, multiple windows (doc 06 §4.1) | Implemented (v1 feature, forward times in both directions) |
| Max ride time per passenger, transposed login model (doc 06 §4.2, doc 12 WP 4.3) | Implemented |
| Seats, heterogeneous fleet 4/6/12/26/40 (doc 06 §4.4) | Implemented |
| Wheelchair second capacity (doc 12 WP 4.3, doc 06 §4.5) | Implemented |
| Allowed vehicles / types per stop (doc 12 WP 4.3, doc 06 §4.4) | Implemented (via `VehicleVar` domains: `SetAllowedVehiclesForIndex`'s span binding is broken in the 9.15 wheel) |
| Fixed vehicle cost, explicit objective weights (doc 12 WP 4.3, P6) | Implemented |
| `RegisterTransitMatrix` (doc 12 WP 4.3, doc 06 §7 B5) | Implemented; default |
| Max route duration / driver duty span (doc 06 §4.5) | Implemented (v1 `maxDurationS`, now also in trip mode) |
| Multi-depot, current position, open start / end, availability windows (doc 06 §4.1) | Implemented |
| Escort required; flagged passenger not first pickup / last drop without escort; escort seat (doc 06 §4.5, doc 10 §5.3) | Implemented as attribute-neutral flags. The API's policy engine decides who is flagged and when (night window, site time zone); the solver never receives gender |
| Individual journeys / no pooling (doc 06 §4.2) | Implemented (`exclusive`) |
| One customer per trip in R1 (README P2) | Implemented (`customerId`, hard type incompatibility) |
| Pinned assignments (manual edits) | Implemented (`pinnedVehicleId`; keeps the vehicle, not the sequence) |
| Per-passenger unassigned reasons (doc 06 §4.6) | Implemented (`passengerIds`, `code`, `detail`) |
| WARN rules as soft penalties (doc 10 §5.3) | **Deferred**: no WARN-rule list is specified yet; only BLOCK rules are modelled |
| Generic grouping restrictions (must / must-not ride together) (doc 06 §4.5) | **Deferred**: listed as an example pending the owner / Agent 6 legal list; only the customer rule (P2) is implemented |
| Driver breaks, rest, qualification (doc 06 §4.1) | **Deferred**: not specified beyond the span cap ("break intervals later") |
| Multiple sites / mixed directions in one vehicle (pickup-and-delivery) (doc 06 §4.2) | **Deferred**: out of the first release per doc 06 |
| Stage-1 shuttle stop assignment, walking limits (doc 06 §4.3) | **Deferred**: needs the GH `foot` profile (WP 4.6, O3) |
| Passenger ride-time / early-arrival soft objectives (doc 06 §4.1) | Partly: `weights.routeDuration` penalises route span incl. waiting; no per-passenger ride-time cost |

## Corpus (WP 4.4)

`corpus/*.json` holds **36 scenario specs** (doc 11 §2.3): a `generator` block (seed, size, fleet, constraint mix)
and an `expect` block (status, unassigned bounds, required / allowed codes, vehicle bounds, `objectiveBound`).
`corpus_gen.build(spec)` turns a spec into a problem deterministically; matrices are **synthetic**
(`synthetic-haversine-x1.35-25kmh`, the `bench_optimizer.synth` function), never ETAs. Real GraphHopper matrices on
staging (nightly) are not part of this change.

A scenario passes when the status is expected, `verify()` finds no violation, wall time ≤ `timeLimitS` × 1.10,
unassigned count and codes match `expect`, and the objective ≤ `objectiveBound` (recorded with `--record` as
objective × 1.05, i.e. no regression). Sizes: 5 to 300 passengers, 1 to 40 vehicles; IN and OUT; tight pickup
windows; tight max ride; capacity shortage; fleet unavailable; islands and 5 % null cells; wheelchair with / without
accessible vehicles; night escort rules IN and OUT; escort required with none available; pinned and badly pinned;
narrow lanes; exclusive; two customers; open starts; return to garage; partial availability; driver-duty cap;
vehicle-heavy vs distance-only weights; a v1 generic problem; guided search to the limit; a 180-passenger night shift
with every constraint mixed; a 300-passenger / 40-vehicle B4-size case.

Results on the dev PC (WSL2, Python 3.14.4, OR-Tools 9.15.6755), 2026-11-11: **36/36 PASS, 12.4 s total**. Selected
timings (deterministic mode):

| Scenario | Passengers / vehicles | Wall | Vehicles used | Doc target |
|---|---|---|---|---|
| 09 IN | 200 / 25 | 0.35 s | 14 | 200 door-to-door: 30–60 s limit (doc 06 §7) |
| 10 OUT | 200 / 25 | 0.51 s | 13 | ″ |
| 35 IN night, mixed constraints | 180 / 25 | 1.3 s | 21 | ″ |
| 36 IN | 300 / 40 | 1.2 s | 17 | B4: 300 nodes FEASIBLE, 0 violations in 60 s |
| 34 IN guided search | 100 / 14 | 8.0 s (limit 8 s) | 13 | solve time ≤ limit + 10 % (doc 11 §2.3) |

These are solver times on synthetic matrices on the dev PC, not the production-class staging host; B4 / B5 must
still be re-run on staging (C3) before any production request. B5 (dev PC, greedy to local optimum, same objective
in both modes): 100 stops 0.58 s callback vs 0.16 s matrix; 200 stops 1.86 s vs 0.63 s (≈ 3× faster). Guided search
for 20 s improved the 200-stop objective by about 6 % over the local optimum.

## Resource notes

- CPU: one solve uses one core for up to `timeLimitS`; the server runs at most `OPTIMIZER_CONCURRENCY` worker
  processes. Memory grows with the matrix (n × n lists plus OR-Tools' copy) and the body is capped at 8 MB. Peak
  memory for a 600-location problem has not been measured yet; benchmark it on the production host before enabling
  the service there (doc 06 §7, B4).
- Recommended production caps when a systemd unit is added (WP 4.2, not part of this change): `CPUQuota=150%`,
  `MemoryMax=3G`, `OPTIMIZER_CONCURRENCY=1`, bind `127.0.0.1`, token from an `EnvironmentFile` readable only by the
  service user.
- No database, no disk writes, no outbound network.

## CI

`.github/workflows/ci.yml` job `optimizer`: Python 3.14.4, `pip install --require-hashes --no-deps
--only-binary=:all: -r requirements.lock` from PyPI, then `python -m pytest` (unit tests + the corpus, about 30 s).

To change a pin: edit `requirements*.txt`, rebuild the venv, `pip freeze` into `requirements.lock`, and regenerate
the `--hash` lines for every published file of each pinned release (PyPI JSON API `digests.sha256`).
