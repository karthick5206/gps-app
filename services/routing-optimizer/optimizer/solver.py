"""Vehicle routing on a precomputed road matrix (built by the API from GraphHopper), solved with OR-Tools.

Pure function `solve(problem) -> result`; no I/O, no routing engine. Times are integer seconds relative to the plan
epoch chosen by the caller (the API uses "seconds since plan start"). The matrix is indexed by `locationIndex`;
`None` cells mean the engine found no route and are treated as forbidden arcs.

Two problem shapes (README "Input / output contract"):

* **generic** (contract v1, P3): a capacitated VRP with time windows. Unchanged behaviour when no v2 field is sent.
* **trip** (contract v2, WP 4.3): one site and one direction (doc 06 §4.2).
  - `IN` (login, homes -> site): solved as the reverse of a drop problem on the transposed matrix. Vehicles start
    at the site in model time `R = T - t` (T = latest allowed site arrival) and end at their garage / current
    position, so a passenger's ride time is `Cumul(node) - Cumul(Start(v))`.
  - `OUT` (logout, site -> homes): vehicles depart from the site; ride time is `Cumul(node) - Cumul(Start(v))`.
  Max ride time uses a second dimension whose slack is tied to the time dimension's slack, so its cumul is exactly
  the time elapsed since the vehicle left (IN: until it reaches) the site.

The solver never claims optimality unless OR-Tools proves it (`provenOptimal`): a normal result is `FEASIBLE`
(best solution found within the time limit). Every stop is either routed or listed in `unassigned` with a reason.
"""
from __future__ import annotations

import math
import time
from dataclasses import dataclass
from typing import Any

from ortools.constraint_solver import pywrapcp, routing_enums_pb2

SCHEMA_VERSION = 2
SUPPORTED_SCHEMA_VERSIONS = (1, 2)
LIMITS = {'stops': 500, 'vehicles': 50, 'locations': 600, 'timeLimitS': 120}
DEFAULT_HORIZON_S = 24 * 3600
UNREACHABLE = 10**9          # transit for a None cell: larger than any horizon, so the time dimension forbids the arc
BIG_COST = 10**9             # arc cost of a None cell (never chosen: the time dimension forbids it anyway)
UNLIMITED_CAPACITY = 10**6   # vehicle without a capacity
DROP_PENALTY = 10**7         # per unit of priority; raised automatically when weighted costs could exceed it
PINNED_PENALTY_FACTOR = 100  # a pinned stop is far more expensive to drop than a free one

# P3 reason (snake_case, kept for compatibility) -> doc 06 §4.6 reason code. Codes marked (ext) extend that table.
REASON_CODES = {
    'invalid_time_window': 'INVALID_TIME_WINDOW',                    # (ext) every window has start > end
    'no_vehicle_available': 'NO_COMPATIBLE_VEHICLE',                  # every vehicle unusable (availability / site)
    'demand_exceeds_vehicle_capacity': 'NO_COMPATIBLE_VEHICLE',
    'no_compatible_vehicle': 'NO_COMPATIBLE_VEHICLE',
    'pinned_assignment_infeasible': 'PINNED_ASSIGNMENT_INFEASIBLE',  # (ext)
    'safety_rule': 'SAFETY_RULE',
    'unreachable_location': 'ROUTING_UNAVAILABLE',
    'time_window_unreachable': 'SHIFT_WINDOW_UNREACHABLE',
    'max_ride_unachievable': 'MAX_RIDE_UNACHIEVABLE',
    'exceeds_max_route_duration': 'MAX_ROUTE_DURATION',               # (ext) driver duty / route span
    'no_solution_found': 'NO_SOLUTION',                               # (ext)
    # 'not_scheduled_capacity_or_time' -> CAPACITY_EXHAUSTED | TIME_LIMIT | NOT_SCHEDULED (ext), decided post-solve
}
_PRECHECK_ORDER = ('unreachable_location', 'time_window_unreachable', 'max_ride_unachievable',
                   'exceeds_max_route_duration')
FIRST_SOLUTION = {
    'path_cheapest_arc': routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC,
    'parallel_cheapest_insertion': routing_enums_pb2.FirstSolutionStrategy.PARALLEL_CHEAPEST_INSERTION,
    'savings': routing_enums_pb2.FirstSolutionStrategy.SAVINGS,
    'automatic': routing_enums_pb2.FirstSolutionStrategy.AUTOMATIC,
}
LOCAL_SEARCH = {
    'guided': routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH,
    'greedy': routing_enums_pb2.LocalSearchMetaheuristic.GREEDY_DESCENT,
    'tabu': routing_enums_pb2.LocalSearchMetaheuristic.TABU_SEARCH,
    'annealing': routing_enums_pb2.LocalSearchMetaheuristic.SIMULATED_ANNEALING,
}


class InvalidProblem(ValueError):
    pass


@dataclass
class _Ctx:
    n: int
    dur: list[list[int | None]]
    dist: list[list[int | None]] | None
    vehicles: list[dict]
    stops: list[dict]
    horizon: int
    trip: dict | None
    opts: dict
    weights: dict | None
    schema: int


# ----------------------------------------------------------------------------------------------------------------
# Validation and normalisation
# ----------------------------------------------------------------------------------------------------------------

