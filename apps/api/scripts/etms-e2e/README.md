# ETMS E3 test harness (WP 3.8)

Repeatable E3 test gate (doc 12 §5 E3 exit criteria). It automates the checks the independent QA run of 2026-11-11
did by hand: the 200-passenger week (IST and US DST), double submit, 8-way parallel capacity, the booking burst, and
GraphHopper stopped or hanging. With `--http` it also runs the real API and processor, drives a published trip through
the v1.8 tracker and runs dispatcher / passenger bots over HTTP. Synthetic data only. Nothing shared is touched: no
`veetracer`, no `veetrax_assess`, no Valkey db 0, no PM2, and no outside map host.

## Run the gate

```bash
# Only the server and credentials of this URL are used. The database it names is never opened.
export E3H_PG_URL='postgresql://<user>:<password>@127.0.0.1:5432/postgres'
npm run etms:gate -w @veetracer/api                    # takes about 2 minutes
npm run etms:gate -w @veetracer/api -- --http          # plus the HTTP stage, about 4-5 minutes
```

What the gate does:

1. Creates `veetrax_e3h_<stamp>_test`. It refuses any other name. The role needs `CREATEDB`, and `btree_gist` must be
   creatable, as in the E3 backend evidence.
2. Runs `prisma migrate deploy` from zero.
3. Runs the DB suites with `CI=true DB_TEST_REQUIRED=1`:
   - `src/etms/etms-e3-gate.db-test.ts`: this work package.
   - `src/etms/etms-bookings-trips.db-test.ts`: E3 schema, constraints and purge.
4. Runs the regression unit specs: reports, planned trips, routes, E3 dispatch rules and the harness parts.
5. With `--http`, runs the HTTP stage (next section).
6. Drops the database. Pass `--keep` to keep it.
7. Prints one row per criterion with PASS, PASS\*, FAIL, PENDING or NO TEST, then `GATE: PASS|FAIL`.

The summary, the raw jest JSON and the logs (passwords redacted) go to `apps/api/var/etms-e2e/<stamp>/`, which git
ignores. Copy `summary.md` into an evidence note if you need one.

Other flags:

- `--skip-unit`: skip step 4.
- `--http-only`: skip steps 3 and 4 (for debugging the HTTP stage).
- `--no-build`: use the existing `dist/` instead of running `nest build`.
- `--valkey-db <1-15>` (default 11) and `--valkey-url` (default `redis://127.0.0.1:6379`, or `E3H_VALKEY_URL`).
- `--out <dir>`: write the results somewhere else.
- `--name veetrax_e3h_x_test`: use a fixed database name.

Exit code: 0 = PASS, 1 = FAIL, 2 = setup error.

**By hand:** use an already migrated `*_test` database. Without `ETMS_DB_TEST_URL` the suite skips, like every DB test.

```bash
CI=true ETMS_DB_TEST_URL=postgresql://…/veetrax_e3h_x_test \
  npx jest --testRegex 'etms-e3-gate\.db-test\.ts$' --runInBand
```

## HTTP stage (`--http`)

The chaos-run pattern: real processes, a scratch database, a private Valkey index.

1. `nest build`, then the GraphHopper stub on a free port.
2. **Synthetic accounts** (`http-seed.ts`), written into the scratch database:
   - an IST customer with branches North and South, a control tenant and an etms-off tenant
   - roles from the real ETMS templates (`ensureEtmsRoleTemplates`)
   - users: Transport admin, North-only dispatcher, a fleet user without ETMS menus, passenger logins, admins for the other tenants
   - GT06 devices in the simulator IMEI range, fitted to the vans
3. **Processes** (`stack.ts`): `dist/main.js` and `dist/processor/main.js` on a free port, with `ROUTER_URL` set to the stub.
   - Valkey: `redis://…/<db>`. The index must be 1–15, never 0, and empty at start; it is `FLUSHDB`ed at the end.
4. **HTTP checks** (`http-checks.ts`, criterion `HTTP`):
   - no token or a malformed token gives 401 on a sample of 14 ETMS routes
   - permission guard: a fleet user and a passenger get 403 on dispatcher routes; `/me/transport` without `etms_self` gives 403
   - branch scope: a South booking is 404 and absent from the board for the North dispatcher
   - an etms-off tenant gets 404 on bookings, shifts, schedules, board, trips and create, even with the Transport admin template
   - another tenant gets 404
   - `Idempotent-Replay: true` on a booking replay and a change-set replay (absent on the first call), 422 for another body, 400 without a key
   - the 61st create in a minute gives 429 `RATE_LIMITED`, with `Retry-After` equal to the body's `retryAfterSec`
