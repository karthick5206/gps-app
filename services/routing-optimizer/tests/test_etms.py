"""WP 4.3 solver extensions (contract v2): one test group per constraint. Synthetic grid matrices, no network.

Grid helper: points in km, Manhattan metres, 10 m/s -> 100 s per km. Index 0 is the site unless stated otherwise.
"""
import random
import time

import pytest

from optimizer import solve, verify


def grid(points, speed_mps=10):
    dist = [[round((abs(a[0] - b[0]) + abs(a[1] - b[1])) * 1000) for b in points] for a in points]
    return {'distancesM': dist, 'durationsS': [[round(d / speed_mps) for d in row] for row in dist]}


def run(problem):
    res = solve(problem)
    assert res['status'] in ('FEASIBLE', 'OPTIMAL'), res
    assert verify(problem, res) == [], verify(problem, res)
    return res


def order(route):
    return [s['stopId'] for s in route['stops']]


def codes(res):
    return {u['stopId']: u['code'] for u in res['unassigned']}


IN = lambda window=(3000, 3600), **kw: {'direction': 'IN', 'siteIndex': 0, 'siteWindow': list(window), **kw}  # noqa: E731
OUT = lambda window=(3600, 4200), **kw: {'direction': 'OUT', 'siteIndex': 0, 'siteWindow': list(window), **kw}  # noqa: E731
OPT = {'timeLimitS': 2, 'deterministic': True}


# --- direction, site window, max ride ----------------------------------------------------------------------------

def test_in_trip_arrives_in_site_window_with_latest_pickups():
    pts = [(0, 0), (1, 0), (2, 0), (3, 0), (4, 0)]          # garage at index 4
    p = {'schemaVersion': 2, 'matrix': grid(pts), 'trip': IN(maxRideS=1000),
         'vehicles': [{'id': 'v', 'startIndex': 4, 'capacity': 6}],
         'stops': [{'id': f'p{i}', 'locationIndex': i, 'passengerIds': [f'emp{i}'], 'serviceS': 30} for i in (1, 2, 3)],
         'options': OPT}
    res = run(p)
    [r] = res['routes']
    assert order(r) == ['p3', 'p2', 'p1']
    assert r['siteArrivalS'] == 3600 and r['endS'] == 3600       # as late as allowed: shortest rides
    assert r['locationSequence'] == [4, 3, 2, 1, 0]
    rides = {s['stopId']: s['rideS'] for s in r['stops']}
    assert rides == {'p1': 130, 'p2': 260, 'p3': 390}             # site arrival - pickup start
    assert r['stops'][0]['onBoard'] == 1 and r['stops'][-1]['onBoard'] == 3
    assert r['startS'] == r['stops'][0]['serviceStartS'] - 100   # garage departure just in time
    assert res['schemaVersion'] == 2 and res['trip']['direction'] == 'IN'


def test_in_max_ride_splits_vehicles_or_reports():
    pts = [(0, 0), (5, 0), (0, 5)]
    stops = [{'id': 'east', 'locationIndex': 1, 'demand': 1}, {'id': 'north', 'locationIndex': 2, 'demand': 1}]
    two = {'matrix': grid(pts), 'trip': IN(window=(4000, 5000), maxRideS=1200),
           'vehicles': [{'id': 'a', 'startIndex': None, 'capacity': 4}, {'id': 'b', 'startIndex': None, 'capacity': 4}],
           'stops': stops, 'options': OPT}
    res = run(two)
    assert len(res['routes']) == 2                                 # pooled ride would be 1500 s > 1200 s
    one = {**two, 'vehicles': two['vehicles'][:1]}
    res1 = run(one)
    assert len(res1['unassigned']) == 1
    assert res1['unassigned'][0]['reason'] == 'not_scheduled_capacity_or_time'
    assert res1['unassigned'][0]['code'] == 'NOT_SCHEDULED'


def test_max_ride_unachievable_is_a_precheck():
    pts = [(0, 0), (20, 0)]                                         # direct ride 2000 s
    p = {'matrix': grid(pts), 'trip': IN(window=(5000, 6000)), 'vehicles': [{'id': 'v', 'startIndex': None}],
         'stops': [{'id': 'far', 'locationIndex': 1, 'demand': 1, 'maxRideS': 1800, 'passengerIds': ['e1']}],
         'options': OPT}
    res = run(p)
    assert res['unassigned'] == [{'stopId': 'far', 'reason': 'max_ride_unachievable', 'code': 'MAX_RIDE_UNACHIEVABLE',
                                  'passengerIds': ['e1']}]


