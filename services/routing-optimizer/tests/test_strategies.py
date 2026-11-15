"""E4 WP-S strategy support (doc 18 §7): weights.rideTime, trip.detourGuard, post-solve unassigned reasons.

All matrices are SYNTHETIC (grid helper from test_etms: Manhattan km, 100 s per km); index 0 is the site.
Preset weights are the README "Strategy presets": Default (v7200, t1) is the API's current default.
"""
import pytest

import corpus_gen
import corpus_run
from optimizer import solve, verify
from optimizer.solver import _DropClassifier, _frame, validate

from test_etms import IN, OPT, OUT, codes, grid, order, run

DEFAULT = {'vehicle': 7200, 'time': 1}
BALANCED = {'vehicle': 3600, 'time': 2, 'rideTime': 1}
COMFORT = {'vehicle': 1800, 'time': 1, 'rideTime': 2}


def vans(n, seats=7):
    return [{'id': f'van{i}', 'startIndex': None, 'endIndex': None, 'capacity': seats} for i in range(n)]


def trip_problem(pts, trip, n_vans, weights, guard=None, **opts):
    t = dict(trip)
    if guard:
        t['detourGuard'] = guard
    return {'schemaVersion': 2, 'matrix': grid(pts), 'trip': t, 'vehicles': vans(n_vans),
            'stops': [{'id': f'p{i}', 'locationIndex': i, 'passengerIds': [f'e{i}'], 'serviceS': 60}
                      for i in range(1, len(pts))],
            'options': {**OPT, 'weights': weights, **opts}}


# --- grouping ----------------------------------------------------------------------------------------------------

FIVE = [(0, 0), (3, 0), (3.5, 0.5), (4, 0), (4, 1), (5, 0.5)]          # five homes at five points, one corridor


@pytest.mark.parametrize('n_vans', [1, 2])
@pytest.mark.parametrize('weights', [DEFAULT, BALANCED], ids=['default', 'balanced'])
def test_five_passengers_share_one_seven_seater(n_vans, weights):
    res = run(trip_problem(FIVE, IN(window=(3000, 3600), maxRideS=1800), n_vans, weights))
    assert res['unassigned'] == []
    [r] = res['routes']                                                  # the second van stays unused
    assert len(r['stops']) == 5 and r['load'] == 5


FAR = [(0, 0), (6, 0), (6.5, 0.5), (7, 0), (7, 1), (0, -15)]           # four in the east, one far south


@pytest.mark.parametrize('trip', [IN(window=(5000, 6000)), OUT(window=(3600, 4200))], ids=['IN', 'OUT'])
def test_distant_passenger_gets_own_van_only_with_ride_cost(trip):
    pooled = run(trip_problem(FAR, trip, 2, DEFAULT))
    assert len(pooled['routes']) == 1                                   # vehicle weight dominates: one van
    comfort = run(trip_problem(FAR, trip, 2, COMFORT))
    assert len(comfort['routes']) == 2                                  # the far ride now costs more than a van
    assert ['p5'] in [order(r) for r in comfort['routes']]
    rides = lambda res: max(s['rideS'] for r in res['routes'] for s in r['stops'])  # noqa: E731
    assert rides(comfort) < rides(pooled)
    # The far passenger travels direct: no detour.
    far = next(s for r in comfort['routes'] for s in r['stops'] if s['stopId'] == 'p5')
    assert far['detourS'] == 0 and far['directS'] == (1500 + 60 if trip['direction'] == 'IN' else 1500)


TWO_DIR = [(0, 0), (0, 8), (0.5, 8), (-0.5, 8.5), (0, -8), (0.5, -8.5)]  # three north, two south (8 km)


def test_two_directions_default_merges_balanced_splits():
    trip = IN(window=(5000, 6000))
    merged = run(trip_problem(TWO_DIR, trip, 2, DEFAULT))
    assert len(merged['routes']) == 1
    split = run(trip_problem(TWO_DIR, trip, 2, BALANCED))
    assert sorted(sorted(order(r)) for r in split['routes']) == [['p1', 'p2', 'p3'], ['p4', 'p5']]
    assert split['objectiveBreakdown']['rideTimeCost'] > 0


GUARD = {'ratio': 1.5, 'extraS': 300, 'costPerS': 10}


def test_detour_guard_alone_splits_with_two_vans_and_never_drops_with_one():
    trip = IN(window=(5000, 6000))
    two = run(trip_problem(TWO_DIR, trip, 2, DEFAULT, GUARD))
    assert sorted(sorted(order(r)) for r in two['routes']) == [['p1', 'p2', 'p3'], ['p4', 'p5']]
    assert two['objectiveBreakdown']['detourCost'] == 0
    one = run(trip_problem(TWO_DIR, trip, 1, DEFAULT, GUARD))
    assert one['unassigned'] == [] and len(one['routes'][0]['stops']) == 5   # soft: nobody is dropped
    assert one['objectiveBreakdown']['detourCost'] > 0
    worst = max(s['detourS'] for s in one['routes'][0]['stops'])
    assert worst > 300                                                    # beyond the guard, served anyway


