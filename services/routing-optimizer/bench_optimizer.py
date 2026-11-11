"""Optimizer timing on synthetic instances (solver only; no routing engine is called).

  python -m bench_optimizer [--matrix matrix.json]

Synthetic matrices use haversine x 1.35 at 25 km/h (urban free-flow-ish) so only the solver is measured. They are a
benchmark input only, never an ETA. With --matrix, a 41x41 matrix built by the API from GraphHopper
({"durationsS": [...], "distancesM": [...]}, index 0 = depot) is also solved with 40 stops and 5 vehicles.
"""
import argparse
import json
import math
import random
import time

from optimizer import solve


def hav_m(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * 6371008.8 * math.asin(math.sqrt(h))


def synth(points):
    d = [[round(hav_m(a, b) * 1.35) for b in points] for a in points]
    return {'distancesM': d, 'durationsS': [[round(x / (25 / 3.6)) for x in r] for r in d]}


def problem(n_stops, n_veh, matrix, rng, windows=True, limit=10):
    stops = []
    for i in range(1, n_stops + 1):
        s = {'id': f's{i}', 'locationIndex': i, 'demand': rng.randint(1, 3), 'serviceS': 300}
        if windows and i % 4 == 0:
            a = rng.randrange(0, 5 * 3600, 900)
            s['timeWindows'] = [[a, a + 2 * 3600]]
        stops.append(s)
    cap = math.ceil(sum(s['demand'] for s in stops) / n_veh * 1.25)
    return {'matrix': matrix, 'vehicles': [{'id': f'v{k}', 'startIndex': 0, 'endIndex': 0, 'capacity': cap, 'timeWindow': [0, 10 * 3600]} for k in range(n_veh)],
            'stops': stops, 'options': {'timeLimitS': limit}}


def run(name, prob):
    t0 = time.perf_counter()
    r = solve(prob)
    wall = time.perf_counter() - t0
    served = sum(len(x['stops']) for x in r['routes'])
    print(json.dumps({'case': name, 'status': r['status'], 'provenOptimal': r['provenOptimal'], 'wallS': round(wall, 2),
                      'served': served, 'unassigned': len(r['unassigned']), 'vehiclesUsed': len(r['routes']),
                      'totalKm': round(sum((x['distanceM'] or 0) for x in r['routes']) / 1000, 1)}))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--matrix', help='JSON file with a 41x41 matrix built from GraphHopper')
    a = ap.parse_args()
    rng = random.Random(11)
    depot = (13.0067, 80.2206)
    if a.matrix:
        with open(a.matrix, encoding='utf-8') as f:
            m = json.load(f)
        print(json.dumps({'case': 'matrix_file', 'size': len(m['durationsS']),
                          'nullCells': sum(v is None for r in m['durationsS'] for v in r)}))
        run('file_40stops_5veh_tw_10s', problem(40, 5, m, rng, limit=10))
        run('file_40stops_5veh_tw_2s', problem(40, 5, m, rng, limit=2))
    for n, v, lim in ((100, 5, 10), (200, 10, 30), (200, 10, 60)):
        pts = [depot] + [(rng.uniform(12.85, 13.20), rng.uniform(80.05, 80.28)) for _ in range(n)]
        run(f'synthetic_{n}stops_{v}veh_tw_{lim}s', problem(n, v, synth(pts), rng, limit=lim))


if __name__ == '__main__':
    main()