def test_out_trip_departs_in_window_open_end_and_ride():
    pts = [(0, 0), (1, 0), (2, 0), (3, 0)]
    p = {'matrix': grid(pts), 'trip': OUT(window=(3600, 4200), maxRideS=400),
         'vehicles': [{'id': 'v', 'startIndex': 0, 'endIndex': None, 'capacity': 4}],
         'stops': [{'id': f'd{i}', 'locationIndex': i, 'demand': 1, 'serviceS': 20} for i in (3, 1, 2)], 'options': OPT}
    res = run(p)
    [r] = res['routes']
    assert order(r) == ['d1', 'd2', 'd3']
    assert r['siteDepartureS'] == 3600 == r['startS']
    assert r['endS'] == r['stops'][-1]['departureS']                # open end: route ends at the last drop
    assert [s['rideS'] for s in r['stops']] == [100, 220, 340]
    assert [s['onBoard'] for s in r['stops']] == [2, 1, 0]
    assert r['locationSequence'] == [0, 1, 2, 3]


def test_out_vehicle_deadhead_and_unusable_vehicles():
    pts = [(0, 0), (1, 0), (30, 0)]
    m = grid(pts)
    m['durationsS'][2][0] = None                                   # garage 2 has no road to the site
    p = {'matrix': m, 'trip': OUT(window=(3600, 3700)),
         'vehicles': [{'id': 'far', 'startIndex': 2, 'endIndex': None, 'capacity': 4},
                      {'id': 'late', 'startIndex': 1, 'endIndex': None, 'capacity': 4, 'timeWindow': [3650, 86400]},
                      {'id': 'ok', 'startIndex': 1, 'endIndex': None, 'capacity': 4, 'timeWindow': [3000, 86400]}],
         'stops': [{'id': 's', 'locationIndex': 1, 'demand': 1}], 'options': OPT}
    res = run(p)
    assert {u['vehicleId']: u['reason'] for u in res['unusableVehicles']} == {
        'far': 'cannot_reach_site', 'late': 'availability_outside_site_window'}   # 3650 + 100 s deadhead > 3700
    [r] = res['routes']
    assert r['vehicleId'] == 'ok' and r['deadheadToSiteS'] == 100


def test_site_window_unreachable_reported():
    pts = [(0, 0), (1, 0)]
    p = {'matrix': grid(pts), 'trip': IN(window=(3000, 3600)),
         'vehicles': [{'id': 'v', 'startIndex': None, 'timeWindow': [0, 86400]}],
         'stops': [{'id': 's', 'locationIndex': 1, 'demand': 1, 'timeWindows': [[3550, 3600]]}], 'options': OPT}
    res = run(p)                                                    # pickup at 3550 + 100 s > latest arrival 3600
    assert codes(res) == {'s': 'SHIFT_WINDOW_UNREACHABLE'}


# --- capacity, heterogeneous fleet, wheelchair, escort seat -------------------------------------------------------

def test_heterogeneous_fleet_capacity():
    rng = random.Random(4)
    pts = [(0, 0)] + [(rng.uniform(-3, 3), rng.uniform(-3, 3)) for _ in range(10)]
    stops = [{'id': f's{i}', 'locationIndex': i, 'demand': 1} for i in range(1, 11)]
    stops.append({'id': 'group', 'locationIndex': 1, 'demand': 7})
    p = {'matrix': grid(pts), 'trip': OUT(),
         'vehicles': [{'id': 'car', 'capacity': 4, 'type': 'car4'}, {'id': 'suv', 'capacity': 6, 'type': 'suv6'},
                      {'id': 'tt', 'capacity': 12, 'type': 'tt12'}],
         'stops': stops, 'options': OPT}
    res = run(p)
    assert codes(res) == {}
    loads = {r['vehicleId']: r['load'] for r in res['routes']}
    assert all(loads[v] <= c for v, c in (('car', 4), ('suv', 6), ('tt', 12)) if v in loads)
    assert sum(loads.values()) == 17
    p['stops'][-1]['demand'] = 13
    res2 = run(p)
    assert res2['unassigned'][0]['reason'] == 'demand_exceeds_vehicle_capacity'


