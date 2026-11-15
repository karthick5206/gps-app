"""On-demand pooling prototype (SYNTHETIC data only): OR-Tools pickup-and-delivery with time windows, per-request
max wait / max ride (detour), private exclusivity, multi-trip vehicles, driver span + break, live insertion.

Usage: python pdp_proto.py all OUT.json      (acceptance + directions + strategies + live)
       python pdp_proto.py scale N V LIMIT   (one scale run, prints JSON; used in a subprocess for memory)
"""
from __future__ import annotations

import json
import math
import random
import subprocess
import sys
import time
from dataclasses import dataclass, field

from ortools.constraint_solver import pywrapcp, routing_enums_pb2

SVC_PICK, SVC_DROP = 60, 30
TURNAROUND = 120          # extra service at a pickup that starts a new trip (vehicle empty before it); see notes
BIG = 1000                # exclusivity dimension capacity


# ------------------------------------------------------------------------------------------------ synthetic city
def travel(a, b):
    km = math.dist(a, b) * 1.35
    return (0 if km == 0 else round(30 + km / 25 * 3600)), round(km * 1000)


@dataclass
class Req:
    id: str
    pick: tuple
    drop: tuple
    earliest: int            # requested earliest pickup (s after 07:00)
    window: int              # pickup window width = max pickup wait
    n: int = 1
    pref: str = 'SHARED'     # SHARED | PRIVATE | FLEXIBLE
    ratio: float = 1.8
    extra: int = 900
    deadline: int | None = None   # optional arrival deadline (absolute)
    # live state
    vehicle: str | None = None    # committed vehicle (pinned)
    onboard_since: int | None = None  # picked up already at this time (only the drop remains)

    @property
    def direct(self):
        return travel(self.pick, self.drop)[0]

    @property
    def max_ride(self):
        return max(round(self.direct * self.ratio), self.direct + self.extra)


@dataclass
class Veh:
    id: str
    pos: tuple
    cap: int = 7
    avail: int = 0
    shift_end: int = 5 * 3600
    max_span: int = 5 * 3600
    brk: tuple | None = (2 * 3600, 3 * 3600 + 1800, 1800)   # (earliest start, latest start, duration)
    onboard: int = 0
    onboard_private: bool = False


def city(n, seed=3, horizon=4 * 3600, size=20.0, mix=(0.7, 0.15, 0.15)):
    rnd = random.Random(seed)
    reqs = []
    for k in range(n):
        u = rnd.random()
        pref = 'SHARED' if u < mix[0] else 'PRIVATE' if u < mix[0] + mix[1] else 'FLEXIBLE'
        pick = (rnd.uniform(0, size), rnd.uniform(0, size))
        drop = (rnd.uniform(0, size), rnd.uniform(0, size))
        while math.dist(pick, drop) < 2:
            drop = (rnd.uniform(0, size), rnd.uniform(0, size))
        reqs.append(Req(f'r{k + 1}', pick, drop, rnd.randrange(900, horizon), 900, 1 if rnd.random() < .85 else 2, pref))
    return reqs


# ------------------------------------------------------------------------------------------------ model
@dataclass
class Model:
    reqs: list
    vehs: list
    weights: dict
    nodes: list = field(default_factory=list)   # (kind, req_idx | veh_idx, point)


