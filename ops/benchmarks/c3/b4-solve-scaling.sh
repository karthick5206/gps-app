#!/usr/bin/env bash
# B4 (doc 06 §7): OR-Tools solve, door-to-door 100 / 200 / 300 / 500 passengers x 10 / 30 / 60 / 120 s: wall time,
# status, objective curve, peak RSS, verifier violations. Every solve runs under the optimiser unit's caps
# (lib/capped.sh: CPUQuota=150%, MemoryMax=3G, MemorySwapMax=0, Nice=10).
# Inputs : C3_PYTHON (default /opt/veetrax/venvs/routing-optimizer/bin/python, the venv release.sh builds);
#          C3_SOLVE_SIZES, C3_B4_LIMITS (defaults above); C3_UNCAPPED=1 only to measure headroom (label the run)
# Metric : wallS, status, objective, unassigned, verifier violations, peak RSS (MB) per size and limit
# Pass   : 300 nodes FEASIBLE, 0 hard-constraint violations in 60 s (doc 06 §7, proposed);
#          500 pax / 40 veh <= 60 s and never above timeLimitS + 10 % (doc 11 §5.2); no solve killed under 3G
# Output : $C3_RESULTS/b4.json, b4.csv, b4.log, verdict.txt
# Mode   : onhost (measures this machine's CPU). Run on the C3 host with the API stack idle.
C3_ARGS=("$@")
source "$(dirname "$0")/lib/guard.sh"
c3_guard B4 onhost
c3_python_or_die
if [[ $C3_DRY == 1 ]]; then "$C3_PY" "$C3_DIR/helpers/b4_solve.py" b4; exit $?; fi
"$C3_PY" "$C3_DIR/helpers/b4_solve.py" b4 | tee "$C3_RESULTS/b4.log"
rc=${PIPESTATUS[0]}
c3_verdict "$([[ $rc == 0 ]] && echo PASS || echo FAIL)" "B4 solve scaling (doc 06 §7, doc 11 §5.2) [$C3_LABEL]"
exit $rc
