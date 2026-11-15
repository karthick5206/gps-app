"""E4 review harness (inspection only): runs services/routing-optimizer/optimizer/solver.solve on problems shaped exactly like
apps/api/src/routing-jobs/optimize-problem.ts solverProblem() builds them (contract v2, trip IN, default weights)."""
import json
import sys
import time
from pathlib import Path

REPO, OUT = Path(sys.argv[1]), Path(sys.argv[2])
sys.path.insert(0, str(REPO / 'services' / 'routing-optimizer'))
from optimizer.solver import solve  # noqa: E402

HERE = Path(__file__).parent
NAMES = ['Office (Tidel Park)', 'Depot (Saidapet)', 'Adyar', 'Thiruvanmiyur', 'Velachery', 'Perungudi', 'Besant Nagar',
         'Tambaram (far SW)', 'Anna Nagar (north)', 'Kilpauk (north)', 'Sholinganallur (south)']


def real_matrix():
    dur, dist = [], []
    for line in (HERE / 'gh-matrix.txt').read_text().split('\n'):
        if not line.strip():
            continue
        dr, tr = [], []
        for cell in line.split():
            if cell == 'null':
                dr.append(None); tr.append(None)
            else:
                d, t = cell.split(':')
                dr.append(round(float(d))); tr.append(round(float(t) / 1000))
        dur.append(tr); dist.append(dr)
    return dur, dist


# Controlled synthetic matrix: points on a km grid (office at origin), 2 min per km Manhattan + 60 s fixed per leg,
# distance = Manhattan km * 1000. Not a road network.
GRID = {0: (0, 0), 1: (-3, 3), 2: (1, 2), 3: (2, 0), 4: (-2, 0), 5: (0, -2), 6: (2, 2), 7: (-12, -6), 8: (-3, 9),
        9: (0, 9), 10: (-1, -8)}


def synthetic_matrix():
    n = len(GRID)
    dur = [[0] * n for _ in range(n)]
    dist = [[0] * n for _ in range(n)]
    for i in range(n):
        for j in range(n):
            if i != j:
                km = abs(GRID[i][0] - GRID[j][0]) + abs(GRID[i][1] - GRID[j][1])
                dur[i][j], dist[i][j] = 60 + 120 * km, 1000 * km
    return dur, dist


WEIGHTS = {'vehicle': 7200, 'distance': 0, 'time': 1, 'routeDuration': 0}   # defaultWeights('duration')


def problem(mat, pax, vehicles, *, site_window=(5400, 7200), max_ride=3600, depot=False, time_limit=5, pins=None,
            per_stop_ride=None):
    dur, dist = mat
    # API matrix order (planPoints): [site, depot?, ...stops]; here we index straight into the 11-point matrix and
    # sub-select, which is the same as the API building a matrix for exactly these points.
    pts = [0] + ([1] if depot else []) + pax
    sub = lambda m: [[m[a][b] for b in pts] for a in pts]  # noqa: E731
    first = 2 if depot else 1
    stops = []
    for k, loc in enumerate(pax):
        s = {'id': f'p{k + 1}-{NAMES[loc].split(" ")[0]}', 'locationIndex': first + k, 'demand': 1, 'serviceS': 60,
             'priority': 1, 'passengerIds': [f'pax{k + 1}']}
        if pins and loc in pins:
            s['pinnedVehicleId'] = pins[loc]
        if per_stop_ride and loc in per_stop_ride:
            s['maxRideS'] = per_stop_ride[loc]
        stops.append(s)
    return {
        'schemaVersion': 2,
        'matrix': {'durationsS': sub(dur), 'distancesM': sub(dist)},
        'vehicles': [{'id': vid, 'startIndex': 1 if depot else None, 'endIndex': 0, 'capacity': cap} for vid, cap in vehicles],
        'stops': stops,
        'horizonS': 86400,
        'trip': {'direction': 'IN', 'siteIndex': 0, 'siteWindow': list(site_window), **({'maxRideS': max_ride} if max_ride else {})},
        'options': {'timeLimitS': time_limit, 'weights': WEIGHTS},
    }, pts


def summarise(name, kind, prob, pts, res, wall):
    lines = [f'### {name}  [{kind}]']
    lines.append(f"status={res.get('status')} solver={res.get('solverStatus')} wall={wall:.1f}s "
                 f"vehicles used={res.get('objectiveBreakdown', {}).get('vehiclesUsed')} objective={res.get('objective')}")
    for r in res.get('routes', []):
        seq = ' -> '.join(f"{s['stopId']} (ride {s.get('rideS', 0) // 60}m)" for s in r['stops'])
        lines.append(f"  {r['vehicleId']} [{len(r['stops'])}/{r.get('seats')} seats] {seq} -> Office "
                     f"arrive {r.get('siteArrivalS')}s, drive {r['durationS'] // 60} min, {(r.get('distanceM') or 0) / 1000:.1f} km")
    for u in res.get('unassigned', []):
        lines.append(f"  UNASSIGNED {u['stopId']}: {u['reason']} / {u.get('code')} {u.get('detail', '')}")
    if res.get('error'):
        lines.append(f"  ERROR {res['error']}")
    return '\n'.join(lines)