5. **Bot cycle** (`bots.ts`, criteria `BOT` and `AC3b`):
   - The dispatcher bot books 3 passengers for today (pickups 1.2 / 0.8 / 0.4 km from the office), asks for candidates, publishes CREATE_TRIP + 3 × ADD_PASSENGER, acknowledges on the driver's behalf and starts.
   - `sim-trip.ts` drives the van along the trip's stops. The bot records outcomes at each arrive event: BOARDED, BOARDED, NO_SHOW, then DROPPED × 2 at the office. Before each outcome it checks that GPS left the passenger PENDING.
   - Finally it completes the trip.
   - The passenger bot checks that it sees only its own trip (co-riders as a count), sees the vehicle while the trip runs, and sees its own outcome. A no-show passenger loses the vehicle.
6. **Clean-up:** every process is stopped (SIGTERM, then `taskkill /T /F`; also from an exit hook), the stub is stopped and the Valkey index is flushed, whatever failed.

**`sim-trip.ts` is `sim:route --trip <id>`** (16 §4.2), also usable on its own:
`npm run etms:sim-trip -w @veetracer/api -- --trip <transportTripId>` with `ETMS_SIM_DATABASE_URL` (a `*_test`
database) and `ETMS_SIM_REDIS_URL` (not db 0).
- It reads the trip's planned stops and the van's IMEI.
- It XADDs NormalizedPositions to `vt:positions` exactly as the gateway does: the processor's input, so nothing is written to the database directly.
- Fixes are 20 m apart, one per second of wall clock, at 72 km/h, with 3 standing fixes in each stop.
- After each stop it waits until the processor group has acknowledged every fix, then reports the trip, stop and passenger state.
- `src/simulator/route-sim.ts` (GT06 over TCP through the gateway) is unchanged.

**Caveats:**
- Valkey pub/sub channels are server-wide. The stack's cache-invalidate and live-update messages, which name synthetic ids only, also reach any other stack on the same Valkey server. QA's db-1 stack had the same property. For full isolation, point `--valkey-url` at a private `valkey-server`.
- The API binds its port on every interface: `app.listen(port)` is production code and was left as it is.

## Parts

| File | What it is |
|---|---|
| `src/etms/testing/e3-synthetic.ts` | Synthetic tenant generator. `standardE3Plan()` builds the doc 16 §4.3 T3 shape: an IST customer with branches North and South, an America/Chicago customer, a control tenant and an etms-off tenant. Passengers have home pins and consent, some have logins. Vehicles use the seat mix 4 / 6 / 12 / 26 / 40 / none and non-issued plates. It also creates drivers and shifts (16 §4.1 IST and US shifts, including an overnight shift across 02:00). `seedE3Synthetic()` writes a plan with SQL. The plan is deterministic for a seed. |
| `src/etms/testing/graphhopper-stub.ts` | GraphHopper stand-in for `GET /route` and `/health`. Routes are straight lines × 1.3 at 30 km/h. Modes: `up`, `hang`, `error` (500), `noroute` (400). Stopped means the port refuses connections. |
| `scripts/etms-e2e/graphhopper-stub.ts` | The same stub as a process, for runs against the real API (`ROUTER_URL=http://127.0.0.1:18989 ROUTER_ENGINE=graphhopper`). Switch modes with `curl 127.0.0.1:18990/mode?set=hang\|down\|up`. |
| `src/etms/etms-e3-gate.db-test.ts` | The acceptance suite. Each test name carries its criterion (`[AC1]`…`[AC9]`, `[ISO]`). The suite logs one `E3-GATE-SUMMARY {…}` line with the measured counts and timings. |
| `src/etms/testing/e3-harness.spec.ts` | Unit tests for the generator and the stub. They run in the normal jest suite. |
| `scripts/etms-e2e/gate.ts` | The runner described above. |
| `scripts/etms-e2e/stack.ts`, `http-stage.ts` | Real-process stack (API, processor, private Valkey index) and the `--http` stage around it. |
| `scripts/etms-e2e/http-seed.ts`, `http-client.ts`, `http-checks.ts` | HTTP accounts, a fetch client with a check recorder, and the HTTP checks. |
| `scripts/etms-e2e/bots.ts`, `sim-trip.ts` | Dispatcher and passenger bots, and `sim:route --trip` through the processor. |

## Criteria map