def solve(reqs, vehs, weights, limit=10, first='parallel_cheapest_insertion', ls='guided', mandatory=(), initial=None):
    """Returns dict with routes (per vehicle: list of (kind, req id, time)), dropped, stats."""
    t0 = time.perf_counter()
    nv = len(vehs)
    nodes = [('start', i, v.pos) for i, v in enumerate(vehs)] + [('end', None, None)]
    end = nv
    pnode, dnode = {}, {}
    for k, r in enumerate(reqs):
        if r.onboard_since is None:
            pnode[k] = len(nodes); nodes.append(('pick', k, r.pick))
        dnode[k] = len(nodes); nodes.append(('drop', k, r.drop))
    nn = len(nodes)
    T = [[0] * nn for _ in range(nn)]
    D = [[0] * nn for _ in range(nn)]
    for i in range(nn):
        for j in range(nn):
            if nodes[i][0] == 'end' or nodes[j][0] == 'end' or i == j:
                continue
            T[i][j], D[i][j] = travel(nodes[i][2], nodes[j][2])
    svc = [0] * nn
    for k, i in pnode.items():
        svc[i] = SVC_PICK
    for k, i in dnode.items():
        svc[i] = SVC_DROP

    man = pywrapcp.RoutingIndexManager(nn, nv, list(range(nv)), [end] * nv)
    rm = pywrapcp.RoutingModel(man)
    sol = rm.solver()
    w = weights
    tmat = [[T[i][j] + svc[i] for j in range(nn)] for i in range(nn)]
    t_cb = rm.RegisterTransitMatrix(tmat)
    cost = [[int(w.get('time', 0) * T[i][j] + w.get('distance', 0) * D[i][j]) for j in range(nn)] for i in range(nn)]
    rm.SetArcCostEvaluatorOfAllVehicles(rm.RegisterTransitMatrix(cost))
    H = max(v.shift_end for v in vehs) + 3600
    rm.AddDimension(t_cb, H, H, False, 'Time')
    td = rm.GetDimensionOrDie('Time')
    # Load (seats) and exclusivity: pickups +, drops −. Start cumul = onboard state (live).
    dem = [0] * nn
    exc = [0] * nn
    for k, r in enumerate(reqs):
        e = BIG if r.pref == 'PRIVATE' else r.n
        if k in pnode:
            dem[pnode[k]] = r.n; exc[pnode[k]] = e
        dem[dnode[k]] = -r.n; exc[dnode[k]] = -e
    rm.AddDimensionWithVehicleCapacity(rm.RegisterUnaryTransitVector(dem), 0, [v.cap for v in vehs], False, 'Load')
    ld = rm.GetDimensionOrDie('Load')
    # Exclusivity: a private passenger fills BIG; any co-rider while it is on board overflows.
    rm.AddDimension(rm.RegisterUnaryTransitVector(exc), 0, BIG, False, 'Excl')
    xd = rm.GetDimensionOrDie('Excl')
    for vi, v in enumerate(vehs):
        ld.CumulVar(rm.Start(vi)).SetValue(v.onboard)
        xd.CumulVar(rm.Start(vi)).SetValue(BIG if v.onboard_private else v.onboard)
        ld.CumulVar(rm.End(vi)).SetValue(0)
        td.CumulVar(rm.Start(vi)).SetRange(v.avail, v.shift_end)
        td.CumulVar(rm.End(vi)).SetMax(v.shift_end)
        td.SetSpanUpperBoundForVehicle(v.max_span, vi)
        if w.get('vehicle'):
            rm.SetFixedCostOfVehicle(int(w['vehicle']), vi)
    max_arc = max(max(r) for r in cost) or 1
    penalty = 10**7 + 2 * (nn * max_arc + int(w.get('vehicle', 0)) + int(w.get('wait', 0) + w.get('ride', 0)) * H)
    for k, r in enumerate(reqs):
        di = man.NodeToIndex(dnode[k])
        if k in pnode:
            pi = man.NodeToIndex(pnode[k])
            rm.AddPickupAndDelivery(pi, di)
            sol.Add(rm.VehicleVar(pi) == rm.VehicleVar(di))
            sol.Add(td.CumulVar(pi) <= td.CumulVar(di))
            sol.Add(rm.ActiveVar(pi) == rm.ActiveVar(di))
            td.CumulVar(pi).SetRange(r.earliest, r.earliest + r.window)        # max pickup wait (hard)
            # max ride / detour (hard, accepted by the passenger): drop − (pickup + service) ≤ maxRide
            sol.Add(td.CumulVar(di) - td.CumulVar(pi) <= r.max_ride + SVC_PICK)
            if w.get('wait'):
                td.SetCumulVarSoftUpperBound(pi, r.earliest, int(w['wait']) * r.n)
            if w.get('ride'):
                # Ride cost proxy: drop later than "earliest pickup + direct" (wait + detour), per passenger.
                td.SetCumulVarSoftUpperBound(di, r.earliest + SVC_PICK + r.direct, int(w['ride']) * r.n)
            if r.id not in mandatory and r.vehicle is None:
                rm.AddDisjunction([pi], penalty * r.n)
                rm.AddDisjunction([di], 0)
        else:   # on board: only the drop, mandatory, absolute ride deadline
            td.CumulVar(di).SetMax(r.onboard_since + SVC_PICK + r.max_ride)
        if r.deadline is not None:
            td.CumulVar(di).SetMax(r.deadline)
        if r.vehicle is not None:
            vi = [v.id for v in vehs].index(r.vehicle)
            # Committed: stays on its vehicle. A ×1000 drop penalty is a safety net so the search always has a
            # solution; any committed request that still ends up dropped is reported as a violation (never silent).
            idxs = ([man.NodeToIndex(pnode[k])] if k in pnode else []) + [di]
            for idx in idxs:
                rm.VehicleVar(idx).SetValues([-1, vi])
            rm.AddDisjunction([idxs[0]], penalty * 1000 * r.n)
            if len(idxs) == 2:
                rm.AddDisjunction([idxs[1]], 0)
    # One driver break per vehicle (interval var, node visit transits = service).
    nvt = [svc[man.IndexToNode(i)] if i < rm.Size() else 0 for i in range(rm.Size() + nv * 2)]
    for vi, v in enumerate(vehs):
        if v.brk:
            b = sol.FixedDurationIntervalVar(v.brk[0], v.brk[1], v.brk[2], False, f'break-{v.id}')
            td.SetBreakIntervalsOfVehicle([b], vi, nvt[:rm.Size()])
    for i in range(rm.Size()):
        rm.AddVariableMinimizedByFinalizer(td.CumulVar(i))
    p = pywrapcp.DefaultRoutingSearchParameters()
    p.first_solution_strategy = getattr(routing_enums_pb2.FirstSolutionStrategy, first.upper())
    if ls:
        p.local_search_metaheuristic = getattr(routing_enums_pb2.LocalSearchMetaheuristic,
                                               {'guided': 'GUIDED_LOCAL_SEARCH', 'greedy': 'GREEDY_DESCENT'}[ls])
    p.time_limit.FromSeconds(limit)
    build = time.perf_counter() - t0
    if initial is not None:
        # Live: warm start from the current plan (committed order), new requests start unassigned.
        node_of = {}
        for k, r in enumerate(reqs):
            if k in pnode:
                node_of[('pick', r.id)] = pnode[k]
            node_of[('drop', r.id)] = dnode[k]
        rm.CloseModelWithParameters(p)
        routes0 = [[man.NodeToIndex(node_of[x]) for x in initial.get(v.id, []) if x in node_of] for v in vehs]
        a0 = rm.ReadAssignmentFromRoutes(routes0, True)
        s = rm.SolveFromAssignmentWithParameters(a0, p) if a0 is not None else rm.SolveWithParameters(p)
        build = time.perf_counter() - t0
    else:
        s = rm.SolveWithParameters(p)
    wall = time.perf_counter() - t0
    if s is None:
        return {'ok': False, 'wall': wall, 'status': rm.status()}
    routes = {}
    for vi, v in enumerate(vehs):
        idx = s.Value(rm.NextVar(rm.Start(vi)))
        seq = []
        while not rm.IsEnd(idx):
            kind, k, _ = nodes[man.IndexToNode(idx)]
            seq.append((kind, reqs[k].id, s.Min(td.CumulVar(idx))))
            idx = s.Value(rm.NextVar(idx))
        routes[v.id] = seq
    served = {r for seq in routes.values() for (_, r, _) in seq}
    dropped = [r.id for r in reqs if r.id not in served]
    return {'ok': True, 'wall': round(wall, 2), 'build': round(build, 2), 'routes': routes, 'dropped': dropped,
            'objective': s.ObjectiveValue()}


