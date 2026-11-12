#!/usr/bin/env bash
# B5 (doc 06 §7): Python transit callbacks vs RegisterTransitMatrix, 100 / 200 / 300 / 500 passengers: wall time to
# the first solution (solutionLimit 1) and the objective at 30 s, each solve under the optimiser unit's caps.
# Inputs : C3_PYTHON, C3_SOLVE_SIZES
# Metric : wallS to first solution, objective at 30 s, peak RSS, per size and transit mode
# Pass   : none. Doc 06 §7 target is "measure"; the numbers feed R-5 (doc 06 §6) / ETR-31 (doc 13).
# Output : $C3_RESULTS/b5.json, b5.csv, b5.log, verdict.txt (MEASURED)
# Mode   : onhost
C3_ARGS=("$@")
source "$(dirname "$0")/lib/guard.sh"
c3_guard B5 onhost
c3_python_or_die
if [[ $C3_DRY == 1 ]]; then "$C3_PY" "$C3_DIR/helpers/b4_solve.py" b5; exit $?; fi
"$C3_PY" "$C3_DIR/helpers/b4_solve.py" b5 | tee "$C3_RESULTS/b5.log"
rc=${PIPESTATUS[0]}
c3_verdict MEASURED "B5 callback vs RegisterTransitMatrix (doc 06 §7: measure), exit=$rc [$C3_LABEL]"
exit $rc
