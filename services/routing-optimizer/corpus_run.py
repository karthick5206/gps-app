"""Routing corpus runner (WP 4.4; doc 11 §2.3; E4 exit criterion "30/30 corpus problems pass all invariants").

  python -m corpus_run                 # solve every corpus/*.json, print PASS/FAIL + timing, exit 1 on any FAIL
  python -m corpus_run --only 07       # scenarios whose file name contains "07"
  python -m corpus_run --record        # (re)record objectiveBound = ceil(objective x 1.05) for passing scenarios
  python -m corpus_run --json out.json # also write the per-scenario results (evidence)

A scenario passes when:
  * the status is one of `expect.status` (default FEASIBLE / OPTIMAL);
  * `optimizer.verify` finds no violation: every stop routed once or reported with reason + code, seats, wheelchair
    spaces, time windows, site window, max ride, route duration, availability, allowed vehicles, pinning, escort
    rules, exclusive and customer separation all hold, and times agree with the matrix;
  * wall time <= timeLimitS x 1.10;
  * unassigned count within [minUnassigned, maxUnassigned], every code in `requireCodes` present and every code in
    `allowedCodes` (when given);
  * vehicles used <= maxVehiclesUsed and unusable vehicles >= minUnusableVehicles (when given);
  * objective <= objectiveBound (no regression; recorded with --record).
"""
from __future__ import annotations

import argparse
import glob
import json
import math
import os
import sys
import time

from corpus_gen import MATRIX_SOURCE, build
from optimizer import solve, verify

HERE = os.path.dirname(os.path.abspath(__file__))
CORPUS_DIR = os.path.join(HERE, 'corpus')
BOUND_FACTOR = 1.05
TIME_FACTOR = 1.10


def scenario_files(only: str | None = None) -> list[str]:
    files = sorted(glob.glob(os.path.join(CORPUS_DIR, '*.json')))
    return [f for f in files if not only or only in os.path.basename(f)]


def load(path: str) -> dict:
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def check(spec: dict, problem: dict, res: dict, wall_s: float) -> list[str]:
    e = spec.get('expect', {})
    fails = []
    if res['status'] not in e.get('status', ['FEASIBLE', 'OPTIMAL']):
        fails.append(f"status {res['status']} not in {e.get('status', ['FEASIBLE', 'OPTIMAL'])}")
    fails += verify(problem, res)
    limit = problem['options']['timeLimitS']
    if wall_s > limit * TIME_FACTOR:
        fails.append(f'wall {wall_s:.2f}s > {limit}s x {TIME_FACTOR}')
    un = res.get('unassigned', [])
    if len(un) > e.get('maxUnassigned', 0):
        fails.append(f"{len(un)} unassigned > maxUnassigned {e.get('maxUnassigned', 0)}")
    if len(un) < e.get('minUnassigned', 0):
        fails.append(f"{len(un)} unassigned < minUnassigned {e['minUnassigned']}")
    got = {u['code'] for u in un}
    for c in e.get('requireCodes', []):
        if c not in got:
            fails.append(f'missing unassigned code {c}')
    if 'allowedCodes' in e and not got <= set(e['allowedCodes']):
        fails.append(f"unexpected codes {sorted(got - set(e['allowedCodes']))}")
    used = len(res.get('routes', []))
    if e.get('maxVehiclesUsed') is not None and used > e['maxVehiclesUsed']:
        fails.append(f"{used} vehicles > maxVehiclesUsed {e['maxVehiclesUsed']}")
    if len(res.get('unusableVehicles', [])) < e.get('minUnusableVehicles', 0):
        fails.append(f"unusable vehicles {len(res.get('unusableVehicles', []))} < {e['minUnusableVehicles']}")
    if e.get('objectiveBound') is not None and res.get('objective', 0) > e['objectiveBound']:
        fails.append(f"objective {res.get('objective')} > bound {e['objectiveBound']}")
    return fails


def run_one(path: str) -> dict:
    spec = load(path)
    problem = build(spec)
    t = time.perf_counter()
    res = solve(problem)
    wall = time.perf_counter() - t
    fails = check(spec, problem, res, wall)
    stops = problem['stops']
    pax = sum(len(s.get('passengerIds') or []) for s in stops)
    un_pax = sum(len(u.get('passengerIds') or []) for u in res.get('unassigned', []))
    return {'id': spec['id'], 'file': os.path.basename(path), 'pass': not fails, 'failures': fails,
            'wallS': round(wall, 2), 'timeLimitS': problem['options']['timeLimitS'], 'status': res['status'],
            'stoppedBy': res.get('stats', {}).get('stoppedBy'), 'stops': len(stops), 'passengers': pax,
            'vehicles': len(problem['vehicles']), 'vehiclesUsed': len(res.get('routes', [])),
            'unassignedStops': len(res.get('unassigned', [])), 'unassignedPassengers': un_pax,
            'codes': sorted({u['code'] for u in res.get('unassigned', [])}),
            'objective': res.get('objective'), 'objectiveBound': spec.get('expect', {}).get('objectiveBound'),
            'matrixSource': spec.get('matrixSource', MATRIX_SOURCE)}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog='corpus_run')
    ap.add_argument('--only')
    ap.add_argument('--record', action='store_true')
    ap.add_argument('--json')
    a = ap.parse_args(argv)
    files = scenario_files(a.only)
    results, t0 = [], time.perf_counter()
    for path in files:
        r = run_one(path)
        results.append(r)
        print(f"{'PASS' if r['pass'] else 'FAIL'}  {r['id']:<40} {r['wallS']:>6.2f}s/{r['timeLimitS']:<3} "
              f"{r['status']:<9} pax {r['passengers'] - r['unassignedPassengers']:>3}/{r['passengers']:<3} "
              f"veh {r['vehiclesUsed']:>2}/{r['vehicles']:<2} obj {r['objective']}"
              + (f"  codes {','.join(r['codes'])}" if r['codes'] else ''), flush=True)
        for f in r['failures'][:10]:
            print(f'      - {f}')
        if a.record and not [f for f in r['failures'] if not f.startswith('objective')]:
            spec = load(path)
            spec.setdefault('expect', {})['objectiveBound'] = math.ceil((r['objective'] or 0) * BOUND_FACTOR)
            with open(path, 'w', encoding='utf-8') as f:
                json.dump(spec, f, indent=2)
                f.write('\n')
    passed = sum(r['pass'] for r in results)
    print(f'CORPUS {passed}/{len(results)} PASS  (total {time.perf_counter() - t0:.1f}s, matrices {MATRIX_SOURCE})')
    if a.json:
        with open(a.json, 'w', encoding='utf-8') as f:
            json.dump({'passed': passed, 'total': len(results), 'results': results}, f, indent=2)
    return 0 if passed == len(results) and results else 1


if __name__ == '__main__':
    sys.exit(main())
