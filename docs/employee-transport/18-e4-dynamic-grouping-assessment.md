# 18 E4 dynamic passenger grouping: assessment and redesign plan

Status: assessment done 2026-11-15 on `main` = v1.16.14. Inspection only: production was not changed and E4
optimisation stays off. Evidence (scripts, raw outputs, the road matrix) is in
[`evidence/2026-11-15-e4-grouping/`](evidence/2026-11-15-e4-grouping/).

## 1. Answer to the critical question

**ETMS has two grouping paths, and they behave differently.**

| Path | Where | Grouping | Verdict |
|---|---|---|---|
| **E4 Route plans** (the optimiser, switched off in production) | `services/routing-optimizer/optimizer/solver.py`, fed by `apps/api/src/routing-jobs/*` | One OR-Tools capacitated VRP with time windows over **all** eligible stops and **all** unlocked vehicles of the plan. Assignment and stop order are decided together on the GraphHopper road matrix. | **A: genuine dynamic grouping.** |
| **E3 Daily transport → "Routing" → "Allocate vehicles"** (live, in the browser) | `apps/web/src/features/transport/dispatch/auto-allocate.ts` (`routeGroups`, `allocateRoutes`) | Groups are fixed first by compass bearing from the office (a new group at a 35° gap or at the largest seat count), then vehicles are matched to the groups. Straight-line distance, no road network, no ride-time or deadline constraint. The optimiser is never called. | **B (and coarser): predefined geographic groups, then sequencing.** |

So the dynamic grouping the business asks for **already exists in E4**. It is unavailable to users today because E4 is off
in production (activation gates in §8). The live dispatch tool uses a sector heuristic.

## 2. E4 execution flow (code references)

1. **Plan creation** (`apps/api/src/etms/planning/plan-create.ts`). Takes every booking of the date, direction, office site
   and shift, filtered by `planSkipReason` (`plan-booking-scope.ts:48-58`).
   - The plan's stops start with `assignmentId = null` (`plan-create.ts:180`). Vehicles are empty routes (`:177`).
   - There is **no geographic pre-grouping**. The only partition is date + direction + site + shift (+ branch).
2. **Optimise job.** `optimize-runner.ts:75-167` runs: load → coverage → site-window conflicts → matrix → solve → write.
   - `prisma-plan-gateway.ts:123-224` loads every stop and every unlocked vehicle (`:218`).
   - Locked routes and their stops are left out entirely (`:162`). Pinned stops carry `pinnedAssignmentId` (`:201`).
   - Passenger pickups get **no** time window of their own in trip mode; only the site stop carries the booking window
     (`:179-183`, fixing T1-D1).
3. **Matrix.** Built from GraphHopper `/route` pair calls on the self-hosted engine (`routing/matrix/gh-matrix-client.ts:2-13`).
   - Points are [site, depot?, …stops] (`optimize-problem.ts:106-134`).
   - An unreachable cell is `null`, which becomes a forbidden arc. No straight-line fallback is ever used.
4. **Solver problem** (`optimize-problem.ts:204-244`, contract v2 `trip` mode). Every vehicle gets the same start/end, so
   any vehicle may serve any stop, subject to capacity, wheelchair spaces, pins and customer separation.
   - Default weights are `{vehicle: 7200, time: 1}` (`:66-68`): one extra vehicle costs as much as 2 h of extra driving.
5. **Model** (`solver.py:474-818`). OR-Tools `RoutingModel` with:
   - a Time dimension;
   - Load and Wheelchair capacity dimensions (`:609-619`);
   - a Ride dimension tied to the time slack, which caps each passenger's ride (`:626-634`);
   - fixed vehicle cost (`:637-643`);
   - one disjunction per stop with a drop penalty larger than any route saving, ×100 when pinned (`:646, :661-662`);
   - hard customer-mixing incompatibilities (`:649-672`);
   - pins enforced through the allowed vehicles (`:663-665`).
   - Search: path-cheapest-arc first solution, then guided local search until the time limit (`:687-712`).
6. **Result** (`optimize-problem.ts:295-391`).
   - Every stop must come back exactly once, either routed or with a reason.
   - Seats, time windows and the site window are re-verified (`verifyRoutes :267`).
   - The result is written as a new PLANNED version; it is never published automatically.

### What the objective covers today (default weights)

