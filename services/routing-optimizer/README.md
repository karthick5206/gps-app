# routing-optimizer

OR-Tools vehicle-routing solver for VeeTrax ETMS (E4, WP 4.3a). It solves a capacitated VRP with time windows on a
**matrix the caller supplies**. It never calls a routing engine: the API builds the matrix from GraphHopper
(ETMS README §5 D3: GraphHopper is the only road engine; Valhalla is out of scope). Ported from
`feature/routing-engine` with `valhalla.py`, `cli.py --valhalla` and the bench's Valhalla mode removed (doc 17 §5.1).

Manual dispatch never depends on this service. When it is stopped, busy or failing, the API reports the optimiser as
unavailable; it never substitutes a heuristic plan or invented times.

## Run

Python **3.14** is required (`ortools==9.15.6755` is the release with cp314 wheels). Dependencies are pinned with
sha256 hashes in `requirements.lock` (`requirements.txt` / `requirements-dev.txt` are the human-edited top-level pins).

```bash
python3.14 -m venv ~/.venvs/routing-optimizer
~/.venvs/routing-optimizer/bin/pip install --require-hashes --no-deps --only-binary=:all: -r requirements.lock

# tests (no network)
~/.venvs/routing-optimizer/bin/python -m pytest

# HTTP server, loopback only by default
OPTIMIZER_TOKEN=$(cat ~/.config/veetrax/optimizer.token) ~/.venvs/routing-optimizer/bin/python -m optimizer.server

# one-off solve from a file (or - for stdin); exit 0 = FEASIBLE/OPTIMAL, 2 = otherwise
~/.venvs/routing-optimizer/bin/python -m optimizer.cli problem.json --pretty

# solver timing on synthetic matrices (benchmark input only, never an ETA); --matrix adds a GraphHopper-built one
~/.venvs/routing-optimizer/bin/python -m bench_optimizer [--matrix matrix.json]
```

`./run.sh` (WSL) does the venv, the locked install and starts the server; `./run.sh test` runs pytest. It keeps a
generated token in `~/.config/veetrax/optimizer.token` (mode 0600, outside the repository).

### Server settings

| Variable | Default | Meaning |
|---|---|---|
| `OPTIMIZER_TOKEN` | none (**required**) | ≥ 24 characters, or the server refuses to start. Every request sends `Authorization: Bearer <token>` (constant-time compare). |
| `OPTIMIZER_HOST` / `--host` | `127.0.0.1` | Bind address. A non-loopback bind must be set explicitly. |
| `OPTIMIZER_PORT` / `--port` | `8090` | |
| `OPTIMIZER_ALLOW` | `127.0.0.1/32,::1/128` | Source CIDR allow-list; others get 403 before the body is read. |
| `OPTIMIZER_CONCURRENCY` | `2` | Solves at once; further requests get 429 (the caller retries later). |

Endpoints: `GET /health` → `{ok, ortools, limits, slots, busy}`; `POST /optimize` (body ≤ 8 MB) → the result below,
HTTP 400 for `INVALID_INPUT`, 200 otherwise. The access log has one line per request and never logs bodies or headers.

## Input / output contract

Times are integer seconds from a plan epoch the caller chooses (the API uses "seconds since plan start").

```jsonc
{
  "matrix": {
    "durationsS": [[0, 420, null], [400, 0, 380], [null, 390, 0]],  // n x n, n <= 600; null = no road (forbidden arc)
    "distancesM": [[0, 3100, null], [2900, 0, 2500], [null, 2600, 0]] // optional, same shape
  },
  "horizonS": 86400,                                  // optional, default 24 h
  "vehicles": [{                                      // 1..50
    "id": "v1", "startIndex": 0, "endIndex": 0,       // matrix indexes (endIndex defaults to startIndex)
    "capacity": 6,                                    // optional; omitted = unlimited
    "timeWindow": [0, 36000],                         // optional shift
    "maxDurationS": 7200                              // optional route-duration cap
  }],
  "stops": [{                                         // 0..500
    "id": "s1", "locationIndex": 1,
    "demand": 1, "serviceS": 120,                     // optional, default 0
    "timeWindows": [[600, 1200], [3000, 3600]],       // optional, one or more
    "priority": 1                                     // optional, drop penalty weight (>= 1)
  }],
  "options": { "timeLimitS": 10, "objective": "time", "localSearch": "guided", "solutionLimit": null }
}                                                     // timeLimitS is clamped to 1..120; objective "distance" needs distancesM
```

Result:

```jsonc
{
  "status": "FEASIBLE",            // FEASIBLE | OPTIMAL | NO_SOLUTION | INVALID_INPUT
  "provenOptimal": false,          // true only when OR-Tools proves it (status OPTIMAL)
  "solverStatus": "ROUTING_SUCCESS",
  "objective": 1234,
  "routes": [{
    "vehicleId": "v1", "startS": 0, "endS": 1600, "durationS": 1600, "distanceM": 5600, "load": 1,
    "locationSequence": [0, 1, 0],
    "stops": [{ "stopId": "s1", "locationIndex": 1, "arrivalS": 420, "serviceStartS": 600, "waitS": 180,
                "departureS": 720, "load": 1 }]
  }],
  "unassigned": [{ "stopId": "s9", "reason": "time_window_unreachable" }],
  "stats": { "wallTimeMs": 1012, "timeLimitS": 10, "stops": 2, "vehicles": 1 },
  "note": "Best solution found within the time limit; not proven optimal."
}
```

- `INVALID_INPUT` adds `error` (e.g. `matrix.durationsS is required`); a problem without a matrix is always refused.
- Unassigned reasons: `invalid_time_window`, `demand_exceeds_vehicle_capacity`, `unreachable_location`,
  `time_window_unreachable`, `exceeds_max_route_duration` (pre-checks), `not_scheduled_capacity_or_time` (dropped by
  the solver), `no_solution_found`.
- `distanceM` is `null` when no `distancesM` was sent. Times in the result come from matrix cells; the API re-routes
  each leg with the routing provider before showing distances or times to users (doc 06 §3, rule RD-39).

Limits (`solver.LIMITS`): 500 stops, 50 vehicles, 600 locations, 120 s time limit.

## Resource notes

- CPU: one solve uses one core for up to `timeLimitS`; the server runs at most `OPTIMIZER_CONCURRENCY` solves.
  Memory grows with the matrix (Python transit callbacks over an n × n list) and the body is capped at 8 MB. Peak
  memory for a 600-location problem has not been measured yet; benchmark it on the production host before enabling
  the service there (doc 06 §7, B4).
- Recommended production caps when a systemd unit is added (WP 4.2, not part of this change): `CPUQuota=150%`,
  `MemoryMax=3G`, `OPTIMIZER_CONCURRENCY=1`, bind `127.0.0.1`, token from an `EnvironmentFile` readable only by the
  service user.
- No database, no disk writes, no outbound network.

## CI

`.github/workflows/ci.yml` job `optimizer`: Python 3.14.4, `pip install --require-hashes --no-deps
--only-binary=:all: -r requirements.lock` from PyPI, then `python -m pytest`.

To change a pin: edit `requirements*.txt`, rebuild the venv, `pip freeze` into `requirements.lock`, and regenerate
the `--hash` lines for every published file of each pinned release (PyPI JSON API `digests.sha256`).
