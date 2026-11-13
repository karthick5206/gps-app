#!/usr/bin/env bash
# B6 (doc 06 §7): mixed load. Phase 1 replays tracker ETA (/route) + map-matching (/match) traffic alone (baseline);
# phase 2 replays the same traffic while full-matrix builds run back to back (B2 load: n=C3_B6_MATRIX_N, 4 in flight).
# Inputs : C3_GH_URL; C3_TRACKER_ROUTE_RPS and C3_MATCH_RPS = production rates (REQUIRED; no document gives them:
#          TBD (owner/ops), from production GraphHopper access logs); C3_B6_DURATION_S (per phase, default 300);
#          C3_B6_MATRIX_N (default 200)
# Metric : /route and /match p50 / p95 / p99, errors, per phase; matrix builds completed under load
# Pass   : tracker /route p95 under load <= 2 x baseline (doc 06 §7). /match: reported, threshold TBD (owner).
# Output : $C3_RESULTS/b6-baseline.json, b6-load.json, b6-matrix.log, verdict.txt
# Mode   : offbox (load generator off the C3 host, doc 11 §5.4 rule 4; C3_GH_URL via an ssh tunnel)
C3_ARGS=("$@")
source "$(dirname "$0")/lib/guard.sh"
c3_guard B6 offbox
c3_need C3_GH_URL C3_TRACKER_ROUTE_RPS C3_MATCH_RPS
D="${C3_B6_DURATION_S:-300}"; N="${C3_B6_MATRIX_N:-200}"
if [[ $C3_DRY == 1 ]]; then
  echo "   phase 1 (baseline, $D s):"; c3_tsx "$C3_DIR/helpers/tracker-replay.ts" --duration "$D" --dry-run
  echo "   phase 2 (with matrix load, $D s):"; c3_tsx "$C3_DIR/helpers/export-matrix.ts" --n "$N" --loop "$D" --dry-run
  echo "   pass = /route p95 (phase 2) <= 2 x p95 (phase 1)"
  exit 0
fi
echo "== phase 1: baseline ($D s)"
c3_tsx "$C3_DIR/helpers/tracker-replay.ts" --duration "$D" --out "$C3_RESULTS/b6-baseline.json" || { c3_verdict FAIL "B6 baseline replay failed"; exit 1; }
echo "== phase 2: replay + matrix builds ($D s)"
c3_tsx "$C3_DIR/helpers/export-matrix.ts" --n "$N" --loop "$D" --out "$C3_RESULTS/b6-matrices" > "$C3_RESULTS/b6-matrix.log" 2>&1 &
MPID=$!
trap 'kill $MPID 2>/dev/null' EXIT
sleep 5   # let the first build reach its fan-out before measuring
c3_tsx "$C3_DIR/helpers/tracker-replay.ts" --duration "$D" --out "$C3_RESULTS/b6-load.json" || { c3_verdict FAIL "B6 load replay failed"; exit 1; }
wait $MPID; trap - EXIT
echo "   matrix builds under load: $(grep -c '"build"' "$C3_RESULTS/b6-matrix.log")"
node "$C3_DIR/helpers/evaluate.mjs" b6 "$C3_RESULTS/b6-baseline.json" "$C3_RESULTS/b6-load.json" | tee "$C3_RESULTS/b6.log"
rc=${PIPESTATUS[0]}
c3_verdict "$([[ $rc == 0 ]] && echo PASS || echo FAIL)" "B6 tracker /route p95 <= 2 x baseline under matrix load (doc 06 §7) [$C3_LABEL]"
exit $rc
