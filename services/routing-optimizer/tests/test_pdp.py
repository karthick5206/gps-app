"""Contract v3 mode "pdp" (doc 20 §4): on-demand pooling, multi-trip vehicles, live insertion.

All data is SYNTHETIC: a 20 x 20 km city, straight line x 1.35 at 25 km/h + 30 s per leg (the prototype's matrix,
evidence/2026-11-15-pooling). Every result is re-checked by the independent `verify_pdp`.
"""
import math
import random

import pytest

from optimizer import solve, verify

OPT = {'timeLimitS': 2}


class City:
    """Points -> matrix. `add(point)` returns the location index."""

    def __init__(self):
        self.pts = []

    def add(self, p):
        self.pts.append(p)
        return len(self.pts) - 1

    def matrix(self):
        dur, dist = [], []
        for a in self.pts:
            rd, rs = [], []
            for b in self.pts:
                km = math.dist(a, b) * 1.35
                rd.append(0 if km == 0 else round(30 + km / 25 * 3600))
                rs.append(round(km * 1000))
            dur.append(rd)
            dist.append(rs)
        return {'durationsS': dur, 'distancesM': dist}


def req(c, rid, pick, drop, t, pref='SHARED', window=900, **kw):
    return {'id': rid, 'pickupIndex': c.add(pick), 'dropIndex': c.add(drop), 'passengers': 1, 'preference': pref,
            'pickupWindow': [t, t + window], 'detour': {'ratio': 1.8, 'extraS': 900}, **kw}


def veh(c, vid, pos, cap=7, **kw):
    return {'id': vid, 'startIndex': c.add(pos), 'capacity': cap, 'turnaroundS': 120, **kw}


def problem(c, vehicles, requests, **opts):
    return {'schemaVersion': 3, 'mode': 'pdp', 'horizonS': 6 * 3600, 'matrix': c.matrix(), 'vehicles': vehicles,
            'requests': requests, 'options': {**OPT, **opts}}


def run(pb):
    res = solve(pb)
    assert res['status'] in ('FEASIBLE', 'COMMITMENT_VIOLATION'), res
    assert verify(pb, res) == []
    return res


def trips(res):
    return [(r['vehicleId'], t) for r in res['routes'] for t in r['trips']]


def trip_of(res, rid):
    return next((v, t) for v, t in trips(res) if rid in t['requestIds'])


def info(res, rid):
    return next(x for x in res['requests'] if x['requestId'] == rid)


HUBS = [(4, 4), (16, 5), (10, 16)]        # e.g. station, office park, mall


def random_city(n, n_veh, seed, mix=(0.6, 0.2, 0.2), horizon=4 * 3600, hub_share=0.0):
    """n requests over `horizon`; `hub_share` of them start near a hub (sd 0.8 km) and end anywhere."""
    rnd = random.Random(seed)
    c = City()
    vehicles = [veh(c, f'v{k + 1}', (rnd.uniform(0, 20), rnd.uniform(0, 20))) for k in range(n_veh)]
    requests = []
    for k in range(n):
        u = rnd.random()
        pref = 'SHARED' if u < mix[0] else 'PRIVATE' if u < mix[0] + mix[1] else 'FLEXIBLE'
        if rnd.random() < hub_share:
            h = rnd.choice(HUBS)
            a = (min(20, max(0, rnd.gauss(h[0], 0.8))), min(20, max(0, rnd.gauss(h[1], 0.8))))
        else:
            a = (rnd.uniform(0, 20), rnd.uniform(0, 20))
        b = (rnd.uniform(0, 20), rnd.uniform(0, 20))
        while math.dist(a, b) < 2:
            b = (rnd.uniform(0, 20), rnd.uniform(0, 20))
        requests.append(req(c, f'r{k + 1}', a, b, rnd.randrange(900, horizon), pref))
    return c, vehicles, requests


# --- pooling ------------------------------------------------------------------------------------------------------

def test_different_destinations_pooled_when_compatible():
    """Three riders from neighbouring pickups to three different drops along one corridor share one vehicle."""
    c = City()
    rs = [req(c, f'a{k}', (2 + 0.2 * k, 10), (12 + 2 * k, 10.5 + 0.3 * k), 1800) for k in range(3)]
    res = run(problem(c, [veh(c, 'v1', (1, 10)), veh(c, 'v2', (19, 1))], rs))
    assert res['unserved'] == []
    _, t = trip_of(res, 'a0')
    assert set(t['requestIds']) == {'a0', 'a1', 'a2'} and t['shared'] and t['peakLoad'] == 3
    assert len({st['locationIndex'] for st in t['stops'] if st['kind'] == 'DROP'}) == 3
    assert all(info(res, r)['servedAs'] == 'SHARED' for r in ('a0', 'a1', 'a2'))


