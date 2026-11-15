"""Follow-up presets (soft-only Balanced, time-first with low vehicle weight). Reuses e4_strategies helpers."""
import json
import sys
from pathlib import Path

sys.argv = [sys.argv[0], sys.argv[1], 'none']
HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import e4_strategies as E  # noqa: E402

EXTRA = {
    'Balanced soft (v3600,t2,ride1)': ('proto', {'vehicle': 3600, 'distance': 0, 'time': 2, 'routeDuration': 0, 'rideTime': 1}, None),
    'Balanced soft (v5400,t2,ride1)': ('proto', {'vehicle': 5400, 'distance': 0, 'time': 2, 'routeDuration': 0, 'rideTime': 1}, None),
    'Balanced + loose guard 2.0/15m (v3600,t2,ride1)': ('proto', {'vehicle': 3600, 'distance': 0, 'time': 2, 'routeDuration': 0, 'rideTime': 1}, (2.0, 900)),
    'Fastest fleet time (v120,t1)': ('prod', {'vehicle': 120, 'distance': 0, 'time': 1, 'routeDuration': 0}, None),
    'Shortest distance (v2000,d1)': ('prod', {'vehicle': 2000, 'distance': 1, 'time': 0, 'routeDuration': 0}, None),
}
SC = [s for s in E.SCEN if s[0] in ('base5 1x7', 'base5 2x7', 'far 2x7', 'twoDir 2x7', 'nine mixed 4/7/12')]
for sname, pax, veh, mr in SC:
    print('\n##', sname)
    for pname, (solver, w, guard) in EXTRA.items():
        d = E.run(solver, pax, veh, mr, w, guard)
        print(f"{pname[:48]:48} veh {d['veh']} km {d['km']:5} drive {d['driveMin']:3} maxR {d['maxRide']:3} avgR {d['avgRide']:5} "
              f"un {len(d['unassigned'])} | {d['occ']} | {d['routes']}", flush=True)
