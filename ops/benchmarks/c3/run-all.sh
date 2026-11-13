#!/usr/bin/env bash
# Runs the C3 kit in RUNBOOK order with one shared results stamp. Pass --dry-run to validate everything first.
#   bash ops/benchmarks/c3/run-all.sh [--dry-run] [--only B1,B4]
# On-host scripts (B3, B4, B5) must run on the C3 host; offbox scripts (B1, B2, B6, R5) on the load generator. When one
# machine cannot do both, run the two groups separately with the same C3_STAMP.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ONLY=""; PASS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --only) ONLY="$2"; shift 2 ;;
    *) PASS+=("$1"); shift ;;
  esac
done
export C3_STAMP="${C3_STAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
declare -A SCRIPT=([B1]=b1-route-latency.sh [B2]=b2-matrix-full.sh [B3]=b3-sparse-quality.sh [B4]=b4-solve-scaling.sh
                   [B5]=b5-transit.sh [B6]=b6-mixed-load.sh [R5]=r5-isolation.sh)
rc_all=0
for id in B1 B2 B3 B4 B5 B6 R5; do
  [[ -n "$ONLY" && ",$ONLY," != *",$id,"* ]] && continue
  bash "$HERE/${SCRIPT[$id]}" "${PASS[@]}"
  rc=$?
  echo "-- $id exit $rc"
  [[ $rc == 3 ]] && { echo "guard refused: stopping"; exit 3; }
  [[ $rc != 0 ]] && rc_all=1
done
exit $rc_all