def test_incompatible_directions_separated():
    """Same area and time, three to the far north-east and three to the far south-west: never one trip."""
    c = City()
    rs = [req(c, f'ne{k}', (10 + 0.3 * k, 10), (19 - 0.4 * k, 19), 3600, detour={'ratio': 1.5, 'extraS': 600})
          for k in range(3)]
    rs += [req(c, f'sw{k}', (10 - 0.3 * k, 10), (1 + 0.4 * k, 1), 3600, detour={'ratio': 1.5, 'extraS': 600})
           for k in range(3)]
    res = run(problem(c, [veh(c, 'v1', (10, 9)), veh(c, 'v2', (10, 11))], rs))
    assert res['unserved'] == []
    for _, t in trips(res):
        groups = {r[:2] for r in t['requestIds']}
        assert len(groups) == 1, t['requestIds']


def test_private_exclusive_for_the_whole_trip():
    """A PRIVATE rider on the same corridor as two shared riders: alone on its trip, and nobody rides before or after
    within that trip; the shared riders pool."""
    c = City()
    rs = [req(c, 's1', (2, 10), (14, 10), 1800), req(c, 's2', (2.3, 10), (15, 10.2), 1800),
          req(c, 'p1', (2.1, 10.1), (14.5, 10.1), 1800, 'PRIVATE')]
    res = run(problem(c, [veh(c, 'v1', (1, 10)), veh(c, 'v2', (1, 10.5))], rs))
    assert res['unserved'] == []
    _, t = trip_of(res, 'p1')
    assert t['requestIds'] == ['p1'] and not t['shared']
    assert info(res, 'p1')['servedAs'] == 'PRIVATE'
    _, ts = trip_of(res, 's1')
    assert set(ts['requestIds']) == {'s1', 's2'}


def test_flexible_shared_or_alone():
    c = City()
    rs = [req(c, 'f1', (2, 10), (14, 10), 1800, 'FLEXIBLE'), req(c, 's1', (2.2, 10), (14.5, 10), 1800),
          req(c, 'f2', (18, 2), (18, 15), 1800, 'FLEXIBLE')]           # f2 far away, alone
    res = run(problem(c, [veh(c, 'v1', (1, 10)), veh(c, 'v2', (18, 1))], rs))
    assert res['unserved'] == []
    assert info(res, 'f1')['servedAs'] == 'SHARED' and trip_of(res, 'f1')[1]['shared']
    assert info(res, 'f2')['servedAs'] == 'PRIVATE' and trip_of(res, 'f2')[1]['requestIds'] == ['f2']


@pytest.mark.parametrize('seed', [1, 2])
def test_precedence_and_capacity_never_violated(seed):
    """Small vehicles (3 seats), groups of 1-2, mixed preferences: the independent checker finds nothing, and the
    checker itself catches a tampered result."""
    c, vs, rs = random_city(24, 3, seed)
    for v in vs:
        v['capacity'] = 3
    for k, r in enumerate(rs):
        r['passengers'] = 1 + (k % 3 == 0)
    pb = problem(c, vs, rs)
    res = run(pb)
    assert res['metrics']['served'] >= 8
    # tamper: swap the first trip's pickup and drop of one request -> precedence violation is detected
    t = next(t for _, t in trips(res) if len(t['stops']) >= 2)
    t['stops'][0], t['stops'][-1] = t['stops'][-1], t['stops'][0]
    assert verify(pb, res)


def test_multi_trip_vehicle_with_turnaround():
    """One vehicle, two requests, the second after the first can be dropped: two sequential trips; the second pickup starts only after the
    first drop + repositioning travel + turnaround."""
    c = City()
    rs = [req(c, 'r1', (2, 2), (10, 2), 1800, window=600), req(c, 'r2', (10.5, 3), (18, 10), 6000, window=900)]
    pb = problem(c, [veh(c, 'v1', (1, 2), turnaroundS=300)], rs)
    res = run(pb)
    assert res['unserved'] == []
    (route,) = res['routes']
    assert len(route['trips']) == 2
    t1, t2 = route['trips']
    drop1, pick2 = t1['stops'][-1], t2['stops'][0]
    leg = pb['matrix']['durationsS'][drop1['locationIndex']][pick2['locationIndex']]
    assert t2['turnaroundS'] == 300
    assert pick2['startS'] >= drop1['departureS'] + leg + 300


