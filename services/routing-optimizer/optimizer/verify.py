"""Independent re-check of a solve result against the raw problem (doc 06 §4.5: "a validator that re-checks").

`verify(problem, result) -> list[str]` returns human-readable violations; an empty list means every hard constraint
holds. It reads the raw problem JSON (not the solver's normalised model) and recomputes times from the matrix, so a
modelling error in `solver.py` shows up here. Used by the tests and the corpus runner; the API can mirror it.
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
    return out