def _int_matrix(m: Any, n: int, name: str) -> list[list[int | None]]:
    if not isinstance(m, list) or len(m) != n or any(not isinstance(r, list) or len(r) != n for r in m):
        raise InvalidProblem(f'{name} must be a {n}x{n} array')
    out = []
    for r in m:
        row = []
        for v in r:
            if v is None:
                row.append(None)
            elif isinstance(v, (int, float)) and not isinstance(v, bool) and v >= 0:
                row.append(int(round(v)))
            else:
                raise InvalidProblem(f'{name} cells must be non-negative numbers or null')
        out.append(row)
    return out


def _window(w: Any, horizon: int, what: str) -> tuple[int, int]:
    if w is None:
        return 0, horizon
    if not (isinstance(w, (list, tuple)) and len(w) == 2 and all(isinstance(x, (int, float)) for x in w)):
        raise InvalidProblem(f'{what} must be [startS, endS]')
    return int(w[0]), int(w[1])


def _num(x: Any, what: str, *, integer: bool = False, positive: bool = False) -> float | int | None:
    if x is None:
        return None
    if isinstance(x, bool) or not isinstance(x, (int, float)):
        raise InvalidProblem(f'{what} must be a number')
    if x < 0 or (positive and x <= 0):
        raise InvalidProblem(f'{what} must be {"> 0" if positive else ">= 0"}')
    return int(x) if integer else x


def _str_set(x: Any, what: str) -> set[str] | None:
    if x is None:
        return None
    if not isinstance(x, list):
        raise InvalidProblem(f'{what} must be an array of strings')
    return {str(i) for i in x}


def _trip(t: Any, n: int, horizon: int) -> dict | None:
    if t is None:
        return None
    if not isinstance(t, dict):
        raise InvalidProblem('trip must be an object')
    direction = t.get('direction')
    if direction not in ('IN', 'OUT'):
        raise InvalidProblem('trip.direction must be "IN" or "OUT"')
    try:
        site = int(t.get('siteIndex'))
    except (TypeError, ValueError):
        raise InvalidProblem('trip.siteIndex must be a matrix index') from None
    if not 0 <= site < n:
        raise InvalidProblem('trip.siteIndex out of range')
    if t.get('siteWindow') is None:
        raise InvalidProblem('trip.siteWindow is required')
    w0, w1 = _window(t.get('siteWindow'), horizon, 'trip.siteWindow')
    if not 0 <= w0 <= w1 <= horizon:
        raise InvalidProblem('trip.siteWindow must satisfy 0 <= startS <= endS <= horizonS')
    return {'direction': direction, 'site': site, 'window': (w0, w1),
            'maxRide': _num(t.get('maxRideS'), 'trip.maxRideS', integer=True, positive=True)}


def _weights(w: Any, has_dist: bool) -> dict | None:
    if w is None:
        return None
    if not isinstance(w, dict):
        raise InvalidProblem('options.weights must be an object')
    out = {k: _num(w.get(k), f'options.weights.{k}') or 0 for k in ('vehicle', 'distance', 'time', 'routeDuration')}
    if not (out['distance'] or out['time'] or out['routeDuration']):
        raise InvalidProblem('options.weights needs distance, time or routeDuration > 0')
    if out['distance'] and not has_dist:
        raise InvalidProblem('options.weights.distance needs matrix.distancesM')
    return out


