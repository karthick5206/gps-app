#!/usr/bin/env bash
# B3 (doc 06 §7): M1 sparse k = 20 / 40 / 60 (+ depot legs): solution-quality loss vs the full matrix.
# Step 1 builds the full and sparse matrices from the C3 GraphHopper (helpers/export-matrix.ts, the API's MatrixBuilder);
# step 2 solves the same seeded problem on each and re-scores on the full matrix (helpers/b3_quality.py).
# Inputs : C3_GH_URL; C3_PYTHON; C3_B3_N (points incl. depot, default 200); C3_B3_KS (default 20,40,60);
#          C3_B3_LIMIT_S (solve limit, default 60); C3_B3_REPEATS (default 1); C3_B3_VEHICLES (default 10)
# Metric : re-scored driven seconds per k, loss % vs full, unassigned
# Pass   : < 3 % worse than the full matrix, for every k (doc 06 §7 benchmark plan, proposed)
# Output : $C3_RESULTS/matrices/*.json, b3.json, b3.csv, verdict.txt
# Mode   : offbox for step 1 is possible, but step 2 solves locally: run the whole script on the C3 host (onhost).
C3_ARGS=("$@")
source "$(dirname "$0")/lib/guard.sh"
c3_guard B3 onhost
c3_need C3_GH_URL
c3_python_or_die
N="${C3_B3_N:-200}"; KS="${C3_B3_KS:-20,40,60}"
if [[ $C3_DRY == 1 ]]; then
  c3_tsx "$C3_DIR/helpers/export-matrix.ts" --n "$N" --ks "$KS" --dry-run
  "$C3_PY" "$C3_DIR/helpers/b3_quality.py" /nonexistent /nonexistent
  exit $?
fi
c3_tsx "$C3_DIR/helpers/export-matrix.ts" --n "$N" --ks "$KS" --out "$C3_RESULTS/matrices" | tee "$C3_RESULTS/b3-matrices.log"
[[ ${PIPESTATUS[0]} == 0 ]] || { c3_verdict FAIL "B3 matrix export failed (see b3-matrices.log)"; exit 1; }
"$C3_PY" "$C3_DIR/helpers/b3_quality.py" "$C3_RESULTS/matrices" "$C3_RESULTS" | tee "$C3_RESULTS/b3.log"
rc=${PIPESTATUS[0]}
c3_verdict "$([[ $rc == 0 ]] && echo PASS || echo FAIL)" "B3 sparse loss < 3 % (doc 06 §7) [$C3_LABEL]"
exit $rc