# ------------------------------------------------------------------------------------------------ checker + metrics
def simulate(seq, rmap, v):
    """Forward-simulate a vehicle route with earliest feasible times. Returns (ok, reasons, times)."""
    t, pos = v.avail, v.pos
    load, excl = v.onboard, (BIG if v.onboard_private else v.onboard)
    picked = {r.id: r.onboard_since for r in rmap.values() if r.onboard_since is not None and r.vehicle == v.id}
    reasons, times = set(), []
    for kind, rid in seq:
        r = rmap[rid]
        pt = r.pick if kind == 'pick' else r.drop
        t += travel(pos, pt)[0]
        if kind == 'pick':
            if t < r.earliest:
                t = r.earliest
            if t > r.earliest + r.window:
                reasons.add('pickup_window')
            if load == 0 and times:
                t += TURNAROUND  # new trip: preparation
            load += r.n
            excl += BIG if r.pref == 'PRIVATE' else r.n
            picked[rid] = t
            times.append(t); t += SVC_PICK
        else:
            if rid not in picked:
                reasons.add('precedence')
            elif t - (picked[rid] + SVC_PICK) > r.max_ride:
                reasons.add('max_ride')
            if r.deadline is not None and t > r.deadline:
                reasons.add('deadline')
            load -= r.n
            excl -= BIG if r.pref == 'PRIVATE' else r.n
            times.append(t); t += SVC_DROP
        if load > v.cap:
            reasons.add('capacity')
        if excl > BIG:
            reasons.add('private_exclusive')
        pos = pt
    if t > v.shift_end or t - v.avail > v.max_span:
        reasons.add('vehicle_time')
    return not reasons, reasons, times