def validate(problem: dict) -> _Ctx:
    if not isinstance(problem, dict):
        raise InvalidProblem('problem must be an object')
    schema = problem.get('schemaVersion', 1)
    if schema not in SUPPORTED_SCHEMA_VERSIONS:
        raise InvalidProblem(f'schemaVersion must be one of {list(SUPPORTED_SCHEMA_VERSIONS)}')
    matrix = problem.get('matrix') or {}
    if not isinstance(matrix, dict):
        raise InvalidProblem('matrix must be an object')
    dur_raw = matrix.get('durationsS')
    if dur_raw is None:
        raise InvalidProblem('matrix.durationsS is required')
    n = len(dur_raw) if isinstance(dur_raw, list) else 0
    if not 1 <= n <= LIMITS['locations']:
        raise InvalidProblem(f"matrix must have 1..{LIMITS['locations']} locations")
    dur = _int_matrix(dur_raw, n, 'matrix.durationsS')
    dist = _int_matrix(matrix['distancesM'], n, 'matrix.distancesM') if matrix.get('distancesM') is not None else None
    horizon = int(problem.get('horizonS') or DEFAULT_HORIZON_S)
    if horizon <= 0:
        raise InvalidProblem('horizonS must be > 0')
    vehicles, stops = problem.get('vehicles') or [], problem.get('stops') or []
    if not isinstance(vehicles, list) or not 1 <= len(vehicles) <= LIMITS['vehicles']:
        raise InvalidProblem(f"1..{LIMITS['vehicles']} vehicles required")
    if not isinstance(stops, list) or len(stops) > LIMITS['stops']:
        raise InvalidProblem(f"at most {LIMITS['stops']} stops")
    trip = _trip(problem.get('trip'), n, horizon)
    opts = problem.get('options') or {}
    if not isinstance(opts, dict):
        raise InvalidProblem('options must be an object')
    if opts.get('firstSolution') is not None and opts['firstSolution'] not in FIRST_SOLUTION:
        raise InvalidProblem(f'options.firstSolution must be one of {sorted(FIRST_SOLUTION)}')
    # E4 security review L5: numeric options are checked here (a wrong type is a 400, never a worker exception).
    for key in ('timeLimitS', 'solutionLimit', 'seed'):
        v = opts.get(key)
        if v is not None and (isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v)):
            raise InvalidProblem(f'options.{key} must be a finite number')
    weights = _weights(opts.get('weights'), dist is not None)

    norm_v, vids = [], set()
    for i, v in enumerate(vehicles):
        if not isinstance(v, dict):
            raise InvalidProblem('each vehicle must be an object')
        vid = str(v.get('id', f'vehicle-{i}'))
        if vid in vids:
            raise InvalidProblem(f'duplicate vehicle id {vid}')
        vids.add(vid)
        # Missing startIndex = 0 (P3); explicit null = open start (route begins at its first stop).
        s = None if ('startIndex' in v and v['startIndex'] is None) else int(v.get('startIndex', 0))
        e = (None if v['endIndex'] is None else int(v['endIndex'])) if 'endIndex' in v else s
        if (s is not None and not 0 <= s < n) or (e is not None and not 0 <= e < n):
            raise InvalidProblem(f'vehicle {vid}: start/end index out of range')
        tw = _window(v.get('timeWindow'), horizon, f'vehicle {vid} timeWindow')
        raw_cap = None if v.get('capacity') is None else int(v['capacity'])
        if raw_cap is not None and raw_cap < 0:
            raise InvalidProblem(f'vehicle {vid}: capacity must be >= 0')
        escort = bool(v.get('escort', False))
        seats = raw_cap
        if raw_cap is not None and escort and v.get('escortUsesSeat', True):
            seats = raw_cap - 1   # doc 06 §4.5: the escort's seat consumes capacity
            if seats < 0:
                raise InvalidProblem(f'vehicle {vid}: capacity must leave a seat for the escort')
        max_dur = v.get('maxDurationS')
        dw = _num(v.get('distanceWeight'), f'vehicle {vid} distanceWeight')
        if dw and dist is None:
            raise InvalidProblem(f'vehicle {vid}: distanceWeight needs matrix.distancesM')
        norm_v.append({
            'id': vid, 'start': s, 'end': e, 'tw': tw,
            'capacity': UNLIMITED_CAPACITY if seats is None else seats, 'rawCapacity': raw_cap,
            'maxDuration': int(max_dur) if max_dur is not None else None,
            'wheelchair': int(_num(v.get('wheelchairSpaces'), f'vehicle {vid} wheelchairSpaces', integer=True) or 0),
            'escort': escort, 'type': None if v.get('type') is None else str(v['type']),
            'fixedCost': _num(v.get('fixedCost'), f'vehicle {vid} fixedCost'),
            'dw': dw, 'tw_weight': _num(v.get('timeWeight'), f'vehicle {vid} timeWeight'),
        })

    norm_s, ids = [], set()
    for i, st in enumerate(stops):
        if not isinstance(st, dict):
            raise InvalidProblem('each stop must be an object')
        sid = str(st.get('id', f'stop-{i}'))
        if sid in ids:
            raise InvalidProblem(f'duplicate stop id {sid}')
        ids.add(sid)
        li = int(st.get('locationIndex', -1))
        if not 0 <= li < n:
            raise InvalidProblem(f'stop {sid}: locationIndex out of range')
        windows = st.get('timeWindows') or [None]
        tws = sorted(_window(w, horizon, f'stop {sid} timeWindow') for w in windows)
        pax = st.get('passengerIds')
        if pax is not None and not isinstance(pax, list):
            raise InvalidProblem(f'stop {sid}: passengerIds must be an array')
        demand = int(st['demand']) if st.get('demand') is not None else (len(pax) if pax else 0)
        service = int(st.get('serviceS', 0) or 0)
        if demand < 0 or service < 0:
            raise InvalidProblem(f'stop {sid}: demand and serviceS must be >= 0')
        max_ride = _num(st.get('maxRideS'), f'stop {sid} maxRideS', integer=True, positive=True)
        escort_ends = bool(st.get('escortIfFirstOrLast', False))
        if trip is None and (max_ride is not None or escort_ends):
            raise InvalidProblem(f'stop {sid}: maxRideS / escortIfFirstOrLast need trip.direction')
        norm_s.append({
            'id': sid, 'loc': li, 'tws': tws, 'demand': demand, 'service': service,
            'priority': max(1, int(st.get('priority', 1) or 1)),
            'passengerIds': [str(p) for p in pax] if pax is not None else None,
            'maxRide': max_ride if max_ride is not None else (trip['maxRide'] if trip else None),
            'wheelchair': int(_num(st.get('wheelchair'), f'stop {sid} wheelchair', integer=True) or 0),
            'allowedIds': _str_set(st.get('allowedVehicleIds'), f'stop {sid} allowedVehicleIds'),
            'allowedTypes': _str_set(st.get('allowedVehicleTypes'), f'stop {sid} allowedVehicleTypes'),
            'requiresEscort': bool(st.get('requiresEscort', False)),
            'escortEnds': escort_ends,
            'pinned': None if st.get('pinnedVehicleId') is None else str(st['pinnedVehicleId']),
            'customer': None if st.get('customerId') is None else str(st['customerId']),
            'exclusive': bool(st.get('exclusive', False)),
        })
    return _Ctx(n, dur, dist, norm_v, norm_s, horizon, trip, opts, weights, schema)


# ----------------------------------------------------------------------------------------------------------------
# Vehicle frames and pre-checks
# ----------------------------------------------------------------------------------------------------------------

