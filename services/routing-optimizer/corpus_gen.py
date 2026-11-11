"""Build a routing-corpus problem (WP 4.4) from a small scenario spec (`corpus/*.json`, key `generator`).

Everything is derived from `generator.seed` with `random.Random`, so a spec always yields the same problem. Points are
synthetic (around a fixed site in Chennai); the matrix is **synthetic**: haversine x 1.35 at 25 km/h, the same
function as `bench_optimizer.synth` (doc 11 §2.3). It is a solver input only, never an ETA.

Index layout: 0 = site (or depot for generic problems), then garages, then one location per stop.
"""
from __future__ import annotations

import math
import random

from bench_optimizer import synth

MATRIX_SOURCE = 'synthetic-haversine-x1.35-25kmh'
SITE = (13.0067, 80.2206)
SEAT_TYPES = {4: 'car4', 6: 'suv6', 12: 'tt12', 26: 'minibus26', 40: 'bus40'}
HORIZON_S = 24 * 3600


def _offset(rng: random.Random, radius_km: float, centre=SITE) -> tuple[float, float]:
    r = radius_km * math.sqrt(rng.random())
    th = rng.uniform(0, 2 * math.pi)
    dy, dx = r * math.sin(th), r * math.cos(th)
    return centre[0] + dy / 111.32, centre[1] + dx / (111.32 * math.cos(math.radians(centre[0])))


def build(spec: dict) -> dict:
    g = spec['generator']
    rng = random.Random(g['seed'])
    direction = g.get('direction')                     # 'IN' | 'OUT' | None (generic CVRPTW, contract v1)
    pts = [SITE]
    n_depots = g.get('depots', 1)
    depot_idx = list(range(1, 1 + n_depots))
    pts += [_offset(rng, g.get('depotRadiusKm', 8)) for _ in range(n_depots)]

    stops, pid = [], 0
    while pid < g['passengers']:
        size = rng.randint(2, 3) if rng.random() < g.get('groupShare', 0.1) else 1
        size = min(size, g['passengers'] - pid)
        loc = len(pts)
        pts.append(_offset(rng, g.get('radiusKm', 12)))
        st = {'id': f'st{len(stops) + 1:03d}', 'locationIndex': loc,
              'passengerIds': [f'emp{pid + k + 1:04d}' for k in range(size)], 'serviceS': g.get('serviceS', 60)}
        if direction is None:
            st['demand'] = size
        stops.append(st)
        pid += size
    matrix = synth(pts)
    dur = matrix['durationsS']

    def pick(k: int) -> list[dict]:
        return rng.sample(stops, min(k, len(stops)))

    # Degraded matrices: random null cells between homes, and islands with no road at all.
    if g.get('nullShare'):
        for i in range(1 + n_depots, len(pts)):
            for j in range(1 + n_depots, len(pts)):
                if i != j and rng.random() < g['nullShare']:
                    dur[i][j] = matrix['distancesM'][i][j] = None
    for st in pick(g.get('islands', 0)):
        li = st['locationIndex']
        for k in range(len(pts)):
            if k != li:
                dur[li][k] = dur[k][li] = matrix['distancesM'][li][k] = matrix['distancesM'][k][li] = None

    # Fleet.
    vehicles = []
    for seats, count in sorted(((int(s), c) for s, c in g['fleet'].items())):
        for _ in range(count):
            vehicles.append({'id': f'v{len(vehicles) + 1:02d}-{SEAT_TYPES.get(seats, str(seats))}', 'capacity': seats,
                             'type': SEAT_TYPES.get(seats, str(seats))})
    open_share = g.get('openStartShare', 0)
    for k, v in enumerate(vehicles):
        garage = depot_idx[k % n_depots]
        v['startIndex'] = None if rng.random() < open_share else garage
        if direction == 'OUT':
            v['endIndex'] = None if g.get('openEnd', True) else garage
        elif direction is None:
            v['startIndex'] = v['endIndex'] = 0
        if g.get('maxDurationS'):
            v['maxDurationS'] = g['maxDurationS']
    for v in vehicles[:g.get('escortVehicles', 0)]:
        v['escort'] = True
    for v in vehicles[:g.get('wheelchairVehicles', 0)]:
        v['wheelchairSpaces'] = 2
    shift = g.get('shiftS', 8 * 3600)
    if direction == 'IN':
        site_window = [shift - g.get('maxEarlyS', 1800), shift - g.get('bufferS', 600)]
    else:
        site_window = [shift + g.get('releaseS', 300), shift + g.get('releaseS', 300) + g.get('maxDepartWaitS', 900)]
    for v in vehicles[len(vehicles) - g.get('lateVehicles', 0):] if g.get('lateVehicles') else []:
        v['timeWindow'] = [site_window[1] + 3600, HORIZON_S]

    # Stop attributes (each drawn deterministically from the seed).
    if g.get('pickupWindowS') and direction == 'IN':
        for st in stops:
            to_site = dur[st['locationIndex']][0] or 0
            centre = site_window[1] - int(to_site * 1.4) - 600
            half = g['pickupWindowS'] // 2
            st['timeWindows'] = [[max(0, centre - half), centre + half]]
    if direction is None:
        for st in stops[3::4]:
            a = rng.randrange(0, 5 * 3600, 900)
            st['timeWindows'] = [[a, a + g.get('genericWindowS', 7200)]]
    for st in pick(g.get('wheelchair', 0)):
        st['wheelchair'] = 1
    for st in pick(int(len(stops) * g.get('flaggedShare', 0))):
        st['escortIfFirstOrLast'] = True
    for st in pick(g.get('requiresEscort', 0)):
        st['requiresEscort'] = True
    for st in pick(int(len(stops) * g.get('narrowShare', 0))):
        st['allowedVehicleTypes'] = ['car4', 'suv6']
    for st in pick(g.get('exclusive', 0)):
        st['exclusive'] = True
    for k, st in enumerate(pick(g.get('pinned', 0))):
        fits = [v for v in vehicles if v['capacity'] - (1 if v.get('escort') else 0) >= len(st['passengerIds'])]
        st['pinnedVehicleId'] = fits[k % len(fits)]['id']
    for st in pick(g.get('pinBad', 0)):
        st['pinnedVehicleId'] = 'v99-ghost'
    for st in pick(g.get('farMaxRide', 0)):
        st['maxRideS'] = 300                      # shorter than any realistic direct ride
    if g.get('customers', 1) > 1:
        for k, st in enumerate(stops):
            st['customerId'] = f'cust{k % g["customers"] + 1}'

    problem = {'schemaVersion': 2, 'matrix': matrix, 'horizonS': HORIZON_S, 'vehicles': vehicles, 'stops': stops,
               'options': {'timeLimitS': g.get('timeLimitS', 10), 'deterministic': g.get('search', 'greedy') == 'greedy',
                           'localSearch': g.get('search', 'greedy'), 'seed': g['seed'],
                           'firstSolution': g.get('firstSolution', 'path_cheapest_arc')}}
    if g.get('weights', 'default') is not None:
        problem['options']['weights'] = g.get('weights') if g.get('weights', 'default') != 'default' else {
            'vehicle': 20000, 'distance': 1}
    if g.get('allowMixedCustomers'):
        problem['options']['allowMixedCustomers'] = True
    if direction:
        problem['trip'] = {'direction': direction, 'siteIndex': 0, 'siteWindow': site_window,
                           'maxRideS': g.get('maxRideS', 5400)}
    return problem