def check(res, reqs, vehs):
    """Independent verification of the solver's routes (precedence, capacity, exclusivity, windows, max ride)."""
    rmap = {r.id: r for r in reqs}
    viol = {}
    for v in vehs:
        seq = res['routes'][v.id]
        load, excl, seen = v.onboard, v.onboard, {}
        for kind, rid, tm in seq:
            r = rmap[rid]
            if kind == 'pick':
                seen[rid] = tm
                load += r.n; excl += BIG if r.pref == 'PRIVATE' else r.n
                if not (r.earliest <= tm <= r.earliest + r.window):
                    viol.setdefault(rid, []).append('pickup_window')
            else:
                if rid in seen:
                    if tm - seen[rid] - SVC_PICK > r.max_ride:
                        viol.setdefault(rid, []).append('max_ride')
                elif r.onboard_since is None:
                    viol.setdefault(rid, []).append('precedence')
                load -= r.n; excl -= BIG if r.pref == 'PRIVATE' else r.n
            if load > v.cap:
                viol.setdefault(v.id, []).append('capacity')
            if excl > BIG:
                viol.setdefault(v.id, []).append('private_exclusive')
    return viol


def trips_of(seq, rmap, start_load=0):
    """Split a vehicle route into trips where the on-board load returns to 0."""
    trips, cur, load = [], [], start_load
    for kind, rid, tm in seq:
        cur.append((kind, rid, tm))
        load += rmap[rid].n if kind == 'pick' else -rmap[rid].n
        if load == 0:
            trips.append(cur); cur = []
    if cur:
        trips.append(cur)
    return trips


def metrics(res, reqs, vehs):
    rmap = {r.id: r for r in reqs}
    out = {'served': len(reqs) - len(res['dropped']), 'unserved': len(res['dropped']), 'vehicles': {}}
    waits, rides, detours, km_total, occ_samples = [], [], [], 0, []
    labels = {}
    for v in vehs:
        seq = res['routes'][v.id]
        trips = trips_of(seq, rmap, v.onboard)
        pos, km = v.pos, 0
        for kind, rid, _ in seq:
            pt = rmap[rid].pick if kind == 'pick' else rmap[rid].drop
            km += travel(pos, pt)[1]; pos = pt
        km_total += km
        picks = {}
        for kind, rid, tm in seq:
            r = rmap[rid]
            if kind == 'pick':
                picks[rid] = tm; waits.append(tm - r.earliest)
            elif rid in picks:
                ride = tm - picks[rid] - SVC_PICK
                rides.append(ride); detours.append(ride - r.direct)
        # co-riders while on board → shared label (FLEXIBLE reporting)
        onboard = set()
        for kind, rid, _ in seq:
            if kind == 'pick':
                for o in onboard:
                    labels[o] = 'shared'
                labels.setdefault(rid, 'shared' if onboard else 'alone')
                onboard.add(rid)
            else:
                onboard.discard(rid)
        tr = []
        for t in trips:
            pax = [rid for k, rid, _ in t if k == 'pick']
            maxload, load = 0, 0
            for k, rid, _ in t:
                load += rmap[rid].n if k == 'pick' else -rmap[rid].n
                maxload = max(maxload, load)
            tr.append({'start': t[0][2], 'end': t[-1][2], 'requests': len(pax), 'peakLoad': maxload,
                       'stops': [f"{k[0].upper()}:{rid}" for k, rid, _ in t]})
            occ_samples.append(maxload / v.cap)
        out['vehicles'][v.id] = {'trips': len(trips), 'km': round(km / 1000, 1), 'tripList': tr}
    flex = [r.id for r in reqs if r.pref == 'FLEXIBLE' and r.id not in res['dropped']]
    out.update({
        'kmTotal': round(km_total / 1000, 1),
        'waitMin': {'avg': round(sum(waits) / len(waits) / 60, 1) if waits else None, 'max': round(max(waits, default=0) / 60, 1)},
        'rideMin': {'avg': round(sum(rides) / len(rides) / 60, 1) if rides else None, 'max': round(max(rides, default=0) / 60, 1)},
        'detourMin': {'avg': round(sum(detours) / len(detours) / 60, 1) if detours else None, 'max': round(max(detours, default=0) / 60, 1)},
        'peakOccupancyAvg': round(sum(occ_samples) / len(occ_samples), 2) if occ_samples else None,
        'sharedShare': round(sum(1 for r, l in labels.items() if l == 'shared') / max(1, len(labels)), 2),
        'flexibleLabels': {f: labels.get(f) for f in flex},
        'privateWithCoRiders': [r.id for r in reqs if r.pref == 'PRIVATE' and labels.get(r.id) == 'shared'],
    })
    return out