def _frame(ctx: _Ctx, v: dict) -> dict | str:
    """Model start/end location (None = open) and cumul ranges in model time; a reason string if unusable."""
    a, b = v['tw']
    trip = ctx.trip
    if trip is None:
        if a > b:
            return 'invalid_availability_window'
        return {'mstart': v['start'], 'mend': v['end'], 'start': (a, b), 'end': (a, b), 'deadhead': 0}
    w0, w1 = trip['window']
    site = trip['site']
    if trip['direction'] == 'OUT':
        dh = 0 if v['start'] is None or v['start'] == site else ctx.dur[v['start']][site]
        if dh is None:
            return 'cannot_reach_site'
        lo, hi = max(w0, a + dh), min(w1, b)
        if lo > hi:
            return 'availability_outside_site_window'
        return {'mstart': site, 'mend': v['end'], 'start': (lo, hi), 'end': (lo, b), 'deadhead': dh}
    # IN, reversed model time R = T - t.
    T = w1
    lo, hi = max(w0, a), min(w1, b)
    if lo > hi:
        return 'availability_outside_site_window'
    return {'mstart': site, 'mend': v['start'], 'start': (T - hi, T - lo), 'end': (0, T - a), 'deadhead': 0,
            'arrive': (lo, hi)}


def _incompat(v: dict, s: dict) -> set[str]:
    fails = set()
    if s['allowedIds'] is not None and v['id'] not in s['allowedIds']:
        fails.add('vehicle_id')
    if s['allowedTypes'] is not None and v['type'] not in s['allowedTypes']:
        fails.add('vehicle_type')
    if s['demand'] > v['capacity']:
        fails.add('seats')
    if s['wheelchair'] > v['wheelchair']:
        fails.add('wheelchair')
    # An exclusive (no pooling) flagged passenger is always both first and last: it needs an escort vehicle.
    if (s['requiresEscort'] or (s['exclusive'] and s['escortEnds'])) and not v['escort']:
        fails.add('escort')
    return fails


def _direct(ctx: _Ctx, v: dict, f: dict, s: dict) -> str | None:
    """None when this vehicle alone can serve the stop, else the pre-check reason."""
    dur, svc, max_ride, max_dur = ctx.dur, s['service'], s['maxRide'], v['maxDuration']
    windows = [(a, b) for a, b in s['tws'] if a <= b]
    reasons = set()
    trip = ctx.trip
    if trip is None:   # P3 semantics
        to_stop = 0 if v['start'] is None else dur[v['start']][s['loc']]
        back = 0 if v['end'] is None else dur[s['loc']][v['end']]
        if to_stop is None or back is None:
            return 'unreachable_location'
        earliest = v['tw'][0] + to_stop
        for a, b in windows:
            start_service = max(earliest, a)
            if start_service <= b and start_service + svc + back <= v['tw'][1]:
                if max_dur is None or (start_service - v['tw'][0]) + svc + back <= max_dur:
                    return None
                reasons.add('exceeds_max_route_duration')
            else:
                reasons.add('time_window_unreachable')
    elif trip['direction'] == 'OUT':
        site = trip['site']
        to = dur[site][s['loc']]
        back = 0 if v['end'] is None else dur[s['loc']][v['end']]
        if to is None or back is None:
            return 'unreachable_location'
        d0, d1 = f['start']
        for a, b in windows:
            d = min(max(a - to, d0), d1)               # leave as late as useful: shortest ride
            ss = max(a, d + to)
            if ss > b:
                reasons.add('time_window_unreachable')
                continue
            if max_ride is not None and ss - d > max_ride:
                reasons.add('max_ride_unachievable')
                continue
            end = ss + svc + back
            if end > v['tw'][1]:
                reasons.add('time_window_unreachable')
                continue
            if max_dur is not None and end - d > max_dur:
                reasons.add('exceeds_max_route_duration')
                continue
            return None
    else:   # IN
        site = trip['site']
        from_g = 0 if v['start'] is None else dur[v['start']][s['loc']]
        to_site = dur[s['loc']][site]
        if from_g is None or to_site is None:
            return 'unreachable_location'
        lo_arr, hi_arr = f['arrive']
        for a, b in windows:
            ss = min(b, hi_arr - svc - to_site)        # pick up as late as possible: shortest ride
            if ss < max(a, v['tw'][0] + from_g, 0):
                reasons.add('time_window_unreachable')
                continue
            arrive = max(ss + svc + to_site, lo_arr)
            if max_ride is not None and arrive - ss > max_ride:
                reasons.add('max_ride_unachievable')
                continue
            if max_dur is not None and arrive - (ss - from_g) > max_dur:
                reasons.add('exceeds_max_route_duration')
                continue
            return None
    for r in _PRECHECK_ORDER:
        if r in reasons:
            return r
    return 'time_window_unreachable'


