"""Independent re-check of a solve result against the raw problem (doc 06 §4.5: "a validator that re-checks").

`verify(problem, result) -> list[str]` returns human-readable violations; an empty list means every hard constraint
holds. It reads the raw problem JSON (not the solver's normalised model) and recomputes times from the matrix, so a
modelling error in `solver.py` shows up here. Used by the tests and the corpus runner; the API can mirror it.

Max ride is HARD and checked here. `trip.detourGuard` and `options.weights.rideTime` are SOFT (objective costs):
exceeding the guard is never a violation, but the reported `rideS` / `directS` / `detourS` the API shows are
re-checked against the matrix.
"""
from __future__ import annotations

from collections import Counter

from .solver import DEFAULT_HORIZON_S

ROUTED_STATUSES = ('FEASIBLE', 'OPTIMAL')


def _demand(st: dict) -> int:
    if st.get('demand') is not None:
        return int(st['demand'])
    return len(st.get('passengerIds') or [])


def _windows(st: dict, horizon: int) -> list[tuple[int, int]]:
    ws = st.get('timeWindows') or [None]
    return [(0, horizon) if w is None else (int(w[0]), int(w[1])) for w in ws]


def _start(veh: dict) -> int | None:
    return None if ('startIndex' in veh and veh['startIndex'] is None) else int(veh.get('startIndex', 0))


def _end(veh: dict) -> int | None:
    if 'endIndex' in veh:
        return None if veh['endIndex'] is None else int(veh['endIndex'])
    return _start(veh)