def classify_unserved(res, reqs, vehs):
    """Why each unserved request could not be inserted into any vehicle's route (all positions tried)."""
    rmap = {r.id: r for r in reqs}
    out = {}
    for rid in res['dropped']:
        r = rmap[rid]
        reasons = set()
        feasible = False
        for v in vehs:
            base = [(k, x) for k, x, _ in res['routes'][v.id]]
            # alone, from the vehicle start, ignoring the route: is there vehicle time at all?
            for i in range(len(base) + 1):
                for j in range(i, len(base) + 1):
                    seq = base[:i] + [('pick', rid)] + base[i:j] + [('drop', rid)] + base[j:]
                    ok, why, _ = simulate(seq, rmap, v)
                    if ok:
                        feasible = True; break
                    reasons |= why
                if feasible:
                    break
        out[rid] = 'NOT_SELECTED' if feasible else sorted(reasons)
    return out


def cheapest_insertion(routes, new, reqs, vehs):
    """Live heuristic: insert one request into existing routes at the cheapest feasible position (no re-solve)."""
    rmap = {r.id: r for r in reqs}
    rmap[new.id] = new
    best = None
    t0 = time.perf_counter()
    reasons = set()
    for v in vehs:
        base = [(k, x) for k, x, _ in routes[v.id]]
        ok0, _, t_base = simulate(base, rmap, v)
        base_end = t_base[-1] if t_base else v.avail
        for i in range(len(base) + 1):
            for j in range(i, len(base) + 1):
                seq = base[:i] + [('pick', new.id)] + base[i:j] + [('drop', new.id)] + base[j:]
                ok, why, times = simulate(seq, rmap, v)
                if not ok:
                    reasons |= why; continue
                delta = (times[-1] if times else 0) - base_end
                if best is None or delta < best[0]:
                    best = (delta, v.id, i, j)
    return best, sorted(reasons), round((time.perf_counter() - t0) * 1000, 1)


# ------------------------------------------------------------------------------------------------ scenarios
STRATS = {
    'balanced': {'vehicle': 3600, 'time': 1, 'wait': 1, 'ride': 1},
    'max_utilisation': {'vehicle': 20000, 'time': 1},
    'shortest_distance': {'vehicle': 2000, 'distance': 1},
    'fastest_pickup': {'vehicle': 600, 'time': 1, 'wait': 5},
    'comfort': {'vehicle': 1800, 'time': 1, 'ride': 3},
    'minimum_vehicles': {'vehicle': 100000, 'time': 1},
}


def fleet(n, seed=11, size=20.0):
    rnd = random.Random(seed)
    return [Veh(f'v{k + 1}', (rnd.uniform(0, size), rnd.uniform(0, size))) for k in range(n)]


