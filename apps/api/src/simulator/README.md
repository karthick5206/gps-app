# Device simulators

Run every command from the repository root. Never point a simulator at production: use a local stack or an isolated
test instance.

| Script | What it does |
|---|---|
| `npm run sim -w @veetracer/api -- --count 20` | Load test: N devices drive randomly around Chennai (`gt06-sim.ts`). |
| `npm run sim:register -w @veetracer/api -- --count 20` | Registers simulator IMEIs as devices and objects in the demo company (`register.ts`). |
| `npm run sim:route -w @veetracer/api -- --scenario on-time --imei <imei>` | Drives one or more devices along a planned route (`route-sim.ts`), for planned trips. |

## Route simulator

`route-sim.ts` drives GT06 (Concox) devices along a route so the planned-trip tracker
(`docs/routes-trips/SPEC.md` §4.3) can be tested end to end: trip start on leaving the start stop, arrival and
departure per stop, skipped stops, completion at the last stop, deviation from the corridor, unscheduled stops and
late arrivals. The timeline is computed up front by `route-drive.ts` (pure and deterministic, see
`route-drive.spec.ts`). The CLI then sends one fix from it every `--interval` seconds, with login, heartbeats and
reconnects.

### Quick start

```bash
# See what a scenario does without connecting: the stop summary goes to stderr, the timeline as CSV to stdout
npm run sim:route -w @veetracer/api -- --scenario deviation --dry-run > deviation.csv

# Local stack (gateway on 127.0.0.1:5023): register the IMEI first (npm run sim:register), create a route
# and a planned trip for that vehicle starting now, then:
npm run sim:route -w @veetracer/api -- --scenario late-stop --imei 868120000000001

# Several vehicles on the same route, 30 s apart, against a test instance
npm run sim:route -w @veetracer/api -- --scenario on-time --imei-start 868120000000001 --count 5 --stagger 30 \
  --host test-gateway.example --port 5023
```

The run prints each event as its fix is sent (`arrive`, `depart`, `skip`, `deviation-on/off`,
`unscheduled-start/end`) and exits after the last fix.

### Bundled scenarios (`scenarios/`)

All use `chennai-route.json`: Koyambedu CMBT → Anna Nagar Roundtana → Kilpauk Medical College → Egmore Station →
Chennai Central. It is 10.6 km long, with 100 m radii, 2 min waits and planned offsets 0 / 8 / 18 / 25 / 30 min.
Its `path` follows the main roads (JN Salai, 2nd Avenue, Poonamallee High Road) roughly, so no GraphHopper is
needed.

| Scenario | What the tracker should record (at the default speed factor 1) |
|---|---|
| `on-time` | Starts on leaving Koyambedu, every stop arrived / departed within about 1 min of plan, completes. |
| `late-stop` | 15 extra minutes at Anna Nagar, so Kilpauk is reached about 15 min late (`TRIP_STOP_LATE`, threshold 10 min), as are the stops after it. |
| `deviation` | Parallel road 400 m north between 68 % and 80 % of the path: `ROUTE_DEVIATION` opens and closes. |
| `skip-stop` | Passes Egmore 175 m away (radius 100 m, still inside the 200 m corridor): Egmore SKIPPED. |
| `unscheduled-stop` | Stands still for 7 min on the road between Anna Nagar and Kilpauk (45 % of the path): `UNSCHEDULED_STOP`. |

A scenario file is `{ name, description, route, cruiseKph, scenario }`, where `scenario` takes the options below.
They can be combined, and flags override them:

| Option | Flag | Meaning |
|---|---|---|
| `delayAtStopSec: {stop, sec}` | `--delay-stop i --delay-sec s` | Extra dwell at stop `i-1`, so stop `i` is reached `s` seconds later. The vehicle waits inside a stop radius, so this never counts as an unscheduled stop. |
| `deviation: {fromFrac, toFrac, offsetM, side}` | `--deviation "0.68,0.8,400,left"` | Parallel detour between two path fractions. It ramps out and back over `offsetM` metres. |
| `skipStop: i` | `--skip-stop i` | Bypass stop `i` (not the first or the last) at radius + 75 m, without slowing down. |
| `unscheduledStop: {atFrac, sec}` | `--unscheduled "0.45,420"` | Speed 0 for `sec` seconds at a path fraction. |
| `speedFactor` | `--speed-factor f` | Time compression, see below. |

Stop indexes start at 0.

### Timestamps and `--speed-factor`

Fix timestamps are always the **wall clock** at the moment the fix is sent. The gateway rejects fixes too far in the
future and the tracker works on fix times, so the simulator never compresses timestamps. Instead, `--speed-factor f` compresses
the drive:

- The vehicle covers `f` times the distance per second.
- The planned waits (`waitMin`) are divided by `f`.
- The reported speed stays the nominal cruise speed, so overspeed rules don't fire.
- `delayAtStopSec` and `unscheduledStop` are **not** divided. The tracker measures them against wall-clock
  thresholds (late after 10 min, unscheduled stop after 5 min), so they still fire.
- `cruise × f` must stay at or below 180 km/h, because the gateway drops fixes with an implied speed above 200 km/h
  as jumps. With the default 30 km/h, `--speed-factor 6` is the maximum.

With `f > 1` the vehicle reaches stops earlier than the route's planned offsets. The dry-run summary prints the
simulated arrival per stop next to the planned offset, so you can set offsets for a compressed test, or judge
lateness relative to the on-time run.

### Route and path sources

- `--scenario <name|file>`: a bundled scenario, or a scenario JSON file. Its `route` is resolved next to it.
- `--route-file <file>`: `{ stops: [{name, lat, lng, radiusM?, offsetMin?, waitMin? | waitSec?}], path?, corridorM? }`.
  This is the shape `GET /api/routes/:id` returns, and a `{ data: ... }` wrapper is accepted too. `path: null` means
  straight lines between the stops.
- `--stops "lat,lng;lat,lng;..."`: ad-hoc stops named `Stop 1..n`, with `--wait <s>` dwell each.
- `--path-file <file>`: overrides the path. It accepts `[[lng,lat], ...]`, a GeoJSON LineString, or a GraphHopper
  `/route` response (plain or encoded points), auto-detected.
- `--router-url http://localhost:8989`: fetches a road path through the stops from GraphHopper
  (`/route?profile=car&points_encoded=false&point=...`).
- With no path at all, the vehicle drives straight lines between the stops, which is also what the tracker uses
  when a route has no path.

The vehicle dwells at the point of the path nearest to each stop. A warning is printed if a stop is farther from the
path than its radius.

### Exporting a route from the API into a route file

Use a local stack or a test instance only, never production:

```bash
API=http://localhost:4000/api
TOKEN=$(curl -s -X POST $API/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"..."}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).accessToken')
curl -s -H "Authorization: Bearer $TOKEN" $API/routes/<routeId> > my-route.json   # add -H "X-Company-Id: <id>" if needed

npm run sim:route -w @veetracer/api -- --route-file my-route.json --dry-run > /dev/null   # check the stop summary
npm run sim:route -w @veetracer/api -- --route-file my-route.json --imei 868120000000001 --skip-stop 2
```

The file can be used as is: the stop fields (`radiusM`, `offsetMin`, `waitMin`) and `path` are read directly, and
extra fields are ignored. Use `--path-file` or `--router-url` if the saved route has no path.

### Other flags

`--cruise 30` (km/h), `--interval 5` (s), `--start-dwell 60` (s parked in the start stop before leaving, so the
tracker sees the vehicle inside first), `--corridor 200` (m, only for the printed deviation messages),
`--protocol gt06|gt06-4g`, `--tz 330` (device time zone in minutes, as in `gt06-sim`), `--host`, `--port 5023`.
