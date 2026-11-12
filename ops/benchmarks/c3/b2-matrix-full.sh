#!/usr/bin/env bash
# B2 (doc 06 §7): M1 full matrix 100 / 200 / 400 nodes; wall time and CPU-seconds per matrix.
# Reuses apps/api/scripts/etms-matrix-bench.ts (the API's real MatrixBuilder; cold, no cache) against the C3 GraphHopper.
# Inputs : C3_GH_URL; C3_GH_PID (GraphHopper JVM pid on the C3 host, for GH CPU-seconds from /proc; only when this
#          script runs ON the C3 host, else leave empty); C3_B2_SIZES (default 100,200,400);
#          C3_B2_CONCURRENCY (default 4 = the doc 06 §7 "≤ 4 in flight" limit)
# Metric : wallS, engine requests, cells/s, node CPU s, GH CPU s per city and size
# Pass   : 200 x 200 full matrix < 60 s wall (doc 06 §7 benchmark plan, proposed target), every city
# Output : $C3_RESULTS/b2.jsonl, b2.csv, verdict.txt
C3_ARGS=("$@")
source "$(dirname "$0")/lib/guard.sh"
c3_guard B2 offbox
c3_need C3_GH_URL
SIZES="${C3_B2_SIZES:-100,200,400}"; CONC="${C3_B2_CONCURRENCY:-4}"
CMD=("$C3_REPO/apps/api/scripts/etms-matrix-bench.ts" --url "${C3_GH_URL:-}" --sizes "$SIZES" --strategy auto
     --concurrency "$CONC" --cities chennai,bengaluru --b1-pairs 20)
[[ -n "${C3_GH_PID:-}" ]] && CMD+=(--gh-pid "$C3_GH_PID")
if [[ $C3_DRY == 1 ]]; then
  echo "   plan: full matrices n=$SIZES, $CONC in flight, Chennai + Bengaluru; pass = n=200 wallS < 60"
  c3_run c3_tsx "${CMD[@]}" --json "\$C3_RESULTS/b2.jsonl"
  exit 0
fi
c3_tsx "${CMD[@]}" --json "$C3_RESULTS/b2.jsonl" | tee "$C3_RESULTS/b2.log"
[[ ${PIPESTATUS[0]} == 0 ]] || { c3_verdict FAIL "B2 benchmark run failed (see b2.log)"; exit 1; }
node "$C3_DIR/helpers/evaluate.mjs" b2 "$C3_RESULTS/b2.jsonl" "$C3_RESULTS"
rc=$?
c3_verdict "$([[ $rc == 0 ]] && echo PASS || echo FAIL)" "B2 200x200 full matrix < 60 s (doc 06 §7) [$C3_LABEL]"
exit $rc
