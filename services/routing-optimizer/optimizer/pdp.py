"""Contract v3 `mode: "pdp"`: on-demand pickup-and-delivery pooling (doc 20 §4, prototype evidence/2026-11-15-pooling).

Pure function `solve_pdp(problem) -> result`, dispatched from `solver.solve` when `problem["mode"] == "pdp"`. Times are
integer seconds from the caller's plan epoch; the matrix is indexed by location index, `None` = no route.

Model (OR-Tools routing):

* Each request = a pickup and a drop on the same vehicle, pickup first (`AddPickupAndDeliverySets` + explicit
  vehicle / activity / time constraints), both served or both dropped.
* **Trips** are the segments where the vehicle load returns to 0. Every non-PRIVATE pickup has two alternative nodes
  (one active): `S` "starts a trip" (load before = 0) and `J` "joins a trip" (load before >= 1). A PRIVATE request
  has only an `S` node. The arc into an `S` node carries the vehicle's `turnaroundS` unless it leaves the vehicle start,
  so turnaround between trips is exact and the reported trips are exactly the model's trips.
* **PRIVATE = whole-trip exclusivity**: an `Excl` dimension (private pickup +BIG, drop -BIG; others +-passengers,
  capacity BIG). A private pickup starts a trip (nobody on board) and nobody may board until its drop, after which the
  load is 0 again, so the private request is alone on its trip. FLEXIBLE is solved as shared-eligible and labelled
  `servedAs: PRIVATE` when alone on its trip.
* Hard per request: pickup window (= the accepted max wait), max ride = min(maxRideS, max(direct x ratio,
  direct + extraS)) measured from pickup service end to drop service start, optional arriveByS, seats, wheelchair
  spaces, allowed vehicles / types. Vehicles: start position, availableFromS, shiftEndS, maxSpanS, break intervals,
  passengers already on board (drop-only nodes with dropByS).
* Committed requests stay on their vehicle with their committed pickup window; their drop penalty is x1000. A
  committed request the solver still cannot serve is reported in `commitmentViolations` and the status is
  `COMMITMENT_VIOLATION` (the caller must not write the result).
* Drop penalty per request = base x priority x passengers; priority = options.priorityWeights[preference] (default
  PRIVATE 3, FLEXIBLE 1.5, SHARED 1) x request.priority (default 1).
* `options.warmStart` seeds the search from the current routes; `options.insertOnly` skips OR-Tools and inserts each
  uncommitted request at its cheapest feasible position into the warm-start routes (committed order never changes).

Unserved requests get a reason code from a pre-check (alone on an empty vehicle) or, after the solve, from an
insertion re-check into the final routes (README "pdp reason codes").
"""
from __future__ import annotations

import math
import time
from typing import Any

from ortools.constraint_solver import pywrapcp

from .solver import (BIG_COST, FIRST_SOLUTION, LIMITS, LOCAL_SEARCH, MAX_TOTAL_COST, UNREACHABLE, InvalidProblem,
                     _int_matrix, _num, _status_name, _str_set)

PDP_SCHEMA_VERSION = 3
PDP_LIMITS = {'requests': 250, 'vehicles': LIMITS['vehicles'], 'locations': LIMITS['locations'],
              'timeLimitS': LIMITS['timeLimitS'], 'horizonS': 7 * 86400, 'capacity': 100, 'passengersPerRequest': 50,
              'breaksPerVehicle': 4, 'allowedVehicleIds': 100, 'warmStartTokens': 1000}
PREFERENCES = ('SHARED', 'PRIVATE', 'FLEXIBLE')
DEFAULT_PRIORITY = {'PRIVATE': 3.0, 'FLEXIBLE': 1.5, 'SHARED': 1.0}
MAX_PRIORITY = 100
MAX_WEIGHT = 1e4             # time / distance / wait / rideTime
MAX_VEHICLE_WEIGHT = 1e7
MAX_RATIO = 10
MAX_SERVICE_S = 3600
DEFAULT_PICKUP_SERVICE_S = 60
DEFAULT_DROP_SERVICE_S = 30
DEFAULT_TURNAROUND_S = 120
MAX_TURNAROUND_S = 4 * 3600
COMMITTED_FACTOR = 1000
EXCL_BIG = 10**5             # > any seat count
BASE_PENALTY = 10**7
COST_SCALE_FRACTIONAL = 100
CLASSIFY_BUDGET_S = 1.0
MAX_TURN_BUCKETS = 3
REPAIR_BUDGET_S = 1.0
STRATEGIES = {
    'BALANCED': {'vehicle': 3600, 'time': 1, 'wait': 1, 'rideTime': 1},
    'MAX_UTILISATION': {'vehicle': 20000, 'time': 1},
    'SHORTEST_DISTANCE': {'vehicle': 2000, 'distance': 1},
    'FASTEST_PICKUP': {'vehicle': 1800, 'time': 1, 'wait': 3},
    'COMFORT': {'vehicle': 1800, 'time': 1, 'rideTime': 2},
    'MINIMUM_VEHICLES': {'vehicle': 50000, 'time': 1},
}
WEIGHT_KEYS = ('vehicle', 'time', 'distance', 'wait', 'rideTime')
REASON_CODES = ('PICKUP_WINDOW', 'VEHICLE_TIME', 'MAX_RIDE', 'CAPACITY', 'PRIVATE_NEEDS_EMPTY_VEHICLE', 'DRIVER_HOURS',
                'NO_COMPATIBLE_VEHICLE', 'ROUTING_UNAVAILABLE', 'NOT_SELECTED')
_CODE_ORDER = ('PRIVATE_NEEDS_EMPTY_VEHICLE', 'CAPACITY', 'PICKUP_WINDOW', 'MAX_RIDE', 'DRIVER_HOURS', 'VEHICLE_TIME',
               'ROUTING_UNAVAILABLE')


# ----------------------------------------------------------------------------------------------------------------
# Validation
# ----------------------------------------------------------------------------------------------------------------

def _int(x: Any, what: str, lo: int, hi: int, default: int | None = None) -> int | None:
    if x is None:
        if default is None:
            return None
        return default
    if isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x) or x != int(x):
        raise InvalidProblem(f'{what} must be an integer')
    x = int(x)
    if not lo <= x <= hi:
        raise InvalidProblem(f'{what} must be within [{lo}, {hi}]')
    return x


def _pair(w: Any, what: str, horizon: int) -> tuple[int, int]:
    if not (isinstance(w, (list, tuple)) and len(w) == 2):
        raise InvalidProblem(f'{what} must be [startS, endS]')
    a, b = _int(w[0], what, 0, horizon), _int(w[1], what, 0, horizon)
    if a > b:
        raise InvalidProblem(f'{what} must satisfy startS <= endS')
    return a, b


def _loc(x: Any, what: str, n: int) -> int:
    if x is None:
        raise InvalidProblem(f'{what} is required')
    return _int(x, what, 0, n - 1)


def _float(x: Any, what: str, lo: float, hi: float, default: float) -> float:
    if x is None:
        return default
    v = _num(x, what)
    if not lo <= v <= hi:
        raise InvalidProblem(f'{what} must be within [{lo:g}, {hi:g}]')
    return float(v)


def _weights(opts: dict, has_dist: bool) -> tuple[str, dict]:
    strategy = opts.get('strategy') or 'BALANCED'
    if not isinstance(strategy, str) or strategy not in STRATEGIES:
        raise InvalidProblem(f'options.strategy must be one of {sorted(STRATEGIES)}')
    w = {k: 0 for k in WEIGHT_KEYS}
    w.update(STRATEGIES[strategy])
    raw = opts.get('weights')
    if raw is not None:
        if not isinstance(raw, dict):
            raise InvalidProblem('options.weights must be an object')
        for k in WEIGHT_KEYS:
            if raw.get(k) is not None:
                w[k] = _float(raw[k], f'options.weights.{k}', 0,
                              MAX_VEHICLE_WEIGHT if k == 'vehicle' else MAX_WEIGHT, 0)
    if w['distance'] and not has_dist:
        raise InvalidProblem('options.weights.distance (strategy SHORTEST_DISTANCE) needs matrix.distancesM')
    if not (w['time'] or w['distance']):
        raise InvalidProblem('options.weights needs time or distance > 0')
    return strategy, w


