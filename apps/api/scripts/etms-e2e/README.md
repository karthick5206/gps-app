# ETMS E3 test harness (WP 3.8)

Repeatable E3 test gate (doc 12 §5 E3 exit criteria). It automates the checks the independent QA run of 2026-11-11
did by hand: the 200-passenger week (IST and US DST), double submit, 8-way parallel capacity, the booking burst, and
GraphHopper stopped or hanging. Synthetic data only. Nothing shared is touched: no `veetracer`, no `veetrax_assess`,
no Valkey, no PM2, and no outside map host.

## Run the gate

```bash
# Only the server and credentials of this URL are used. The database it names is never opened.
export E3H_PG_URL='postgresql://<user>:<password>@127.0.0.1:5432/postgres'
npm run etms:gate -w @veetracer/api                    # takes about 2 minutes
npm run etms:gate -w @veetracer/api -- --secfix        # after etms/e3-secfix is merged
npm run etms:gate -w @veetracer/api -- --known-defects # once H1 / H2 below are fixed
```

What the gate does:

1. Creates `veetrax_e3h_<stamp>_test`. It refuses any other name. The role needs `CREATEDB`, and `btree_gist` must be
   creatable, as in the E3 backend evidence.
2. Runs `prisma migrate deploy` from zero.
3. Runs the DB suites with `CI=true DB_TEST_REQUIRED=1`:
   - `src/etms/etms-e3-gate.db-test.ts`: this work package.
   - `src/etms/etms-bookings-trips.db-test.ts`: E3 schema, constraints and purge.
4. Runs the regression unit specs: reports, planned trips, routes, E3 dispatch rules and the harness parts.
5. Drops the database. Pass `--keep` to keep it.
6. Prints one row per criterion with PASS, PASS\*, FAIL, PENDING or NO TEST, then `GATE: PASS|FAIL`.

The summary, the raw jest JSON and the logs (passwords redacted) go to `apps/api/var/etms-e2e/<stamp>/`, which git
ignores. Copy `summary.md` into an evidence note if you need one.

Other flags:

- `--skip-unit`: skip step 4.
- `--out <dir>`: write the results somewhere else.
- `--name veetrax_e3h_x_test`: use a fixed database name.

Exit code: 0 = PASS, 1 = FAIL, 2 = setup error.

**By hand:** use an already migrated `*_test` database. Without `ETMS_DB_TEST_URL` the suite skips, like every DB test.

```bash
CI=true ETMS_DB_TEST_URL=postgresql://…/veetrax_e3h_x_test \
  npx jest --testRegex 'etms-e3-gate\.db-test\.ts$' --runInBand
```

## Parts

| File | What it is |
|---|---|
| `src/etms/testing/e3-synthetic.ts` | Synthetic tenant generator. `standardE3Plan()` builds the doc 16 §4.3 T3 shape: an IST customer with branches North and South, an America/Chicago customer, a control tenant and an etms-off tenant. Passengers have home pins and consent, some have logins. Vehicles use the seat mix 4 / 6 / 12 / 26 / 40 / none and non-issued plates. It also creates drivers and shifts (16 §4.1 IST and US shifts, including an overnight shift across 02:00). `seedE3Synthetic()` writes a plan with SQL. The plan is deterministic for a seed. |
| `src/etms/testing/graphhopper-stub.ts` | GraphHopper stand-in for `GET /route` and `/health`. Routes are straight lines × 1.3 at 30 km/h. Modes: `up`, `hang`, `error` (500), `noroute` (400). Stopped means the port refuses connections. |
| `scripts/etms-e2e/graphhopper-stub.ts` | The same stub as a process, for runs against the real API (`ROUTER_URL=http://127.0.0.1:18989 ROUTER_ENGINE=graphhopper`). Switch modes with `curl 127.0.0.1:18990/mode?set=hang\|down\|up`. |
| `src/etms/etms-e3-gate.db-test.ts` | The acceptance suite. Each test name carries its criterion (`[AC1]`…`[AC9]`, `[ISO]`). The suite logs one `E3-GATE-SUMMARY {…}` line with the measured counts and timings. |
| `src/etms/testing/e3-harness.spec.ts` | Unit tests for the generator and the stub. They run in the normal jest suite. |
| `scripts/etms-e2e/gate.ts` | The runner described above. |

## Criteria map

