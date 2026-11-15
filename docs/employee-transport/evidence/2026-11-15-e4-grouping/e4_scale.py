"""E4 review: solver scale on a SYNTHETIC city matrix (not a road network). Each solve in its own process, peak RSS sampled.

Synthetic city: office at the centre of a 30 x 30 km area, homes uniformly random (seeded), road distance = straight
line x 1.35 (detour factor), speed 22 km/h urban average + 45 s per leg (turns, signals). Problem shape = the API's
(contract v2, trip IN, default weights vehicle 7200 / time 1, depot start, maxRide given), service 60 s per pickup.
"""
import json
import math
import random
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(sys.argv[1])


def build(n, vehicles, max_ride, seed=7):
    rnd = random.Random(seed)
    pts = [(0.0, 0.0), (-6.0, 4.0)] + [(rnd.uniform(-15, 15), rnd.uniform(-15, 15)) for _ in range(n)]
    m = len(pts)
    dur = [[0] * m for _ in range(m)]
    dist = [[0] * m for _ in range(m)]
    for i in range(m):
        for j in range(m):
            if i != j:
                km = math.dist(pts[i], pts[j]) * 1.35
                dist[i][j] = round(km * 1000)
                dur[i][j] = round(45 + km / 22 * 3600)
    return {
        'schemaVersion': 2,
        'matrix': {'durationsS': dur, 'distancesM': dist},
        'vehicles': [{'id': f'v{k + 1}', 'startIndex': 1, 'endIndex': 0, 'capacity': cap} for k, cap in enumerate(vehicles)],
        'stops': [{'id': f's{k + 1}', 'locationIndex': 2 + k, 'demand': 1, 'serviceS': 60, 'priority': 1} for k in range(n)],
        'horizonS': 86400,
        'trip': {'direction': 'IN', 'siteIndex': 0, 'siteWindow': [9000, 10800], **({'maxRideS': max_ride} if max_ride else {})},
        'options': {'weights': {'vehicle': 7200, 'distance': 0, 'time': 1, 'routeDuration': 0}},
    }


CHILD = r'''
import json, sys, time
sys.path.insert(0, sys.argv[1])
from optimizer.solver import solve
p = json.loads(sys.stdin.read())
t = time.perf_counter(); r = solve(p); w = time.perf_counter() - t
b = r.get('objectiveBreakdown') or {}
rides = [s.get('rideS', 0) for x in r.get('routes', []) for s in x['stops']]
print(json.dumps({'status': r['status'], 'solver': r.get('solverStatus'), 'wall': round(w, 2), 'vehicles': b.get('vehiclesUsed'),
                  'driveMin': round((b.get('totalDurationS') or 0) / 60), 'km': round((b.get('totalDistanceM') or 0) / 1000, 1),
                  'unassigned': len(r.get('unassigned', [])), 'maxRideMin': round(max(rides, default=0) / 60),
                  'objective': r.get('objective'), 'codes': sorted({u.get('code') for u in r.get('unassigned', [])})}))
'''


def run(problem):
    import psutil
    proc = subprocess.Popen([sys.executable, '-c', CHILD, str(REPO / 'services' / 'routing-optimizer')], stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    ps = psutil.Process(proc.pid)
    proc.stdin.write(json.dumps(problem)); proc.stdin.close()
    peak = 0
    while proc.poll() is None:
        try:
            peak = max(peak, ps.memory_info().rss)
        except psutil.Error:
            pass
        time.sleep(0.05)
    out = proc.stdout.read().strip().splitlines()
    if not out:
        return {'error': proc.stderr.read()[-500:]}
    res = json.loads(out[-1])
    res['peakMB'] = round(peak / 2**20)
    return res


def main():
    rows = []
    for n in (10, 25, 50, 75):
        fleet = [7] * min(20, math.ceil(n / 5) + 2)
        for limit in ((10, 30, 60) if n == 75 else (10, 30)):
            for max_ride in ((3600, None) if limit != 60 else (3600,)):
                p = build(n, fleet, max_ride)
                p['options']['timeLimitS'] = limit
                r = run(p)
                row = {'pax': n, 'fleet': f'{len(fleet)}x7', 'timeLimitS': limit, 'maxRideMin': max_ride // 60 if max_ride else None, **r}
                rows.append(row)
                print(json.dumps(row), flush=True)
    # Deterministic mode (greedy descent, stops at a local optimum) for comparison: what it costs in quality / time.
    for n in (25, 75):
        fleet = [7] * min(20, math.ceil(n / 5) + 2)
        p = build(n, fleet, 3600)
        p['options'].update({'timeLimitS': 60, 'deterministic': True})
        r = run(p)
        row = {'pax': n, 'fleet': f'{len(fleet)}x7', 'timeLimitS': 60, 'maxRideMin': 60, 'mode': 'deterministic', **r}
        rows.append(row)
        print(json.dumps(row), flush=True)
    Path(sys.argv[2]).write_text(json.dumps(rows, indent=1))


if __name__ == '__main__':
    main()