| Criterion | Automated by |
|---|---|
| AC1: 200-passenger recurring week | **IST:** 400 schedules give a preview of 2,000 legs, and the generator walks the week to 2,000 (a re-run adds 0). Then dropping Fridays for 50 passengers cancels 50, archiving 50 OUT schedules cancels 250 and 10 Wednesday SKIPs cancel 10, leaving 1,690. A stale PATCH returns `VERSION_CONFLICT`. Every leg is at 09:00 / 18:00 IST. **US (America/Chicago):** a spring fortnight (DST starts 14 Mar 2027) and a fall fortnight (DST ends 7 Nov 2027), 4,800 legs each. Local times stay fixed and the UTC times move by 1 h on the right dates, including the overnight shift on the night of the change. PostgreSQL's own time-zone rules check the times. |
| AC2: double submit | 5 parallel and 50 retried creates with one key give exactly 1 booking. A different body gives 422, no key gives 400 and a second key gives 409. A change set replayed with the same key gives the same result, a different body gives 422, and parallel submits with one key publish exactly once. |
| AC3b: tracker under the simulator (`--http`) | sim-trip fixes become Position rows and the live cache, and the passenger sees the van. GPS marks pickups 2 and 3 ARRIVED → DEPARTED with arrival times and the office ARRIVED. The trip auto-completes (`closedBy AUTO`). `nextStopSeq` and `etaNextStop` advance while driving. Passengers stay PENDING until the dispatcher bot records outcomes, and every outcome event is `WEB`. |
| HTTP / BOT (`--http`) | See "HTTP stage". |
| AC3: atomic publish | PlannedTrip (`origin=ETMS`, `routeId=null`), header, passengers and events are written together. A refused change set (capacity, or a seated booking given to a second trip) leaves no row behind. |
| AC4: capacity | 8 parallel change sets give 1 OK and 7 `VERSION_CONFLICT`. Workers that retry seat exactly the capacity of 3, and `occupiedSeats` equals the sum of active seats. Same vehicle or same driver in parallel gives exactly one winner. |
| AC5: passenger view | The passenger sees only their own trip. Co-riders are a count, and no other name or home point appears. Another passenger's trip gives 404. Outside the window the vehicle is `OUTSIDE_WINDOW`. A non-passenger gets `NOT_A_PASSENGER`. |
| AC6: GPS never boards | A tracker-style stop arrival leaves passengers PENDING. The database refuses a `GPS` outcome, and a `WEB` outcome boards. |
| AC7: null-route label | Regression unit specs: `trip-performance` and `planned-trips-report`. |
| AC8: burst (indicative) | 4 dispatchers make 200 parallel creates: 0 errors, p50 / p95 / p99 recorded. 50 retries with the same key give 0 duplicates. A user's 61st create in a minute gets 429 `RATE_LIMITED`. |
| AC9: GraphHopper | The stub is up, stopped or hanging, and `ROUTER_URL` is also tested unset. **Up:** publish stores a road path and candidates get a ROAD ETA from the trip stop. **Stopped or hanging:** no ETA or path is ever invented, and publish still succeeds. Timings are recorded. |
| AC10: Routes / Planned trips unchanged | Regression unit specs for planned trips, routes and reports. |
| ISO (supporting) | **Another tenant:** gets 404 on GET, candidates and seating a booking, and on using the other tenant's vehicle. Its board is empty. **Branch-scoped dispatcher:** South bookings are hidden and a South van gives 404. |

## Regression tests for the merged fixes (always on)

The E3 security fixes (QA B1–B5, etms/e3-secfix) and the harness-found defects HD1 / HD2 (fixed with ND1) are merged
into `etms/e3` (5056c54). Their tests used to be skipped until the fixes landed. They now run by default. The flags
`--secfix` / `--known-defects` are still accepted and change nothing for these tests.

| Test | Fix |
|---|---|
| `[ISO][secfix B1]` ADD_PASSENGER / ADD_STOP of a South booking by a North dispatcher. Both must give **404 `NOT_FOUND`** (scope). The ADD_STOP case uses a consenting passenger, so a 403 `CONSENT_REQUIRED` would reveal that scope was never checked. | B1 / M6 |
| `[AC9][secfix B2]` GraphHopper stopped: board / candidates say routing unavailable | B2 |
| `[AC9][secfix B3]` GraphHopper hanging: publish under 3 s. The road path is written after the commit; the "GraphHopper up" test polls for it. | B3 |
| `[AC3][secfix B5]`, `[AC3b][secfix B5]` dispatcher start does not mark the first pickup stop DEPARTED (in-process and over HTTP with the real processor) | B5 |
| `[AC2][fixed HD1]` parallel double submit of a booking: every request gets the same booking back (was 409 `BOOKING_DUPLICATE` for a loser) | HD1 |
| `[AC2][fixed HD2]` parallel change-set publish with one key: the losers replay the winner (was 409 `VEHICLE_BUSY`) | HD2 |

**Fixtures follow the secured publish rule (M2):**
- A stop that is not a company place must be the own pickup / drop of a consenting passenger seated in the same change set.
- Site stops and the depot that empty trips start from name a company place (`poiId`, within the place-match distance, created before any draft).
- Booking drops name the office place.