def _assess(ctx: _Ctx, frames: list[tuple[dict, dict]], s: dict) -> tuple[str | None, dict | None, list[int]]:
    """(reason, detail, model-vehicle positions that may serve the stop)."""
    if all(a > b for a, b in s['tws']):
        return 'invalid_time_window', None, []
    if not frames:
        return 'no_vehicle_available', {'failed': ['availability']}, []
    cand = list(enumerate(frames))
    if s['pinned'] is not None:
        cand = [(k, vf) for k, vf in cand if vf[0]['id'] == s['pinned']]
        if not cand:
            return 'pinned_assignment_infeasible', {'pinnedVehicleId': s['pinned'], 'failed': ['vehicle_unavailable']}, []
    compat, all_fails = [], []
    for k, (v, f) in cand:
        fails = _incompat(v, s)
        all_fails.append(fails)
        if not fails:
            compat.append((k, v, f))
    if not compat:
        failed = sorted(set().union(*all_fails))
        if s['pinned'] is not None:
            return 'pinned_assignment_infeasible', {'pinnedVehicleId': s['pinned'], 'failed': failed}, []
        if any(fl == {'escort'} for fl in all_fails):
            return 'safety_rule', {'rule': 'requiresEscort'}, []
        if all('seats' in fl for fl in all_fails):
            return 'demand_exceeds_vehicle_capacity', {'failed': ['seats']}, []
        return 'no_compatible_vehicle', {'failed': failed}, []
    ok, reasons = [], set()
    for k, v, f in compat:
        r = _direct(ctx, v, f, s)
        if r is None:
            ok.append(k)
        else:
            reasons.add(r)
    if ok:
        return None, None, ok
    reason = next(r for r in _PRECHECK_ORDER + ('time_window_unreachable',) if r in reasons)
    if s['pinned'] is not None:
        return 'pinned_assignment_infeasible', {'pinnedVehicleId': s['pinned'], 'failed': [reason]}, []
    return reason, None, []


def _model_windows(ctx: _Ctx, s: dict, dim_cap: int) -> list[tuple[int, int]]:
    out = []
    rev = ctx.trip is not None and ctx.trip['direction'] == 'IN'
    T = ctx.trip['window'][1] if rev else 0
    for a, b in s['tws']:
        if a > b:
            continue
        if rev:
            a, b = T - b, T - a
        a, b = max(a, 0), min(b, dim_cap)
        if a <= b:
            out.append((a, b))
    return sorted(out)


def _unassigned(s: dict, reason: str, detail: dict | None = None, code: str | None = None) -> dict:
    u = {'stopId': s['id'], 'reason': reason, 'code': code or REASON_CODES.get(reason, 'NOT_SCHEDULED')}
    if s.get('passengerIds') is not None:
        u['passengerIds'] = s['passengerIds']
    if detail:
        u['detail'] = detail
    return u


# ----------------------------------------------------------------------------------------------------------------
# Solve
# ----------------------------------------------------------------------------------------------------------------