| # | Factor | Status |
|---|---|---|
| 1 | Minimum number of vehicles | Yes, through the 7200 fixed cost per vehicle |
| 2 | Total fleet distance | Only with `objective: distance` or explicit weights (default distance weight 0) |
| 3 | Total fleet travel time | Yes, arc cost = road seconds |
| 4 | Passenger ride duration | **Constraint only** (max ride). Not minimised |
| 5 | Office arrival deadline | Hard (site window) |
| 6 | Geographic grouping efficiency | Implicit through road time; no explicit term |
| 7 | Detours and backtracking | Implicit through road time; **no detour limit per passenger** |
| 8 | Capacity and availability | Seats and wheelchair spaces hard. Vehicle availability is **not passed** (solver supports it, API does not send it) |
| 9 | Pinned and locked | Pins hard (allowed vehicle + ×100 penalty). Locked routes removed from the problem |

**Weights that can produce undesirable grouping:**
- **The vehicle weight dominates.** With 7200 s per vehicle and no company max-ride policy (the default is "no limit",
  `max-ride.ts:11`), the solver happily merges opposite directions into one van.
  - Scenario S3: north and south passengers in one van, longest ride 47 min.
  - Synthetic 75-booking run without a max ride: rides up to 2 h 18 min.
- **Open start.** Without a depot the first pickup leg is free, so deadhead from the garage is never costed.

## 3. Five-passenger / seven-seater scenario and variants

All runs used the real solver with the API's problem shape, contract v2 IN trip, arrive 08:30–09:00, 60 s per pickup,
5 s limit.

**REAL** = road times and distances from the self-hosted GraphHopper (car profile) on production. These were 110
read-only pair queries; nothing was changed there.

**SYNTHETIC** = a controlled grid matrix (2 min/km Manhattan + 60 s per leg), not a road network.

Points (Chennai): office Tidel Park; homes Adyar, Thiruvanmiyur, Velachery, Perungudi, Besant Nagar; far Tambaram;
north Anna Nagar and Kilpauk; south Sholinganallur. Full output: `evidence/…/e4-results.txt`.

| Scenario | Matrix | Result |
|---|---|---|
| S1 5 pax, 5 points, 1×7-seater, max ride 60 m | REAL | **All 5 in one van**, 27 min drive, 18.1 km, longest ride 27 min |
| S1 same | SYNTHETIC | All 5 in one van |
| S4 same + a second van available | REAL | Still **one** van (the second is not used) |
| S2 Besant Nagar → Tambaram (far), max ride 60 m | REAL | One van, Tambaram picked first, ride 46 min |
| S2c far, 2 vans, max ride 40 m | REAL | **Split**: van A Tambaram + Velachery + Perungudi, van B Adyar + Thiruvanmiyur |
| S3 3 south + 2 north, 2 vans, max ride 60 m | REAL | **One van mixes both directions** (ride 47 min), because of the vehicle weight |
| S3b same, max ride 45 m | REAL | Split into a north+Thiruvanmiyur van and a south van |
| S3c same, 1 van, max ride 45 m | REAL | Sholinganallur unassigned, but the reason given is **TIME_LIMIT** (wrong, see §4) |
| S5 depot start, arrive within 25 min of plan start | REAL | Two vans (one cannot make the deadline) |
| S5b within 20 min | REAL | 4 of 5 served, Velachery unassigned (reason given: TIME_LIMIT) |
| S6 max ride 30 / 20 / 15 / 10 min | REAL | 1 / 2 / 2 vans; at 10 min one passenger is unassigned (reason given: TIME_LIMIT) |
| S7 Velachery pinned to van B | REAL | Pin kept; everyone moves to van B (no extra vehicle) |
| S8 van B locked with Velachery | REAL | Locked route untouched; the other 4 are solved on van A. Seats free on the locked van are not offered to others |
| S9 9 pax on 1×7-seater | REAL | 7 served, 2 CAPACITY_EXHAUSTED |
| S9b 9 pax, 2 vans | REAL | Split into a north+east van and a south+west van |

**Conclusion:** the solver puts five passengers at five different points into one seven-seater when it is feasible. It
splits only when a constraint (max ride, deadline, capacity) forces it.

## 4. Limitations found

1. **Unassigned reasons are mislabelled.** Guided local search always runs to the time limit, so `hit_limit` is always
   true and every dropped stop that isn't a capacity case is labelled `TIME_LIMIT` (`solver.py:715, :798`). The real
   cause (fleet too small within max ride or deadline) is not explained.
2. **Passenger ride time is not in the objective**, and there is no detour limit, so comfort depends entirely on the
   company max ride.
3. **Vehicle availability is not sent to the solver.** Busy vehicles or drivers are found only at publish time
   (`VEHICLE_BUSY` / `DRIVER_BUSY`).
4. **The UI has only raw weights** (four numbers); there are no strategies. `deterministic` and `allowMixedCustomers` have
   no API writer.
