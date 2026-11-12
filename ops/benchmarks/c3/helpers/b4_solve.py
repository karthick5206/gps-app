"""C3 B4 / B5 (doc 06 §7): OR-Tools solve scaling and transit-registration comparison, solver only.

  B4: door-to-door IN problems with 100 / 200 / 300 / 500 passengers at time limits 10 / 30 / 60 / 120 s: wall time,
      status, objective, peak RSS, verifier violations. Pass (doc 06 §7, proposed): 300 nodes FEASIBLE with 0
      hard-constraint violations in 60 s. Also checked: doc 11 §5.2 "Optimisation 500 pax / 40 veh <= 60 s" and
      "never above timeLimitS + 10 %".
  B5: the same problems with options.transit = 'callback' (Python callbacks) vs 'matrix' (RegisterTransitMatrix, the
      default): wall time to the first solution (solutionLimit 1) and the objective at a fixed limit. Doc 06 §7 target:
      "measure" (no pass/fail).

Problems come from the corpus generator (services/routing-optimizer/corpus_gen.py, synthetic haversine x 1.35 matrix,
seeded): the matrix is a solver input only, so only the solver is measured (as bench_optimizer.py). Each solve runs in
its own process (fresh peak RSS), under lib/capped.sh (the optimiser unit's caps) unless C3_UNCAPPED=1.

  run through ../b4-solve-scaling.sh or ../b5-transit.sh (never on its own)
  python b4_solve.py --one <passengers> <limitS> <matrix|callback> [--first]     (internal: one solve, prints JSON)
  python b4_solve.py --dump <passengers> <file>                                   (internal: write the problem JSON)
"""
import json
import os
import resource
import subprocess
import sys
import time

REPO = os.environ.get('C3_REPO') or os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..', '..'))
sys.path.insert(0, os.path.join(REPO, 'ops', 'benchmarks', 'c3', 'lib'))
sys.path.insert(0, os.path.join(REPO, 'services', 'routing-optimizer'))
from c3guard import c3_guard  # noqa: E402

# Fleets sized ~1.5-1.8x seats per passenger, <= 50 vehicles (solver LIMITS); 500 pax uses 40 vehicles (doc 11 §5.2).
FLEETS = {
    100: {'4': 3, '6': 3, '12': 4, '26': 2, '40': 1},
    200: {'4': 5, '6': 6, '12': 7, '26': 4, '40': 3},      # = corpus 09-in-xl-200x25
    300: {'4': 5, '6': 6, '12': 8, '26': 6, '40': 5},
    500: {'4': 5, '6': 7, '12': 10, '26': 10, '40': 8},
}


def problem(passengers: int, limit: int, transit: str = 'matrix', first: bool = False) -> dict:
    from corpus_gen import build
    spec = {'generator': {'seed': 600 + passengers, 'direction': 'IN', 'passengers': passengers, 'depots': 3,
                          'fleet': FLEETS[passengers], 'timeLimitS': limit, 'search': 'guided',
                          'groupShare': 0}}   # one stop per passenger: nodes = passengers + 3 garages + site
    p = build(spec)
    p['options']['transit'] = transit
    if first:
        p['options']['solutionLimit'] = 1
    return p


def one(passengers: int, limit: int, transit: str, first: bool) -> dict:
    from optimizer import solve, verify
    p = problem(passengers, limit, transit, first)
    t0 = time.perf_counter()
    r = solve(p)
    wall = time.perf_counter() - t0
    viol = verify(p, r) if r.get('status') in ('FEASIBLE', 'OPTIMAL') else []
    return {'passengers': passengers, 'stops': len(p['stops']), 'nodes': len(p['matrix']['durationsS']),
            'vehicles': len(p['vehicles']), 'limitS': limit, 'transit': transit, 'firstSolutionOnly': first,
            'status': r.get('status'), 'objective': r.get('objective'), 'wallS': round(wall, 2),
            'unassigned': len(r.get('unassigned', [])), 'violations': len(viol), 'violationSample': viol[:3],
            'peakRssMb': round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1)}


def spawn(passengers, limit, transit, first=False) -> dict:
    cmd = [sys.executable, os.path.abspath(__file__), '--one', str(passengers), str(limit), transit] + (['--first'] if first else [])
    if os.environ.get('C3_UNCAPPED') != '1':
        cmd = ['bash', os.path.join(REPO, 'ops', 'benchmarks', 'c3', 'lib', 'capped.sh')] + cmd
    try:
        pr = subprocess.run(cmd, capture_output=True, text=True, timeout=limit * 3 + 300)
    except subprocess.TimeoutExpired:
        return {'passengers': passengers, 'limitS': limit, 'transit': transit, 'firstSolutionOnly': first,
                'status': 'PROCESS_TIMEOUT'}
    if pr.returncode != 0:
        return {'passengers': passengers, 'limitS': limit, 'transit': transit, 'firstSolutionOnly': first,
                'status': 'PROCESS_FAILED', 'exit': pr.returncode, 'oomKilledLikely': pr.returncode == 137,
                'stderr': pr.stderr[-400:]}
    return json.loads(pr.stdout.strip().splitlines()[-1])


