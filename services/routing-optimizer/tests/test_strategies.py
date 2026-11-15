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


# --- review fixes (H1, M1, M2, L1-L3) -------------------------------------------------------------------------------

STRATEGY_VARIANTS = {'rideTime': ({'rideTime': 1}, None), 'guard': ({}, GUARD), 'both': ({'rideTime': 1}, GUARD)}


H1_DUR = [[0, 234, 448, 548, 272, 540, 448], [234, 0, 682, 781, 221, 773, 682], [448, 682, 0, 99, 720, 131, 364],
          [548, 781, 99, 0, 819, 95, 400], [272, 221, 720, 819, 0, 811, 720], [540, 773, 131, 95, 811, 0, 495],
          [448, 682, 364, 400, 720, 495, 0]]


@pytest.mark.parametrize('variant', sorted(STRATEGY_VARIANTS))
def test_h1_waiting_window_does_not_lose_the_first_solution(variant):
    """Review H1 minimised repro (SYNTHETIC matrix from the QA probe): OUT, one 7-seater with open start / end, p2's
    window forces a long wait. With soft bounds on the slack-tied Ride dimension every stop came back
    TIME_LIMIT{unusedVehicles} and no route; without the strategy fields all four are served."""
    extra_w, guard = STRATEGY_VARIANTS[variant]
    trip = OUT(window=(3600, 4200), **({'detourGuard': guard} if guard else {}))
    p = {'schemaVersion': 2, 'matrix': {'durationsS': H1_DUR}, 'trip': trip,
         'vehicles': [{'id': 'v1', 'startIndex': None, 'endIndex': None, 'capacity': 7}],
         'stops': [{'id': 'p1', 'locationIndex': 1, 'demand': 1, 'serviceS': 60},
                   {'id': 'p2', 'locationIndex': 2, 'demand': 2, 'serviceS': 60, 'timeWindows': [[5632, 5954]]},
                   {'id': 'p3', 'locationIndex': 3, 'demand': 2, 'serviceS': 60},
                   {'id': 'p4', 'locationIndex': 4, 'demand': 2, 'serviceS': 60}],
         'options': {'timeLimitS': 1, 'deterministic': True, 'weights': {'vehicle': 1800, 'time': 1, **extra_w}}}
    res = run(p)
    assert res['unassigned'] == [] and len(res['routes'][0]['stops']) == 4


def _random_case(seed):
    import random
    rng = random.Random(seed)
    direction = 'IN' if seed % 2 else 'OUT'
    pts = [(0, 0)] + [(rng.uniform(-6, 6), rng.uniform(-6, 6)) for _ in range(7)]
    trip = IN(window=(6000, 6600)) if direction == 'IN' else OUT(window=(3600, 4200))
    p = trip_problem(pts, trip, 2, dict(DEFAULT))
    for st in p['stops']:
        if rng.random() < 0.5:                                           # narrow windows that force waits
            centre = rng.randrange(4000, 6000) if direction == 'IN' else rng.randrange(3800, 6500)
            st['timeWindows'] = [[centre, centre + rng.randrange(20, 300)]]
    return p


@pytest.mark.parametrize('seed', range(30))
def test_strategy_costs_never_change_who_is_served(seed):
    """Seeded random IN / OUT cases with narrow stop windows: rideTime, guard or both serve as many passengers as the
    same problem without them (soft costs never drop anyone). When drops are forced, WHICH passenger is left out is
    a tie between equal penalties and may differ, so the count is compared; no search-limit code may appear."""
    p = _random_case(seed)
    served = lambda res: sum(len(r['stops']) for r in res['routes'])  # noqa: E731
    base = served(run(p))
    for name, (extra_w, guard) in STRATEGY_VARIANTS.items():
        q = {**p, 'trip': {**p['trip'], **({'detourGuard': guard} if guard else {})},
             'options': {**p['options'], 'weights': {**p['options']['weights'], **extra_w}}}
        res = run(q)
        assert served(res) == base, name
        assert not {u['code'] for u in res['unassigned']} & {'TIME_LIMIT', 'NOT_SCHEDULED'}, (name, res['unassigned'])