| Criterion | Automated by |
|---|---|
| AC1: 200-passenger recurring week | **IST:** 400 schedules give a preview of 2,000 legs, and the generator walks the week to 2,000 (a re-run adds 0). Then dropping Fridays for 50 passengers cancels 50, archiving 50 OUT schedules cancels 250 and 10 Wednesday SKIPs cancel 10, leaving 1,690. A stale PATCH returns `VERSION_CONFLICT`. Every leg is at 09:00 / 18:00 IST. **US (America/Chicago):** a spring fortnight (DST starts 14 Mar 2027) and a fall fortnight (DST ends 7 Nov 2027), 4,800 legs each. Local times stay fixed and the UTC times move by 1 h on the right dates, including the overnight shift on the night of the change. PostgreSQL's own time-zone rules check the times. |
| AC2: double submit | 5 parallel and 50 retried creates with one key give exactly 1 booking. A different body gives 422, no key gives 400 and a second key gives 409. A change set replayed with the same key gives the same result, a different body gives 422, and parallel submits with one key publish exactly once. |
| AC3: atomic publish | PlannedTrip (`origin=ETMS`, `routeId=null`), header, passengers and events are written together. A refused change set (capacity, or a seated booking given to a second trip) leaves no row behind. |
| AC4: capacity | 8 parallel change sets give 1 OK and 7 `VERSION_CONFLICT`. Workers that retry seat exactly the capacity of 3, and `occupiedSeats` equals the sum of active seats. Same vehicle or same driver in parallel gives exactly one winner. |
| AC5: passenger view | The passenger sees only their own trip. Co-riders are a count, and no other name or home point appears. Another passenger's trip gives 404. Outside the window the vehicle is `OUTSIDE_WINDOW`. A non-passenger gets `NOT_A_PASSENGER`. |
| AC6: GPS never boards | A tracker-style stop arrival leaves passengers PENDING. The database refuses a `GPS` outcome, and a `WEB` outcome boards. |
| AC7: null-route label | Regression unit specs: `trip-performance` and `planned-trips-report`. |
| AC8: burst (indicative) | 4 dispatchers make 200 parallel creates: 0 errors, p50 / p95 / p99 recorded. 50 retries with the same key give 0 duplicates. A user's 61st create in a minute gets 429 `RATE_LIMITED`. |
| AC9: GraphHopper | The stub is up, stopped or hanging, and `ROUTER_URL` is also tested unset. **Up:** publish stores a road path and candidates get a ROAD ETA from the trip stop. **Stopped or hanging:** no ETA or path is ever invented, and publish still succeeds. Timings are recorded. |
| AC10: Routes / Planned trips unchanged | Regression unit specs for planned trips, routes and reports. |
| ISO (supporting) | **Another tenant:** gets 404 on GET, candidates and seating a booking, and on using the other tenant's vehicle. Its board is empty. **Branch-scoped dispatcher:** South bookings are hidden and a South van gives 404. |

## Pending on etms/e3-secfix (run with `--secfix` after the merge)

Each of these tests fails on `etms/e3` today. This was checked: all five fail with `--secfix`.

| Test | QA defect |
|---|---|
| `[ISO][pending secfix B1]` ADD_PASSENGER and ADD_STOP of another branch's booking by a branch-scoped dispatcher | B1 |
| `[AC9][pending secfix B2]` GraphHopper stopped: board / candidates say routing unavailable | B2 |
| `[AC9][pending secfix B3]` GraphHopper hanging: publish under 3 s | B3 |
| `[AC3][pending secfix B5]` dispatcher start does not mark the first pickup stop DEPARTED | B5 |

If secfix changes the `RoutingService` constructor, adjust `routingFor()` in the gate suite. It is the only place
that builds one.

## Known defects found by the harness (not in the secfix scope; `--known-defects`)

| ID | Defect | Where |
|---|---|---|
| H1 (Low) | When the same Idempotency-Key is submitted in parallel, a losing request can get **409 `BOOKING_DUPLICATE`** instead of a replay of the winner. It happened in every default gate run (2 of 5 losers in the last one). It is a race, so the stricter `--known-defects` test does not catch it every time. Exactly one booking is still created. | `BookingsService.create`: the active-duplicate pre-check runs before the key's unique violation can turn into a replay. It should re-check the key, or replay when the duplicate carries the same key. |
| H2 (Low) | When the same Idempotency-Key is submitted in parallel to change-set publish, the losers get **409 `VEHICLE_BUSY`** instead of the winner's result. The advisory lock serialises them, then the overlap check fires before the ledger's unique key. Exactly one publish still happens. | `DispatchService.publishWithKey` / `apply`: look the key up again after taking the locks. |

## Gaps compared with the WP 3.8 definition

Doc 12 WP 3.8 asks for a `scripts/etms-e2e/` harness on the chaos-run pattern, `sim:route --trip`, passenger and
dispatcher bots, and a Playwright suite. This delivery covers the backend gate on services against a real database.
These parts are **not** built yet:

- **Real `dist/` processes:** the chaos-run pattern starts api, gateway and processor on a private Valkey and drives
  them over HTTP. The gate calls the services in-process instead. HTTP-only behaviour therefore stays covered only by
  unit specs and QA: guards, the `Idempotent-Replay` header, the etms-off 404 guard, 429 headers.
- **`sim:route --trip <id>`, and criterion 3's second half:** "the v1.8 tracker follows the trip under sim:route (stop
  arrivals, ETA, alerts)". AC6 imitates the tracker's write instead.
- **Passenger and dispatcher bots, Playwright journeys, mobile.**
- **Test gate wording:** doc 12 says "full run on `veetrax_assess`". The gate uses a fresh `veetrax_e3h_*_test`
  database instead, as the brief and doc 16 I1 require for destructive runs.