def main():
    if len(sys.argv) > 1 and sys.argv[1] == '--one':
        print(json.dumps(one(int(sys.argv[2]), int(sys.argv[3]), sys.argv[4], '--first' in sys.argv)))
        return
    if len(sys.argv) > 1 and sys.argv[1] == '--dump':
        c3_guard()
        p = problem(int(sys.argv[2]), int(os.environ.get('C3_R5_LIMIT_S', '60')))
        with open(sys.argv[3], 'w', encoding='utf-8') as fh:
            json.dump(p, fh)
        print(json.dumps({'stops': len(p['stops']), 'nodes': len(p['matrix']['durationsS']), 'vehicles': len(p['vehicles']),
                          'limitS': p['options']['timeLimitS'], 'bytes': os.path.getsize(sys.argv[3])}))
        return
    mode = sys.argv[1]  # b4 | b5
    dry = c3_guard()
    sizes = [int(x) for x in os.environ.get('C3_SOLVE_SIZES', '100,200,300,500').split(',')]
    limits = [int(x) for x in os.environ.get('C3_B4_LIMITS', '10,30,60,120').split(',')]
    plan = ([(n, lim, 'matrix', False) for n in sizes for lim in limits] if mode == 'b4' else
            [(n, lim, t, f) for n in sizes for t in ('matrix', 'callback') for (lim, f) in ((120, True), (30, False))])
    if dry:
        capped = 'uncapped' if os.environ.get('C3_UNCAPPED') == '1' else 'CPUQuota=150% MemoryMax=3G'
        print(f'   plan: {len(plan)} solves ({mode}), sizes {sizes}, each in its own process ({capped}); '
              f'at most about {sum(p[1] for p in plan if not p[3]) // 60 + 1} min of fixed-limit solver time')
        for n in sizes:   # validate that the problems build within the solver LIMITS (no solve)
            p = problem(n, 10)
            ok = len(p['stops']) <= 500 and len(p['matrix']['durationsS']) <= 600 and len(p['vehicles']) <= 50
            print(f'   {"ok" if ok else "OVER LIMITS"}: {n} passengers -> {len(p["stops"])} stops, '
                  f'{len(p["matrix"]["durationsS"])} nodes, {len(p["vehicles"])} vehicles')
            if not ok:
                sys.exit(2)
        return
    out = os.environ['C3_RESULTS']
    rows = []
    for n, lim, t, f in plan:
        row = spawn(n, lim, t, f)
        rows.append(row)
        print(json.dumps(row), flush=True)
    checks = []
    if mode == 'b4':
        def find(n, lim):
            return next((r for r in rows if r.get('passengers') == n and r.get('limitS') == lim), None)
        r300 = find(300, 60)
        checks.append({'check': 'B4 300 nodes (300 passengers + 4 depot/site nodes) FEASIBLE, 0 hard violations, '
                                '0 unassigned in 60 s (doc 06 §7)',
                       'pass': bool(r300 and r300.get('status') in ('FEASIBLE', 'OPTIMAL') and r300.get('violations') == 0
                                    and r300.get('unassigned') == 0), 'row': r300})
        r500 = find(500, 60)
        checks.append({'check': 'Optimisation 500 pax / 40 veh <= 60 s (+10 %), feasible (doc 11 §5.2)',
                       'pass': bool(r500 and r500.get('status') in ('FEASIBLE', 'OPTIMAL') and r500.get('wallS', 1e9) <= 60 * 1.10),
                       'row': r500})
        over = [r for r in rows if r.get('wallS') is not None and r['wallS'] > r['limitS'] * 1.10]
        checks.append({'check': 'never above timeLimitS + 10 % (doc 11 §5.2)', 'pass': not over, 'rows': over})
        bad = [r for r in rows if str(r.get('status', '')).startswith('PROCESS_')]
        checks.append({'check': 'no solve killed (MemoryMax=3G) or failed (doc 06 §7 production limits, doc 16 §3.1)',
                       'pass': not bad, 'rows': bad})
    else:
        checks.append({'check': 'B5 callback vs RegisterTransitMatrix: measure only (doc 06 §7), no pass/fail', 'pass': None})
    with open(os.path.join(out, f'{mode}.json'), 'w', encoding='utf-8') as fh:
        json.dump({'label': os.environ.get('C3_LABEL'), 'rows': rows, 'checks': checks}, fh, indent=2)
    keys = ['passengers', 'stops', 'nodes', 'vehicles', 'limitS', 'transit', 'firstSolutionOnly', 'status', 'objective',
            'wallS', 'unassigned', 'violations', 'peakRssMb']
    with open(os.path.join(out, f'{mode}.csv'), 'w', encoding='utf-8') as fh:
        fh.write(','.join(keys) + '\n')
        for r in rows:
            fh.write(','.join(str(r.get(k, '')) for k in keys) + '\n')
    for c in checks:
        if c['pass'] is not None:
            print(('PASS ' if c['pass'] else 'FAIL ') + c['check'])
    sys.exit(1 if any(c['pass'] is False for c in checks) else 0)


if __name__ == '__main__':
    main()