def validate_pdp(problem: dict) -> dict:
    if problem.get('schemaVersion') != PDP_SCHEMA_VERSION:
        raise InvalidProblem('mode "pdp" needs schemaVersion 3')
    matrix = problem.get('matrix')
    if not isinstance(matrix, dict) or matrix.get('durationsS') is None:
        raise InvalidProblem('matrix.durationsS is required')
    raw = matrix['durationsS']
    n = len(raw) if isinstance(raw, list) else 0
    if not 1 <= n <= PDP_LIMITS['locations']:
        raise InvalidProblem(f"matrix must have 1..{PDP_LIMITS['locations']} locations")
    dur = _int_matrix(raw, n, 'matrix.durationsS')
    dist = _int_matrix(matrix['distancesM'], n, 'matrix.distancesM') if matrix.get('distancesM') is not None else None
    if any(c is not None and c > PDP_LIMITS['horizonS'] for r in dur for c in r):
        raise InvalidProblem('matrix.durationsS cells must be <= 7 days')
    if dist is not None and any(c is not None and c > 10**8 for r in dist for c in r):
        raise InvalidProblem('matrix.distancesM cells must be <= 1e8')
    H = _int(problem.get('horizonS'), 'horizonS', 1, PDP_LIMITS['horizonS'], 86400)
    opts = problem.get('options') or {}
    if not isinstance(opts, dict):
        raise InvalidProblem('options must be an object')
    strategy, weights = _weights(opts, dist is not None)
    for key in ('timeLimitS',):
        v = opts.get(key)
        if v is not None and (isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v)):
            raise InvalidProblem(f'options.{key} must be a finite number')
    if opts.get('firstSolution') is not None and (not isinstance(opts['firstSolution'], str)
                                                  or opts['firstSolution'] not in FIRST_SOLUTION):
        raise InvalidProblem(f'options.firstSolution must be one of {sorted(FIRST_SOLUTION)}')
    if opts.get('localSearch') is not None and (not isinstance(opts['localSearch'], str)
                                                or opts['localSearch'] not in LOCAL_SEARCH):
        raise InvalidProblem(f'options.localSearch must be one of {sorted(LOCAL_SEARCH)}')
    if opts.get('insertOnly') is not None and not isinstance(opts['insertOnly'], bool):
        raise InvalidProblem('options.insertOnly must be a boolean')
    prio_w = dict(DEFAULT_PRIORITY)
    pw = opts.get('priorityWeights')
    if pw is not None:
        if not isinstance(pw, dict) or any(k not in PREFERENCES for k in pw):
            raise InvalidProblem(f'options.priorityWeights keys must be in {list(PREFERENCES)}')
        for k, v in pw.items():
            prio_w[k] = _float(v, f'options.priorityWeights.{k}', 0.01, MAX_PRIORITY, prio_w[k])

    vehicles = problem.get('vehicles')
    if not isinstance(vehicles, list) or not 1 <= len(vehicles) <= PDP_LIMITS['vehicles']:
        raise InvalidProblem(f"1..{PDP_LIMITS['vehicles']} vehicles required")
    requests = problem.get('requests') if problem.get('requests') is not None else []
    if not isinstance(requests, list) or len(requests) > PDP_LIMITS['requests']:
        raise InvalidProblem(f"requests must be an array of at most {PDP_LIMITS['requests']} requests")

    req: dict[str, dict] = {}
    vehs, vids = [], set()
    for i, v in enumerate(vehicles):
        if not isinstance(v, dict):
            raise InvalidProblem('each vehicle must be an object')
        vid = str(v.get('id', f'vehicle-{i}'))
        if vid in vids:
            raise InvalidProblem(f'duplicate vehicle id {vid}')
        vids.add(vid)
        w = f'vehicle {vid}'
        avail = _int(v.get('availableFromS'), f'{w} availableFromS', 0, H, 0)
        shift_end = _int(v.get('shiftEndS'), f'{w} shiftEndS', 0, H, H)
        if avail > shift_end:
            raise InvalidProblem(f'{w}: availableFromS must be <= shiftEndS')
        cap = _int(v.get('capacity'), f'{w} capacity', 1, PDP_LIMITS['capacity'])
        if cap is None:
            raise InvalidProblem(f'{w}: capacity is required')
        wc = _int(v.get('wheelchairSpaces'), f'{w} wheelchairSpaces', 0, cap, 0)
        breaks_raw = v.get('breaks') or []
        if not isinstance(breaks_raw, list) or len(breaks_raw) > PDP_LIMITS['breaksPerVehicle']:
            raise InvalidProblem(f"{w}: at most {PDP_LIMITS['breaksPerVehicle']} breaks")
        breaks = []
        for b in breaks_raw:
            if not isinstance(b, dict):
                raise InvalidProblem(f'{w}: each break must be an object')
            e = _int(b.get('earliestS'), f'{w} break earliestS', 0, H)
            lt = _int(b.get('latestS'), f'{w} break latestS', 0, H)
            d = _int(b.get('durationS'), f'{w} break durationS', 1, 12 * 3600)
            if e is None or lt is None or d is None or e > lt:
                raise InvalidProblem(f'{w}: break needs earliestS <= latestS and durationS')
            breaks.append((e, lt, d))
        breaks.sort()
        end_raw = v.get('endIndex')
        nv = {'id': vid, 'k': i, 'start': _loc(v.get('startIndex'), f'{w} startIndex', n),
              'end': None if end_raw is None else _loc(end_raw, f'{w} endIndex', n),
              'avail': avail, 'shiftEnd': shift_end,
              'span': _int(v.get('maxSpanS'), f'{w} maxSpanS', 1, H),
              'cap': cap, 'wc': wc, 'type': None if v.get('type') is None else str(v['type']),
              'turn': _int(v.get('turnaroundS'), f'{w} turnaroundS', 0, MAX_TURNAROUND_S, DEFAULT_TURNAROUND_S),
              'breaks': breaks, 'onboard': []}
        ob = v.get('onboard') or []
        if not isinstance(ob, list) or len(ob) > cap:
            raise InvalidProblem(f'{w}: onboard must be an array of at most capacity entries')
        for o in ob:
            if not isinstance(o, dict) or o.get('requestId') is None:
                raise InvalidProblem(f'{w}: each onboard entry needs requestId')
            rid = str(o['requestId'])
            if rid in req:
                raise InvalidProblem(f'duplicate request id {rid}')
            pref = o.get('preference') or 'SHARED'
            if pref not in PREFERENCES:
                raise InvalidProblem(f'onboard {rid}: preference must be one of {list(PREFERENCES)}')
            pax = _int(o.get('passengers'), f'onboard {rid} passengers', 1, cap, 1)
            req[rid] = {'id': rid, 'onboard': True, 'p': None, 'd': _loc(o.get('dropIndex'), f'onboard {rid} dropIndex', n),
                        'n': pax, 'wc': _int(o.get('wheelchair'), f'onboard {rid} wheelchair', 0, pax, 0),
                        'pref': pref, 'win': (0, H), 'arrive': _int(o.get('dropByS'), f'onboard {rid} dropByS', 0, H),
                        'limit': None, 'direct': None, 'svcP': 0,
                        'svcD': _int(o.get('dropServiceS'), f'onboard {rid} dropServiceS', 0, MAX_SERVICE_S,
                                     DEFAULT_DROP_SERVICE_S),
                        'prio': 1.0, 'ids': None, 'types': None, 'committed': vid, 'commitWin': None}
            nv['onboard'].append(rid)
        if sum(req[r]['n'] for r in nv['onboard']) > cap or sum(req[r]['wc'] for r in nv['onboard']) > wc:
            raise InvalidProblem(f'{w}: onboard passengers exceed capacity / wheelchair spaces')
        vehs.append(nv)
    vmap = {v['id']: v for v in vehs}

    for i, r in enumerate(requests):
        if not isinstance(r, dict):
            raise InvalidProblem('each request must be an object')
        rid = str(r.get('id', f'request-{i}'))
        if rid in req:
            raise InvalidProblem(f'duplicate request id {rid}')
        w = f'request {rid}'
        pref = r.get('preference') or 'SHARED'
        if pref not in PREFERENCES:
            raise InvalidProblem(f'{w}: preference must be one of {list(PREFERENCES)}')
        p, d = _loc(r.get('pickupIndex'), f'{w} pickupIndex', n), _loc(r.get('dropIndex'), f'{w} dropIndex', n)
        if r.get('pickupWindow') is None:
            raise InvalidProblem(f'{w}: pickupWindow is required')
        win = _pair(r['pickupWindow'], f'{w} pickupWindow', H)
        pax = _int(r.get('passengers'), f'{w} passengers', 1, PDP_LIMITS['passengersPerRequest'], 1)
        max_ride = _int(r.get('maxRideS'), f'{w} maxRideS', 1, H)
        det = r.get('detour')
        ratio = extra = None
        if det is not None:
            if not isinstance(det, dict):
                raise InvalidProblem(f'{w}: detour must be an object')
            ratio = _float(det.get('ratio'), f'{w} detour.ratio', 1, MAX_RATIO, 1.0)
            extra = _int(det.get('extraS'), f'{w} detour.extraS', 0, H, 0)
        direct = dur[p][d]
        limit = max_ride
        if det is not None and direct is not None:
            dl = max(int(math.floor(direct * ratio + 1e-9)), direct + extra)
            limit = dl if limit is None else min(limit, dl)
        committed, cwin = None, None
        c = r.get('committed')
        if c is not None:
            if not isinstance(c, dict) or c.get('vehicleId') is None:
                raise InvalidProblem(f'{w}: committed needs vehicleId')
            committed = str(c['vehicleId'])
            if committed not in vmap:
                raise InvalidProblem(f'{w}: committed to unknown vehicle {committed}')
            if c.get('pickupWindow') is not None:
                cwin = _pair(c['pickupWindow'], f'{w} committed.pickupWindow', H)
        ids = _str_set(r.get('allowedVehicleIds'), f'{w} allowedVehicleIds')
        if ids is not None and len(ids) > PDP_LIMITS['allowedVehicleIds']:
            raise InvalidProblem(f'{w}: too many allowedVehicleIds')
        types = _str_set(r.get('allowedVehicleTypes'), f'{w} allowedVehicleTypes')
        req[rid] = {'id': rid, 'onboard': False, 'p': p, 'd': d, 'n': pax,
                    'wc': _int(r.get('wheelchair'), f'{w} wheelchair', 0, pax, 0), 'pref': pref,
                    'win': cwin if cwin is not None else win, 'requested': win,
                    'arrive': _int(r.get('arriveByS'), f'{w} arriveByS', 0, H),
                    'limit': limit, 'direct': direct,
                    'svcP': _int(r.get('pickupServiceS'), f'{w} pickupServiceS', 0, MAX_SERVICE_S,
                                 DEFAULT_PICKUP_SERVICE_S),
                    'svcD': _int(r.get('dropServiceS'), f'{w} dropServiceS', 0, MAX_SERVICE_S, DEFAULT_DROP_SERVICE_S),
                    'prio': prio_w[pref] * _float(r.get('priority'), f'{w} priority', 0.01, MAX_PRIORITY, 1.0),
                    'ids': ids, 'types': types, 'committed': committed, 'commitWin': cwin}

    warm_raw = opts.get('warmStart')
    warm: dict[str, list[tuple[str, str]]] = {}
    if warm_raw is not None:
        if not isinstance(warm_raw, dict):
            raise InvalidProblem('options.warmStart must be an object {vehicleId: ["P:id", "D:id", ...]}')
        total = 0
        for vid, toks in warm_raw.items():
            if not isinstance(toks, list):
                raise InvalidProblem('options.warmStart values must be arrays')
            total += len(toks)
            if total > PDP_LIMITS['warmStartTokens']:
                raise InvalidProblem('options.warmStart is too long')
            seq = []
            for t in toks:
                if not isinstance(t, str) or t[:2] not in ('P:', 'D:'):
                    raise InvalidProblem('options.warmStart tokens must be "P:<requestId>" or "D:<requestId>"')
                seq.append((t[0], t[2:]))
            warm[str(vid)] = seq
    return {'n': n, 'dur': dur, 'dist': dist, 'H': H, 'vehs': vehs, 'vmap': vmap, 'req': req,
            'strategy': strategy, 'w': weights, 'opts': opts, 'warm': warm, 'prioW': prio_w,
            'insertOnly': bool(opts.get('insertOnly'))}