def solve(problem: dict) -> dict:
    t0 = time.perf_counter()
    try:
        ctx = validate(problem)
    except InvalidProblem as e:
        return {'schemaVersion': SCHEMA_VERSION, 'status': 'INVALID_INPUT', 'provenOptimal': False, 'error': str(e),
                'routes': [], 'unassigned': []}
    opts = ctx.opts
    time_limit = max(1, min(int(opts.get('timeLimitS', 10)), LIMITS['timeLimitS']))
    trip = ctx.trip
    rev = trip is not None and trip['direction'] == 'IN'
    T = trip['window'][1] if trip else 0
    dim_cap = max(T, 1) if rev else ctx.horizon
    null_cells = sum(c is None for r in ctx.dur for c in r)

    frames, unusable = [], []
    for v in ctx.vehicles:
        f = _frame(ctx, v)
        if isinstance(f, str):
            unusable.append({'vehicleId': v['id'], 'reason': f})
        else:
            frames.append((v, f))

    unassigned, active = [], []
    for s in ctx.stops:
        reason, detail, allowed = _assess(ctx, frames, s)
        mw = _model_windows(ctx, s, dim_cap) if reason is None else []
        if reason is None and not mw:
            reason = 'time_window_unreachable'
        if reason:
            unassigned.append(_unassigned(s, reason, detail))
        else:
            active.append({**s, '_allowed': allowed, '_mw': mw})

    base: dict = {'schemaVersion': SCHEMA_VERSION}
    if trip:
        base['trip'] = {'direction': trip['direction'], 'siteIndex': trip['site'], 'siteWindow': list(trip['window'])}

    def stats(extra: dict) -> dict:
        return {'wallTimeMs': round((time.perf_counter() - t0) * 1000), 'timeLimitS': time_limit,
                'stops': len(ctx.stops), 'vehicles': len(ctx.vehicles), 'vehiclesUsable': len(frames),
                'matrixNullCells': null_cells, **extra}

    if not frames or not active:
        return {**base, 'status': 'FEASIBLE', 'provenOptimal': False, 'solverStatus': 'NOT_RUN', 'objective': 0,
                'objectiveBreakdown': _breakdown([], 0), 'weights': ctx.weights, 'routes': [],
                'unassigned': unassigned, 'unusableVehicles': unusable,
                'stats': stats({'stoppedBy': 'nothing_to_route', 'deterministic': True}),
                'note': 'Nothing to route: no usable vehicle or no stop passed the pre-checks.'}

    mv = [v for v, _ in frames]
    mf = [f for _, f in frames]
    keys = {f['mstart'] for f in mf} | {f['mend'] for f in mf}
    depot_keys = sorted(keys, key=lambda x: (x is None, x if x is not None else 0))
    nd = len(depot_keys)
    node_loc: list[int | None] = depot_keys + [s['loc'] for s in active]
    node_svc = [0] * nd + [s['service'] for s in active]
    dnode = {k: i for i, k in enumerate(depot_keys)}
    nn = len(node_loc)

    manager = pywrapcp.RoutingIndexManager(nn, len(mv), [dnode[f['mstart']] for f in mf],
                                           [dnode[f['mend']] for f in mf])
    routing = pywrapcp.RoutingModel(manager)
    solver = routing.solver()
    # 'matrix' (default) registers C++ transit matrices: no Python call per arc evaluation (doc 06 §7 B5). The server
    # runs each solve in a worker process, so holding the GIL for the whole search is harmless there. 'callback' keeps
    # the P3 Python callbacks (for benchmarking B5 only).
    callbacks = opts.get('transit') == 'callback'
    keep = []

    def reg_matrix(m: list[list[int]]) -> int:
        if callbacks:
            cb = lambda fi, ti: m[manager.IndexToNode(fi)][manager.IndexToNode(ti)]  # noqa: E731
            keep.append(cb)
            return routing.RegisterTransitCallback(cb)
        return routing.RegisterTransitMatrix(m)

    def reg_vector(vec: list[int]) -> int:
        if callbacks:
            cb = lambda fi: vec[manager.IndexToNode(fi)]  # noqa: E731
            keep.append(cb)
            return routing.RegisterUnaryTransitCallback(cb)
        return routing.RegisterUnaryTransitVector(vec)

    def leg(m: list[list[int | None]], i: int, j: int) -> int | None:
        li, lj = node_loc[i], node_loc[j]
        if li is None or lj is None:
            return 0           # open start / end: a virtual location at zero distance from everything
        return m[lj][li] if rev else m[li][lj]   # IN runs on the transposed matrix

    legs = [[leg(ctx.dur, i, j) for j in range(nn)] for i in range(nn)]
    dlegs = [[leg(ctx.dist, i, j) for j in range(nn)] for i in range(nn)] if ctx.dist is not None else None
    # Forward: service of the origin + travel. Reversed (IN): travel + service of the destination (the pickup).
    tmat = [[UNREACHABLE if legs[i][j] is None else legs[i][j] + (node_svc[j] if rev else node_svc[i])
             for j in range(nn)] for i in range(nn)]
    time_idx = reg_matrix(tmat)

    # Arc costs: the P3 objective ("time" | "distance") without weights; explicit weights otherwise (P6).
    w = ctx.weights

    def cost_key(v: dict) -> tuple:
        if w is None:
            return ('p3', 'distance' if opts.get('objective') == 'distance' and ctx.dist is not None else 'time')
        return ('w', v['dw'] if v['dw'] is not None else w['distance'],
                v['tw_weight'] if v['tw_weight'] is not None else w['time'])

    cost_cache: dict[tuple, int] = {}
    max_arc = 0
    for vi, v in enumerate(mv):
        key = cost_key(v)
        if key not in cost_cache:
            cm = []
            for i in range(nn):
                row = []
                for j in range(nn):
                    d = legs[i][j]
                    if key[0] == 'p3':
                        c = dlegs[i][j] if key[1] == 'distance' else d
                        c = BIG_COST if c is None or d is None else c
                    else:
                        dm = dlegs[i][j] if dlegs is not None else 0
                        if d is None or (key[1] and dm is None):
                            c = BIG_COST
                        else:
                            c = int(round(key[1] * (dm or 0) + key[2] * d))
                    if c < BIG_COST:
                        max_arc = max(max_arc, c)
                    row.append(c)
                cm.append(row)
            cost_cache[key] = reg_matrix(cm)
        routing.SetArcCostEvaluatorOfVehicle(cost_cache[key], vi)

    routing.AddDimension(time_idx, dim_cap, dim_cap, False, 'Time')
    tdim = routing.GetDimensionOrDie('Time')

    # Capacity dimensions: seats, wheelchair spaces, exclusive (no pooling) occupancy.
    demand = [0] * nd + [s['demand'] for s in active]
    load_dim = None
    if any(demand):
        routing.AddDimensionWithVehicleCapacity(reg_vector(demand), 0,
                                                [v['capacity'] for v in mv], True, 'Load')
        load_dim = routing.GetDimensionOrDie('Load')
    wc = [0] * nd + [s['wheelchair'] for s in active]
    if any(wc):
        routing.AddDimensionWithVehicleCapacity(reg_vector(wc), 0,
                                                [v['wheelchair'] for v in mv], True, 'Wheelchair')
    if any(s['exclusive'] for s in active):
        big = len(active) + 1    # an exclusive stop fills the vehicle; any other stop then overflows it
        occ = [0] * nd + [big if s['exclusive'] else 1 for s in active]
        routing.AddDimensionWithVehicleCapacity(reg_vector(occ), 0, [big] * len(mv), True,
                                                'Exclusive')

    # Ride time: same transits as Time, slack tied to the time slack, cumul 0 at the site.
    if trip and any(s['maxRide'] is not None for s in active):
        routing.AddDimension(time_idx, dim_cap, dim_cap, True, 'Ride')
        ride = routing.GetDimensionOrDie('Ride')
        for idx in range(routing.Size()):
            solver.Add(ride.SlackVar(idx) == tdim.SlackVar(idx))
        for k, s in enumerate(active):
            if s['maxRide'] is not None:
                ride.CumulVar(manager.NodeToIndex(nd + k)).SetMax(s['maxRide'])

    # Fixed vehicle cost and route-duration weight.
    fixed = [v['fixedCost'] if v['fixedCost'] is not None else (w['vehicle'] if w else 0) for v in mv]
    span_w = int(round(w['routeDuration'])) if w else 0
    for vi in range(len(mv)):
        if fixed[vi]:
            routing.SetFixedCostOfVehicle(int(round(fixed[vi])), vi)
        if span_w:
            tdim.SetSpanCostCoefficientForVehicle(span_w, vi)

    # Dropping a passenger must always cost more than any route could save.
    penalty_base = max(DROP_PENALTY, 2 * (int(round(max(fixed, default=0))) + (nn + 1) * max_arc + span_w * dim_cap) + 1)

    # Customer mixing (P2: one customer per trip in R1) via hard visit-type incompatibilities.
    customers = sorted({s['customer'] for s in active if s['customer'] is not None})
    no_mix = len(customers) > 1 and not opts.get('allowMixedCustomers', False)
    ctype = {c: i for i, c in enumerate(customers)}
    all_v = list(range(len(mv)))
    for k, s in enumerate(active):
        idx = manager.NodeToIndex(nd + k)
        windows = s['_mw']
        var = tdim.CumulVar(idx)
        var.SetRange(windows[0][0], windows[-1][1])
        for (a1, b1), (a2, b2) in zip(windows, windows[1:]):
            if a2 > b1 + 1:
                var.RemoveInterval(b1 + 1, a2 - 1)
        factor = PINNED_PENALTY_FACTOR if s['pinned'] is not None else 1
        routing.AddDisjunction([idx], penalty_base * s['priority'] * factor)
        if s['_allowed'] != all_v:
            # SetAllowedVehiclesForIndex's absl::Span typemap is broken in the 9.15 Python wheel; same effect:
            routing.VehicleVar(idx).SetValues([-1] + s['_allowed'])
        if no_mix and s['customer'] is not None:
            routing.SetVisitType(idx, ctype[s['customer']], pywrapcp.RoutingModel.TYPE_ADDED_TO_VEHICLE)
    if no_mix:
        for c1 in range(len(customers)):
            for c2 in range(len(customers)):
                if c1 != c2:
                    routing.AddHardTypeIncompatibility(c1, c2)

    for vi, f in enumerate(mf):
        tdim.CumulVar(routing.Start(vi)).SetRange(*f['start'])
        tdim.CumulVar(routing.End(vi)).SetRange(*f['end'])
        if mv[vi]['maxDuration'] is not None:
            tdim.SetSpanUpperBoundForVehicle(mv[vi]['maxDuration'], vi)
        routing.AddVariableMinimizedByFinalizer(tdim.CumulVar(routing.Start(vi)))
    if trip:
        # Fix every stop time: earliest drop (OUT) / latest pickup (IN) once the site time is fixed.
        for k in range(len(active)):
            routing.AddVariableMinimizedByFinalizer(tdim.CumulVar(manager.NodeToIndex(nd + k)))
    for vi in range(len(mv)):
        routing.AddVariableMinimizedByFinalizer(tdim.CumulVar(routing.End(vi)))

    # Search parameters. Determinism: same input + same OR-Tools build + a search that ends at a local optimum or a
    # solution limit (not the clock) gives the same result; `stats.deterministic` says whether that held.
    deterministic = bool(opts.get('deterministic', False))
    params = pywrapcp.DefaultRoutingSearchParameters()
    params.first_solution_strategy = FIRST_SOLUTION[opts.get('firstSolution') or 'path_cheapest_arc']
    ls = opts.get('localSearch') or ('greedy' if deterministic else 'guided')
    if ls in LOCAL_SEARCH:
        params.local_search_metaheuristic = LOCAL_SEARCH[ls]
    remaining_ms = max(100, int(time_limit * 1000 - (time.perf_counter() - t0) * 1000))
    params.time_limit.FromMilliseconds(remaining_ms)
    if opts.get('solutionLimit'):
        params.solution_limit = int(opts['solutionLimit'])

    routing.CloseModelWithParameters(params)
    # Safety (doc 06 §4.5, doc 10 §5.3): a flagged passenger may not be the first pickup (IN) / last drop (OUT) of a
    # vehicle without an escort. In both model directions that position is "the node just before End(v)".
    for k, s in enumerate(active):
        if s['escortEnds']:
            idx = manager.NodeToIndex(nd + k)
            for vi, v in enumerate(mv):
                if not v['escort']:
                    routing.NextVar(idx).RemoveValue(routing.End(vi))
    if opts.get('seed') is not None:
        solver.ReSeed(int(opts['seed']))

    solution = routing.SolveWithParameters(params)
    status_name = _status_name(routing.status())
    wall_ms = round((time.perf_counter() - t0) * 1000)
    hit_limit = wall_ms >= time_limit * 1000 * 0.97
    stopped_by = 'time_limit' if hit_limit else 'solution_limit' if opts.get('solutionLimit') else 'local_optimum'

    if solution is None:
        for s in active:
            unassigned.append(_unassigned(s, 'no_solution_found', None, 'TIME_LIMIT' if hit_limit else 'NO_SOLUTION'))
        return {**base, 'status': 'NO_SOLUTION', 'provenOptimal': False, 'solverStatus': status_name, 'routes': [],
                'unassigned': unassigned, 'unusableVehicles': unusable,
                'stats': stats({'stoppedBy': stopped_by, 'deterministic': deterministic and not hit_limit})}

    routes, served = [], set()
    for vi, v in enumerate(mv):
        f = mf[vi]
        idx = routing.Start(vi)
        start_c = solution.Min(tdim.CumulVar(idx))
        seq = []
        idx = solution.Value(routing.NextVar(idx))
        while not routing.IsEnd(idx):
            seq.append(idx)
            idx = solution.Value(routing.NextVar(idx))
        end_c = solution.Min(tdim.CumulVar(idx))
        if not seq:
            continue
        if rev:   # back to real (forward) order and time
            seq.reverse()
            first_loc, first_dep = v['start'], T - end_c
        else:
            first_loc, first_dep = f['mstart'], start_c
        visits, dist_m, prev_loc, prev_dep, load, wc_load = [], 0, first_loc, first_dep, 0, 0
        total = sum(active[manager.IndexToNode(i) - nd]['demand'] for i in seq)
        for idx in seq:
            s = active[manager.IndexToNode(idx) - nd]
            lg = 0 if prev_loc is None else ctx.dur[prev_loc][s['loc']]
            if ctx.dist is not None and prev_loc is not None:
                dist_m += ctx.dist[prev_loc][s['loc']] or 0
            arrival = prev_dep + lg
            c = solution.Min(tdim.CumulVar(idx))
            begin = T - c if rev else c
            load += s['demand']
            wc_load += s['wheelchair']
            visit = {'stopId': s['id'], 'locationIndex': s['loc'], 'arrivalS': arrival, 'serviceStartS': begin,
                     'waitS': max(0, begin - arrival), 'departureS': begin + s['service'], 'load': load}
            if s['passengerIds'] is not None:
                visit['passengerIds'] = s['passengerIds']
            if trip:
                visit['onBoard'] = load if rev else total - load
                visit['rideS'] = (T - start_c) - begin if rev else begin - start_c
                visit['maxRideS'] = s['maxRide']
            visits.append(visit)
            served.add(s['id'])
            prev_loc, prev_dep = s['loc'], begin + s['service']
        end_loc = trip['site'] if rev else f['mend']
        lg = 0 if end_loc is None else ctx.dur[prev_loc][end_loc]
        if ctx.dist is not None and end_loc is not None:
            dist_m += ctx.dist[prev_loc][end_loc] or 0
        arrival_end = prev_dep + lg
        end_s = (T - start_c) if rev else max(arrival_end, end_c)
        seq_locs = ([first_loc] if first_loc is not None else []) + [x['locationIndex'] for x in visits] + \
                   ([end_loc] if end_loc is not None else [])
        route = {'vehicleId': v['id'], 'startS': first_dep, 'endS': end_s, 'durationS': end_s - first_dep,
                 'distanceM': dist_m if ctx.dist is not None else None, 'locationSequence': seq_locs,
                 'stops': visits, 'load': load if load_dim is not None else None,
                 'seats': None if v['rawCapacity'] is None else v['capacity'], 'escort': v['escort'],
                 'wheelchairLoad': wc_load, 'fixedCost': fixed[vi]}
        if rev:
            route['siteArrivalS'] = end_s
            route['waitBeforeSiteS'] = max(0, end_s - arrival_end)
        elif trip:
            route['siteDepartureS'] = start_c
            route['deadheadToSiteS'] = f['deadhead']
        routes.append(route)

    dropped = [s for s in active if s['id'] not in served]
    if dropped:
        need = sum(s['demand'] for s in active)
        seats = sum(v['capacity'] for v in mv)
        for s in dropped:
            if s['escortEnds'] and not any(mv[k]['escort'] for k in s['_allowed']):
                unassigned.append(_unassigned(s, 'safety_rule', {'rule': 'escortIfFirstOrLast'}))
            elif s['pinned'] is not None:
                unassigned.append(_unassigned(s, 'pinned_assignment_infeasible',
                                              {'pinnedVehicleId': s['pinned'], 'failed': ['not_scheduled']}))
            else:
                code = 'CAPACITY_EXHAUSTED' if need > seats else 'TIME_LIMIT' if hit_limit else 'NOT_SCHEDULED'
                unassigned.append(_unassigned(s, 'not_scheduled_capacity_or_time', None, code))

    proven = status_name == 'ROUTING_OPTIMAL'
    penalty = sum(penalty_base * s['priority'] * (PINNED_PENALTY_FACTOR if s['pinned'] is not None else 1)
                  for s in dropped)
    return {
        **base,
        'status': 'OPTIMAL' if proven else 'FEASIBLE',
        'provenOptimal': proven,
        'solverStatus': status_name,
        'objective': solution.ObjectiveValue(),
        'objectiveBreakdown': _breakdown(routes, penalty),
        'weights': w,
        'routes': routes,
        'unassigned': unassigned,
        'unusableVehicles': unusable,
        'stats': stats({'stoppedBy': stopped_by, 'deterministic': deterministic and not hit_limit,
                        'searchTimeLimitMs': remaining_ms}),
        'note': 'Proven optimal by OR-Tools.' if proven else 'Best solution found within the time limit; not proven optimal.',
    }


def _breakdown(routes: list[dict], penalty: int) -> dict:
    dist = [r['distanceM'] for r in routes if r.get('distanceM') is not None]
    return {'vehiclesUsed': len(routes),
            'totalDistanceM': sum(dist) if len(dist) == len(routes) else None,
            'totalDurationS': sum(r['durationS'] for r in routes),
            'fixedCost': sum(r.get('fixedCost') or 0 for r in routes),
            'dropPenalty': penalty}


def _status_name(raw: Any) -> str:
    # 9.x returns an int enum on RoutingModel; names are stable across versions.
    names = {0: 'ROUTING_NOT_SOLVED', 1: 'ROUTING_SUCCESS', 2: 'ROUTING_PARTIAL_SUCCESS_LOCAL_OPTIMUM_NOT_REACHED',
             3: 'ROUTING_FAIL', 4: 'ROUTING_FAIL_TIMEOUT', 5: 'ROUTING_INVALID', 6: 'ROUTING_INFEASIBLE',
             7: 'ROUTING_OPTIMAL'}
    try:
        return names.get(int(raw), str(raw))
    except (TypeError, ValueError):
        return getattr(raw, 'name', str(raw))
