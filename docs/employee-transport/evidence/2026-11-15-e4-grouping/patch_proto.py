"""Applies the prototype changes to scratchpad/solver_proto.py (a copy of services/routing-optimizer/optimizer/solver.py)."""
import sys
from pathlib import Path

p = Path(sys.argv[1])
s = p.read_text(encoding='utf-8')


def rep(old, new, count=1):
    global s
    assert s.count(old) == count, (old[:80], s.count(old))
    s = s.replace(old, new)


# 1. weights: new integer key rideTime (cost per passenger-second of ride, trip mode only).
rep("""    out = {k: _num(w.get(k), f'options.weights.{k}') or 0 for k in ('vehicle', 'distance', 'time', 'routeDuration')}""",
    """    out = {k: _num(w.get(k), f'options.weights.{k}') or 0 for k in ('vehicle', 'distance', 'time', 'routeDuration', 'rideTime')}""")

# 2. Ride dimension also when rideTime is weighted; soft cost on every pickup's ride cumul.
rep("""    if trip and any(s['maxRide'] is not None for s in active):
        routing.AddDimension(time_idx, dim_cap, dim_cap, True, 'Ride')
        ride = routing.GetDimensionOrDie('Ride')
        for idx in range(routing.Size()):
            solver.Add(ride.SlackVar(idx) == tdim.SlackVar(idx))
        for k, s in enumerate(active):
            if s['maxRide'] is not None:
                ride.CumulVar(manager.NodeToIndex(nd + k)).SetMax(s['maxRide'])""",
    """    ride_w = int(round(w.get('rideTime') or 0)) if (w and trip) else 0
    if trip and (ride_w or any(s['maxRide'] is not None for s in active)):
        routing.AddDimension(time_idx, dim_cap, dim_cap, True, 'Ride')
        ride = routing.GetDimensionOrDie('Ride')
        for idx in range(routing.Size()):
            solver.Add(ride.SlackVar(idx) == tdim.SlackVar(idx))
        for k, s in enumerate(active):
            if s['maxRide'] is not None:
                ride.CumulVar(manager.NodeToIndex(nd + k)).SetMax(s['maxRide'])
            if ride_w:
                # Sum of passenger ride times (s) x rideTime: comfort as a cost, not only a cap.
                ride.SetCumulVarSoftUpperBound(manager.NodeToIndex(nd + k), 0, ride_w * max(1, s['demand']))""")

# penalty must dominate ride costs too.
rep("""    penalty_base = max(DROP_PENALTY, 2 * (int(round(max(fixed, default=0))) + (nn + 1) * max_arc + span_w * dim_cap) + 1)""",
    """    ride_w_pen = int(round((w or {}).get('rideTime') or 0)) if trip else 0
    penalty_base = max(DROP_PENALTY, 2 * (int(round(max(fixed, default=0))) + (nn + 1) * max_arc + span_w * dim_cap
                                          + ride_w_pen * dim_cap * max(1, sum(s['demand'] for s in active))) + 1)""")

# 3. Post-solve reason classification for dropped stops (trip mode).
rep("""            else:
                code = 'CAPACITY_EXHAUSTED' if need > seats else 'TIME_LIMIT' if hit_limit else 'NOT_SCHEDULED'
                unassigned.append(_unassigned(s, 'not_scheduled_capacity_or_time', None, code))""",
    """            else:
                code, detail = _classify_drop(ctx, s, mv, mf, routes, need, seats, hit_limit)
                unassigned.append(_unassigned(s, 'not_scheduled_capacity_or_time', detail, code))""")

s += '''


def _ride_times_in(ctx, seq_locs, svc, site):
    """IN trip: ride time (s) of each pickup for a forward pickup sequence ending at the site, picking up as late as
    possible (no waits): ride(i) = sum of service + legs from pickup i to the site."""
    rides, acc = [], 0
    for i in range(len(seq_locs) - 1, -1, -1):
        nxt = site if i == len(seq_locs) - 1 else seq_locs[i + 1]
        leg = ctx.dur[seq_locs[i]][nxt]
        if leg is None:
            return None
        acc += svc[i] + leg
        rides.append(acc)
    return list(reversed(rides))


def _classify_drop(ctx, s, mv, mf, routes, need, seats, hit_limit):
    """Why a pre-check-feasible stop was left out (prototype).

    - TIME_LIMIT only when a compatible vehicle stayed unused (the search, not the problem, is the limit);
    - CAPACITY_EXHAUSTED when every compatible vehicle is in use and none has a free seat (or seats < demand overall);
    - otherwise FLEET_TOO_SMALL with the binding constraint: inserting the stop anywhere into a used compatible route
      with a free seat breaks the max ride of someone on board ('max_ride') or the site window / vehicle start
      ('time_window')."""
    allowed = {mv[k]['id'] for k in s['_allowed']}
    used = {r['vehicleId'] for r in routes}
    if need > seats:
        return 'CAPACITY_EXHAUSTED', {'seatsNeeded': need, 'seats': seats}
    if allowed - used:
        return ('TIME_LIMIT' if hit_limit else 'NOT_SCHEDULED'), {'unusedVehicles': len(allowed - used)}
    free = [r for r in routes if r['vehicleId'] in allowed and r.get('seats') is not None and r['seats'] - (r.get('load') or 0) >= s['demand']]
    if not free:
        return 'CAPACITY_EXHAUSTED', {'freeSeats': 0}
    trip = ctx.trip
    if not trip or trip['direction'] != 'IN':
        return 'FLEET_TOO_SMALL', {'freeSeats': sum(r['seats'] - (r.get('load') or 0) for r in free)}
    site = trip['site']
    stop_by_id = {x['id']: x for x in ctx.stops}
    binding = set()
    for r in free:
        locs = [v['locationIndex'] for v in r['stops']]
        svc = [stop_by_id[v['stopId']]['service'] for v in r['stops']]
        caps = [stop_by_id[v['stopId']]['maxRide'] for v in r['stops']]
        arrive = r.get('siteArrivalS')
        for pos in range(len(locs) + 1):
            L = locs[:pos] + [s['loc']] + locs[pos:]
            SV = svc[:pos] + [s['service']] + svc[pos:]
            C = caps[:pos] + [s['maxRide']] + caps[pos:]
            rides = _ride_times_in(ctx, L, SV, site)
            if rides is None:
                binding.add('unreachable'); continue
            if any(c is not None and rd > c for rd, c in zip(rides, C)):
                binding.add('max_ride'); continue
            if arrive is not None and arrive - rides[0] < 0:
                binding.add('time_window'); continue
            return ('TIME_LIMIT' if hit_limit else 'NOT_SCHEDULED'), {'insertableInto': r['vehicleId']}
    return 'FLEET_TOO_SMALL', {'binding': sorted(binding), 'freeSeats': sum(r['seats'] - (r.get('load') or 0) for r in free)}
'''
p.write_text(s, encoding='utf-8')
print('patched')
