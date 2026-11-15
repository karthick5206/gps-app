"""E4 strategy presets on the REAL GraphHopper matrix (scratchpad/gh-matrix.txt). Inspection only.

Metric definitions (same for every run):
  vehicles  = routes with >= 1 stop
  km        = sum over routes of road distance first pickup -> ... -> office (open start: no deadhead)
  drive min = sum over routes of durationS (first pickup departure -> office arrival, incl. service and waits)
  ride      = per passenger: office arrival - own pickup (service start), minutes; max and mean over assigned passengers
  occ       = passengers / seats per used vehicle
"""
import importlib.util
import json
import sys
from pathlib import Path

REPO, HERE = Path(sys.argv[1]), Path(__file__).parent
sys.path.insert(0, str(REPO / 'services' / 'routing-optimizer'))
from optimizer.solver import solve as solve_prod  # noqa: E402

spec = importlib.util.spec_from_file_location('solver_proto', HERE / 'solver_proto.py')
proto = importlib.util.module_from_spec(spec); sys.modules["solver_proto"] = proto; spec.loader.exec_module(proto)
solve_proto = proto.solve

NAMES = ['Office', 'Depot', 'Adyar', 'Thiruvanmiyur', 'Velachery', 'Perungudi', 'Besant', 'Tambaram', 'AnnaNagar',
         'Kilpauk', 'Sholinganallur']


def real_matrix():
    dur, dist = [], []
    for line in (HERE / 'gh-matrix.txt').read_text().split('\n'):
        if line.strip():
            dr, tr = [], []
            for cell in line.split():
                d, t = cell.split(':')
                dr.append(round(float(d))); tr.append(round(float(t) / 1000))
            dur.append(tr); dist.append(dr)
    return dur, dist


DUR, DIST = real_matrix()

PRESETS = {
    # name: (solver, weights, guard)  guard = (ratio, extra_s) max detour vs direct ride, or None
    'Current default (v7200,t1)': ('prod', {'vehicle': 7200, 'distance': 0, 'time': 1, 'routeDuration': 0}, None),
    'Balanced (v3600,t1,ride1 +guard 1.6/10m)': ('proto', {'vehicle': 3600, 'distance': 0, 'time': 2, 'routeDuration': 0, 'rideTime': 1}, (1.6, 600)),
    'Fewer vehicles (v20000,t1)': ('prod', {'vehicle': 20000, 'distance': 0, 'time': 1, 'routeDuration': 0}, None),
    'Shortest distance (v50000,d1)': ('prod', {'vehicle': 50000, 'distance': 1, 'time': 0, 'routeDuration': 0}, None),
    'Shortest distance, no vehicle wt (v0,d1)': ('prod', {'vehicle': 0, 'distance': 1, 'time': 0, 'routeDuration': 0}, None),
    'Fastest fleet time (v600,t1)': ('prod', {'vehicle': 600, 'distance': 0, 'time': 1, 'routeDuration': 0}, None),
    'Comfort, weights only (v1800,t1,span2)': ('prod', {'vehicle': 1800, 'distance': 0, 'time': 1, 'routeDuration': 2}, None),
    'Comfort, ride cost (v1800,t1,ride2)': ('proto', {'vehicle': 1800, 'distance': 0, 'time': 1, 'routeDuration': 0, 'rideTime': 2}, None),
}

SCEN = [
    ('base5 1x7', [2, 3, 4, 5, 6], [('A', 7)], 3600),
    ('base5 2x7', [2, 3, 4, 5, 6], [('A', 7), ('B', 7)], 3600),
    ('far 2x7', [2, 3, 4, 5, 7], [('A', 7), ('B', 7)], 3600),
    ('twoDir 2x7', [3, 5, 10, 8, 9], [('A', 7), ('B', 7)], 3600),
    ('nine 3x7', [2, 3, 4, 5, 6, 10, 8, 9, 7], [('A', 7), ('B', 7), ('C', 7)], 5400),
    ('nine mixed 4/7/12', [2, 3, 4, 5, 6, 10, 8, 9, 7], [('S4', 4), ('M7', 7), ('L12', 12)], 5400),
]