5. **One solve gives one plan.** "Compare" works only across separately created plans, so there is no alternative generation.
6. **Editing gaps.** No undo/restore, no drag-and-drop or map editing, no add/remove booking after creation, no driver
   picker, and no "remove from route" in the UI. Recalculation happens only after a reorder.
7. **Publishing is whole-plan only.** There is no selected-routes publish and no review document with a confirmation hash
   (the warning fingerprint exists).
8. **Locked routes cannot take more passengers** (their free seats are invisible to the solver). This is by design;
   document it.
9. **One trip per vehicle per plan** (no multi-trip). This is acceptable within one shift leg.

## 5. Performance and scale (SYNTHETIC city matrix)

Setup: 30 × 30 km, homes random (seeded), road = straight line × 1.35 at 22 km/h + 45 s per leg, depot start, 7-seaters,
fleet = ⌈n/5⌉+2 (at most 20). Measured on the dev PC with Python 3.12 and OR-Tools 9.15.6755; production runs Python
3.14, same OR-Tools. Raw data: `evidence/…/e4-scale.json`.

| Bookings | Limit | Max ride | Vans used | Fleet drive | Longest ride | Unassigned |
|---|---|---|---|---|---|---|
| 10 | 10 s | 60 m | 4 | 350 min | 59 m | 4 (too far for 60 m in this synthetic city) |
| 10 | 10 s | none | 3 | 399 min | 130 m | 0 |
| 25 | 10 s | 60 m / none | 7 / 4 | 654 / 696 min | 59 / 171 m | 8 / 0 |
| 50 | 10 s | 60 m / none | 12 / 8 | 1141 / 1175 min | 60 / 148 m | 14 / 0 |
| 75 | 10 s | 60 m / none | 17 / 12 | 1712 / 1624 min | 60 / 138 m | 21 / 0 |
| 75 | 30 s / 60 s | 60 m | 17 | 1709 min | 60 m | 21 |
| 75 | deterministic | 60 m | 17 | 1696 min | 60 m | 22 (found in **0.07 s**) |

- **Solve time is not a risk at the 75-booking limit.** A first local optimum takes under 0.1 s. 10 s → 30 s → 60 s of
  guided search improves fleet drive time by under 0.2 %.
- **Memory:** peak 43 MB (process tree) at 75 stops × 20 vehicles. The unit's cap is `MemoryMax=3G`, one solve at a time.
- **Matrix is the cost driver.** 75 bookings means up to ~77² ≈ 5,900 GraphHopper pair cells per plan (B2/B6 on staging,
  R-5). Cache and sparse matrix are already in place (`routing/matrix/*`).
- **Fallback:**
  - A failed or slow solve fails the job: nothing is written and the plan returns to its earlier status.
  - The E3 manual dispatch keeps working with the optimiser stopped (E4 exit criterion).
  - The solver limits are 500 stops / 50 vehicles / 120 s; the API limits are 150 stops / 20 vehicles / 60 s / 75 bookings.

## 6. Strategies (prototype results)

Prototype on the REAL matrix; data in `evidence/…/e4-strategies-*.json`, prototype solver `evidence/…/solver_proto.py`.

**How each metric is defined**
- **km / drive:** from the first pickup to office arrival, summed over routes (open start).
- **ride:** from a passenger's pickup to office arrival.
- **occupancy:** passengers / seats.

| Scenario | Today's default (v7200, t1) | Balanced (v3600, t2, rideTime 1) | Comfort (v1800, t1, rideTime 2) |
|---|---|---|---|
| 5 pax, 2×7-seaters | 1 van, 27 min, longest ride 27 | 1 van, 27 min, longest ride 27 | 2 vans, 25 min, longest ride 13 |
| 3 south + 2 north, 2 vans | 1 van mixes directions, longest ride 48 | **2 vans by direction**, longest ride 27, 32.9 km (−21 %) | 2 vans by direction |
| 9 pax, fleet of 4 / 7 / 12 seats | 12-seater alone, **longest ride 80** | 4-seater + 12-seater, longest ride 38 | 3 vehicles, longest ride 29 |

**Findings**
- Fewer vehicles (v20000, t1), Shortest distance (v2000, d1) and Fastest (v120, t1) can be expressed with today's weights.
- **Balanced and Comfort need a new `rideTime` weight.** It is a soft cost on each passenger's ride. Span cost
  (`routeDuration`) is not a proxy: with an open start it only rescales the time weight.
- **Max-detour guard:**
  - As a soft bound (ride ≤ max(direct × 1.6, direct + 10 min)) it splits opposite directions when a second van exists.
  - As a hard bound it would drop passengers to stay inside the limit, so it must stay soft. The company max ride
    remains the only hard ride limit.