# ----------------------------------------------------------------------------------------------------------------
# Route simulation (insertOnly, pre-checks, reasons). Forward earliest times; same semantics as the model / verify.
# ----------------------------------------------------------------------------------------------------------------

def _compatible(v: dict, r: dict) -> bool:
    if r['committed'] is not None:
        return r['committed'] == v['id']
    if r['n'] > v['cap'] or r['wc'] > v['wc']:
        return False
    if r['ids'] is not None and v['id'] not in r['ids']:
        return False
    if r['types'] is not None and v['type'] not in r['types']:
        return False
    return True


class _Sim:
    """Mutable route state; `step` visits one stop and returns the first violation (tag, requestId) or None."""
    __slots__ = ('t', 'loc', 'visited', 'load', 'wc', 'aboard', 'priv', 'picked', 'pending', 'taken', 'stops',
                 'first_start')

    @classmethod
    def start(cls, pb: dict, v: dict, empty: bool = False) -> '_Sim':
        s = cls()
        R = pb['req']
        ob = [] if empty else v['onboard']
        s.t, s.loc, s.visited = v['avail'], v['start'], False
        s.load = sum(R[x]['n'] for x in ob)
        s.wc = sum(R[x]['wc'] for x in ob)
        s.aboard = set(ob)
        s.priv = sum(1 for x in ob if R[x]['pref'] == 'PRIVATE')
        s.picked = {}
        s.pending, s.taken = [], []
        for b in v['breaks']:
            if b[0] + b[2] <= v['avail']:
                s.taken.append((b[0], b[2]))      # off duty before the vehicle is available
            else:
                s.pending.append(b)
        s.stops = []
        s.first_start = None
        return s

    def copy(self) -> '_Sim':
        c = _Sim()
        c.t, c.loc, c.visited, c.load, c.wc, c.priv = self.t, self.loc, self.visited, self.load, self.wc, self.priv
        c.aboard, c.picked = set(self.aboard), dict(self.picked)
        c.pending, c.taken, c.stops = list(self.pending), list(self.taken), list(self.stops)
        c.first_start = self.first_start
        return c

    def step(self, pb: dict, v: dict, kind: str, rid: str) -> tuple[str, str | None] | None:
        r = pb['req'][rid]
        dest = r['p'] if kind == 'P' else r['d']
        leg = pb['dur'][self.loc][dest]
        if leg is None:
            return ('unreachable', rid)
        turn = v['turn'] if (kind == 'P' and self.load == 0 and self.visited) else 0
        lo = r['win'][0] if kind == 'P' else 0
        svc = r['svcP'] if kind == 'P' else r['svcD']
        while self.pending:
            e, lt, d = self.pending[0]
            bs = max(self.t, e)
            if bs > lt:
                return ('break', None)
            start_nb = max(self.t + leg + turn, lo)
            if bs + d + leg + turn <= start_nb or max(start_nb + svc, e) > lt:
                self.taken.append((bs, d))
                self.t = bs + d
                self.pending.pop(0)
                continue
            break
        arr = self.t + leg
        start = max(arr + turn, lo)
        if kind == 'P':
            if start > r['win'][1]:
                return ('pickup_window', rid)
            if self.priv or (r['pref'] == 'PRIVATE' and self.load > 0):
                return ('private', rid)
            self.load += r['n']
            self.wc += r['wc']
            if self.load > v['cap'] or self.wc > v['wc']:
                return ('capacity', rid)
            self.picked[rid] = start
            self.aboard.add(rid)
            if r['pref'] == 'PRIVATE':
                self.priv += 1
        else:
            if rid not in self.aboard:
                return ('precedence', rid)
            if rid in self.picked and r['limit'] is not None and start - (self.picked[rid] + r['svcP']) > r['limit']:
                return ('max_ride', rid)
            if r['arrive'] is not None and start > r['arrive']:
                return ('arrive_by', rid)
            self.load -= r['n']
            self.wc -= r['wc']
            self.aboard.discard(rid)
            if r['pref'] == 'PRIVATE':
                self.priv -= 1
        if self.first_start is None:
            self.first_start = start
        self.stops.append((kind, rid, arr, start, turn))
        self.t, self.loc, self.visited = start + svc, dest, True
        return None

    def finish(self, pb: dict, v: dict) -> tuple[tuple[str, str | None] | None, int, int]:
        """(violation, route startS, route endS)."""
        end = self.t
        if v['end'] is not None:
            leg = pb['dur'][self.loc][v['end']]
            if leg is None:
                return ('unreachable', None), v['avail'], end
            end += leg
        for e, lt, d in self.pending:
            bs = max(end, e)
            if bs > lt:
                return ('break', None), v['avail'], end
            self.taken.append((bs, d))
        self.pending = []
        rstart = v['avail']
        if self.stops and not any(v['avail'] <= b < self.stops[0][3] for b, _ in self.taken):
            k, rid, arr, st, turn = self.stops[0]
            rstart += st - arr - turn          # leave later instead of waiting at the first stop
        if end > v['shiftEnd']:
            return ('shift_end', None), rstart, end
        if v['span'] is not None and end - rstart > v['span']:
            return ('span', None), rstart, end
        return None, rstart, end