def verify(problem: dict, result: dict) -> list[str]:
    if isinstance(problem, dict) and problem.get('mode') == 'pdp':
        return verify_pdp(problem, result)
    out: list[str] = []
    if result.get('status') == 'INVALID_INPUT':
        return out
    dur = problem['matrix']['durationsS']
    horizon = int(problem.get('horizonS') or DEFAULT_HORIZON_S)
    trip = problem.get('trip')
    direction = trip['direction'] if trip else None
    site = int(trip['siteIndex']) if trip else None
    sw = trip.get('siteWindow') if trip else None
    trip_max_ride = trip.get('maxRideS') if trip else None
    opts = problem.get('options') or {}
    vehicles = {str(v.get('id', f'vehicle-{i}')): v for i, v in enumerate(problem.get('vehicles') or [])}
    stops = {str(s.get('id', f'stop-{i}')): s for i, s in enumerate(problem.get('stops') or [])}

    # 1. Every stop is routed exactly once or reported, never silently dropped.
    seen = Counter()
    for r in result.get('routes', []):
        for x in r['stops']:
            seen[x['stopId']] += 1
    for u in result.get('unassigned', []):
        seen[u['stopId']] += 1
        if not u.get('reason') or not u.get('code'):
            out.append(f"unassigned {u['stopId']}: missing reason/code")
    for sid in stops:
        if seen[sid] != 1:
            out.append(f'stop {sid}: appears {seen[sid]} times (routed + unassigned)')
    for sid in seen:
        if sid not in stops:
            out.append(f'unknown stop {sid} in result')
    used = Counter(r['vehicleId'] for r in result.get('routes', []))
    for vid, c in used.items():
        if vid not in vehicles:
            out.append(f'unknown vehicle {vid}')
        elif c > 1:
            out.append(f'vehicle {vid} used by {c} routes')

    for r in result.get('routes', []):
        vid = r['vehicleId']
        veh = vehicles.get(vid)
        if veh is None or not r['stops']:
            if veh is not None:
                out.append(f'{vid}: empty route reported')
            continue
        tag = vid
        rs = [(x, stops[x['stopId']]) for x in r['stops'] if x['stopId'] in stops]
        # 2. Capacity: seats (escort takes one unless escortUsesSeat=false), wheelchair spaces.
        if veh.get('capacity') is not None:
            seats = int(veh['capacity']) - (1 if veh.get('escort') and veh.get('escortUsesSeat', True) else 0)
            load = sum(_demand(st) for _, st in rs)
            if load > seats:
                out.append(f'{tag}: load {load} > seats {seats}')
        wc = sum(int(st.get('wheelchair') or 0) for _, st in rs)
        if wc > int(veh.get('wheelchairSpaces') or 0):
            out.append(f'{tag}: wheelchair {wc} > spaces {veh.get("wheelchairSpaces") or 0}')
        # 3. Compatibility, pinning, safety, pooling.
        for x, st in rs:
            sid = x['stopId']
            if st.get('allowedVehicleIds') is not None and vid not in [str(i) for i in st['allowedVehicleIds']]:
                out.append(f'{tag}: {sid} not allowed on this vehicle')
            if st.get('allowedVehicleTypes') is not None and veh.get('type') not in st['allowedVehicleTypes']:
                out.append(f'{tag}: {sid} not allowed on type {veh.get("type")}')
            if st.get('pinnedVehicleId') is not None and str(st['pinnedVehicleId']) != vid:
                out.append(f'{tag}: {sid} pinned to {st["pinnedVehicleId"]}')
            if st.get('requiresEscort') and not veh.get('escort'):
                out.append(f'{tag}: {sid} requires an escort')
            if st.get('exclusive') and len(rs) > 1:
                out.append(f'{tag}: exclusive {sid} shares the vehicle')
        if not veh.get('escort') and direction:
            edge = rs[0][1] if direction == 'IN' else rs[-1][1]
            if edge.get('escortIfFirstOrLast'):
                pos = 'first pickup' if direction == 'IN' else 'last drop'
                out.append(f'{tag}: flagged {edge.get("id")} is {pos} without escort')
        if not opts.get('allowMixedCustomers'):
            cust = {st.get('customerId') for _, st in rs if st.get('customerId') is not None}
            if len(cust) > 1:
                out.append(f'{tag}: mixes customers {sorted(cust)}')
        # 4. Times recomputed from the matrix.
        start = _start(veh)
        prev = site if direction == 'OUT' else start
        prev_dep = r['startS']
        for x, st in rs:
            loc = int(st['locationIndex'])
            if x['locationIndex'] != loc:
                out.append(f'{tag}: {x["stopId"]} wrong location')
            leg = 0 if prev is None else dur[prev][loc]
            if leg is None:
                out.append(f'{tag}: uses a null matrix arc {prev}->{loc}')
                leg = 0
            if x['arrivalS'] != prev_dep + leg:
                out.append(f'{tag}: {x["stopId"]} arrival {x["arrivalS"]} != {prev_dep + leg}')
            if x['serviceStartS'] < x['arrivalS']:
                out.append(f'{tag}: {x["stopId"]} service before arrival')
            if not any(a <= x['serviceStartS'] <= b for a, b in _windows(st, horizon)):
                out.append(f'{tag}: {x["stopId"]} outside its time windows')
            if x['departureS'] != x['serviceStartS'] + int(st.get('serviceS') or 0):
                out.append(f'{tag}: {x["stopId"]} departure mismatch')
            prev, prev_dep = loc, x['departureS']
        end_loc = site if direction == 'IN' else _end(veh)
        leg = 0 if end_loc is None else dur[prev][end_loc]
        if leg is None:
            out.append(f'{tag}: uses a null matrix arc {prev}->{end_loc}')
            leg = 0
        if r['endS'] < prev_dep + leg:
            out.append(f'{tag}: endS {r["endS"]} before reaching the end ({prev_dep + leg})')
        tw = veh.get('timeWindow') or [0, horizon]
        if r['startS'] < tw[0] or r['endS'] > tw[1]:
            out.append(f'{tag}: route [{r["startS"]}, {r["endS"]}] outside availability {tw}')
        if veh.get('maxDurationS') is not None and r['endS'] - r['startS'] > veh['maxDurationS']:
            out.append(f'{tag}: duration {r["endS"] - r["startS"]} > maxDurationS {veh["maxDurationS"]}')
        # 5. Site window and max ride time.
        if direction == 'IN':
            arr = r.get('siteArrivalS', r['endS'])
            if not sw[0] <= arr <= sw[1]:
                out.append(f'{tag}: site arrival {arr} outside {sw}')
            for x, st in rs:
                mr = st['maxRideS'] if st.get('maxRideS') is not None else trip_max_ride
                if mr is not None and arr - x['serviceStartS'] > mr:
                    out.append(f'{tag}: {x["stopId"]} ride {arr - x["serviceStartS"]} > {mr}')
                out += _ride_fields(tag, x, arr - x['serviceStartS'],
                                    _leg(dur, int(st['locationIndex']), site, int(st.get('serviceS') or 0)))
        elif direction == 'OUT':
            dep = r['startS']
            if not sw[0] <= dep <= sw[1]:
                out.append(f'{tag}: site departure {dep} outside {sw}')
            if start is not None and start != site:
                dh = dur[start][site]
                if dh is None or dep < tw[0] + dh:
                    out.append(f'{tag}: cannot reach the site by {dep}')
            for x, st in rs:
                mr = st['maxRideS'] if st.get('maxRideS') is not None else trip_max_ride
                if mr is not None and x['serviceStartS'] - dep > mr:
                    out.append(f'{tag}: {x["stopId"]} ride {x["serviceStartS"] - dep} > {mr}')
                out += _ride_fields(tag, x, x['serviceStartS'] - dep, _leg(dur, site, int(st['locationIndex']), 0))
    return out


