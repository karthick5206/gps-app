#!/usr/bin/env bash
# B1 (doc 06 §7): GraphHopper /route latency, calc_points=false, urban pairs Chennai / Bengaluru / Delhi NCR, c1/c4/c8.
# Inputs : C3_GH_URL (the C3 GraphHopper, e.g. an ssh tunnel http://127.0.0.1:18989), C3_B1_PAIRS (default 400 per level)
# Metric : p50 / p95 / p99 latency (ms), failures, requests/s per city and concurrency
# Pass   : p95 < 20 ms at c4 in every city (doc 06 §7 benchmark plan, proposed target)
# Output : $C3_RESULTS/b1.json, b1.csv, verdict.txt
# Mode   : offbox (a load generator; doc 11 §5.4 rule 4). Run with nothing else loading GraphHopper.
C3_ARGS=("$@")
source "$(dirname "$0")/lib/guard.sh"
c3_guard B1 offbox
c3_need C3_GH_URL
if [[ $C3_DRY == 1 ]]; then c3_tsx "$C3_DIR/helpers/b1-route-latency.ts" --dry-run; exit 0; fi
c3_tsx "$C3_DIR/helpers/b1-route-latency.ts" | tee "$C3_RESULTS/b1.log"
rc=${PIPESTATUS[0]}
c3_verdict "$([[ $rc == 0 ]] && echo PASS || echo FAIL)" "B1 p95 < 20 ms at c4 (doc 06 §7) [$C3_LABEL]"
exit $rc