def _run(pb: dict, v: dict, seq: list[tuple[str, str]], empty: bool = False):
    s = _Sim.start(pb, v, empty)
    for kind, rid in seq:
        bad = s.step(pb, v, kind, rid)
        if bad:
            return bad, s, None, None
    bad, rs, re_ = s.finish(pb, v)
    return bad, s, rs, re_


def _code(tag: str, rid: str | None, me: dict) -> str:
    own = rid == me['id']
    if tag == 'unreachable':
        return 'ROUTING_UNAVAILABLE'
    if tag == 'capacity':
        return 'CAPACITY'
    if tag == 'private':
        return 'PRIVATE_NEEDS_EMPTY_VEHICLE' if me['pref'] == 'PRIVATE' else 'CAPACITY'
    if tag in ('span', 'break'):
        return 'DRIVER_HOURS'
    if tag == 'shift_end':
        return 'VEHICLE_TIME'
    if own and tag == 'pickup_window':
        return 'PICKUP_WINDOW'
    if own and tag in ('max_ride', 'arrive_by'):
        return 'MAX_RIDE'
    return 'VEHICLE_TIME'                      # another passenger's commitment / the vehicle's schedule has no room


def _pick_code(counts: dict[str, int]) -> str:
    return max(counts, key=lambda c: (counts[c], -_CODE_ORDER.index(c)))


def _arc(pb: dict, a: int | None, b: int | None, key: str) -> int:
    m = pb['dur'] if key == 'dur' else pb['dist']
    if m is None or a is None or b is None:
        return 0
    return m[a][b] or 0


def _locs(pb: dict, v: dict, seq: list[tuple[str, str]]) -> list[int]:
    R = pb['req']
    return [v['start']] + [R[x]['p'] if k == 'P' else R[x]['d'] for k, x in seq]


def _insert(pb: dict, v: dict, base: list[tuple[str, str]], rid: str, scale_cost: bool = True,
            deadline: float | None = None):
    """Cheapest feasible insertion of `rid` into `base` on vehicle v. Returns (best | None, failure code counts,
    timed_out). best = (cost, i, j)."""
    R, w = pb['req'], pb['w']
    r = R[rid]
    counts: dict[str, int] = {}
    # Prefix states and the base schedule (departures) for the convergence shortcut.
    s = _Sim.start(pb, v)
    prefix = [s.copy()]
    base_dep = []
    for kind, x in base:
        if s.step(pb, v, kind, x):
            return None, {'VEHICLE_TIME': 1}, False      # base route itself infeasible (should not happen)
        prefix.append(s.copy())
        base_dep.append((s.t, len(s.pending)))
    locs = _locs(pb, v, base)
    best = None
    L = len(base)
    priv = r['pref'] == 'PRIVATE'
    for i in range(L + 1):
        if deadline is not None and time.perf_counter() > deadline:
            return best, counts, True
        if prefix[i].t > r['win'][1]:
            counts['PICKUP_WINDOW'] = counts.get('PICKUP_WINDOW', 0) + 1
            break                                  # later positions only leave later
        st0 = prefix[i].copy()
        bad = st0.step(pb, v, 'P', rid)
        if bad:
            c = _code(*bad, r)
            counts[c] = counts.get(c, 0) + 1
            continue
        pick_t = st0.stops[-1][3]
        for j in range(i, L + 1 if not priv else i + 1):
            if j > i:
                bad = st0.step(pb, v, *base[j - 1])
                if bad:
                    c = _code(*bad, r)
                    counts[c] = counts.get(c, 0) + 1
                    break                          # the prefix up to j already fails: later drops fail too
            if deadline is not None and time.perf_counter() > deadline:
                return best, counts, True
            if (r['limit'] is not None and st0.t - (pick_t + r['svcP']) > r['limit']) or \
                    (r['arrive'] is not None and st0.t > r['arrive']):
                counts['MAX_RIDE'] = counts.get('MAX_RIDE', 0) + 1
                break                              # already past the ride limit: later drops are later
            st = st0.copy()
            bad = st.step(pb, v, 'D', rid)
            if bad:
                c = _code(*bad, r)
                counts[c] = counts.get(c, 0) + 1
                continue
            drop_t = st.stops[-1][3]
            ok = True
            converged = False
            for k in range(j, L):
                bad = st.step(pb, v, *base[k])
                if bad:
                    c = _code(*bad, r)
                    counts[c] = counts.get(c, 0) + 1
                    ok = False
                    break
                # Same state as the base route from here on: the rest is the base route's (feasible) tail. Only when
                # the first stop is unchanged (i > 0): inserting before it can move the route start, so span and
                # breaks must then be re-checked by finish().
                if i > 0 and st.t <= base_dep[k][0] and len(st.pending) == base_dep[k][1] \
                        and not st.aboard - prefix[k + 1].aboard:
                    converged = True
                    break
            if not ok:
                continue
            if not converged:
                bad, _, _ = st.finish(pb, v)
                if bad:
                    c = _code(*bad, r)
                    counts[c] = counts.get(c, 0) + 1
                    continue
            # cost delta (travel + service time, distance, own wait / ride, vehicle activation)
            pl, dl = r['p'], r['d']
            if i == j:
                a, b = locs[i], locs[i + 1] if i < L else None
                added = [(a, pl), (pl, dl)] + ([(dl, b)] if b is not None else [])
                removed = [(a, b)] if b is not None else []
            else:
                a1, b1 = locs[i], locs[i + 1]
                a2, b2 = locs[j], locs[j + 1] if j < L else None
                added = [(a1, pl), (pl, b1), (a2, dl)] + ([(dl, b2)] if b2 is not None else [])
                removed = [(a1, b1)] + ([(a2, b2)] if b2 is not None else [])
            dt = sum(_arc(pb, x, y, 'dur') for x, y in added) - sum(_arc(pb, x, y, 'dur') for x, y in removed)
            dd = sum(_arc(pb, x, y, 'dist') for x, y in added) - sum(_arc(pb, x, y, 'dist') for x, y in removed)
            wait = pick_t - r['win'][0]
            ride = drop_t - (pick_t + r['svcP'])
            cost = (w['time'] * (dt + r['svcP'] + r['svcD']) + w['distance'] * dd + w['wait'] * r['n'] * wait
                    + w['rideTime'] * r['n'] * ride + (w['vehicle'] if not base and not v['onboard'] else 0))
            if best is None or cost < best[0]:
                best = (cost, i, j)
    return best, counts, False