- **The unassigned-reason fix is prototyped.** For example, two directions with 1 van and max ride 45 min gives
  `FLEET_TOO_SMALL {binding: [max_ride], freeSeats: 3}`; 9 pax on 1 van gives `CAPACITY_EXHAUSTED`.

**Strategy presets (WP-A / WP-S):**

| Strategy | Weights | Trade-off shown to the dispatcher |
|---|---|---|
| Balanced (default) | vehicle 3600, time 2, rideTime 1 | Few vehicles without long detours; splits opposite directions |
| Fewer vehicles | vehicle 20000, time 1 | Fullest vehicles; longer rides within the max ride |
| Shortest distance | vehicle 2000, distance 1 | Least km (fuel); may use one more vehicle |
| Fastest fleet time | vehicle 120, time 1 | Least driving time; uses more vehicles |
| Passenger comfort | vehicle 1800, time 1, rideTime 2 | Shortest rides; most vehicles |

## 6a. Proposed dispatcher workflow (WP-W)

1. **Optimise** tab:
   - choose the date, direction, site, shift and vehicles (as today);
   - choose a **strategy** (cards with the trade-off text) and optional advanced preferences: occupancy, max ride
     (capped at the policy), detour, vehicle size, keep directions, keep pins/locks;
   - choose **Generate alternatives** (2–5 strategies) or a single plan.
2. **Alternatives**:
   - a compare table using the §WP-A metrics (vehicles, passengers, km, drive time, max/avg ride, occupancy, deadline
     compliance, excluded with reasons) with best-value markers;
   - "Use this plan" keeps one alternative and discards the others.
3. **Plan workspace** (`PlanReviewPage`):
   - a map with route lines and draggable stop markers, next to vehicle route cards;
   - drag a passenger between cards or reorder within a card; "Remove from route", "Add booking", driver picker,
     pin passenger, pin stop, lock route;
   - **Undo / Redo**, which restores the previous / next plan version;
   - after every edit the server re-times the route on GraphHopper and re-checks seats, max ride, windows,
     availability and consent. Warnings and blocking errors appear on the card; nothing invalid is silently accepted;
   - "Show changes" compares the plan with the last optimised version.
4. **Review & publish** (a dedicated screen):
   - choose the routes to publish;
   - the server returns the review: vehicles, drivers, exact sequence, km and times, occupancy, manual changes,
     excluded passengers, warnings to acknowledge and blocking errors;
   - Publish sends the `reviewHash`. Any change after review gives `PLAN_REVIEW_STALE` and the screen reloads for a fresh
     confirmation;
   - published routes become read-only; the remaining routes can be edited and published later.

## 7. Redesign plan (work packages)

| WP | Scope | Depends on |
|---|---|---|
| **WP-S** solver | Strategy support: passenger ride-time cost, detour limit (ride ≤ max(direct × ratio, direct + X)), correct unassigned reasons (re-check dropped stops: CAPACITY / MAX_RIDE / DEADLINE / FLEET_TOO_SMALL / PINNED), deterministic option; Python tests incl. "5 pax share one 7-seater" | – |
| **WP-A** API strategies + alternatives | `strategy` on optimise (Balanced, Fewer vehicles, Shortest distance, Fastest time, Comfort) mapped to validated weights and options inside company policy; advanced preferences (occupancy, max ride ≤ policy, detour, vehicle size, preserve pins and locks); vehicle availability windows sent to the solver; "Generate alternatives" = sibling plans per strategy, queued jobs; compare metrics extended (max/avg ride, occupancy, deadline compliance, excluded with reasons) | WP-S |
| **WP-B** API editing + publish | restore version (undo/redo), recalculate, add/remove booking, pin passenger, availability pre-check, `GET review` + `reviewHash`, selected-routes publish through the existing transaction, published routes immutable | – (in progress) |
| **WP-W** web workspace | strategy picker with trade-off text, alternatives compare, map with draggable stops and route cards, drag-and-drop reorder/reassign, undo/redo, remove from route, driver picker, final review screen, selected publish, re-confirmation | WP-A, WP-B |
| **WP-Q** QA + security | independent review of each WP; isolation matrix; consent; 75 limit; scale runs at 10/25/50/75 | each WP |

No production change. E4 stays off until the existing gates pass (§8).

## 8. Activation gates (unchanged)

Three switches (env, platform, company) plus the readiness checklist (`routing-switch/*`), Python 3.14 (doc 17 §7),
C3 staging host (README §7, doc 16 §1.1), B1–B6 benchmarks (doc 06 §7, doc 12 §7) and the E4 exit criteria
(doc 11 :292). Nothing in this plan bypasses them.
