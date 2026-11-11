"""Optimizer unit tests: synthetic matrices, no network."""
import json
import os
import subprocess
import sys

import pytest

from optimizer import solve

HERE = os.path.dirname(__file__)


def grid_matrix(points, speed_mps=10):
    """Manhattan-distance matrix in metres (points in km on a grid) and seconds at speed_mps."""
    dist = [[round((abs(a[0] - b[0]) + abs(a[1] - b[1])) * 1000) for b in points] for a in points]
    return {'distancesM': dist, 'durationsS': [[round(d / speed_mps) for d in row] for row in dist]}


def test_single_vehicle_visits_all_in_sensible_order():
    pts = [(0, 0), (1, 0), (2, 0), (3, 0), (4, 0)]
    res = solve({
        'matrix': grid_matrix(pts),
        'vehicles': [{'id': 'v1', 'startIndex': 0, 'endIndex': 0, 'capacity': 10}],
        'stops': [{'id': f's{i}', 'locationIndex': i, 'demand': 1, 'serviceS': 60} for i in (3, 1, 4, 2)],
        'options': {'timeLimitS': 1},
    })
    assert res['status'] in ('FEASIBLE', 'OPTIMAL')
    assert res['unassigned'] == []
    [route] = res['routes']
    seq = [s['stopId'] for s in route['stops']]
    assert seq in (['s1', 's2', 's3', 's4'], ['s4', 's3', 's2', 's1'])
    assert route['distanceM'] == 8000
    # ETAs are monotonic and include service time: 4 legs of 100 s + 4 x 60 s service + 400 s return.
    assert route['durationS'] == 8000 / 10 + 4 * 60
    arrivals = [s['arrivalS'] for s in route['stops']]
    assert arrivals == sorted(arrivals)
    assert route['locationSequence'][0] == 0 and route['locationSequence'][-1] == 0


def test_capacity_splits_across_two_vehicles():
    pts = [(0, 0), (1, 1), (1, -1), (-1, 1), (-1, -1)]
    res = solve({
        'matrix': grid_matrix(pts),
        'vehicles': [{'id': 'a', 'capacity': 2}, {'id': 'b', 'capacity': 2}],
        'stops': [{'id': f's{i}', 'locationIndex': i, 'demand': 1} for i in range(1, 5)],
        'options': {'timeLimitS': 1},
    })
    assert res['status'] == 'FEASIBLE' or res['status'] == 'OPTIMAL'
    assert res['unassigned'] == []
    assert sorted(len(r['stops']) for r in res['routes']) == [2, 2]
    assert all(r['load'] <= 2 for r in res['routes'])


def test_time_windows_are_respected_and_waiting_reported():
    pts = [(0, 0), (1, 0), (2, 0)]
    res = solve({
        'matrix': grid_matrix(pts),
        'vehicles': [{'id': 'v', 'timeWindow': [0, 7200]}],
        # s2 must be served late, s1 early: forces order s1 -> s2 and a wait before s2.
        'stops': [{'id': 's2', 'locationIndex': 2, 'timeWindows': [[3000, 3600]], 'serviceS': 120},
                  {'id': 's1', 'locationIndex': 1, 'timeWindows': [[0, 600]], 'serviceS': 120}],
        'options': {'timeLimitS': 1},
    })
    [route] = res['routes']
    s1, s2 = route['stops']
    assert (s1['stopId'], s2['stopId']) == ('s1', 's2')
    assert 0 <= s1['serviceStartS'] <= 600
    assert 3000 <= s2['serviceStartS'] <= 3600
    assert s2['waitS'] > 0


def test_infeasible_time_windows_reported_with_reasons():
    pts = [(0, 0), (5, 0), (1, 0), (2, 0)]
    res = solve({
        'matrix': grid_matrix(pts),   # depot -> idx1 takes 500 s
        'vehicles': [{'id': 'v', 'timeWindow': [0, 3600], 'capacity': 5, 'maxDurationS': 3600}],
        'stops': [
            {'id': 'too-early', 'locationIndex': 1, 'timeWindows': [[0, 100]]},      # cannot arrive before 500 s
            {'id': 'backwards', 'locationIndex': 2, 'timeWindows': [[900, 100]]},    # start > end
            {'id': 'too-heavy', 'locationIndex': 3, 'demand': 9},                    # exceeds every capacity
            {'id': 'ok', 'locationIndex': 3, 'demand': 1},
        ],
        'options': {'timeLimitS': 1},
    })
    reasons = {u['stopId']: u['reason'] for u in res['unassigned']}
    assert reasons == {'too-early': 'time_window_unreachable', 'backwards': 'invalid_time_window',
                       'too-heavy': 'demand_exceeds_vehicle_capacity'}
    assert [s['stopId'] for r in res['routes'] for s in r['stops']] == ['ok']
    assert res['provenOptimal'] is False or res['status'] == 'OPTIMAL'


