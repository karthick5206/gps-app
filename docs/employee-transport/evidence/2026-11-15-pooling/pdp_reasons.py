"""Closest-insertion reasons: for each unserved request, the violation set of the insertion with the fewest violations
(alone on an empty vehicle schedule counts too)."""
import json, sys
from collections import Counter
import pdp_proto as P

def closest(res, reqs, vehs):
    rmap = {r.id: r for r in reqs}; out = {}
    for rid in res['dropped']:
        best = None
        for v in vehs:
            base = [(k, x) for k, x, _ in res['routes'][v.id]]
            for i in range(len(base) + 1):
                for j in range(i, len(base) + 1):
                    ok, why, _ = P.simulate(base[:i] + [('pick', rid)] + base[i:j] + [('drop', rid)] + base[j:], rmap, v)
                    if best is None or len(why) < len(best):
                        best = why
        out[rid] = sorted(best) if best else ['NOT_SELECTED']
    return out

reqs, vehs = P.city(50), P.fleet(2)
res = P.solve(reqs, vehs, P.STRATS['balanced'], limit=10)
c = closest(res, reqs, vehs)
print('2veh served', 50 - len(res['dropped']), Counter(str(v) for v in c.values()))
served_private = [r.id for r in reqs if r.pref == 'PRIVATE' and r.id not in res['dropped']]
print('private served', served_private)