If a later change alters the `RoutingService` constructor, adjust `routingFor()` in the gate suite. It is the only
place that builds one.

## Gaps compared with the WP 3.8 definition

Doc 12 WP 3.8 asks for a `scripts/etms-e2e/` harness on the chaos-run pattern, `sim:route --trip`, passenger and
dispatcher bots, and a Playwright suite. The first three are built: `--http`, `sim-trip.ts` and `bots.ts`. Still open:

- **Playwright web journeys and mobile (Maestro):** not built in this round, by decision of the Lead.
- **Gateway TCP leg:** sim-trip feeds the processor's input stream. GT06 framing through the gateway is covered by
  `route-sim` and the chaos harness, not by this gate.
- **Alerts:** the bot run is on time and on route, so no late or deviation alert is provoked. `TRIP_STOP_LATE` and
  deviation alerts are not asserted.
- **Test gate wording:** doc 12 says "full run on `veetrax_assess`". The gate uses a fresh `veetrax_e3h_*_test`
  database instead, as the brief and doc 16 I1 require for destructive runs.

## E5 scenarios (WP 5.5): `npm run etms:e5`

`sim:route` scenarios `etms-on-time`, `etms-no-show` and `etms-offline-driver` (doc 12 §8, doc 11 §6 / §7 E5), end to
end against the real built API, processor and **notifier**, on a scratch database `veetrax_e5s_<stamp>_test`.

```bash
export E3H_PG_URL='postgresql://<user>:<password>@127.0.0.1:5432/postgres'
npm run etms:e5 -w @veetracer/api                              # all three, about 15 minutes
npm run etms:e5 -w @veetracer/api -- --scenario etms-no-show   # one (etms-offline-driver also runs etms-on-time first)
```

Flags: `--no-build`, `--keep`, `--valkey-db <1-15>` (default 14; must be empty, flushed after), `--valkey-url`,
`--out <dir>`, `--name veetrax_e5s_x_test`, `--known-defects` (fail on checks tagged `pending known-defect …`).
`npm run sim:route -- --scenario etms-…` points here: these scenarios need the driver and passenger APIs too.

- **Scenarios** are JSON in `src/simulator/scenarios/etms-*.json`; the format and the R6 replay plan are in
  `src/etms/testing/e5-scenario.ts` (pure, unit-tested in `e5-scenario.spec.ts`).
- **Stack:** API + processor + notifier with `PUSH_PROVIDER=fake` (each push is a JSON line in `<out>/push.log`, ticket
  ids `fake-…`; nothing leaves the machine; the fake is refused when `NODE_ENV=production`) and `SMS_PROVIDER=console`.
- **Accounts:** `http-seed.ts` with 12 passengers (9 logins) and 3 drivers; driver logins are a User with the real
  `Transport driver` template role linked as `Driver.userId` (the Transport admin template has no `drivers` edit, so
  `POST /drivers/:id/login` is not used). Each scenario has its own vehicle, driver and three passengers.
- **Per scenario** (`e5-bots.ts`): push tokens registered through `/auth/push-token`; dispatcher books and publishes;
  one relay pass is awaited (TRIP_ASSIGNED + TRIP_STARTING_SOON while the trip is SCHEDULED); the driver bot uses the
  driver API as the app does (`/me`, duty start, `/trips`, detail, ACKNOWLEDGE event, online start, a 10-minute-old start
  refused with STALE_COMMAND); sim-trip drives the van through `vt:positions`; at each stop the driver bot sends the
  scenario's taps with stable `clientEventId`s and a per-trip `seq`. In the offline window they are queued and, on
  reconnect, replayed shuffled and duplicated (R6), with RETRY events resent until settled, then the whole queue once
  more (all DUPLICATE).
- **Checks:** GPS never sets an outcome; pickup outcomes by DRIVER_APP; each clientEventId stored once; `/driver/v1/sync`
  returns every stored outcome; passengers see their own status and co-riders only as a count; the offline run converges
  to `etms-on-time`'s final state; notifications (no duplicates, PUSH rows SENT through the fake provider, payload exactly
  `{ kind, tripId, notificationId }` on channel `trip`, no names); no SMS; I2 (a finished trip no longer blocks erasure).
- **Known defect D1** (tagged `pending known-defect D1`): the v1.8 tracker auto-completes the trip when the van reaches
  the office, so the driver's DROPPED taps there come back `LATE TRIP_CLOSED` and the riders stay BOARDED. The checks
  record the evidence; `--known-defects` makes them fail.

Evidence: `apps/api/var/etms-e2e/e5-<stamp>/` (`summary.md`, `results.json`, `push.log`, process logs), git-ignored.