def test_escort_takes_a_seat():
    pts = [(0, 0), (1, 0), (2, 0), (3, 0), (4, 0)]
    p = {'matrix': grid(pts), 'trip': OUT(), 'vehicles': [{'id': 'v', 'capacity': 4, 'escort': True, 'endIndex': None}],
         'stops': [{'id': f's{i}', 'locationIndex': i, 'demand': 1} for i in range(1, 5)], 'options': OPT}
    res = run(p)
    assert len(res['unassigned']) == 1 and res['unassigned'][0]['code'] == 'CAPACITY_EXHAUSTED'
    assert res['routes'][0]['seats'] == 3
    p['vehicles'][0]['escortUsesSeat'] = False
    assert run(p)['unassigned'] == []


def test_wheelchair_second_capacity():
    pts = [(0, 0), (1, 0), (2, 0), (3, 0)]
    p = {'matrix': grid(pts), 'trip': OUT(),
         'vehicles': [{'id': 'plain', 'capacity': 6, 'endIndex': None},
                      {'id': 'access', 'capacity': 6, 'wheelchairSpaces': 1, 'endIndex': None, 'fixedCost': 0}],
         'stops': [{'id': 'w1', 'locationIndex': 1, 'demand': 1, 'wheelchair': 1},
                   {'id': 'w2', 'locationIndex': 2, 'demand': 1, 'wheelchair': 1},
                   {'id': 'x', 'locationIndex': 3, 'demand': 1}], 'options': OPT}
    res = run(p)
    routed = {s['stopId']: r['vehicleId'] for r in res['routes'] for s in r['stops']}
    assert len([s for s in ('w1', 'w2') if routed.get(s) == 'access']) == 1   # one space only
    assert codes(res) in ({'w1': 'NOT_SCHEDULED'}, {'w2': 'NOT_SCHEDULED'})
    p['vehicles'] = p['vehicles'][:1]
    res2 = run(p)
    assert res2['unassigned'][0]['code'] == 'NO_COMPATIBLE_VEHICLE'
    assert res2['unassigned'][0]['detail'] == {'failed': ['wheelchair']}


def test_allowed_vehicle_types_and_ids():
    pts = [(0, 0), (1, 0), (2, 0)]
    p = {'matrix': grid(pts), 'trip': OUT(),
         'vehicles': [{'id': 'bus', 'capacity': 40, 'type': 'bus40'}, {'id': 'car', 'capacity': 4, 'type': 'car4'}],
         'stops': [{'id': 'lane', 'locationIndex': 1, 'demand': 1, 'allowedVehicleTypes': ['car4', 'suv6']},
                   {'id': 'byid', 'locationIndex': 2, 'demand': 1, 'allowedVehicleIds': ['bus']},
                   {'id': 'none', 'locationIndex': 2, 'demand': 1, 'allowedVehicleTypes': ['tt12']}],
         'options': OPT}
    res = run(p)
    routed = {s['stopId']: r['vehicleId'] for r in res['routes'] for s in r['stops']}
    assert routed == {'lane': 'car', 'byid': 'bus'}
    assert res['unassigned'][0]['detail'] == {'failed': ['vehicle_type']}


# --- safety (doc 06 §4.5, doc 10 §5.3) -------------------------------------------------------------------------

def test_escort_rule_in_flagged_not_first_pickup():
    pts = [(0, 0), (4, 0), (2, 0), (6, 0)]       # natural order garage(6) -> F(4) -> M(2) -> site
    base = {'matrix': grid(pts), 'trip': IN(window=(3000, 3600)),
            'stops': [{'id': 'F', 'locationIndex': 1, 'demand': 1, 'escortIfFirstOrLast': True},
                      {'id': 'M', 'locationIndex': 2, 'demand': 1}], 'options': OPT}
    res = run({**base, 'vehicles': [{'id': 'v', 'startIndex': 3, 'capacity': 4}]})
    assert order(res['routes'][0]) == ['M', 'F']
    res2 = run({**base, 'vehicles': [{'id': 'v', 'startIndex': 3, 'capacity': 4, 'escort': True}]})
    assert order(res2['routes'][0]) == ['F', 'M']