def test_live_insertion_respects_commitments():
    """Live: v1 carries an onboard rider and has a committed pickup; a new compatible request is inserted without
    moving any committed passenger; a far PRIVATE request that would break the commitments is rejected with a
    reason, and the committed plan stays as it was."""
    c = City()
    v1 = veh(c, 'v1', (6.5, 10), availableFromS=3600)
    onb_drop = c.add((12, 10))
    v1['onboard'] = [{'requestId': 'ob1', 'dropIndex': onb_drop, 'dropByS': 3600 + 1800}]
    committed = req(c, 'c1', (8, 10.2), (15, 10), 3900, window=900, committed={'vehicleId': 'v1',
                                                                               'pickupWindow': [3900, 4500]})
    new = req(c, 'n1', (7, 10.1), (13, 10.1), 3700, window=900)
    far = req(c, 'pf', (1, 19), (19, 1), 3700, 'PRIVATE', window=300)
    warm = {'v1': ['P:c1', 'D:ob1', 'D:c1']}
    for insert_only in (False, True):
        pb = problem(c, [v1], [committed, new, far], warmStart=warm, insertOnly=insert_only)
        res = run(pb)
        assert res['status'] == 'FEASIBLE' and res['commitmentViolations'] == []
        assert info(res, 'c1')['vehicleId'] == 'v1'
        assert info(res, 'ob1')['dropS'] <= 3600 + 1800
        assert 3900 <= info(res, 'c1')['pickupS'] <= 4500
        assert info(res, 'n1')['vehicleId'] == 'v1'
        (u,) = res['unserved']
        assert u['requestId'] == 'pf' and u['code'] in ('PICKUP_WINDOW', 'PRIVATE_NEEDS_EMPTY_VEHICLE', 'MAX_RIDE')


def test_commitment_that_cannot_be_kept_fails_the_job():
    c = City()
    v1 = veh(c, 'v1', (1, 1), availableFromS=3600)
    # committed pickup 20 km away within 2 minutes: impossible -> COMMITMENT_VIOLATION, never silently dropped
    bad = req(c, 'c1', (19, 19), (19, 10), 3600, window=120, committed={'vehicleId': 'v1'})
    res = run(problem(c, [v1], [bad]))
    assert res['status'] == 'COMMITMENT_VIOLATION'
    assert [x['requestId'] for x in res['commitmentViolations']] == ['c1']


def test_insert_only_fast_path():
    c, vs, rs = random_city(30, 3, 7)
    base = run(problem(c, vs, rs))
    warm = {r['vehicleId']: [('P:' if st['kind'] == 'PICKUP' else 'D:') + st['requestId']
                             for t in r['trips'] for st in t['stops']] for r in base['routes']}
    c2 = City()
    c2.pts = list(c.pts)
    new = req(c2, 'NEW', c.pts[rs[0]['pickupIndex']], c.pts[rs[0]['dropIndex']],
              rs[0]['pickupWindow'][0] + 60, 'SHARED')
    pb = problem(c2, vs, rs + [new], warmStart=warm, insertOnly=True)
    res = run(pb)
    assert res['solverStatus'] == 'INSERT_ONLY' and res['stats']['warmStart'] == 'used'
    assert res['stats']['insertMs'] < 2000
    # the planned requests keep their vehicles and relative order (no re-sequencing)
    for r in res['routes']:
        seq = [('P:' if st['kind'] == 'PICKUP' else 'D:') + st['requestId'] for t in r['trips'] for st in t['stops']]
        assert [x for x in seq if x[2:] != 'NEW' and x[2:] in {y[2:] for y in warm.get(r['vehicleId'], [])}] == \
            warm.get(r['vehicleId'], [])


def test_infeasible_request_gets_explicit_reason():
    c = City()
    rs = [req(c, 'wide', (2, 2), (4, 4), 1800, passengers=9),                       # 9 seats > 7
          req(c, 'late', (19, 19), (18, 18), 0, window=60),                         # unreachable in 60 s
          req(c, 'ride', (1, 1), (19, 19), 1800, maxRideS=600, detour=None),        # direct ride > max ride
          req(c, 'ok', (2, 1), (5, 1), 1800)]
    res = run(problem(c, [veh(c, 'v1', (1, 1), availableFromS=0)], rs))
    codes = {u['requestId']: u['code'] for u in res['unserved']}
    assert codes == {'wide': 'NO_COMPATIBLE_VEHICLE', 'late': 'PICKUP_WINDOW', 'ride': 'MAX_RIDE'}
    assert info(res, 'ok')['vehicleId'] == 'v1'