def _leg(dur: list, a: int, b: int, extra: int) -> int | None:
    return None if dur[a][b] is None else dur[a][b] + extra


def _ride_fields(tag: str, x: dict, ride: int, direct: int | None) -> list[str]:
    """Reported ride / direct ride / detour (trip visits) agree with the matrix. IN direct = own boarding + leg to the
    site; OUT direct = leg from the site; detourS = max(0, rideS - directS)."""
    out = []
    if 'rideS' in x and x['rideS'] != ride:
        out.append(f'{tag}: {x["stopId"]} rideS {x["rideS"]} != {ride}')
    if 'directS' in x:
        if x['directS'] != direct:
            out.append(f'{tag}: {x["stopId"]} directS {x["directS"]} != {direct}')
        elif x.get('detourS') != max(0, ride - direct):
            out.append(f'{tag}: {x["stopId"]} detourS {x.get("detourS")} != {max(0, ride - direct)}')
    return out


# ----------------------------------------------------------------------------------------------------------------
# Contract v3 mode "pdp" (doc 20 §4). Recomputed from the raw problem: every request once (served / unserved /
# commitment violation), precedence (pickup before drop, same vehicle, same trip), seats and wheelchair spaces at every
# stop, PRIVATE alone on its whole trip, pickup windows (committed window when given), max ride / detour, arriveBy,
# onboard dropBy, travel times + turnaround between trips + breaks, shift end, span, break windows, allowed vehicles,
# trips split exactly where the load returns to 0, committed requests on their vehicle.
# ----------------------------------------------------------------------------------------------------------------

_PDP_CODES = ('PICKUP_WINDOW', 'VEHICLE_TIME', 'MAX_RIDE', 'CAPACITY', 'PRIVATE_NEEDS_EMPTY_VEHICLE', 'DRIVER_HOURS',
              'NO_COMPATIBLE_VEHICLE', 'ROUTING_UNAVAILABLE', 'NOT_SELECTED')


def _pdp_limit(r: dict, direct: int | None) -> int | None:
    lim = r.get('maxRideS')
    det = r.get('detour')
    if det is not None and direct is not None:
        ratio = det.get('ratio') if det.get('ratio') is not None else 1
        extra = det.get('extraS') if det.get('extraS') is not None else 0
        d = max(int(direct * ratio + 1e-9), direct + int(extra))
        lim = d if lim is None else min(lim, d)
    return lim