def test_escort_rule_out_flagged_not_last_drop():
    pts = [(0, 0), (4, 0), (2, 0)]               # natural order site -> M(2) -> F(4)
    base = {'matrix': grid(pts), 'trip': OUT(),
            'stops': [{'id': 'F', 'locationIndex': 1, 'demand': 1, 'escortIfFirstOrLast': True},
                      {'id': 'M', 'locationIndex': 2, 'demand': 1}], 'options': OPT}
    res = run({**base, 'vehicles': [{'id': 'v', 'capacity': 4, 'endIndex': None}]})
    assert order(res['routes'][0]) == ['F', 'M']
    res2 = run({**base, 'vehicles': [{'id': 'v', 'capacity': 4, 'endIndex': None, 'escort': True}]})
    assert order(res2['routes'][0]) == ['M', 'F']


def test_escort_rule_alone_passenger_is_reported():
    pts = [(0, 0), (4, 0)]
    p = {'matrix': grid(pts), 'trip': OUT(), 'vehicles': [{'id': 'v', 'capacity': 4}],
         'stops': [{'id': 'F', 'locationIndex': 1, 'demand': 1, 'escortIfFirstOrLast': True}], 'options': OPT}
    res = run(p)
    assert res['unassigned'] == [{'stopId': 'F', 'reason': 'safety_rule', 'code': 'SAFETY_RULE',
                                  'detail': {'rule': 'escortIfFirstOrLast'}}]


def test_requires_escort_vehicle():
    pts = [(0, 0), (1, 0)]
    p = {'matrix': grid(pts), 'trip': OUT(), 'vehicles': [{'id': 'v', 'capacity': 4}],
         'stops': [{'id': 'F', 'locationIndex': 1, 'demand': 1, 'requiresEscort': True}], 'options': OPT}
    assert codes(run(p)) == {'F': 'SAFETY_RULE'}
    p['vehicles'].append({'id': 'e', 'capacity': 4, 'escort': True})
    res = run(p)
    assert res['routes'][0]['vehicleId'] == 'e'


# --- pinning, pooling, customers --------------------------------------------------------------------------------

def test_pinned_assignment_kept():
    pts = [(0, 0), (1, 0), (-1, 0), (10, 0)]
    p = {'matrix': grid(pts), 'trip': OUT(),
         'vehicles': [{'id': 'near', 'startIndex': 0, 'capacity': 4, 'endIndex': None},
                      {'id': 'other', 'startIndex': 0, 'capacity': 4, 'endIndex': None}],
         'stops': [{'id': 'a', 'locationIndex': 1, 'demand': 1, 'pinnedVehicleId': 'other'},
                   {'id': 'b', 'locationIndex': 2, 'demand': 1, 'pinnedVehicleId': 'near'}],
         'options': {**OPT, 'weights': {'vehicle': 100000, 'time': 1}}}
    res = run(p)                                  # the vehicle weight alone would pool them on one vehicle
    routed = {s['stopId']: r['vehicleId'] for r in res['routes'] for s in r['stops']}
    assert routed == {'a': 'other', 'b': 'near'}
    p['stops'][0]['pinnedVehicleId'] = 'ghost'
    p['stops'][1]['pinnedVehicleId'] = 'near'
    p['stops'][1]['demand'] = 9
    res2 = run(p)
    assert codes(res2) == {'a': 'PINNED_ASSIGNMENT_INFEASIBLE', 'b': 'PINNED_ASSIGNMENT_INFEASIBLE'}
    assert {u['stopId']: u['detail']['failed'] for u in res2['unassigned']} == {
        'a': ['vehicle_unavailable'], 'b': ['seats']}


def test_exclusive_no_pooling():
    pts = [(0, 0), (1, 0), (2, 0), (3, 0)]
    p = {'matrix': grid(pts), 'trip': OUT(),
         'vehicles': [{'id': f'v{i}', 'capacity': 6, 'endIndex': None} for i in range(2)],
         'stops': [{'id': 'solo', 'locationIndex': 2, 'demand': 1, 'exclusive': True},
                   {'id': 'a', 'locationIndex': 1, 'demand': 1}, {'id': 'b', 'locationIndex': 3, 'demand': 1}],
         'options': {**OPT, 'weights': {'vehicle': 100000, 'time': 1}}}
    res = run(p)
    solo = [r for r in res['routes'] if 'solo' in order(r)]
    assert len(solo) == 1 and order(solo[0]) == ['solo']
    assert codes(res) == {}