def _classify(pb: dict, routes: dict[str, list], rid: str, deadline: float) -> tuple[str, dict]:
    r = pb['req'][rid]
    counts: dict[str, int] = {}
    for v in pb['vehs']:
        if not _compatible(v, r):
            continue
        best, c, timed_out = _insert(pb, v, routes[v['id']], rid, deadline=deadline)
        if best is not None:
            return 'NOT_SELECTED', {'insertableInto': v['id']}
        if timed_out:
            return 'NOT_SELECTED', {'binding': ['unknown']}
        for k, x in c.items():
            counts[k] = counts.get(k, 0) + x
    if r['pref'] == 'PRIVATE':
        return 'PRIVATE_NEEDS_EMPTY_VEHICLE', {'binding': sorted(counts)}
    if not counts:
        return 'NOT_SELECTED', {'binding': ['unknown']}
    return _pick_code(counts), {'binding': sorted(counts)}


def _precheck(pb: dict, rid: str) -> tuple[str, dict] | None:
    """None if the request fits alone on some compatible empty vehicle; else its reason code."""
    r = pb['req'][rid]
    comp = [v for v in pb['vehs'] if _compatible(v, r)]
    if not comp:
        return 'NO_COMPATIBLE_VEHICLE', {}
    if r['onboard']:
        return None
    if r['direct'] is None:
        return 'ROUTING_UNAVAILABLE', {}
    if r['limit'] is not None and r['direct'] > r['limit']:
        return 'MAX_RIDE', {'directS': r['direct'], 'limitS': r['limit']}
    if r['arrive'] is not None and r['win'][0] + r['svcP'] + r['direct'] > r['arrive']:
        return 'MAX_RIDE', {'binding': ['arrive_by']}
    counts: dict[str, int] = {}
    for v in comp:
        bad, _, _, _ = _run(pb, v, [('P', rid), ('D', rid)], empty=True)
        if bad is None:
            return None
        c = _code(*bad, r)
        counts[c] = counts.get(c, 0) + 1
    return _pick_code(counts), {'binding': sorted(counts)}


# ----------------------------------------------------------------------------------------------------------------
# Solve
# ----------------------------------------------------------------------------------------------------------------

def solve_pdp(problem: dict) -> dict:
    t0 = time.perf_counter()
    try:
        pb = validate_pdp(problem)
        res = _solve(pb, t0)
        res['stats']['wallTimeMs'] = round((time.perf_counter() - t0) * 1000)
        return res
    except (InvalidProblem, OverflowError) as e:
        msg = str(e) if isinstance(e, InvalidProblem) else 'costs or penalties too large for the solver (int64)'
        return {'schemaVersion': PDP_SCHEMA_VERSION, 'mode': 'pdp', 'status': 'INVALID_INPUT', 'provenOptimal': False,
                'error': msg, 'routes': [], 'requests': [], 'unserved': [], 'commitmentViolations': []}


def _solve(pb: dict, t0: float) -> dict:
    R, vehs = pb['req'], pb['vehs']
    unserved, violations, active = [], [], []
    for rid, r in R.items():
        pre = _precheck(pb, rid)
        if pre is None:
            active.append(rid)
            continue
        code, detail = pre
        if r['committed'] is not None:
            violations.append({'requestId': rid, 'vehicleId': r['committed'], 'code': code, **({'detail': detail} if detail else {})})
        else:
            unserved.append({'requestId': rid, 'code': code, **({'detail': detail} if detail else {})})
    stats = {'requests': sum(1 for r in R.values() if not r['onboard']),
             'onboard': sum(1 for r in R.values() if r['onboard']), 'vehicles': len(vehs),
             'strategy': pb['strategy'], 'insertOnly': pb['insertOnly']}
    if pb['insertOnly']:
        routes, extra_unserved, extra_viol, info = _insert_only(pb, active, t0)
        solver_status = 'INSERT_ONLY'
        objective = None
    else:
        routes, extra_unserved, extra_viol, info, solver_status, objective = _ortools(pb, active, t0)
    stats.update(info)
    unserved += extra_unserved
    violations += extra_viol
    out = _build(pb, routes)
    served = {x['requestId'] for x in out['requests']}
    # every committed request must be served on its vehicle (onboard drops included)
    vio_ids = {x['requestId'] for x in violations}
    for rid, r in R.items():
        if r['committed'] is not None and rid not in served and rid not in vio_ids:
            violations.append({'requestId': rid, 'vehicleId': r['committed'], 'code': 'NOT_SELECTED'})
    status = 'COMMITMENT_VIOLATION' if violations else 'FEASIBLE'
    return {'schemaVersion': PDP_SCHEMA_VERSION, 'mode': 'pdp', 'status': status, 'provenOptimal': False,
            'solverStatus': solver_status, 'objective': objective, 'strategy': pb['strategy'], 'weights': pb['w'],
            'routes': out['routes'], 'requests': out['requests'],
            'unserved': sorted(unserved, key=lambda u: u['requestId']),
            'commitmentViolations': sorted(violations, key=lambda u: u['requestId']),
            'metrics': out['metrics'], 'stats': stats}


# -- insertOnly ---------------------------------------------------------------------------------------------------

def _warm_routes(pb: dict, active: set[str]) -> tuple[dict[str, list], int]:
    """Warm-start sequences per vehicle (complete pairs of known, active, compatible requests; onboard drops first
    when missing). Returns (routes, ignored token count)."""
    R = pb['req']
    routes, ignored, used = {}, 0, set()
    for v in pb['vehs']:
        toks = pb['warm'].get(v['id'], [])
        first: dict[tuple[str, str], int] = {}
        for q, t in enumerate(toks):
            first.setdefault(t, q)
        seq = []
        for q, (k, x) in enumerate(toks):
            r = R.get(x)
            ok = (r is not None and x in active and x not in used and first[(k, x)] == q and _compatible(v, r)
                  and ((r['onboard'] and k == 'D' and x in v['onboard'])
                       or (not r['onboard'] and first.get(('P', x), 1 << 30) < first.get(('D', x), -1))))
            if ok:
                seq.append((k, x))
            else:
                ignored += 1
        used |= {x for _, x in seq}
        missing = [x for x in v['onboard'] if x in active and x not in used]
        missing.sort(key=lambda x: (R[x]['arrive'] if R[x]['arrive'] is not None else pb['H'], x))
        seq = [('D', x) for x in missing] + seq
        used |= set(missing)
        routes[v['id']] = seq
    return routes, ignored


def _insert_only(pb: dict, active: list[str], t0: float):
    R = pb['req']
    deadline = t0 + _time_limit(pb['opts'])
    act = set(active)
    routes, ignored = _warm_routes(pb, act)
    unserved, violations = [], []
    blocked: set[str] = set()
    for v in pb['vehs']:
        bad, _, _, _ = _run(pb, v, routes[v['id']])
        if bad:
            # The current (committed) plan of this vehicle itself breaks a constraint. insertOnly never re-sequences
            # it: its committed requests are commitment violations, the vehicle takes no insertion, and its
            # uncommitted requests are inserted elsewhere if possible.
            for x in sorted({x for _, x in routes[v['id']]}):
                if R[x]['committed'] is not None:
                    code = _code(bad[0], bad[1], R[x]) if bad[1] == x else 'VEHICLE_TIME'
                    violations.append({'requestId': x, 'vehicleId': v['id'], 'code': code,
                                       'detail': {'binding': [bad[0]], 'routeInfeasible': True}})
            routes[v['id']] = []
            blocked.add(v['id'])
    placed = {x for seq in routes.values() for _, x in seq} | {x['requestId'] for x in violations}
    todo = [x for x in active if x not in placed]
    todo.sort(key=lambda x: (R[x]['committed'] is None, -R[x]['prio'], R[x]['win'][0], x))
    t_ins = time.perf_counter()
    inserted = 0
    timed_out = False
    for rid in todo:
        r = R[rid]
        if timed_out or time.perf_counter() > deadline:
            # options.timeLimitS spent: the rest is reported, never silently dropped
            timed_out = True
            entry = {'requestId': rid, 'code': 'NOT_SELECTED', 'detail': {'binding': ['time_limit']}}
            (violations if r['committed'] is not None else unserved).append(
                {**entry, 'vehicleId': r['committed']} if r['committed'] is not None else entry)
            continue
        best = None
        counts: dict[str, int] = {}
        for v in pb['vehs']:
            if v['id'] in blocked or not _compatible(v, r):
                continue
            b, c, out_of_time = _insert(pb, v, routes[v['id']], rid, deadline=deadline)
            timed_out = timed_out or out_of_time
            for k, x in c.items():
                counts[k] = counts.get(k, 0) + x
            if b is not None and (best is None or b[0] < best[0][0]):
                best = (b, v['id'])
        if best is None:
            if timed_out:
                code, binding = 'NOT_SELECTED', ['time_limit']
            else:
                code = ('PRIVATE_NEEDS_EMPTY_VEHICLE' if r['pref'] == 'PRIVATE'
                        else _pick_code(counts) if counts else 'NOT_SELECTED')
                binding = sorted(counts)
            entry = {'requestId': rid, 'code': code, 'detail': {'binding': binding}}
            (violations if r['committed'] is not None else unserved).append(
                {**entry, 'vehicleId': r['committed']} if r['committed'] is not None else entry)
            continue
        (cost, i, j), vid = best
        seq = routes[vid]
        routes[vid] = seq[:i] + [('P', rid)] + seq[i:j] + [('D', rid)] + seq[j:]
        inserted += 1
    return routes, unserved, violations, {'warmStart': 'used' if pb['warm'] else 'none', 'warmStartIgnored': ignored,
                                          'inserted': inserted, 'timedOut': timed_out,
                                          'insertMs': round((time.perf_counter() - t_ins) * 1000, 1)}