def test_unreachable_cells_and_competition_for_a_window():
    # Two stops share one tight window that a single vehicle cannot both meet -> one dropped by the solver.
    pts = [(0, 0), (3, 0), (-3, 0)]
    m = grid_matrix(pts)
    res = solve({
        'matrix': m,
        'vehicles': [{'id': 'v', 'timeWindow': [0, 10000]}],
        'stops': [{'id': 'east', 'locationIndex': 1, 'timeWindows': [[300, 400]]},
                  {'id': 'west', 'locationIndex': 2, 'timeWindows': [[300, 400]]}],
        'options': {'timeLimitS': 1},
    })
    assert len(res['unassigned']) == 1
    assert res['unassigned'][0]['reason'] == 'not_scheduled_capacity_or_time'
    # A null cell (no road) makes the stop unreachable before solving.
    m2 = grid_matrix(pts)
    m2['durationsS'][0][2] = None
    m2['durationsS'][2][0] = None
    res2 = solve({'matrix': m2, 'vehicles': [{'id': 'v'}],
                  'stops': [{'id': 'island', 'locationIndex': 2}], 'options': {'timeLimitS': 1}})
    # v2 adds the doc 06 §4.6 code next to the P3 reason (additive).
    assert res2['unassigned'] == [{'stopId': 'island', 'reason': 'unreachable_location', 'code': 'ROUTING_UNAVAILABLE'}]


def test_never_claims_optimal_without_proof():
    pts = [(i % 5, i // 5) for i in range(16)]
    res = solve({'matrix': grid_matrix(pts), 'vehicles': [{'id': 'a'}, {'id': 'b'}],
                 'stops': [{'id': f's{i}', 'locationIndex': i} for i in range(1, 16)], 'options': {'timeLimitS': 1}})
    assert res['status'] in ('FEASIBLE', 'OPTIMAL')
    assert res['provenOptimal'] == (res['status'] == 'OPTIMAL')
    assert res['provenOptimal'] == (res['solverStatus'] == 'ROUTING_OPTIMAL')


@pytest.mark.parametrize('bad, msg', [
    ({'vehicles': [{}], 'stops': []}, 'matrix.durationsS is required'),
    ({'matrix': {'durationsS': [[0, 1]]}, 'vehicles': [{}]}, '1x1'),
    ({'matrix': {'durationsS': [[0]]}, 'vehicles': []}, 'vehicles required'),
    ({'matrix': {'durationsS': [[0]]}, 'vehicles': [{}], 'stops': [{'locationIndex': 4}]}, 'out of range'),
    ({'matrix': {'durationsS': [[0]]}, 'vehicles': [{}], 'stops': [{'id': 'x', 'locationIndex': 0}, {'id': 'x', 'locationIndex': 0}]}, 'duplicate'),
])
def test_invalid_input(bad, msg):
    res = solve(bad)
    assert res['status'] == 'INVALID_INPUT'
    assert msg in res['error']


def test_cli_round_trip(tmp_path):
    p = tmp_path / 'problem.json'
    p.write_text(json.dumps({'matrix': grid_matrix([(0, 0), (1, 0)]), 'vehicles': [{'id': 'v'}],
                             'stops': [{'id': 's', 'locationIndex': 1}], 'options': {'timeLimitS': 1}}))
    out = subprocess.run([sys.executable, '-m', 'optimizer.cli', str(p)], cwd=os.path.dirname(HERE),
                         capture_output=True, text=True, check=True)
    assert json.loads(out.stdout)['routes'][0]['stops'][0]['stopId'] == 's'


def test_cli_without_matrix_is_invalid_input(tmp_path):
    # No engine fallback: a problem with locations but no matrix is refused (exit 2), never fetched or estimated.
    p = tmp_path / 'problem.json'
    p.write_text(json.dumps({'locations': [{'lat': 13.0, 'lng': 80.2}, {'lat': 13.1, 'lng': 80.3}],
                             'vehicles': [{'id': 'v'}], 'stops': [{'id': 's', 'locationIndex': 1}]}))
    out = subprocess.run([sys.executable, '-m', 'optimizer.cli', str(p)], cwd=os.path.dirname(HERE),
                         capture_output=True, text=True)
    assert out.returncode == 2
    assert json.loads(out.stdout)['status'] == 'INVALID_INPUT'


def test_package_has_no_routing_engine_coupling():
    # README §5 D3: the optimiser takes a matrix as input; no Valhalla (or any engine) client lives here.
    root = os.path.join(os.path.dirname(HERE), 'optimizer')
    names = sorted(os.listdir(root))
    assert 'valhalla.py' not in names
    for name in names:
        if name.endswith('.py'):
            with open(os.path.join(root, name), encoding='utf-8') as f:
                src = f.read().lower()
            assert 'valhalla' not in src, name
            assert 'urllib.request' not in src and 'import requests' not in src, name