def test_customers_not_mixed_unless_allowed():
    pts = [(0, 0), (1, 0), (2, 0)]
    p = {'matrix': grid(pts), 'trip': OUT(),
         'vehicles': [{'id': f'v{i}', 'capacity': 6, 'endIndex': None} for i in range(2)],
         'stops': [{'id': 'a', 'locationIndex': 1, 'demand': 1, 'customerId': 'acme'},
                   {'id': 'b', 'locationIndex': 2, 'demand': 1, 'customerId': 'globex'}],
         'options': {**OPT, 'weights': {'vehicle': 100000, 'time': 1}}}
    res = run(p)
    assert len(res['routes']) == 2
    p['options'] = {**p['options'], 'allowMixedCustomers': True}
    assert len(run(p)['routes']) == 1


# --- fleet start positions, availability, duty ------------------------------------------------------------------

def test_multi_depot_and_open_start():
    pts = [(0, 0), (9, 0), (-9, 0), (10, 0), (-10, 0)]
    p = {'matrix': grid(pts), 'trip': IN(window=(5000, 6000)),
         'vehicles': [{'id': 'east', 'startIndex': 3, 'capacity': 4}, {'id': 'west', 'startIndex': 4, 'capacity': 4},
                      {'id': 'roaming', 'startIndex': None, 'capacity': 4, 'fixedCost': 10**6}],
         'stops': [{'id': 'e', 'locationIndex': 1, 'demand': 1}, {'id': 'w', 'locationIndex': 2, 'demand': 1}],
         'options': OPT}
    res = run(p)
    routed = {s['stopId']: r['vehicleId'] for r in res['routes'] for s in r['stops']}
    assert routed == {'e': 'east', 'w': 'west'}
    p['vehicles'] = [p['vehicles'][2]]
    r = run(p)['routes'][0]
    assert r['startS'] == r['stops'][0]['serviceStartS']           # open start: route begins at the first pickup
    assert r['locationSequence'][-1] == 0


def test_vehicle_availability_window_in():
    pts = [(0, 0), (1, 0)]
    p = {'matrix': grid(pts), 'trip': IN(window=(3000, 3600)),
         'vehicles': [{'id': 'late', 'startIndex': None, 'timeWindow': [4000, 9000]},
                      {'id': 'ok', 'startIndex': None, 'timeWindow': [0, 3600]}],
         'stops': [{'id': 's', 'locationIndex': 1, 'demand': 1}], 'options': OPT}
    res = run(p)
    assert res['unusableVehicles'] == [{'vehicleId': 'late', 'reason': 'availability_outside_site_window'}]
    assert res['routes'][0]['vehicleId'] == 'ok'
    p['vehicles'] = p['vehicles'][:1]
    res2 = run(p)
    assert res2['routes'] == [] and codes(res2) == {'s': 'NO_COMPATIBLE_VEHICLE'}


def test_max_route_duration_in_trip():
    pts = [(0, 0), (3, 0), (6, 0)]
    p = {'matrix': grid(pts), 'trip': IN(window=(5000, 6000)),
         'vehicles': [{'id': 'v', 'startIndex': 2, 'capacity': 4, 'maxDurationS': 500}],
         'stops': [{'id': 's', 'locationIndex': 1, 'demand': 1}], 'options': OPT}
    assert codes(run(p)) == {'s': 'MAX_ROUTE_DURATION'}                 # garage -> s -> site = 600 s
    p['vehicles'][0]['maxDurationS'] = 600
    assert run(p)['routes'][0]['durationS'] == 600


# --- objective weights ---------------------------------------------------------------------------------------------

def test_weights_vehicle_versus_distance():
    pts = [(0, 0), (5, 0), (-5, 0)]
    p = {'matrix': grid(pts), 'trip': OUT(),
         'vehicles': [{'id': f'v{i}', 'capacity': 4, 'endIndex': None} for i in range(2)],
         'stops': [{'id': 'e', 'locationIndex': 1, 'demand': 1}, {'id': 'w', 'locationIndex': 2, 'demand': 1}],
         'options': {**OPT, 'weights': {'distance': 1}}}
    res = run(p)
    assert res['objectiveBreakdown']['vehiclesUsed'] == 2 and res['objectiveBreakdown']['totalDistanceM'] == 10000
    p['options']['weights'] = {'vehicle': 100000, 'distance': 1}
    res2 = run(p)
    assert res2['objectiveBreakdown']['vehiclesUsed'] == 1 and res2['objectiveBreakdown']['totalDistanceM'] == 15000
    assert res2['objective'] == 100000 + 15000 and res2['weights']['vehicle'] == 100000