# -- OR-Tools -----------------------------------------------------------------------------------------------------

def _time_limit(opts: dict) -> int:
    return max(1, min(int(opts.get('timeLimitS', 10)), PDP_LIMITS['timeLimitS']))


def _turn_buckets(vehs: list[dict]) -> dict[int, int]:
    """Vehicle turnaroundS -> the value used in the model. At most MAX_TURN_BUCKETS transit matrices are built: with
    more distinct values, each is rounded UP to the largest value of its group (conservative: the reported schedule
    still satisfies the exact turnaround, which verify checks)."""
    vals = sorted({v['turn'] for v in vehs})
    if len(vals) <= MAX_TURN_BUCKETS:
        return {x: x for x in vals}
    out, size = {}, math.ceil(len(vals) / MAX_TURN_BUCKETS)
    for g in range(0, len(vals), size):
        grp = vals[g:g + size]
        for x in grp:
            out[x] = grp[-1]
    return out


def _scale(w: dict) -> int:
    return COST_SCALE_FRACTIONAL if any(x != int(x) for x in w.values()) else 1


def _ortools(pb: dict, active: list[str], t0: float):
    R, vehs, dur, dist, H, w = pb['req'], pb['vehs'], pb['dur'], pb['dist'], pb['H'], pb['w']
    nv = len(vehs)
    opts = pb['opts']
    time_limit = _time_limit(opts)
    info: dict = {'timeLimitS': time_limit}
    if not active:
        info.update({'stoppedBy': 'nothing_to_route', 'warmStart': 'none'})
        return {v['id']: [] for v in vehs}, [], [], info, 'NOT_RUN', 0
    # nodes: starts, dummy end, explicit ends, then request nodes
    loc: list[int | None] = [v['start'] for v in vehs]
    kind: list[str] = ['start'] * nv
    owner: list[str | None] = [None] * nv
    if any(v['end'] is None for v in vehs):      # shared dummy end (open end), only when some vehicle uses it
        loc.append(None)
        kind.append('end')
        owner.append(None)
    ends = []
    for v in vehs:
        if v['end'] is None:
            ends.append(nv)
        else:
            ends.append(len(loc))
            loc.append(v['end']); kind.append('end'); owner.append(None)
    node_of: dict[tuple[str, str], int] = {}
    for rid in active:
        r = R[rid]
        if not r['onboard']:
            node_of[('S', rid)] = len(loc); loc.append(r['p']); kind.append('S'); owner.append(rid)
            if r['pref'] != 'PRIVATE':
                node_of[('J', rid)] = len(loc); loc.append(r['p']); kind.append('J'); owner.append(rid)
        node_of[('D', rid)] = len(loc); loc.append(r['d']); kind.append('D'); owner.append(rid)
    nn = len(loc)
    svc = [0] * nn
    for (k, rid), i in node_of.items():
        svc[i] = R[rid]['svcD'] if k == 'D' else R[rid]['svcP']
    scale = _scale(w)
    man = pywrapcp.RoutingIndexManager(nn, nv, list(range(nv)), ends)
    rm = pywrapcp.RoutingModel(man)
    sol = rm.solver()
    keep = []
    base_leg = [[0] * nn for _ in range(nn)]
    dist_leg = [[0] * nn for _ in range(nn)]
    for i in range(nn):
        li = loc[i]
        if li is None:
            continue
        di, si = dur[li], dist[li] if dist else None
        bi, ddi = base_leg[i], dist_leg[i]
        for j in range(nn):
            lj = loc[j]
            if lj is None or i == j:
                continue
            c = di[lj]
            bi[j] = UNREACHABLE if c is None else c
            if si is not None:
                ddi[j] = si[lj] or 0
    is_s = [k == 'S' for k in kind]
    # One arc-cost matrix for all vehicles (travel + service; turnaround is a time term only) and one transit matrix
    # per turnaround bucket (review: one matrix pair per distinct turnaroundS was too slow / too large).
    cm = []
    for i in range(nn):
        bi, ddi, si_ = base_leg[i], dist_leg[i], svc[i]
        cm.append([BIG_COST if bi[j] >= UNREACHABLE else
                   int(round(scale * (w['time'] * (bi[j] + si_) + w['distance'] * ddi[j]))) for j in range(nn)])
    max_arc = max((c for row in cm for c in row if c < BIG_COST), default=1)
    c_cb = rm.RegisterTransitMatrix(cm)
    keep.append(cm)
    del dist_leg
    bucket = _turn_buckets(vehs)
    t_cb = {}
    for ta in sorted(set(bucket.values())):
        tm = []
        for i in range(nn):
            bi, si_ = base_leg[i], svc[i]
            add_turn = ta if kind[i] not in ('start', 'end') else 0
            tm.append([UNREACHABLE if bi[j] >= UNREACHABLE else bi[j] + si_ + (add_turn if is_s[j] else 0)
                       for j in range(nn)])
        keep.append(tm)
        t_cb[ta] = rm.RegisterTransitMatrix(tm)
    info['turnaroundBuckets'] = sorted(t_cb)
    for k in range(nv):
        rm.SetArcCostEvaluatorOfVehicle(c_cb, k)
        if w['vehicle']:
            rm.SetFixedCostOfVehicle(int(round(w['vehicle'] * scale)), k)
    rm.AddDimensionWithVehicleTransits([t_cb[bucket[v['turn']]] for v in vehs], H, H, False, 'Time')
    td = rm.GetDimensionOrDie('Time')
    dem, exc, wcd = [0] * nn, [0] * nn, [0] * nn
    for (k, rid), i in node_of.items():
        r = R[rid]
        sign = -1 if k == 'D' else 1
        dem[i] = sign * r['n']
        exc[i] = sign * (EXCL_BIG if r['pref'] == 'PRIVATE' else r['n'])
        wcd[i] = sign * r['wc']
    l_cb = rm.RegisterUnaryTransitVector(dem)
    rm.AddDimensionWithVehicleCapacity(l_cb, 0, [v['cap'] for v in vehs], False, 'Load')
    ld = rm.GetDimensionOrDie('Load')
    any_priv = any(R[x]['pref'] == 'PRIVATE' for x in active)
    xd = wd = None
    if any_priv:
        rm.AddDimension(rm.RegisterUnaryTransitVector(exc), 0, EXCL_BIG, False, 'Excl')
        xd = rm.GetDimensionOrDie('Excl')
    if any(R[x]['wc'] for x in active):
        rm.AddDimensionWithVehicleCapacity(rm.RegisterUnaryTransitVector(wcd), 0, [v['wc'] for v in vehs], False,
                                           'Wheel')
        wd = rm.GetDimensionOrDie('Wheel')
    act = set(active)
    for k, v in enumerate(vehs):
        ob = [x for x in v['onboard'] if x in act]
        s, e = rm.Start(k), rm.End(k)
        ld.CumulVar(s).SetValue(sum(R[x]['n'] for x in ob))
        if xd is not None:
            xd.CumulVar(s).SetValue(EXCL_BIG if any(R[x]['pref'] == 'PRIVATE' for x in ob)
                                    else sum(R[x]['n'] for x in ob))
        if wd is not None:
            wd.CumulVar(s).SetValue(sum(R[x]['wc'] for x in ob))
        td.CumulVar(s).SetRange(v['avail'], v['shiftEnd'])
        td.CumulVar(e).SetMax(v['shiftEnd'])
        if v['span'] is not None:
            td.SetSpanUpperBoundForVehicle(v['span'], k)
    # penalties
    max_pax = max(R[x]['n'] for x in active)
    base = (BASE_PENALTY * scale + 2 * (nn * max_arc + int(w['vehicle'] * scale) * nv
                                        + int((w['wait'] + w['rideTime']) * scale) * H * max_pax))
    total = 0
    vidx = {v['id']: k for k, v in enumerate(vehs)}
    for rid in active:
        r = R[rid]
        pen = int(math.ceil(base * r['prio'] * r['n'])) * (COMMITTED_FACTOR if r['committed'] is not None else 1)
        total += pen
        if total > MAX_TOTAL_COST // 4:
            raise InvalidProblem('costs or penalties too large for the solver (int64)')
        allowed = [k for k, v in enumerate(vehs) if _compatible(v, r)]
        di = man.NodeToIndex(node_of[('D', rid)])
        picks = [man.NodeToIndex(node_of[(k, rid)]) for k in ('S', 'J') if (k, rid) in node_of]
        for idx in picks + [di]:
            if len(allowed) < nv:
                rm.VehicleVar(idx).SetValues([-1] + allowed)
        if r['arrive'] is not None:
            td.CumulVar(di).SetMax(r['arrive'])
        if r['onboard']:
            rm.AddDisjunction([di], pen)
            continue
        lo, hi = r['win']
        for idx in picks:
            td.CumulVar(idx).SetRange(lo, hi)
        si = picks[0]
        ld.CumulVar(si).SetMax(0)                           # starts a trip: nobody on board
        if len(picks) == 2:
            ld.CumulVar(picks[1]).SetMin(1)                 # joins a trip
            dp = rm.AddDisjunction(picks, pen, 1)
            dd = rm.AddDisjunction([di], 0)
            rm.AddPickupAndDeliverySets(dp, dd)
            sol.Add(rm.ActiveVar(picks[0]) + rm.ActiveVar(picks[1]) == rm.ActiveVar(di))
            sol.Add(rm.VehicleVar(picks[0]) + rm.VehicleVar(picks[1]) + 1 == rm.VehicleVar(di))
        else:
            rm.AddDisjunction([si], pen)
            rm.AddDisjunction([di], 0)
            rm.AddPickupAndDelivery(si, di)
            sol.Add(rm.ActiveVar(si) == rm.ActiveVar(di))
            sol.Add(rm.VehicleVar(si) == rm.VehicleVar(di))
        for idx in picks:
            off = (1 - rm.ActiveVar(idx)) * H if len(picks) == 2 else 0
            sol.Add(td.CumulVar(idx) <= td.CumulVar(di) + off)
            if r['limit'] is not None:
                sol.Add(td.CumulVar(di) - td.CumulVar(idx) <= r['limit'] + r['svcP'] + off)
            if w['wait']:
                td.SetCumulVarSoftUpperBound(idx, lo, max(1, int(round(w['wait'] * r['n'] * scale))))
        if w['rideTime'] and r['direct'] is not None:
            td.SetCumulVarSoftUpperBound(di, min(H, lo + r['svcP'] + r['direct']),
                                         max(1, int(round(w['rideTime'] * r['n'] * scale))))
    # driver breaks
    nvt = [svc[man.IndexToNode(i)] for i in range(rm.Size())]
    brk_vars: dict[int, list] = {}
    for k, v in enumerate(vehs):
        if v['breaks']:
            bs = [sol.FixedDurationIntervalVar(e, lt, d, False, f'break-{v["id"]}-{q}')
                  for q, (e, lt, d) in enumerate(v['breaks'])]
            td.SetBreakIntervalsOfVehicle(bs, k, nvt)
            for b in bs:
                rm.AddIntervalToAssignment(b)
            brk_vars[k] = bs
    for i in range(rm.Size()):
        if not rm.IsStart(i):
            rm.AddVariableMinimizedByFinalizer(td.CumulVar(i))
    for k in range(nv):
        rm.AddVariableMinimizedByFinalizer(td.CumulVar(rm.End(k)))
    for k in range(nv):
        rm.AddVariableMaximizedByFinalizer(td.CumulVar(rm.Start(k)))
    p = pywrapcp.DefaultRoutingSearchParameters()
    p.first_solution_strategy = FIRST_SOLUTION[opts.get('firstSolution') or 'parallel_cheapest_insertion']
    p.local_search_metaheuristic = LOCAL_SEARCH[opts.get('localSearch') or 'guided']
    # The model build counts against options.timeLimitS (at least 0.5 s of search remains).
    p.time_limit.FromMilliseconds(max(500, int(time_limit * 1000 - (time.perf_counter() - t0) * 1000)))
    info['buildMs'] = round((time.perf_counter() - t0) * 1000)
    info['nodes'] = nn
    s = None
    if pb['warm']:
        routes0, ignored = _warm_routes(pb, act)
        info['warmStartIgnored'] = ignored
        rm.CloseModelWithParameters(p)
        idx_routes = []
        for v in vehs:
            load = sum(R[x]['n'] for x in v['onboard'] if x in act)
            seq = []
            for kk, x in routes0[v['id']]:
                if kk == 'D':
                    seq.append(man.NodeToIndex(node_of[('D', x)]))
                    load -= R[x]['n']
                else:
                    seq.append(man.NodeToIndex(node_of[('S' if load == 0 or ('J', x) not in node_of else 'J', x)]))
                    load += R[x]['n']
            idx_routes.append(seq)
        a0 = rm.ReadAssignmentFromRoutes(idx_routes, True)
        if a0 is not None:
            s = rm.SolveFromAssignmentWithParameters(a0, p)
            info['warmStart'] = 'used'
        else:
            info['warmStart'] = 'rejected'
            s = rm.SolveWithParameters(p)
    else:
        info['warmStart'] = 'none'
        s = rm.SolveWithParameters(p)
    solver_status = _status_name(rm.status())
    if s is None:
        info['stoppedBy'] = 'no_solution'
        un = [{'requestId': x, 'code': 'NOT_SELECTED', 'detail': {'binding': ['no_solution']}}
              for x in active if R[x]['committed'] is None]
        return {v['id']: [] for v in vehs}, un, [], info, solver_status, None
    info['stoppedBy'] = 'time_limit' if (time.perf_counter() - t0) >= time_limit * 0.98 else 'local_optimum'
    routes: dict[str, list] = {}
    for k, v in enumerate(vehs):
        idx = s.Value(rm.NextVar(rm.Start(k)))
        seq = []
        while not rm.IsEnd(idx):
            node = man.IndexToNode(idx)
            seq.append(('P' if kind[node] in ('S', 'J') else 'D', owner[node], s.Min(td.CumulVar(idx))))
            idx = s.Value(rm.NextVar(idx))
        brks = [(s.StartValue(b), s.DurationValue(b)) for b in brk_vars.get(k, [])] if seq else []
        routes[v['id']] = {'seq': seq, 'startS': s.Min(td.CumulVar(rm.Start(k))),
                           'endS': s.Min(td.CumulVar(rm.End(k))), 'breaks': brks}
    served = {x for r in routes.values() for _, x, _ in r['seq']}
    plain = {vid: [(kk, x) for kk, x, _ in r['seq']] for vid, r in routes.items()}
    # Repair pass: the local search can miss a feasible insertion (pickup-and-delivery pairs with two pickup
    # alternatives are hard moves). Each dropped request is tried at its cheapest feasible position (committed first,
    # then by priority); a changed route is re-timed by the simulator. Budget REPAIR_BUDGET_S.
    deadline = time.perf_counter() + REPAIR_BUDGET_S
    repaired = 0
    todo = sorted((x for x in active if x not in served),
                  key=lambda x: (R[x]['committed'] is None, -R[x]['prio'], R[x]['win'][0], x))
    for rid in todo:
        best = None
        for v in vehs:
            if not _compatible(v, R[rid]):
                continue
            b, _, timed_out = _insert(pb, v, plain[v['id']], rid, deadline=deadline)
            if b is not None and (best is None or b[0] < best[0][0]):
                best = (b, v['id'])
            if timed_out:
                break
        if best is not None:
            (_, i, j), vid = best
            q = plain[vid]
            plain[vid] = q[:i] + [('P', rid)] + q[i:j] + [('D', rid)] + q[j:]
            routes[vid] = plain[vid]
            served.add(rid)
            repaired += 1
        if time.perf_counter() > deadline:
            break
    info['repairInserted'] = repaired
    deadline = time.perf_counter() + CLASSIFY_BUDGET_S
    unserved = []
    violations = []
    for rid in active:
        if rid in served:
            continue
        code, detail = _classify(pb, plain, rid, deadline)
        entry = {'requestId': rid, 'code': code, **({'detail': detail} if detail else {})}
        if R[rid]['committed'] is not None:
            violations.append({**entry, 'vehicleId': R[rid]['committed']})
        else:
            unserved.append(entry)
    return routes, unserved, violations, info, solver_status, s.ObjectiveValue() / scale