def run(name, kind, mat, pax, vehicles, **kw):
    prob, pts = problem(mat, pax, vehicles, **kw)
    t = time.perf_counter()
    res = solve(prob)
    return summarise(name, kind, prob, pts, res, time.perf_counter() - t), res


def main():
    real, syn = real_matrix(), synthetic_matrix()
    V7 = [('van-A', 7)]
    V7x2 = [('van-A', 7), ('van-B', 7)]
    base = [2, 3, 4, 5, 6]                 # Adyar, Thiruvanmiyur, Velachery, Perungudi, Besant Nagar
    far = [2, 3, 4, 5, 7]                  # Besant Nagar replaced by Tambaram
    two_dir = [3, 5, 10, 8, 9]             # south x3 + north x2
    out, raw = [], {}
    cases = [
        ('S1 base: 5 pax, 1x7-seater, maxRide 60m, arrive 08:30-09:00', 'REAL', real, base, V7, {}),
        ('S1 base', 'SYNTHETIC', syn, base, V7, {}),
        ('S2 far passenger (Tambaram), 1 van, maxRide 60m', 'REAL', real, far, V7, {}),
        ('S2b far passenger, 2 vans, maxRide 60m', 'REAL', real, far, V7x2, {}),
        ('S2c far passenger, 2 vans, maxRide 40m', 'REAL', real, far, V7x2, {'max_ride': 2400}),
        ('S2 far passenger, 2 vans', 'SYNTHETIC', syn, far, V7x2, {}),
        ('S3 two directions (3 south + 2 north), 2 vans, maxRide 60m', 'REAL', real, two_dir, V7x2, {}),
        ('S3b two directions, 2 vans, maxRide 45m', 'REAL', real, two_dir, V7x2, {'max_ride': 2700}),
        ('S3c two directions, 1 van, maxRide 45m', 'REAL', real, two_dir, V7, {'max_ride': 2700}),
        ('S4 second vehicle available (base, 2 vans)', 'REAL', real, base, V7x2, {}),
        ('S5 tight deadline: depot start, arrive within 25 min of plan start, 2 vans', 'REAL', real, base, V7x2,
         {'depot': True, 'site_window': (0, 1500)}),
        ('S5b tight deadline: depot start, within 20 min, 2 vans', 'REAL', real, base, V7x2,
         {'depot': True, 'site_window': (0, 1200)}),
        ('S5c relaxed deadline: depot start, within 60 min, 2 vans', 'REAL', real, base, V7x2,
         {'depot': True, 'site_window': (0, 3600)}),
        ('S6 maxRide 30m (base, 2 vans)', 'REAL', real, base, V7x2, {'max_ride': 1800}),
        ('S6b maxRide 20m (base, 2 vans)', 'REAL', real, base, V7x2, {'max_ride': 1200}),
        ('S6c maxRide 15m (base, 2 vans)', 'REAL', real, base, V7x2, {'max_ride': 900}),
        ('S6d maxRide 10m (base, 2 vans)', 'REAL', real, base, V7x2, {'max_ride': 600}),
        ('S6e no max ride (base, 2 vans)', 'REAL', real, base, V7x2, {'max_ride': None}),
        ('S7 Velachery pinned to van-B (base, 2 vans)', 'REAL', real, base, V7x2, {'pins': {4: 'van-B'}}),
        ('S7b Velachery pinned to van-B, far case (2 vans)', 'REAL', real, far, V7x2, {'pins': {4: 'van-B'}}),
        # Locked route: the API removes the locked vehicle AND its stops before the solve (prisma-plan-gateway.load).
        # van-B locked with Velachery on it -> solver sees 4 pax, van-A only.
        ('S8 locked route: van-B locked with Velachery; solver gets 4 pax + van-A', 'REAL', real, [2, 3, 5, 6], V7, {}),
        ('S9 capacity: 9 pax-stops on 1x7-seater', 'REAL', real, [2, 3, 4, 5, 6, 10, 8, 9, 7], V7, {'max_ride': 5400}),
        ('S9b capacity: 9 pax, 2 vans', 'REAL', real, [2, 3, 4, 5, 6, 10, 8, 9, 7], V7x2, {'max_ride': 5400}),
    ]
    for name, kind, mat, pax, veh, kw in cases:
        text, res = run(name, kind, mat, pax, veh, **kw)
        out.append(text)
        raw[f'{kind}:{name}'] = res
        print(text, flush=True)
    OUT.write_text('\n\n'.join(out), encoding='utf-8')
    (OUT.with_suffix('.json')).write_text(json.dumps(raw, indent=1), encoding='utf-8')


if __name__ == '__main__':
    main()