def test_per_vehicle_cost_and_fixed_cost():
    pts = [(0, 0), (2, 0)]
    p = {'matrix': grid(pts), 'trip': OUT(),
         'vehicles': [{'id': 'bus', 'capacity': 40, 'endIndex': None, 'distanceWeight': 5, 'fixedCost': 100},
                      {'id': 'car', 'capacity': 4, 'endIndex': None, 'fixedCost': 100}],
         'stops': [{'id': 's', 'locationIndex': 1, 'demand': 1}], 'options': {**OPT, 'weights': {'distance': 1}}}
    res = run(p)
    assert res['routes'][0]['vehicleId'] == 'car' and res['objective'] == 100 + 2000


# --- degraded matrices, determinism, limits, contract ---------------------------------------------------------------

def test_null_cells_degrade_gracefully():
    rng = random.Random(9)
    pts = [(0, 0)] + [(rng.uniform(-4, 4), rng.uniform(-4, 4)) for _ in range(25)]
    m = grid(pts)
    for i in range(2, 26):                       # 10 % null cells between homes
        for j in range(2, 26):
            if i != j and rng.random() < 0.10:
                m['durationsS'][i][j] = None
                m['distancesM'][i][j] = None
    for k in range(26):                          # index 1 is an island: no road to or from anywhere
        if k != 1:
            m['durationsS'][1][k] = m['durationsS'][k][1] = None
    p = {'matrix': m, 'trip': OUT(window=(3600, 4200), maxRideS=3600),
         'vehicles': [{'id': f'v{i}', 'capacity': 6, 'endIndex': None} for i in range(6)],
         'stops': [{'id': f's{i}', 'locationIndex': i, 'demand': 1} for i in range(1, 26)], 'options': OPT}
    res = run(p)
    assert codes(res) == {'s1': 'ROUTING_UNAVAILABLE'}
    assert res['stats']['matrixNullCells'] > 0


def test_deterministic_mode_repeats_exactly():
    rng = random.Random(21)
    pts = [(0, 0)] + [(rng.uniform(-6, 6), rng.uniform(-6, 6)) for _ in range(40)]
    p = {'matrix': grid(pts), 'trip': IN(window=(5000, 6000), maxRideS=2400),
         'vehicles': [{'id': f'v{i}', 'capacity': c, 'startIndex': None} for i, c in enumerate([4, 6, 6, 12, 12])],
         'stops': [{'id': f's{i}', 'locationIndex': i, 'demand': 1, 'serviceS': 60} for i in range(1, 41)],
         'options': {'timeLimitS': 20, 'deterministic': True, 'seed': 7}}
    a, b = run(p), run(p)
    assert a['stats']['deterministic'] is True and a['stats']['stoppedBy'] == 'local_optimum'
    strip = lambda r: (r['objective'], r['routes'], r['unassigned'])  # noqa: E731
    assert strip(a) == strip(b)


def test_time_limit_respected():
    rng = random.Random(5)
    pts = [(0, 0)] + [(rng.uniform(-6, 6), rng.uniform(-6, 6)) for _ in range(60)]
    p = {'matrix': grid(pts), 'trip': OUT(maxRideS=3600),
         'vehicles': [{'id': f'v{i}', 'capacity': 12, 'endIndex': None} for i in range(6)],
         'stops': [{'id': f's{i}', 'locationIndex': i, 'demand': 1} for i in range(1, 61)],
         'options': {'timeLimitS': 2}}                          # guided local search runs until the limit
    t = time.perf_counter()
    res = run(p)
    assert time.perf_counter() - t <= 2 * 1.1
    assert res['stats']['stoppedBy'] == 'time_limit' and res['stats']['deterministic'] is False


def test_callback_transit_matches_matrix_transit():
    rng = random.Random(8)
    pts = [(0, 0)] + [(rng.uniform(-5, 5), rng.uniform(-5, 5)) for _ in range(30)]
    p = {'matrix': grid(pts), 'trip': IN(window=(5000, 6000), maxRideS=2400),
         'vehicles': [{'id': f'v{i}', 'capacity': 8, 'startIndex': None} for i in range(5)],
         'stops': [{'id': f's{i}', 'locationIndex': i, 'demand': 1} for i in range(1, 31)],
         'options': {'timeLimitS': 10, 'deterministic': True}}
    a = run(p)
    b = run({**p, 'options': {**p['options'], 'transit': 'callback'}})
    assert (a['objective'], a['routes']) == (b['objective'], b['routes'])