def test_acceptance_50_requests_2_vehicles():
    """Acceptance case 1 (doc 20 §9 #1): 50 requests over 4 h (half of them leave from three hubs), 2 seven-seaters
    with a driver break and a 5 h span: feasible pooled groups and several sequential trips per vehicle; every unserved
    request has a reason."""
    c, vs, rs = random_city(50, 2, 3, hub_share=0.5)
    for v in vs:
        v['breaks'] = [{'earliestS': 2 * 3600, 'latestS': 3 * 3600, 'durationS': 1200}]
        v['maxSpanS'] = 5 * 3600
    res = run(problem(c, vs, rs, timeLimitS=5))
    m = res['metrics']
    assert m['served'] >= 8 and len(res['routes']) == 2
    assert all(len(r['trips']) >= 2 for r in res['routes']) and m['trips'] >= 6
    assert any(t['shared'] and t['peakLoad'] >= 2 for _, t in trips(res))
    assert len(res['unserved']) == 50 - m['served'] and all(u['code'] for u in res['unserved'])
    # PRIVATE riders are not starved (priority 3 vs 1): some are in the plan, each alone on its trip
    assert any(x['servedAs'] == 'PRIVATE' for x in res['requests'])


# --- review regressions -------------------------------------------------------------------------------------------

def _flat(n=5, leg=100):
    return {'durationsS': [[0 if i == j else leg for j in range(n)] for i in range(n)]}


@pytest.mark.parametrize('opts', [{'insertOnly': True, 'warmStart': {'v1': ['P:A', 'D:A']}}, {'timeLimitS': 1}],
                         ids=['insertOnly', 'batch'])
def test_insertion_before_first_stop_rechecks_span(opts):
    """Inserting B (t=1000) before A (t=5000) would make the span 4290 > maxSpanS 3000: never accepted."""
    pb = {'schemaVersion': 3, 'mode': 'pdp', 'horizonS': 20000, 'matrix': _flat(),
          'vehicles': [{'id': 'v1', 'startIndex': 0, 'capacity': 4, 'maxSpanS': 3000}],
          'requests': [{'id': 'A', 'pickupIndex': 1, 'dropIndex': 2, 'pickupWindow': [5000, 5000]},
                       {'id': 'B', 'pickupIndex': 3, 'dropIndex': 4, 'pickupWindow': [1000, 1000]}],
          'options': opts}
    res = run(pb)
    assert [(u['requestId'], u['code']) for u in res['unserved']] == [('B', 'DRIVER_HOURS')]


def test_every_vehicle_with_end_index():
    pb = {'schemaVersion': 3, 'mode': 'pdp', 'matrix': _flat(3),
          'vehicles': [{'id': 'v', 'startIndex': 0, 'endIndex': 0, 'capacity': 2}],
          'requests': [{'id': 'a', 'pickupIndex': 1, 'dropIndex': 2, 'pickupWindow': [0, 3600]}],
          'options': {'timeLimitS': 1}}
    res = run(pb)
    assert res['status'] == 'FEASIBLE' and res['unserved'] == [] and res['routes'][0]['endS'] >= 200


def test_insert_only_respects_time_limit():
    rnd = random.Random(1)
    n = 60
    m = {'durationsS': [[0 if i == j else rnd.randint(30, 90) for j in range(n)] for i in range(n)]}
    reqs = []
    for k in range(250):
        p = rnd.randrange(n)
        reqs.append({'id': f'r{k}', 'pickupIndex': p, 'dropIndex': (p + 1 + rnd.randrange(n - 1)) % n,
                     'pickupWindow': [0, 7 * 86400], 'pickupServiceS': 0, 'dropServiceS': 0})
    pb = {'schemaVersion': 3, 'mode': 'pdp', 'horizonS': 7 * 86400, 'matrix': m,
          'vehicles': [{'id': 'v0', 'startIndex': 0, 'capacity': 100}], 'requests': reqs,
          'options': {'insertOnly': True, 'timeLimitS': 1}}
    res = run(pb)
    assert res['stats']['wallTimeMs'] < 5000 and res['stats']['timedOut']
    assert len(res['unserved']) + res['metrics']['served'] == 250
    assert all(u['code'] == 'NOT_SELECTED' for u in res['unserved'])


def test_many_turnaround_values_share_few_matrices():
    c, vs, rs = random_city(12, 5, 4)
    for k, v in enumerate(vs):
        v['turnaroundS'] = 60 + 37 * k                    # 5 distinct values -> at most 3 buckets (rounded up)
    res = run(problem(c, vs, rs))
    assert len(res['stats']['turnaroundBuckets']) <= 3


@pytest.mark.parametrize('opt', ['strategy', 'firstSolution', 'localSearch'])
def test_unhashable_options_are_invalid_input(opt):
    c = City()
    res = solve(problem(c, [veh(c, 'v1', (1, 1))], [req(c, 'a', (2, 2), (5, 5), 100)], **{opt: ['x']}))
    assert res['status'] == 'INVALID_INPUT'