def main_all(outp):
    report = {}
    # 1. Acceptance: 2 vehicles × 7 seats, 50 requests over 4 h.
    reqs, vehs = city(50), fleet(2)
    res = solve(reqs, vehs, STRATS['balanced'], limit=30)
    report['acceptance'] = {'violations': check(res, reqs, vehs), 'metrics': metrics(res, reqs, vehs),
                            'unservedReasons': classify_unserved(res, reqs, vehs), 'wall': res['wall'],
                            'prefs': {p: sum(1 for r in reqs if r.pref == p) for p in ('SHARED', 'PRIVATE', 'FLEXIBLE')}}
    print('acceptance done', res['wall'], flush=True)
    # 1b. same with 5 vehicles (to show pooling when capacity exists)
    vehs5 = fleet(5)
    res5 = solve(reqs, vehs5, STRATS['balanced'], limit=10)
    report['acceptance_5veh'] = {'violations': check(res5, reqs, vehs5), 'metrics': metrics(res5, reqs, vehs5),
                                 'unservedReasons': classify_unserved(res5, reqs, vehs5), 'wall': res5['wall']}
    print('acceptance 5 done', flush=True)
    # 2. Incompatible directions: 6 riders from the centre at 08:00, 3 to the far north-east, 3 to the far south-west.
    c = (10, 10)
    dreqs = [Req(f'ne{k}', (c[0] + k * .3, c[1]), (19 - k * .4, 19), 3600, 900, ratio=1.5, extra=600) for k in range(3)] + \
            [Req(f'sw{k}', (c[0] - k * .3, c[1]), (1 + k * .4, 1), 3600, 900, ratio=1.5, extra=600) for k in range(3)]
    dv = [Veh('v1', (10, 9), brk=None), Veh('v2', (10, 11), brk=None)]
    dres = solve(dreqs, dv, STRATS['balanced'], limit=5)
    report['directions'] = {'violations': check(dres, dreqs, dv), 'routes': dres['routes'], 'dropped': dres['dropped'],
                            'mixedTrips': [t['stops'] for v in metrics(dres, dreqs, dv)['vehicles'].values() for t in v['tripList']
                                           if any('ne' in s for s in t['stops']) and any('sw' in s for s in t['stops'])]}
    # 3. Strategies on the acceptance problem with 5 vehicles.
    report['strategies'] = {}
    for name, w in STRATS.items():
        r = solve(reqs, vehs5, w, limit=5)
        m = metrics(r, reqs, vehs5)
        report['strategies'][name] = {'served': m['served'], 'vehiclesUsed': sum(1 for v in m['vehicles'].values() if v['trips']),
                                      'trips': sum(v['trips'] for v in m['vehicles'].values()), 'km': m['kmTotal'],
                                      'wait': m['waitMin'], 'ride': m['rideMin'], 'detour': m['detourMin'],
                                      'peakOcc': m['peakOccupancyAvg'], 'shared': m['sharedShare'],
                                      'violations': check(r, reqs, vehs5)}
        print('strategy', name, flush=True)
    # 4. Live insertion at t = 2 h on the 5-vehicle solution.
    now = 2 * 3600
    rmap = {r.id: r for r in reqs}
    live_reqs, live_vehs, keep_routes = [], [], {}
    for v in vehs5:
        seq = res5['routes'][v.id]
        done = [x for x in seq if x[2] < now]
        rest = [x for x in seq if x[2] >= now]
        last = done[-1] if done else None
        pos = (rmap[last[1]].pick if last[0] == 'pick' else rmap[last[1]].drop) if last else v.pos
        picked = {rid: tm for k, rid, tm in done if k == 'pick'}
        dropped_ = {rid for k, rid, _ in done if k == 'drop'}
        onboard = [rid for rid in picked if rid not in dropped_]
        # The vehicle continues from its last visited stop at that stop's departure time (in production: its GPS
        # position and the time of that fix). Parking it there until `now` would make committed ETAs unreachable.
        nv = Veh(v.id, pos, v.cap, avail=(last[2] + (SVC_PICK if last[0] == 'pick' else SVC_DROP)) if last else v.avail,
                 brk=None, onboard=sum(rmap[x].n for x in onboard),
                 onboard_private=any(rmap[x].pref == 'PRIVATE' for x in onboard))
        live_vehs.append(nv)
        for rid in onboard:
            r = rmap[rid]
            live_reqs.append(Req(r.id, r.pick, r.drop, r.earliest, r.window, r.n, r.pref, r.ratio, r.extra,
                                 vehicle=v.id, onboard_since=picked[rid]))
        for k, rid, tm in rest:
            if k == 'pick':
                r = rmap[rid]
                # committed pickup: keep the promised ETA ±5 min inside the original window
                lo, hi = max(r.earliest, tm - 300), min(r.earliest + r.window, tm + 300)
                live_reqs.append(Req(r.id, r.pick, r.drop, lo, hi - lo, r.n, r.pref, r.ratio, r.extra, vehicle=v.id))
        keep_routes[v.id] = [(k, rid, tm) for k, rid, tm in rest]
    new = Req('NEW', (9.5, 10.5), (15, 14), now + 600, 900, 1, 'SHARED')
    t_ins = time.perf_counter()
    init = {v: [(k, rid) for k, rid, _ in seq] for v, seq in keep_routes.items()}
    lres = solve(live_reqs + [new], live_vehs, STRATS['balanced'], limit=5, initial=init)
    if not lres['ok']:
        print('live re-solve failed', lres, flush=True)
    lv = check(lres, live_reqs + [new], live_vehs)
    # commitments: every committed request still on its vehicle, windows kept
    moved = [r.id for r in live_reqs if not any(r.id == rid for (_, rid, _) in lres['routes'][r.vehicle])]
    best, why, ms = cheapest_insertion({v: [(k, rid, tm) for k, rid, tm in seq] for v, seq in keep_routes.items()},
                                       new, live_reqs, live_vehs)
    newp = Req('NEWP', (2, 18), (18, 2), now + 300, 600, 1, 'PRIVATE', ratio=1.2, extra=300)
    pres = solve(live_reqs + [newp], live_vehs, STRATS['balanced'], limit=5, initial=init)
    report['live'] = {'committedRequests': len(live_reqs), 'onboard': sum(1 for r in live_reqs if r.onboard_since is not None),
                      'resolveWallS': lres['wall'], 'newServed': 'NEW' not in lres['dropped'], 'violations': lv,
                      'committedMovedOrDropped': moved + [d for d in lres['dropped'] if d != 'NEW'],
                      'newVehicle': next((v for v, seq in lres['routes'].items() if any(rid == 'NEW' for _, rid, _ in seq)), None),
                      'heuristic': {'best': best, 'failReasons': why, 'ms': ms},
                      'privateFarRequestServed': 'NEWP' not in pres['dropped'],
                      'privateFarReasons': classify_unserved(pres, live_reqs + [newp], live_vehs).get('NEWP')}
    print('live done', flush=True)
    with open(outp, 'w') as f:
        json.dump(report, f, indent=1, default=str)