def test_out_ride_cost_is_symmetric_to_in():
    """Same homes, OUT instead of IN: the ride-time cost splits the two directions the same way."""
    split = run(trip_problem(TWO_DIR, OUT(window=(3600, 4200)), 2, BALANCED))
    assert sorted(sorted(order(r)) for r in split['routes']) == [['p1', 'p2', 'p3'], ['p4', 'p5']]
    for r in split['routes']:                                             # OUT ride = drop start - site departure
        for s in r['stops']:
            assert s['rideS'] == s['serviceStartS'] - r['siteDepartureS'] and s['detourS'] == s['rideS'] - s['directS']


@pytest.mark.parametrize('trip', [IN(window=(5000, 6000)), OUT(window=(3600, 4200))], ids=['IN', 'OUT'])
def test_objective_accounts_ride_and_guard_costs_together(trip):
    """rideTime (Ride dimension) and detourGuard (Detour copy) on the same stops: both soft bounds are active and
    the objective is exactly arcs + rideTimeCost + detourCost."""
    pts = [(0, 0), (2, 0), (0, 2), (-2, 0)]
    p = trip_problem(pts, trip, 1, {'time': 1, 'rideTime': 3}, {'ratio': 1, 'extraS': 0, 'costPerS': 7})
    p['stops'][0]['passengerIds'] = ['a', 'b']                          # demand 2: ride cost x 2
    res = run(p)
    [r] = res['routes']
    b = res['objectiveBreakdown']
    rides = {s['stopId']: s for s in r['stops']}
    assert b['rideTimeCost'] == 3 * (2 * rides['p1']['rideS'] + rides['p2']['rideS'] + rides['p3']['rideS'])
    assert b['detourCost'] == 7 * sum(s['detourS'] for s in r['stops']) > 0
    seq = r['locationSequence']
    arcs = sum(p['matrix']['durationsS'][a][c] for a, c in zip(seq, seq[1:]))
    assert res['objective'] == arcs + b['rideTimeCost'] + b['detourCost']


def test_ride_time_absent_is_identical_to_before():
    """Corpus 05 (deterministic): objective recorded with the solver before WP-S; rideTime 0 changes nothing."""
    p = corpus_gen.build(corpus_run.load(corpus_run.scenario_files('05-in-medium')[0]))
    a = run(p)
    assert a['objective'] == 402900 and a['unassigned'] == []
    assert a['objectiveBreakdown']['rideTimeCost'] == 0 and a['objectiveBreakdown']['detourCost'] == 0
    assert 'rideTime' not in a['weights']
    b = run({**p, 'options': {**p['options'], 'weights': {**p['options']['weights'], 'rideTime': 0}}})
    assert (a['objective'], a['routes']) == (b['objective'], b['routes'])


# --- unassigned reasons --------------------------------------------------------------------------------------------

def test_capacity_exhausted():
    p = trip_problem([(0, 0), (1, 0), (1.5, 0), (2, 0)], IN(window=(3000, 3600)), 1, DEFAULT)
    p['vehicles'][0]['capacity'] = 2
    res = run(p)
    [u] = res['unassigned']
    assert u['code'] == 'CAPACITY_EXHAUSTED' and u['detail'] == {'freeSeats': 0}


@pytest.mark.parametrize('trip', [IN(window=(4000, 5000), maxRideS=1200), OUT(window=(3600, 4200), maxRideS=1200)],
                         ids=['IN', 'OUT'])
def test_fleet_too_small_max_ride(trip):
    res = run(trip_problem([(0, 0), (5, 0), (0, 5)], trip, 1, DEFAULT))   # pooled ride 1500+ s > 1200 s
    [u] = res['unassigned']
    assert u['code'] == 'FLEET_TOO_SMALL' and u['detail'] == {'binding': ['max_ride'], 'freeSeats': 6}


def test_fleet_too_small_max_ride_even_when_search_hits_the_clock():
    p = trip_problem([(0, 0), (5, 0), (0, 5)], IN(window=(4000, 5000), maxRideS=1200), 1, DEFAULT)
    p['options'] = {'timeLimitS': 1, 'weights': DEFAULT}                    # guided search runs to the limit
    res = run(p)
    assert res['stats']['stoppedBy'] == 'time_limit'
    assert codes(res) in ({'p1': 'FLEET_TOO_SMALL'}, {'p2': 'FLEET_TOO_SMALL'})


def test_fleet_too_small_site_window():
    """Depot start at the site at t >= 0, arrive by 1100: each pickup alone fits (1000 s), both do not (2000 s)."""
    p = trip_problem([(0, 0), (5, 0), (-5, 0)], IN(window=(0, 1100)), 1, DEFAULT)
    p['vehicles'][0].update(startIndex=0)
    for s in p['stops']:
        s['serviceS'] = 0
    res = run(p)
    [u] = res['unassigned']
    assert u['code'] == 'FLEET_TOO_SMALL' and u['detail'] == {'binding': ['site_window'], 'freeSeats': 6}


