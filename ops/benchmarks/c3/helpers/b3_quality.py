"""C3 B3 (doc 06 §7): solution-quality loss of a sparse k-nearest matrix (k = 20 / 40 / 60, + depot legs) against the
full matrix. Pass target (doc 06 §7 benchmark plan, proposed): < 3 % worse.

Input: the matrices written by export-matrix.ts (full.json, k20.json, ...; point 0 = depot). The same generic CVRPTW
problem (services/routing-optimizer/bench_optimizer.problem, seeded) is solved on each matrix; a null cell is a
forbidden arc, so the sparse solve can only use the k-nearest legs. Each solution is then re-scored on the FULL matrix
(total driven seconds along every route's locationSequence) and compared with the full-matrix solution. A sparse
solution that leaves more stops unassigned than the full one fails outright.

"OR-Tools objective" in doc 06 is approximated by the re-scored driven time: the sparse objective itself is not
comparable (it is computed on different arcs). The search is time-limited; set C3_B3_REPEATS > 1 to average noise.

  run through ../b3-sparse-quality.sh (never on its own):  python b3_quality.py <matrix dir> <results dir>
"""
import glob
import json
import os
import random
import sys

REPO = os.environ.get('C3_REPO') or os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..', '..', '..'))
sys.path.insert(0, os.path.join(REPO, 'ops', 'benchmarks', 'c3', 'lib'))
sys.path.insert(0, os.path.join(REPO, 'services', 'routing-optimizer'))
from c3guard import c3_guard  # noqa: E402

LOSS_LIMIT = 0.03


def rescore(result: dict, full: list) -> int | None:
    total = 0
    for r in result.get('routes', []):
        seq = [x for x in r.get('locationSequence', []) if x is not None]
        for a, b in zip(seq, seq[1:]):
            if full[a][b] is None:
                return None
            total += full[a][b]
    return total


def main():
    dry = c3_guard()
    mdir, out = sys.argv[1], sys.argv[2]
    limit = int(os.environ.get('C3_B3_LIMIT_S', '60'))
    repeats = int(os.environ.get('C3_B3_REPEATS', '1'))
    vehicles = int(os.environ.get('C3_B3_VEHICLES', '10'))
    if dry:
        print(f'   plan: solve full + each k matrix ({vehicles} vehicles, {limit} s, x{repeats}), re-score on full; pass = loss < 3 %')
        return
    from bench_optimizer import problem
    from optimizer import solve
    full_m = json.load(open(os.path.join(mdir, 'full.json'), encoding='utf-8'))
    n = full_m['n']

    def run(m):
        res = []
        for rep in range(repeats):
            p = problem(n - 1, vehicles, {'durationsS': m['durationsS'], 'distancesM': m['distancesM']}, random.Random(7),
                        windows=True, limit=limit)
            p['options']['seed'] = rep + 1
            r = solve(p)
            res.append({'status': r['status'], 'unassigned': len(r.get('unassigned', [])),
                        'drivenS': rescore(r, full_m['durationsS']), 'objective': r.get('objective')})
        return res

    base = run(full_m)
    base_s = sum(x['drivenS'] for x in base) / len(base)
    base_un = min(x['unassigned'] for x in base)
    rows = [{'k': 0, 'runs': base, 'meanDrivenS': base_s, 'lossPct': 0.0}]
    ok = True
    for f in sorted(glob.glob(os.path.join(mdir, 'k*.json')), key=lambda p: int(os.path.basename(p)[1:-5])):
        m = json.load(open(f, encoding='utf-8'))
        runs = run(m)
        scored = [x['drivenS'] for x in runs if x['drivenS'] is not None]
        mean = sum(scored) / len(scored) if scored else None
        loss = (mean - base_s) / base_s if mean is not None else None
        more_unassigned = min(x['unassigned'] for x in runs) > base_un
        passed = loss is not None and loss < LOSS_LIMIT and not more_unassigned
        ok &= passed
        rows.append({'k': m['k'], 'runs': runs, 'meanDrivenS': mean, 'lossPct': None if loss is None else round(loss * 100, 2),
                     'moreUnassignedThanFull': more_unassigned, 'pass': passed})
        print(json.dumps(rows[-1]), flush=True)
    json.dump({'label': os.environ.get('C3_LABEL'), 'n': n, 'limitS': limit, 'lossLimitPct': LOSS_LIMIT * 100, 'rows': rows},
              open(os.path.join(out, 'b3.json'), 'w', encoding='utf-8'), indent=2)
    with open(os.path.join(out, 'b3.csv'), 'w', encoding='utf-8') as fh:
        fh.write('k,meanDrivenS,lossPct,moreUnassignedThanFull,pass\n')
        for r in rows[1:]:
            fh.write(f"{r['k']},{r['meanDrivenS']},{r['lossPct']},{r['moreUnassignedThanFull']},{r['pass']}\n")
    print(('PASS' if ok else 'FAIL') + ' B3 sparse k-nearest loss < 3 % vs full matrix, every k (doc 06 §7)')
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
