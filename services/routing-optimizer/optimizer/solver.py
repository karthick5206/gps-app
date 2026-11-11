"""Capacitated VRP with time windows on a precomputed road matrix (built by the API from GraphHopper), solved with OR-Tools.

Pure function `solve(problem) -> result`; no I/O. Times are integer seconds relative to the plan epoch chosen by the
caller (the API uses "seconds since plan start"). The matrix is indexed by `locationIndex`; `None` cells mean the
engine found no route and are treated as forbidden arcs.

The solver never claims optimality unless OR-Tools proves it (`provenOptimal`): a normal result is `FEASIBLE`
(best solution found within the time limit).
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

from ortools.constraint_solver import pywrapcp, routing_enums_pb2

LIMITS = {'stops': 500, 'vehicles': 50, 'locations': 600, 'timeLimitS': 120}
DEFAULT_HORIZON_S = 24 * 3600
UNREACHABLE = 10**9          # transit for a None cell: larger than any horizon, so the time dimension forbids the arc
UNLIMITED_CAPACITY = 10**6  # vehicle without a capacity
DROP_PENALTY = 10**7        # per unit of priority; dominates any realistic travel cost


class InvalidProblem(ValueError):
    pass


@dataclass
class _Ctx:
    dur: list[list[int | None]]
    dist: list[list[int | None]] | None
    vehicles: list[dict]
    stops: list[dict]
    horizon: int


def _int_matrix(m: Any, n: int, name: str) -> list[list[int | None]]:
    if not isinstance(m, list) or len(m) != n or any(not isinstance(r, list) or len(r) != n for r in m):
        raise InvalidProblem(f'{name} must be a {n}x{n} array')
    out = []
    for r in m:
        row = []
        for v in r:
            if v is None:
                row.append(None)
            elif isinstance(v, (int, float)) and v >= 0:
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


def validate(problem: dict) -> _Ctx:
    if not isinstance(problem, dict):
        raise InvalidProblem('problem must be an object')
    matrix = problem.get('matrix') or {}
    dur_raw = matrix.get('durationsS')
    if dur_raw is None:
        raise InvalidProblem('matrix.durationsS is required')
    n = len(dur_raw) if isinstance(dur_raw, list) else 0
    if not 1 <= n <= LIMITS['locations']:
        raise InvalidProblem(f"matrix must have 1..{LIMITS['locations']} locations")
    dur = _int_matrix(dur_raw, n, 'matrix.durationsS')
    dist = _int_matrix(matrix['distancesM'], n, 'matrix.distancesM') if matrix.get('distancesM') is not None else None
    horizon = int(problem.get('horizonS') or DEFAULT_HORIZON_S)
    vehicles, stops = problem.get('vehicles') or [], problem.get('stops') or []
    if not 1 <= len(vehicles) <= LIMITS['vehicles']:
        raise InvalidProblem(f"1..{LIMITS['vehicles']} vehicles required")
    if len(stops) > LIMITS['stops']:
        raise InvalidProblem(f"at most {LIMITS['stops']} stops")
    ids = set()
    norm_v = []
    for i, v in enumerate(vehicles):
        vid = str(v.get('id', f'vehicle-{i}'))
        s, e = int(v.get('startIndex', 0)), int(v.get('endIndex', v.get('startIndex', 0)))
        if not (0 <= s < n and 0 <= e < n):
            raise InvalidProblem(f'vehicle {vid}: start/end index out of range')
        tw = _window(v.get('timeWindow'), horizon, f'vehicle {vid} timeWindow')
        cap = UNLIMITED_CAPACITY if v.get('capacity') is None else int(v['capacity'])
        if cap < 0:
            raise InvalidProblem(f'vehicle {vid}: capacity must be >= 0')
        max_dur = v.get('maxDurationS')
        norm_v.append({'id': vid, 'start': s, 'end': e, 'tw': tw, 'capacity': cap,
                       'maxDuration': int(max_dur) if max_dur is not None else None})
    norm_s = []
    for i, st in enumerate(stops):
        sid = str(st.get('id', f'stop-{i}'))
        if sid in ids:
            raise InvalidProblem(f'duplicate stop id {sid}')
        ids.add(sid)
        li = int(st.get('locationIndex', -1))
        if not 0 <= li < n:
            raise InvalidProblem(f'stop {sid}: locationIndex out of range')
        windows = st.get('timeWindows') or [None]
        tws = sorted(_window(w, horizon, f'stop {sid} timeWindow') for w in windows)
        demand = int(st.get('demand', 0) or 0)
        service = int(st.get('serviceS', 0) or 0)
        if demand < 0 or service < 0:
            raise InvalidProblem(f'stop {sid}: demand and serviceS must be >= 0')
        norm_s.append({'id': sid, 'loc': li, 'tws': tws, 'demand': demand, 'service': service,
                       'priority': max(1, int(st.get('priority', 1) or 1))})
    return _Ctx(dur, dist, norm_v, norm_s, horizon)


def _pre_infeasible(ctx: _Ctx, s: dict) -> str | None:
    """A reason when no vehicle can serve the stop even alone; None when the solver should try."""
    if all(a > b for a, b in s['tws']):
        return 'invalid_time_window'
    if s['demand'] > 0 and all(s['demand'] > v['capacity'] for v in ctx.vehicles):
        return 'demand_exceeds_vehicle_capacity'
    reasons = set()
    for v in ctx.vehicles:
        to_stop = ctx.dur[v['start']][s['loc']]
        back = ctx.dur[s['loc']][v['end']]
        if to_stop is None or back is None:
            reasons.add('unreachable_location')
            continue
        earliest = v['tw'][0] + to_stop
        ok_window = False
        for a, b in s['tws']:
            if a > b:
                continue
            start_service = max(earliest, a)
            if start_service <= b and start_service + s['service'] + back <= v['tw'][1]:
                if v['maxDuration'] is None or (start_service - v['tw'][0]) + s['service'] + back <= v['maxDuration']:
                    ok_window = True
                    break
                reasons.add('exceeds_max_route_duration')
            else:
                reasons.add('time_window_unreachable')
        if ok_window:
            return None
    for r in ('unreachable_location', 'time_window_unreachable', 'exceeds_max_route_duration'):
        if r in reasons:
            return r
    return 'time_window_unreachable'


def solve(problem: dict) -> dict:
    t0 = time.perf_counter()
    try:
        ctx = validate(problem)
    except InvalidProblem as e:
        return {'status': 'INVALID_INPUT', 'provenOptimal': False, 'error': str(e), 'routes': [], 'unassigned': []}
    opts = problem.get('options') or {}
    time_limit = max(1, min(int(opts.get('timeLimitS', 10)), LIMITS['timeLimitS']))

    unassigned = []
    active = []
    for s in ctx.stops:
        reason = _pre_infeasible(ctx, s)
        if reason:
            unassigned.append({'stopId': s['id'], 'reason': reason})
        else:
            active.append(s)

    # Node layout: one node per distinct vehicle start/end location (depots) + one node per active stop.
    depot_locs = sorted({v['start'] for v in ctx.vehicles} | {v['end'] for v in ctx.vehicles})
    node_loc = depot_locs + [s['loc'] for s in active]
    node_service = [0] * len(depot_locs) + [s['service'] for s in active]
    node_demand = [0] * len(depot_locs) + [s['demand'] for s in active]
    dnode = {loc: i for i, loc in enumerate(depot_locs)}
    starts = [dnode[v['start']] for v in ctx.vehicles]
    ends = [dnode[v['end']] for v in ctx.vehicles]

    manager = pywrapcp.RoutingIndexManager(len(node_loc), len(ctx.vehicles), starts, ends)
    routing = pywrapcp.RoutingModel(manager)

    def travel(i: int, j: int) -> int:
        d = ctx.dur[node_loc[i]][node_loc[j]]
        return UNREACHABLE if d is None else d

    def time_cb(fi: int, ti: int) -> int:
        i, j = manager.IndexToNode(fi), manager.IndexToNode(ti)
        return node_service[i] + travel(i, j)

    def cost_cb(fi: int, ti: int) -> int:
        i, j = manager.IndexToNode(fi), manager.IndexToNode(ti)
        if opts.get('objective') == 'distance' and ctx.dist is not None:
            d = ctx.dist[node_loc[i]][node_loc[j]]
            return UNREACHABLE if d is None else d
        return travel(i, j)

    time_idx = routing.RegisterTransitCallback(time_cb)
    routing.SetArcCostEvaluatorOfAllVehicles(routing.RegisterTransitCallback(cost_cb))
    routing.AddDimension(time_idx, ctx.horizon, ctx.horizon, False, 'Time')
    tdim = routing.GetDimensionOrDie('Time')

    if any(s['demand'] for s in active):
        dem_idx = routing.RegisterUnaryTransitCallback(lambda fi: node_demand[manager.IndexToNode(fi)])
        routing.AddDimensionWithVehicleCapacity(dem_idx, 0, [v['capacity'] for v in ctx.vehicles], True, 'Load')

    for k, s in enumerate(active):
        idx = manager.NodeToIndex(len(depot_locs) + k)
        windows = [(a, b) for a, b in s['tws'] if a <= b]
        var = tdim.CumulVar(idx)
        var.SetRange(windows[0][0], windows[-1][1])
        for (a1, b1), (a2, b2) in zip(windows, windows[1:]):
            if a2 > b1 + 1:
                var.RemoveInterval(b1 + 1, a2 - 1)
        routing.AddDisjunction([idx], DROP_PENALTY * s['priority'])

    for vi, v in enumerate(ctx.vehicles):
        tdim.CumulVar(routing.Start(vi)).SetRange(v['tw'][0], v['tw'][1])
        tdim.CumulVar(routing.End(vi)).SetRange(v['tw'][0], v['tw'][1])
        if v['maxDuration'] is not None:
            tdim.SetSpanUpperBoundForVehicle(v['maxDuration'], vi)
        routing.AddVariableMinimizedByFinalizer(tdim.CumulVar(routing.Start(vi)))
        routing.AddVariableMinimizedByFinalizer(tdim.CumulVar(routing.End(vi)))

    params = pywrapcp.DefaultRoutingSearchParameters()
    params.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC
    if opts.get('localSearch', 'guided') == 'guided':
        params.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
    params.time_limit.FromSeconds(time_limit)
    if opts.get('solutionLimit'):
        params.solution_limit = int(opts['solutionLimit'])

    solution = routing.SolveWithParameters(params)
    raw_status = routing.status()
    status_name = _status_name(raw_status)
    wall_ms = round((time.perf_counter() - t0) * 1000)

    if solution is None:
        for s in active:
            unassigned.append({'stopId': s['id'], 'reason': 'no_solution_found'})
        return {'status': 'NO_SOLUTION', 'provenOptimal': False, 'solverStatus': status_name, 'routes': [],
                'unassigned': unassigned, 'stats': {'wallTimeMs': wall_ms, 'timeLimitS': time_limit}}

    routes = []
    served = set()
    load_dim = routing.GetDimensionOrDie('Load') if any(s['demand'] for s in active) else None
    for vi, v in enumerate(ctx.vehicles):
        idx = routing.Start(vi)
        if routing.IsEnd(solution.Value(routing.NextVar(idx))):
            continue
        visits, dist_m, prev_node, prev_depart = [], 0, manager.IndexToNode(idx), solution.Min(tdim.CumulVar(idx))
        start_s = prev_depart
        load = 0
        idx = solution.Value(routing.NextVar(idx))
        while True:
            node = manager.IndexToNode(idx)
            leg_s = travel(prev_node, node)
            if ctx.dist is not None:
                dist_m += ctx.dist[node_loc[prev_node]][node_loc[node]] or 0
            arrival = prev_depart + leg_s
            if routing.IsEnd(idx):
                end_s = max(arrival, solution.Min(tdim.CumulVar(idx)))
                break
            s = active[node - len(depot_locs)]
            begin = solution.Min(tdim.CumulVar(idx))
            load += s['demand']
            visits.append({'stopId': s['id'], 'locationIndex': s['loc'], 'arrivalS': arrival, 'serviceStartS': begin,
                           'waitS': max(0, begin - arrival), 'departureS': begin + s['service'], 'load': load})
            served.add(s['id'])
            prev_node, prev_depart = node, begin + s['service']
            idx = solution.Value(routing.NextVar(idx))
        routes.append({'vehicleId': v['id'], 'startS': start_s, 'endS': end_s, 'durationS': end_s - start_s,
                       'distanceM': dist_m if ctx.dist is not None else None,
                       'locationSequence': [v['start']] + [x['locationIndex'] for x in visits] + [v['end']],
                       'stops': visits, 'load': load if load_dim else None})
    for s in active:
        if s['id'] not in served:
            unassigned.append({'stopId': s['id'], 'reason': 'not_scheduled_capacity_or_time'})

    proven = status_name == 'ROUTING_OPTIMAL'
    return {
        'status': 'OPTIMAL' if proven else 'FEASIBLE',
        'provenOptimal': proven,
        'solverStatus': status_name,
        'objective': solution.ObjectiveValue(),
        'routes': routes,
        'unassigned': unassigned,
        'stats': {'wallTimeMs': wall_ms, 'timeLimitS': time_limit, 'stops': len(ctx.stops), 'vehicles': len(ctx.vehicles)},
        'note': 'Best solution found within the time limit; not proven optimal.' if not proven else 'Proven optimal by OR-Tools.',
    }


def _status_name(raw: Any) -> str:
    # 9.x returns an int enum on RoutingModel; names are stable across versions.
    names = {0: 'ROUTING_NOT_SOLVED', 1: 'ROUTING_SUCCESS', 2: 'ROUTING_PARTIAL_SUCCESS_LOCAL_OPTIMUM_NOT_REACHED',
             3: 'ROUTING_FAIL', 4: 'ROUTING_FAIL_TIMEOUT', 5: 'ROUTING_INVALID', 6: 'ROUTING_INFEASIBLE',
             7: 'ROUTING_OPTIMAL'}
    try:
        return names.get(int(raw), str(raw))
    except (TypeError, ValueError):
        return getattr(raw, 'name', str(raw))