def verify_pdp(problem: dict, result: dict) -> list[str]:
    out: list[str] = []
    if result.get('status') == 'INVALID_INPUT':
        return out
    dur = problem['matrix']['durationsS']
    H = int(problem.get('horizonS') or 86400)
    vehicles = {str(v.get('id', f'vehicle-{i}')): v for i, v in enumerate(problem['vehicles'])}
    reqs = {str(r.get('id', f'request-{i}')): r for i, r in enumerate(problem.get('requests') or [])}
    onboard = {str(o['requestId']): (vid, o) for vid, v in vehicles.items() for o in (v.get('onboard') or [])}
    pax = {**{k: int(r.get('passengers') or 1) for k, r in reqs.items()},
           **{k: int(o.get('passengers') or 1) for k, (_, o) in onboard.items()}}
    wch = {**{k: int(r.get('wheelchair') or 0) for k, r in reqs.items()},
           **{k: int(o.get('wheelchair') or 0) for k, (_, o) in onboard.items()}}
    pref = {**{k: r.get('preference') or 'SHARED' for k, r in reqs.items()},
            **{k: o.get('preference') or 'SHARED' for k, (_, o) in onboard.items()}}

    # 1. Accounting: every request exactly once.
    picks, drops = Counter(), Counter()
    where: dict[str, set] = {}
    for rt in result.get('routes', []):
        for t in rt['trips']:
            for st in t['stops']:
                (picks if st['kind'] == 'PICKUP' else drops)[st['requestId']] += 1
                where.setdefault(st['requestId'], set()).add(rt['vehicleId'])
    uns = Counter(u['requestId'] for u in result.get('unserved', []))
    vio = Counter(u['requestId'] for u in result.get('commitmentViolations', []))
    for u in result.get('unserved', []) + result.get('commitmentViolations', []):
        if u.get('code') not in _PDP_CODES:
            out.append(f"{u['requestId']}: unknown reason code {u.get('code')}")
    for rid in reqs:
        served = picks[rid] == 1 and drops[rid] == 1
        if (picks[rid], drops[rid]) not in ((0, 0), (1, 1)):
            out.append(f'{rid}: {picks[rid]} pickups / {drops[rid]} drops')
        if served + uns[rid] + vio[rid] != 1:
            out.append(f'{rid}: served={served} unserved={uns[rid]} violation={vio[rid]} (must be exactly one)')
        if uns[rid] and reqs[rid].get('committed'):
            out.append(f'committed {rid} reported unserved (must be a commitment violation)')
    for rid, (vid, _) in onboard.items():
        if picks[rid]:
            out.append(f'onboard {rid} picked up again')
        if drops[rid] + vio[rid] != 1:
            out.append(f'onboard {rid}: {drops[rid]} drops, {vio[rid]} violations')
        if uns[rid]:
            out.append(f'onboard {rid} reported unserved (must be a commitment violation)')
    for rid in set(picks) | set(drops) | set(uns) | set(vio):
        if rid not in reqs and rid not in onboard:
            out.append(f'unknown request {rid} in result')
    if result.get('commitmentViolations') and result.get('status') != 'COMMITMENT_VIOLATION':
        out.append(f"commitment violations reported with status {result.get('status')}")
    if not result.get('commitmentViolations') and result.get('status') == 'COMMITMENT_VIOLATION':
        out.append('status COMMITMENT_VIOLATION without violations')
    for rid, r in reqs.items():
        c = r.get('committed')
        if c and picks[rid] and where.get(rid) != {str(c['vehicleId'])}:
            out.append(f'{rid}: committed to {c["vehicleId"]} but served by {sorted(where.get(rid, []))}')
    for rid, (vid, _) in onboard.items():
        if drops[rid] and where.get(rid) != {vid}:
            out.append(f'onboard {rid}: dropped by {sorted(where.get(rid, []))}, on board {vid}')

    # 2. Routes.
    seen_v = Counter(rt['vehicleId'] for rt in result.get('routes', []))
    for vid, c in seen_v.items():
        if vid not in vehicles or c > 1:
            out.append(f'vehicle {vid}: unknown or used by {c} routes')
    for rt in result.get('routes', []):
        vid = rt['vehicleId']
        v = vehicles.get(vid)
        if v is None:
            continue
        out += _pdp_route(vid, v, rt, reqs, onboard, pax, wch, pref, dur, H)
    return out