# ----------------------------------------------------------------------------------------------------------------
# Result
# ----------------------------------------------------------------------------------------------------------------

def _timed(pb: dict, routes: dict) -> dict[str, dict]:
    """Normalise routes to {vid: {'seq': [(kind, rid, startS)], 'startS', 'endS', 'breaks'}}. insertOnly routes are
    plain sequences: they are timed by the simulator."""
    out = {}
    for v in pb['vehs']:
        r = routes.get(v['id'])
        if isinstance(r, dict):
            out[v['id']] = r
            continue
        seq = r or []
        if not seq:
            out[v['id']] = {'seq': [], 'startS': v['avail'], 'endS': v['avail'], 'breaks': []}
            continue
        s = _Sim.start(pb, v)
        for kind, rid in seq:
            s.step(pb, v, kind, rid)          # feasibility was checked when the route was built
        _, rs, re_ = s.finish(pb, v)
        out[v['id']] = {'seq': [(k, x, st) for k, x, _, st, _ in s.stops], 'startS': rs, 'endS': re_,
                        'breaks': sorted(s.taken)}
    return out


def _build(pb: dict, routes_in: dict) -> dict:
    R, dur, dist = pb['req'], pb['dur'], pb['dist']
    timed = _timed(pb, routes_in)
    routes, reqs = [], []
    waits, rides, detours, tot_dist, tot_dur, n_trips = [], [], [], 0, 0, 0
    shared_served = 0
    for v in pb['vehs']:
        tr = timed[v['id']]
        seq = tr['seq']
        if not seq:
            continue
        breaks = sorted(tr['breaks'])
        prev_loc, prev_dep = v['start'], tr['startS']
        load = sum(R[x]['n'] for x in v['onboard'])
        aboard = list(v['onboard'])
        trips, cur = [], None
        dist_m = 0
        picked: dict[str, int] = {}
        stops_all = []
        visited = False
        for kind, rid, start in seq:
            r = R[rid]
            here = r['p'] if kind == 'P' else r['d']
            leg = dur[prev_loc][here] or 0
            dist_m += (dist[prev_loc][here] or 0) if dist else 0
            brk = sum(d for b, d in breaks if prev_dep <= b and b + d <= start)
            turn = v['turn'] if (kind == 'P' and load == 0 and visited) else 0
            if cur is None:
                cur = {'tripIndex': len(trips), 'turnaroundS': turn, 'stops': []}
            arr = prev_dep + brk + leg
            svc = r['svcP'] if kind == 'P' else r['svcD']
            if kind == 'P':
                load += r['n']; aboard.append(rid); picked[rid] = start
            else:
                load -= r['n']; aboard.remove(rid)
            stop = {'kind': 'PICKUP' if kind == 'P' else 'DROP', 'requestId': rid, 'locationIndex': here,
                    'arrivalS': arr, 'startS': start, 'departureS': start + svc, 'load': load, 'onboard': list(aboard)}
            cur['stops'].append(stop)
            stops_all.append(stop)
            prev_loc, prev_dep, visited = here, start + svc, True
            if load == 0:
                trips.append(cur); cur = None
        if cur is not None:
            trips.append(cur)
        for t in trips:
            ids = []
            for st in t['stops']:
                if st['requestId'] not in ids:
                    ids.append(st['requestId'])
            peak = max(st['load'] for st in t['stops'])
            alone = len(ids) == 1
            for rid in ids:
                r = R[rid]
                served_as = 'PRIVATE' if r['pref'] == 'PRIVATE' or (r['pref'] == 'FLEXIBLE' and alone) else 'SHARED'
                if not alone:
                    shared_served += 1
                p_st = next((x for x in t['stops'] if x['requestId'] == rid and x['kind'] == 'PICKUP'), None)
                d_st = next((x for x in t['stops'] if x['requestId'] == rid and x['kind'] == 'DROP'), None)
                info = {'requestId': rid, 'vehicleId': v['id'], 'tripIndex': t['tripIndex'], 'servedAs': served_as,
                        'committed': r['committed'] is not None, 'onboardAtStart': r['onboard']}
                if p_st is not None:
                    wait = p_st['startS'] - r['requested'][0]
                    p_st.update({'servedAs': served_as, 'waitS': wait})
                    info.update({'pickupS': p_st['startS'], 'waitS': wait})
                    waits.append(wait)
                if d_st is not None:
                    d_st['servedAs'] = served_as
                    info['dropS'] = d_st['startS']
                    if p_st is not None:
                        ride = d_st['startS'] - p_st['departureS']
                        detour = max(0, ride - r['direct'])
                        d_st.update({'rideS': ride, 'directS': r['direct'], 'detourS': detour})
                        info.update({'rideS': ride, 'directS': r['direct'], 'detourS': detour})
                        rides.append(ride); detours.append(detour)
                reqs.append(info)
            t.update({'startS': t['stops'][0]['startS'], 'endS': t['stops'][-1]['departureS'], 'requestIds': ids,
                      'peakLoad': peak, 'shared': not alone})
        n_trips += len(trips)
        end_s = tr['endS']
        if v['end'] is not None:
            dist_m += (dist[prev_loc][v['end']] or 0) if dist else 0
        tot_dist += dist_m
        tot_dur += end_s - tr['startS']
        routes.append({'vehicleId': v['id'], 'startS': tr['startS'], 'endS': end_s, 'durationS': end_s - tr['startS'],
                       'distanceM': dist_m if dist else None,
                       'breaks': [{'startS': b, 'durationS': d} for b, d in breaks], 'trips': trips})

    def agg(xs: list[int]) -> dict:
        return {'avg': round(sum(xs) / len(xs), 1) if xs else None, 'max': max(xs) if xs else None}
    served_n = sum(1 for x in reqs if not x['onboardAtStart'])
    metrics = {'served': served_n, 'onboardDelivered': len(reqs) - served_n, 'vehiclesUsed': len(routes),
               'trips': n_trips, 'totalDistanceM': tot_dist if dist else None, 'totalDurationS': tot_dur,
               'waitS': agg(waits), 'rideS': agg(rides), 'detourS': agg(detours),
               'sharedShare': round(shared_served / len(reqs), 3) if reqs else None}
    return {'routes': routes, 'requests': sorted(reqs, key=lambda x: x['requestId']), 'metrics': metrics}