@pytest.mark.parametrize('patch, msg', [
    ({'schemaVersion': 3}, 'schemaVersion'),
    ({'trip': {'direction': 'SIDEWAYS', 'siteIndex': 0, 'siteWindow': [0, 10]}}, 'trip.direction'),
    ({'trip': {'direction': 'IN', 'siteIndex': 9, 'siteWindow': [0, 10]}}, 'trip.siteIndex'),
    ({'trip': {'direction': 'IN', 'siteIndex': 0}}, 'siteWindow is required'),
    ({'trip': {'direction': 'IN', 'siteIndex': 0, 'siteWindow': [10, 5]}}, 'siteWindow must satisfy'),
    ({'stops': [{'id': 's', 'locationIndex': 1, 'maxRideS': 100}]}, 'need trip.direction'),
    ({'stops': [{'id': 's', 'locationIndex': 1, 'escortIfFirstOrLast': True}]}, 'need trip.direction'),
    ({'options': {'weights': {'vehicle': 5}}}, 'needs distance, time or routeDuration'),
    ({'matrix': {'durationsS': [[0, 1], [1, 0]]}, 'options': {'weights': {'distance': 1}}}, 'needs matrix.distancesM'),
    ({'vehicles': [{'id': 'a'}, {'id': 'a'}]}, 'duplicate vehicle id'),
    ({'vehicles': [{'id': 'a', 'capacity': 0, 'escort': True}]}, 'seat for the escort'),
    ({'options': {'firstSolution': 'magic'}}, 'firstSolution'),
])
def test_v2_invalid_input(patch, msg):
    base = {'matrix': grid([(0, 0), (1, 0)]), 'vehicles': [{'id': 'v'}], 'stops': [{'id': 's', 'locationIndex': 1}]}
    res = solve({**base, **patch})
    assert res['status'] == 'INVALID_INPUT' and msg in res['error'], res
    assert res['schemaVersion'] == 2


def test_v1_problem_still_solves_with_additive_fields():
    p = {'matrix': grid([(0, 0), (1, 0)]), 'vehicles': [{'id': 'v'}], 'stops': [{'id': 's', 'locationIndex': 1}],
         'options': {'timeLimitS': 1}}
    res = run(p)
    assert res['schemaVersion'] == 2 and 'trip' not in res
    assert res['routes'][0]['locationSequence'] == [0, 1, 0] and res['routes'][0]['load'] is None
    assert res['unusableVehicles'] == [] and res['weights'] is None


def test_passenger_ids_carried_through():
    pts = [(0, 0), (1, 0), (2, 0)]
    p = {'matrix': grid(pts), 'trip': OUT(), 'vehicles': [{'id': 'v', 'capacity': 2, 'endIndex': None}],
         'stops': [{'id': 'home1', 'locationIndex': 1, 'passengerIds': ['e1', 'e2']},
                   {'id': 'home2', 'locationIndex': 2, 'passengerIds': ['e3']}], 'options': OPT}
    res = run(p)
    assert res['routes'][0]['stops'][0]['passengerIds'] == ['e1', 'e2'] and res['routes'][0]['load'] == 2
    assert res['unassigned'][0]['passengerIds'] == ['e3']


def test_verify_catches_violations():
    pts = [(0, 0), (1, 0), (2, 0)]
    p = {'matrix': grid(pts), 'trip': OUT(maxRideS=1000), 'vehicles': [{'id': 'v', 'capacity': 2, 'endIndex': None}],
         'stops': [{'id': 'a', 'locationIndex': 1, 'demand': 1}, {'id': 'b', 'locationIndex': 2, 'demand': 1}],
         'options': OPT}
    res = run(p)
    bad = {**res, 'unassigned': [{'stopId': 'a', 'reason': 'x', 'code': 'X'}]}
    assert any('appears 2 times' in v for v in verify(p, bad))
    p2 = {**p, 'vehicles': [{'id': 'v', 'capacity': 1, 'endIndex': None}]}
    assert any('load 2 > seats 1' in v for v in verify(p2, res))
    p3 = {**p, 'trip': OUT(maxRideS=150)}
    assert any('ride 200 > 150' in v for v in verify(p3, res))
