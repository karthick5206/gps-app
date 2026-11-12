#!/usr/bin/env bash
# R-5 / tracking isolation (doc 06 §6 R-3 + R-5, §7 production limits; doc 13 ETR-29 / ETR-31 / ETR-38; doc 11 §5.2).
# Does route optimisation at ~500 nodes, running in the REAL veetrax-optimizer unit (CPUQuota=150%, MemoryMax=3G,
# MemorySwapMax=0, Nice=10, OOMPolicy=continue) next to GraphHopper matrix builds, leave live tracking alone?
#   Phase 1 (baseline, C3_R5_DURATION_S): device ingest (gt06-sim) + tracker /route + /match replay; metrics polled.
#   Phase 2 (load, same length):          the same, plus back-to-back full-matrix builds (n=C3_R5_MATRIX_N, 4 in
#                                         flight) and back-to-back POST /optimize of a 500-passenger / 40-vehicle problem.
# Inputs (see config.example.env):
#   C3_GH_URL, C3_OPTIMIZER_URL (ssh tunnels to the C3 host's loopback services), C3_OPTIMIZER_TOKEN_FILE,
#   C3_API_URL + C3_METRICS_TOKEN_FILE (GET /api/metrics, /api/health/tracking), C3_GATEWAY_HOST [+ C3_GATEWAY_PORT],
#   C3_SSH (systemctl / journalctl / psql on the C3 host), C3_DB_NAME (default veetrax_etms_test),
#   C3_TRACKER_ROUTE_RPS + C3_MATCH_RPS (production rates: REQUIRED, TBD (owner/ops)),
#   C3_R5_DEVICES (default 1000) and C3_R5_FIX_INTERVAL_S (default 10): doc 11 §5.1 "1,000 vehicles at a 10 s fix
#   interval"; the devices must be registered first (RUNBOOK step 5), IMEIs from C3_R5_IMEI_START (default 868120007000001).
# Pass (each from a document; evaluate.mjs r5):
#   1 tracker /route p95 under load <= 2 x baseline                      doc 06 §7 B6
#   2 every solve FEASIBLE, wall <= 60 s x 1.10, no 503 / reset           doc 11 §5.2 (500 pax / 40 veh <= 60 s; +10 %)
#   3 optimiser: no restart, no OOM kill, MemoryPeak < MemoryMax 3G       doc 06 §7 production limits, doc 16 §3.1
#   4 /api/health/tracking 200 at every poll                              doc 14 G6 (release health gate)
#   5 positions: 0 lost in both phases                                    doc 11 §5.2 "Positions 0 lost"
#   6 vt_queue_oldest_pending_seconds p95 <= 3 s under load (PROXY)       doc 11 §5.2 "Fix -> dispatcher map p95 <= 3 s"
#     (the true fix-to-map p95 needs the E7 live-board socket probe, not in this kit; the proxy only bounds the queue)
#   7 /match p95 ratio: reported, threshold TBD (owner)
# Output : $C3_RESULTS/* (replays, solves, metrics CSV, sim logs, optimiser unit state, positions), verdict.txt
# Mode   : offbox (generators off the C3 host, doc 11 §5.4 rule 4); host readings over ssh.
C3_ARGS=("$@")
source "$(dirname "$0")/lib/guard.sh"
c3_guard R5 offbox
c3_need C3_GH_URL C3_OPTIMIZER_URL C3_OPTIMIZER_TOKEN_FILE C3_API_URL C3_METRICS_TOKEN_FILE C3_GATEWAY_HOST C3_SSH \
  C3_TRACKER_ROUTE_RPS C3_MATCH_RPS
c3_python_or_die
D="${C3_R5_DURATION_S:-600}"; N="${C3_R5_MATRIX_N:-200}"; DEV="${C3_R5_DEVICES:-1000}"; IV="${C3_R5_FIX_INTERVAL_S:-10}"
IMEI0="${C3_R5_IMEI_START:-868120007000001}"; DB="${C3_DB_NAME:-veetrax_etms_test}"; GWP="${C3_GATEWAY_PORT:-5023}"
SIM=(npm run --silent sim -w @veetracer/api -- --count "$DEV" --host "${C3_GATEWAY_HOST:-}" --port "$GWP" --interval "$IV" --imei-start "$IMEI0" --duration "$D")

if [[ $C3_DRY == 1 ]]; then
  echo "   phases: baseline $D s, then load $D s; devices $DEV every $IV s to ${C3_GATEWAY_HOST:-?}:$GWP"
  c3_run "${SIM[@]}"
  c3_tsx "$C3_DIR/helpers/tracker-replay.ts" --duration "$D" --dry-run
  c3_tsx "$C3_DIR/helpers/export-matrix.ts" --n "$N" --loop "$D" --dry-run
  "$C3_PY" "$C3_DIR/helpers/solve_http.py" /dev/null "$D" /dev/null
  echo "   problem: 500 passengers / 40 vehicles from helpers/b4_solve.py --dump (synthetic, validated below)"
  C3_SOLVE_SIZES=500 "$C3_PY" "$C3_DIR/helpers/b4_solve.py" b4 | grep -E 'ok:|OVER'
  echo "   host readings over ssh ${C3_SSH:-?}: systemctl show veetrax-optimizer (MemoryPeak, NRestarts), journalctl OOM, psql $DB"
  exit 0