def main_scale(n, v, limit, mode):
    reqs, vehs = city(n, seed=5), fleet(v, seed=6)
    for x in vehs:
        x.shift_end = x.max_span = 5 * 3600
    if mode == 'det':
        r = solve(reqs, vehs, STRATS['balanced'], limit=limit, ls=None)
    else:
        r = solve(reqs, vehs, STRATS['balanced'], limit=limit)
    m = metrics(r, reqs, vehs)
    print(json.dumps({'n': n, 'v': v, 'limit': limit, 'mode': mode, 'wall': r['wall'], 'build': r['build'],
                      'served': m['served'], 'trips': sum(x['trips'] for x in m['vehicles'].values()), 'km': m['kmTotal'],
                      'violations': len(check(r, reqs, vehs))}))


def scale_all(outp):
    import psutil
    rows = []
    for n, v in ((200, 10),):
        for limit, mode in ((60, 'det'), (10, 'gls')):
            p = subprocess.Popen([sys.executable, __file__, 'scale', str(n), str(v), str(limit), mode], stdout=subprocess.PIPE, text=True)
            root, peak = psutil.Process(p.pid), 0
            while p.poll() is None:
                try:
                    peak = max(peak, sum(c.memory_info().rss for c in [root] + root.children(recursive=True)))
                except psutil.Error:
                    pass
                time.sleep(0.05)
            out = p.stdout.read().strip().splitlines()
            row = json.loads(out[-1]) if out else {'n': n, 'v': v, 'error': 'no output'}
            row['peakMB'] = round(peak / 2**20)
            rows.append(row); print(json.dumps(row), flush=True)
    with open(outp, 'w') as f:
        json.dump(rows, f, indent=1)


if __name__ == '__main__':
    if sys.argv[1] == 'all':
        main_all(sys.argv[2])
    elif sys.argv[1] == 'scale':
        main_scale(int(sys.argv[2]), int(sys.argv[3]), int(sys.argv[4]), sys.argv[5])
    elif sys.argv[1] == 'scaleall':
        scale_all(sys.argv[2])