def test_retry_safety_net_prefers_more_served():
    from optimizer.solver import _better, _needs_retry
    a = {'status': 'FEASIBLE', 'objective': 10, 'routes': [], 'stats': {},
         'unassigned': [{'stopId': 's', 'code': 'TIME_LIMIT'}]}
    b = {'status': 'FEASIBLE', 'objective': 99, 'routes': [{'stops': [{'stopId': 's'}]}], 'unassigned': [],
         'stats': {'firstSolution': 'parallel_cheapest_insertion'}}
    ctx = validate(trip_problem(FIVE, IN(), 1, BALANCED))
    assert _needs_retry(ctx, a) and not _needs_retry(validate(trip_problem(FIVE, IN(), 1, DEFAULT)), a)
    kept = _better(a, b)
    assert kept is b and kept['stats']['retry'] == {'firstSolution': 'parallel_cheapest_insertion', 'used': True}
    assert _better(b, {**a, 'stats': {'firstSolution': 'x'}}) is b                 # fewer served: never kept


def test_fractional_weights_are_scaled_not_rounded():
    trip = IN(window=(5000, 6000))
    half = run(trip_problem(FAR, trip, 1, {'time': 1, 'rideTime': 0.5}))
    one = run(trip_problem(FAR, trip, 1, {'time': 1, 'rideTime': 1}))
    assert half['stats']['costScale'] == 100 and 'costScale' not in one['stats']
    if half['routes'][0]['stops'] == one['routes'][0]['stops']:
        assert abs(2 * half['objectiveBreakdown']['rideTimeCost'] - one['objectiveBreakdown']['rideTimeCost']) <= 1
    guard = run(trip_problem(TWO_DIR, trip, 1, DEFAULT, {'ratio': 1, 'costPerS': 0.25}))
    assert guard['unassigned'] == [] and guard['objectiveBreakdown']['detourCost'] > 0


def test_classifier_budget_checked_inside_the_position_loop():
    """Review M1: one vehicle, 400 stops on board, 10 windows each, every insertion fails late (max duration)."""
    import time
    n = 401
    dur = [[abs(i - j) for j in range(n)] for i in range(n)]
    wins = [[k * 100, k * 100 + 50] for k in range(10)]
    p = {'matrix': {'durationsS': dur}, 'horizonS': 10**6, 'vehicles': [{'id': 'v', 'startIndex': 0, 'maxDurationS': 1}],
         'stops': [{'id': f's{i}', 'locationIndex': i, 'demand': 1, 'timeWindows': wins} for i in range(1, n)]}
    route = {'vehicleId': 'v', 'stops': [{'stopId': f's{i}'} for i in range(1, n - 1)]}
    cls, st = _classifier(p, [route], hit_limit=False)
    cls.deadline = time.perf_counter() + 0.05
    t = time.perf_counter()
    code, detail = cls.classify(st[f's{n - 1}'])
    assert time.perf_counter() - t < 0.5
    assert code == 'NOT_SCHEDULED' and 'unknown' in detail['binding']             # review L1: not FLEET_TOO_SMALL


def test_null_ratio_and_extra_mean_defaults():
    res = run(trip_problem(FIVE, IN(), 1, DEFAULT, {'ratio': None, 'extraS': None, 'costPerS': 1}))
    assert res['unassigned'] == []


@pytest.mark.parametrize('patch, msg', [
    ({'options': {'weights': {'time': 1, 'rideTime': 1e5}}}, 'rideTime must be <='),
    ({'trip': IN(detourGuard={'costPerS': 1e5})}, 'costPerS must be <='),
    ({'trip': IN(detourGuard={'ratio': 11, 'costPerS': 1})}, 'ratio must be >= 1 and <= 10'),
    ({'trip': IN(detourGuard={'extraS': 10**6, 'costPerS': 1})}, 'extraS must be <= horizonS'),
    ({'stops': [{'id': 's', 'locationIndex': 1, 'timeWindows': [[k, k] for k in range(11)]}]}, 'at most 10 timeWindows'),
    ({'stops': [{'id': 's', 'locationIndex': 1, 'priority': 10**15}]}, 'too large'),
    ({'vehicles': [{'id': 'v', 'fixedCost': 1e30}]}, 'too large'),
    ({'options': {'weights': {'time': 1e30}}}, 'too large'),
])
def test_bounds_and_overflow_are_invalid_input(patch, msg):
    base = {'matrix': grid([(0, 0), (1, 0)]), 'vehicles': [{'id': 'v'}], 'stops': [{'id': 's', 'locationIndex': 1}],
            'options': {'timeLimitS': 1}}
    res = solve({**base, **patch})
    assert res['status'] == 'INVALID_INPUT' and msg in res['error'], res