def problem(pax, vehicles, max_ride, weights, guard=None, time_limit=5):
    pts = [0] + pax
    sub = lambda m: [[m[a][b] for b in pts] for a in pts]  # noqa: E731
    stops = []
    for k, loc in enumerate(pax):
        st = {'id': f'{NAMES[loc]}', 'locationIndex': 1 + k, 'demand': 1, 'serviceS': 60, 'priority': 1}
        if guard:
            direct = DUR[loc][0] + 60
            cap = max(round(direct * guard[0]), direct + guard[1])
            st['maxRideS'] = min(cap, max_ride) if max_ride else cap
        stops.append(st)
    return {'schemaVersion': 2, 'matrix': {'durationsS': sub(DUR), 'distancesM': sub(DIST)},
            'vehicles': [{'id': v, 'startIndex': None, 'endIndex': 0, 'capacity': c} for v, c in vehicles],
            'stops': stops, 'horizonS': 86400,
            'trip': {'direction': 'IN', 'siteIndex': 0, 'siteWindow': [5400, 7200], **({'maxRideS': max_ride} if max_ride else {})},
            'options': {'timeLimitS': time_limit, 'weights': weights}}


def metrics(res):
    routes = res.get('routes', [])
    rides = [s['rideS'] for r in routes for s in r['stops']]
    return {
        'veh': len(routes),
        'km': round(sum(r.get('distanceM') or 0 for r in routes) / 1000, 1),
        'driveMin': round(sum(r['durationS'] for r in routes) / 60),
        'maxRide': round(max(rides, default=0) / 60),
        'avgRide': round(sum(rides) / len(rides) / 60, 1) if rides else 0,
        'occ': ' '.join(f"{r['vehicleId']}:{len(r['stops'])}/{r.get('seats')}" for r in routes),
        'routes': ' | '.join(r['vehicleId'] + ':' + '>'.join(s['stopId'][:5] for s in r['stops']) for r in routes),
        'unassigned': [f"{u['stopId']}:{u.get('code')}:{json.dumps(u.get('detail'))}" for u in res.get('unassigned', [])],
        'status': res.get('status'), 'error': res.get('error'),
    }


def run(solver, pax, veh, max_ride, weights, guard):
    fn = solve_proto if solver == 'proto' else solve_prod
    return metrics(fn(problem(pax, veh, max_ride, weights, guard)))


def main():
    out = {}
    mode = sys.argv[2] if len(sys.argv) > 2 else 'all'
    if mode in ('all', 'presets'):
        for sname, pax, veh, mr in SCEN:
            for pname, (solver, w, guard) in PRESETS.items():
                m = run(solver, pax, veh, mr, w, guard)
                out[f'{sname} || {pname}'] = m
                print(json.dumps({'scenario': sname, 'preset': pname, **m}), flush=True)
    if mode in ('all', 'guard'):
        # Detour guard on the two-direction case WITHOUT a company max ride (policy absent = no limit).
        for gname, guard in [('no guard', None), ('guard 2.0/15m', (2.0, 900)), ('guard 1.6/10m', (1.6, 600)), ('guard 1.4/8m', (1.4, 480))]:
            for veh in ([('A', 7), ('B', 7)], [('A', 7)]):
                m = run('proto', [3, 5, 10, 8, 9], veh, None, {'vehicle': 7200, 'distance': 0, 'time': 1, 'routeDuration': 0}, guard)
                key = f'twoDir NO company maxRide, {len(veh)} van(s), default weights, {gname}'
                out[key] = m
                print(json.dumps({'case': key, **m}), flush=True)
    if mode in ('all', 'reasons'):
        # Reason classification: prod vs proto on the S3c / S5b / S6d style drops.
        cases = [('twoDir 1 van maxRide 45m', [3, 5, 10, 8, 9], [('A', 7)], 2700),
                 ('base5 2 vans maxRide 10m', [2, 3, 4, 5, 6], [('A', 7), ('B', 7)], 600),
                 ('nine 1 van maxRide 90m (capacity)', [2, 3, 4, 5, 6, 10, 8, 9, 7], [('A', 7)], 5400)]
        for cname, pax, veh, mr in cases:
            w = {'vehicle': 7200, 'distance': 0, 'time': 1, 'routeDuration': 0}
            for solver in ('prod', 'proto'):
                m = run(solver, pax, veh, mr, w, None)
                key = f'REASONS {cname} [{solver}]'
                out[key] = m
                print(json.dumps({'case': key, 'unassigned': m['unassigned'], 'routes': m['routes']}), flush=True)
    (HERE / f'e4-strategies-{mode}.json').write_text(json.dumps(out, indent=1))


if __name__ == '__main__':
    main()