fi

R="$C3_RESULTS"
host() { ssh -o BatchMode=yes "$C3_SSH" "$@"; }
metrics_token() { local t; t="$(cat "$C3_METRICS_TOKEN_FILE")"; t="${t#METRICS_TOKEN=}"; printf 'header = "Authorization: Bearer %s"\n' "$t"; }
poll_metrics() { # $1 = csv file; runs until killed. The token goes through a curl config on stdin, never argv.
  echo "t,trackingHttp,queueOldestPendingS,queueLag" > "$1"
  while :; do
    local m code
    m="$(metrics_token | curl -s -m 5 -K - "${C3_API_URL%/}/api/metrics" || true)"
    code="$(curl -s -o /dev/null -w '%{http_code}' -m 5 "${C3_API_URL%/}/api/health/tracking" || echo 000)"
    echo "$(date -u +%H:%M:%S),$code,$(awk '/^vt_queue_oldest_pending_seconds/{print $2; exit}' <<<"$m"),$(awk '/^vt_queue_lag/{print $2; exit}' <<<"$m")" >> "$1"
    sleep 5
  done
}
count_positions() { # $1 from (UTC ISO), $2 to; rows stored for the simulator IMEIs
  local last; last=$((IMEI0 + DEV - 1))
  host "sudo -u postgres psql -d '$DB' -Atc \"SELECT count(*) FROM \\\"Position\\\" p JOIN \\\"Device\\\" d ON d.id = p.\\\"deviceId\\\" WHERE d.\\\"uniqueId\\\" BETWEEN '$IMEI0' AND '$last' AND p.\\\"serverTime\\\" >= '$1' AND p.\\\"serverTime\\\" < '$2'\""
}
unit_state() { host "systemctl show veetrax-optimizer -p MemoryPeak -p NRestarts -p ActiveState -p Result" | tr '\n' ' '; }

phase() { # $1 = base|load
  local p="$1" t0 t1 sent
  echo "== phase $p ($D s)"
  poll_metrics "$R/metrics-$p.csv" & local MP=$!
  t0="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  (cd "$C3_REPO" && "${SIM[@]}") > "$R/sim-$p.log" 2>&1 & local SP=$!
  local XP="" OP=""
  if [[ $p == load ]]; then
    c3_tsx "$C3_DIR/helpers/export-matrix.ts" --n "$N" --loop "$D" --out "$R/matrices" > "$R/matrix-load.log" 2>&1 & XP=$!
    "$C3_PY" "$C3_DIR/helpers/solve_http.py" "$R/problem-500.json" "$D" "$R/solves.json" > "$R/solves.log" 2>&1 & OP=$!
    sleep 5
  fi
  c3_tsx "$C3_DIR/helpers/tracker-replay.ts" --duration "$D" --out "$R/replay-$p.json"
  wait $SP; [[ -n "$XP" ]] && wait "$XP"; [[ -n "$OP" ]] && wait "$OP"
  sleep 60   # pipeline drain before counting
  kill $MP 2>/dev/null
  t1="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  sent="$(grep -o 'stopped: sent=[0-9]*' "$R/sim-$p.log" | tail -1 | cut -d= -f2)"
  echo "{\"phase\":\"$p\",\"from\":\"$t0\",\"to\":\"$t1\",\"sent\":${sent:-null},\"stored\":$(count_positions "$t0" "$t1" || echo null)}" > "$R/positions-$p.json"
  cat "$R/positions-$p.json"
}

C3_SOLVE_SIZES=500 "$C3_PY" "$C3_DIR/helpers/b4_solve.py" --dump 500 "$R/problem-500.json" | tee "$R/problem-500.meta.json"
echo "{\"before\":\"$(unit_state)\"," > "$R/optimizer.json.tmp"
phase base
SINCE="$(date -u '+%Y-%m-%d %H:%M:%S')"
phase load
OOM="$(host "journalctl -u veetrax-optimizer --since '$SINCE UTC' --no-pager | grep -ci -E 'oom|killed' || true")"
echo "\"after\":\"$(unit_state)\",\"oomLines\":${OOM:-0}}" >> "$R/optimizer.json.tmp"
mv "$R/optimizer.json.tmp" "$R/optimizer.json"
node "$C3_DIR/helpers/evaluate.mjs" r5 "$R" | tee "$R/r5.log"
rc=${PIPESTATUS[0]}
c3_verdict "$([[ $rc == 0 ]] && echo PASS || echo FAIL)" "R-5 tracking isolation + 500-node solve under unit caps (doc 06 §7, doc 11 §5.2) [$C3_LABEL]"
exit $rc