def test_fleet_too_small_generic_time_window():
    pts = [(0, 0), (5, 0), (-5, 0)]
    p = {'matrix': grid(pts), 'vehicles': [{'id': 'v', 'capacity': 4}],
         'stops': [{'id': 'e', 'locationIndex': 1, 'demand': 1, 'timeWindows': [[500, 600]]},
                   {'id': 'w', 'locationIndex': 2, 'demand': 1, 'timeWindows': [[500, 600]]}],
         'options': {**OPT, 'weights': DEFAULT}}
    res = run(p)
    [u] = res['unassigned']
    assert u['code'] == 'FLEET_TOO_SMALL' and u['detail'] == {'binding': ['time_window'], 'freeSeats': 3}


def _classifier(problem, routes, hit_limit):
    ctx = validate(problem)
    frames = [(v, _frame(ctx, v)) for v in ctx.vehicles]
    cls = _DropClassifier(ctx, [v for v, _ in frames], [f for _, f in frames], routes, hit_limit, False)
    return cls, {s['id']: {**s, '_allowed': list(range(len(frames)))} for s in ctx.stops}


def test_time_limit_only_when_a_compatible_vehicle_stayed_unused():
    p = trip_problem(FIVE, IN(window=(3000, 3600), maxRideS=1800), 2, DEFAULT)
    route = {'vehicleId': 'van0', 'stops': [{'stopId': f'p{i}'} for i in (5, 4, 3, 2)]}
    cls, st = _classifier(p, [route], hit_limit=True)
    assert cls.classify(st['p1']) == ('TIME_LIMIT', {'unusedVehicles': 1})
    cls, st = _classifier(p, [route], hit_limit=False)                      # local optimum: not the clock
    assert cls.classify(st['p1']) == ('NOT_SCHEDULED', {'unusedVehicles': 1})
    # Every vehicle used: a feasible insertion is still a search limit, never FLEET_TOO_SMALL.
    other = {'vehicleId': 'van1', 'stops': [{'stopId': 'p2'}]}
    route1 = {'vehicleId': 'van0', 'stops': [{'stopId': f'p{i}'} for i in (5, 4, 3)]}
    cls, st = _classifier(p, [route1, other], hit_limit=True)
    assert cls.classify(st['p1'])[0] == 'TIME_LIMIT' and 'insertableInto' in cls.classify(st['p1'])[1]


def test_pinned_drop_reason_unchanged():
    p = trip_problem([(0, 0), (1, 0), (2, 0)], IN(window=(3000, 3600)), 2, DEFAULT)
    p['vehicles'][0]['capacity'] = 1
    for s in p['stops']:
        s['pinnedVehicleId'] = 'van0'
    res = run(p)
    [u] = res['unassigned']
    assert u['code'] == 'PINNED_ASSIGNMENT_INFEASIBLE' and u['detail']['failed'] == ['not_scheduled']


# --- contract ------------------------------------------------------------------------------------------------------

@pytest.mark.parametrize('patch, msg', [
    ({'options': {'weights': {'time': 1, 'rideTime': -1}}}, 'rideTime must be >= 0'),
    ({'options': {'weights': {'vehicle': 1, 'rideTime': 1}}}, 'rideTime needs trip.direction'),
    ({'detourGuard': {'ratio': 1.5, 'costPerS': 1}}, 'detourGuard belongs in trip'),
    ({'options': {'detourGuard': {'ratio': 1.5, 'costPerS': 1}}}, 'detourGuard belongs in trip'),
    ({'trip': IN(detourGuard={'ratio': 0.9, 'costPerS': 1})}, 'ratio must be >= 1'),
    ({'trip': IN(detourGuard={'ratio': 1.5})}, 'costPerS is required'),
    ({'trip': IN(detourGuard={'ratio': 1.5, 'costPerS': 0})}, 'costPerS must be > 0'),
    ({'trip': IN(detourGuard={'extraS': -5, 'costPerS': 1})}, 'extraS must be >= 0'),
    ({'trip': IN(detourGuard=[1.5])}, 'detourGuard must be an object'),
])
def test_strategy_invalid_input(patch, msg):
    base = {'matrix': grid([(0, 0), (1, 0)]), 'vehicles': [{'id': 'v'}], 'stops': [{'id': 's', 'locationIndex': 1}]}
    res = solve({**base, **patch})
    assert res['status'] == 'INVALID_INPUT' and msg in res['error'], res


def test_verify_checks_reported_ride_and_detour():
    res = run(trip_problem(FIVE, IN(window=(3000, 3600)), 1, BALANCED, GUARD))
    p = trip_problem(FIVE, IN(window=(3000, 3600)), 1, BALANCED, GUARD)
    bad = {**res, 'routes': [{**res['routes'][0], 'stops': [{**res['routes'][0]['stops'][0], 'directS': 1}]
                              + res['routes'][0]['stops'][1:]}]}
    assert any('directS' in v for v in verify(p, bad))