def _pdp_route(tag: str, v: dict, rt: dict, reqs: dict, onboard: dict, pax: dict, wch: dict, pref: dict, dur: list,
               H: int) -> list[str]:
    out: list[str] = []
    cap, spaces = int(v['capacity']), int(v.get('wheelchairSpaces') or 0)
    turn = int(v['turnaroundS']) if v.get('turnaroundS') is not None else 120
    avail = int(v.get('availableFromS') or 0)
    shift_end = int(v['shiftEndS']) if v.get('shiftEndS') is not None else H
    breaks = sorted((int(b['startS']), int(b['durationS'])) for b in rt.get('breaks', []))
    vb = sorted((int(b['earliestS']), int(b['latestS']), int(b['durationS'])) for b in (v.get('breaks') or []))
    if len(breaks) != len(vb):
        out.append(f'{tag}: {len(breaks)} breaks reported, {len(vb)} required')
    else:
        for (bs, bd), (e, lt, d) in zip(breaks, vb):
            if bd != d or not e <= bs <= lt:
                out.append(f'{tag}: break at {bs} ({bd} s) outside [{e}, {lt}] / {d} s')
    for (a, da), (b, _) in zip(breaks, breaks[1:]):
        if a + da > b:
            out.append(f'{tag}: breaks overlap')
    for b, d in breaks:
        if b < rt['startS'] < b + d:
            out.append(f'{tag}: break at {b} straddles the route start')
    if rt['startS'] < avail:
        out.append(f'{tag}: starts {rt["startS"]} before availableFromS {avail}')
    loc, dep = int(v['startIndex']), rt['startS']
    ob = [k for k, (ov, _) in onboard.items() if ov == tag]
    load, wc = sum(pax[k] for k in ob), sum(wch[k] for k in ob)
    aboard, picked, visited = set(ob), {}, False
    split, cur = [], []
    for t in rt['trips']:
        for st in t['stops']:
            rid, here = st['requestId'], int(st['locationIndex'])
            r = reqs.get(rid)
            is_p = st['kind'] == 'PICKUP'
            if r is not None:
                exp = int(r['pickupIndex']) if is_p else int(r['dropIndex'])
            else:
                exp = int(onboard[rid][1]['dropIndex'])
            if here != exp:
                out.append(f'{tag}: {rid} wrong location')
            leg = dur[loc][here]
            if leg is None:
                out.append(f'{tag}: null matrix arc {loc}->{here}')
                leg = 0
            tn = turn if (is_p and load == 0 and visited) else 0
            gap_b = sum(d for b, d in breaks if dep <= b and b + d <= st['startS'])
            if st['startS'] < dep + leg + tn + gap_b:
                out.append(f'{tag}: {rid} {st["kind"]} at {st["startS"]} < {dep} + travel {leg} + turnaround {tn}'
                           f' + breaks {gap_b}')
            for b, d in breaks:
                if b < st['departureS'] and st['startS'] < b + d:
                    out.append(f'{tag}: break at {b} overlaps {rid} service')
            if is_p:
                if r is None:
                    out.append(f'{tag}: onboard {rid} picked up')
                    continue
                svc = int(r['pickupServiceS']) if r.get('pickupServiceS') is not None else 60
                c = r.get('committed')
                win = c['pickupWindow'] if c and c.get('pickupWindow') is not None else r['pickupWindow']
                if not int(win[0]) <= st['startS'] <= int(win[1]):
                    out.append(f'{tag}: {rid} pickup {st["startS"]} outside {list(win)}')
                if any(pref[x] == 'PRIVATE' for x in aboard):
                    out.append(f'{tag}: {rid} boards while a PRIVATE passenger is on board')
                if pref[rid] == 'PRIVATE' and load:
                    out.append(f'{tag}: PRIVATE {rid} boards with {load} on board')
                if r.get('allowedVehicleIds') is not None and tag not in [str(x) for x in r['allowedVehicleIds']]:
                    out.append(f'{tag}: {rid} not allowed on this vehicle')
                if r.get('allowedVehicleTypes') is not None and v.get('type') not in r['allowedVehicleTypes']:
                    out.append(f'{tag}: {rid} not allowed on type {v.get("type")}')
                load += pax[rid]
                wc += wch[rid]
                aboard.add(rid)
                picked[rid] = st['startS'] + svc
            else:
                src = r if r is not None else onboard[rid][1]
                svc = int(src['dropServiceS']) if src.get('dropServiceS') is not None else 30
                if rid not in aboard:
                    out.append(f'{tag}: {rid} dropped before pickup')
                elif r is not None:
                    ride = st['startS'] - picked[rid]
                    lim = _pdp_limit(r, dur[int(r['pickupIndex'])][int(r['dropIndex'])])
                    if lim is not None and ride > lim:
                        out.append(f'{tag}: {rid} ride {ride} > limit {lim}')
                    if st.get('rideS') is not None and st['rideS'] != ride:
                        out.append(f'{tag}: {rid} rideS {st["rideS"]} != {ride}')
                    if r.get('arriveByS') is not None and st['startS'] > int(r['arriveByS']):
                        out.append(f'{tag}: {rid} drop {st["startS"]} after arriveByS')
                else:
                    db = onboard[rid][1].get('dropByS')
                    if db is not None and st['startS'] > int(db):
                        out.append(f'{tag}: onboard {rid} drop {st["startS"]} after dropByS {db}')
                load -= pax[rid]
                wc -= wch[rid]
                aboard.discard(rid)
            if st['departureS'] != st['startS'] + svc:
                out.append(f'{tag}: {rid} departure mismatch')
            if load > cap:
                out.append(f'{tag}: load {load} > capacity {cap} at {rid}')
            if wc > spaces:
                out.append(f'{tag}: wheelchair {wc} > spaces {spaces} at {rid}')
            if st.get('load') is not None and st['load'] != load:
                out.append(f'{tag}: {rid} reported load {st["load"]} != {load}')
            cur.append(st)
            if load == 0:
                split.append(cur)
                cur = []
            loc, dep, visited = here, st['departureS'], True
    if cur:
        split.append(cur)
    if aboard:
        out.append(f'{tag}: route ends with {sorted(aboard)} on board')
    # Trips are exactly the load-zero segments; PRIVATE is alone on its whole trip; servedAs labels.
    if [[id(st) for st in s] for s in split] != [[id(st) for st in t['stops']] for t in rt['trips']]:
        out.append(f'{tag}: reported trips do not split where the load returns to 0')
    for t in rt['trips']:
        ids = {st['requestId'] for st in t['stops']}
        for rid in ids:
            if pref[rid] == 'PRIVATE' and len(ids) > 1:
                out.append(f'{tag}: PRIVATE {rid} shares trip {t.get("tripIndex")} with {sorted(ids - {rid})}')
        for st in t['stops']:
            sa = st.get('servedAs')
            if sa is None:
                continue
            p = pref[st['requestId']]
            want = 'PRIVATE' if p == 'PRIVATE' or (p == 'FLEXIBLE' and len(ids) == 1) else 'SHARED'
            if sa != want:
                out.append(f'{tag}: {st["requestId"]} servedAs {sa}, expected {want}')
    end_loc = v.get('endIndex')
    leg = 0 if end_loc is None else (dur[loc][int(end_loc)] or 0)
    if rt['endS'] < dep + leg:
        out.append(f'{tag}: endS {rt["endS"]} before {dep + leg}')
    if rt['endS'] > shift_end:
        out.append(f'{tag}: endS {rt["endS"]} after shiftEndS {shift_end}')
    if v.get('maxSpanS') is not None and rt['endS'] - rt['startS'] > int(v['maxSpanS']):
        out.append(f'{tag}: span {rt["endS"] - rt["startS"]} > maxSpanS {v["maxSpanS"]}')
    return out
