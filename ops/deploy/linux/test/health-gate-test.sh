#!/usr/bin/env bash
# Exercises health-gate.sh (and release.sh --health-only) against local stub servers. Needs node and curl only; no
# systemd, database or Valkey. Never touches a real service. Run from anywhere:
#   bash ops/deploy/linux/test/health-gate-test.sh
# Exit 0 when every case behaves as expected.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
GATE="$HERE/../health-gate.sh"
STUB="$HERE/stub-health-server.mjs"
REPO="$(cd "$HERE/../../../.." && pwd)"
BASE_PORT="${BASE_PORT:-18470}"
OK_PORT=$BASE_PORT          # every path 200
BAD_PORT=$((BASE_PORT + 1)) # every path 503
TRK_PORT=$((BASE_PORT + 2)) # 200, but /api/health/tracking 503
DEAD_PORT=$((BASE_PORT + 3)) # nothing listens
PIDS=()
FAILURES=0
trap 'kill "${PIDS[@]}" 2>/dev/null; wait 2>/dev/null' EXIT

start_stub() {
  local port="$1" log
  shift
  log="$(mktemp)"
  node "$STUB" "$port" "$@" >"$log" 2>&1 &
  PIDS+=("$!")
  for _ in $(seq 1 50); do
    grep -q "listening $port" "$log" && return 0
    sleep 0.1
  done
  echo "stub on $port did not start: $(cat "$log")" >&2
  exit 2
}

# run_case <name> <expected exit> <env assignments...>
run_case() {
  local name="$1" expected="$2" out code
  shift 2
  echo
  echo "### $name (expect exit $expected)"
  out="$(env HEALTH_GATE_SYSTEMD=0 HEALTH_POLL_SEC=1 ROUTER_URL= GEOCODER_URL= MARTIN_URL= "$@" bash "$GATE" 2>&1)"
  code=$?
  echo "$out"
  echo "--> exit $code"
  if [[ "$code" != "$expected" ]]; then
    echo "!!! $name: expected exit $expected, got $code"
    FAILURES=$((FAILURES + 1))
  fi
}

ok="http://127.0.0.1:$OK_PORT"
start_stub "$OK_PORT" 200
start_stub "$BAD_PORT" 503
start_stub "$TRK_PORT" 200 api/health/tracking=503

run_case "all healthy" 0 \
  API_HEALTH_URL="$ok/api/health/ready" GATEWAY_HEALTH_URL="$ok/health" TRACKING_HEALTH_URL="$ok/api/health/tracking"

run_case "API answers 503" 1 HEALTH_TIMEOUT_SEC=4 \
  API_HEALTH_URL="http://127.0.0.1:$BAD_PORT/api/health/ready" GATEWAY_HEALTH_URL="$ok/health" TRACKING_HEALTH_URL="$ok/api/health/tracking"

run_case "API not listening" 1 HEALTH_TIMEOUT_SEC=4 \
  API_HEALTH_URL="http://127.0.0.1:$DEAD_PORT/api/health/ready" GATEWAY_HEALTH_URL="$ok/health" TRACKING_HEALTH_URL="$ok/api/health/tracking"

run_case "tracking CRITICAL (503)" 1 HEALTH_TIMEOUT_SEC=4 \
  API_HEALTH_URL="http://127.0.0.1:$TRK_PORT/api/health/ready" GATEWAY_HEALTH_URL="http://127.0.0.1:$TRK_PORT/health" TRACKING_HEALTH_URL="http://127.0.0.1:$TRK_PORT/api/health/tracking"

run_case "tracking skipped for a first install" 0 HEALTH_GATE_TRACKING=0 \
  API_HEALTH_URL="$ok/api/health/ready" GATEWAY_HEALTH_URL="$ok/health" TRACKING_HEALTH_URL="http://127.0.0.1:$DEAD_PORT/x"

run_case "map service down is WARN only" 0 \
  API_HEALTH_URL="$ok/api/health/ready" GATEWAY_HEALTH_URL="$ok/health" TRACKING_HEALTH_URL="$ok/api/health/tracking" \
  MARTIN_URL="http://127.0.0.1:$DEAD_PORT" ROUTER_ENGINE=graphhopper ROUTER_URL="$ok" GEOCODER=photon GEOCODER_URL="http://127.0.0.1:$BAD_PORT"

echo
echo "### API comes up during the wait (stub started 3 s after the gate; expect exit 0)"
late="$(mktemp)"
env HEALTH_GATE_SYSTEMD=0 HEALTH_POLL_SEC=1 HEALTH_TIMEOUT_SEC=15 ROUTER_URL= GEOCODER_URL= MARTIN_URL= \
  API_HEALTH_URL="http://127.0.0.1:$DEAD_PORT/api/health/ready" GATEWAY_HEALTH_URL="$ok/health" TRACKING_HEALTH_URL="$ok/api/health/tracking" \
  bash "$GATE" >"$late" 2>&1 &
gate_pid=$!
sleep 3
start_stub "$DEAD_PORT" 200
wait "$gate_pid"
code=$?
cat "$late"
echo "--> exit $code"
if [[ "$code" != 0 ]]; then
  echo "!!! late API: expected exit 0, got $code"
  FAILURES=$((FAILURES + 1))
fi
rm -f "$late"

run_case "bad setting" 2 HEALTH_TIMEOUT_SEC=abc

# Fake systemctl / journalctl on PATH: veetrax-notifier never becomes active.
FAKEBIN="$(mktemp -d)"
cat >"$FAKEBIN/systemctl" <<'EOF'
#!/usr/bin/env bash
unit="${*: -1}"
if [[ "$unit" == veetrax-notifier ]]; then [[ "$1" == is-active && "$2" != --quiet ]] && echo failed; exit 3; fi
[[ "$1" == is-active && "$2" != --quiet ]] && echo active
exit 0
EOF
cat >"$FAKEBIN/journalctl" <<'EOF'
#!/usr/bin/env bash
echo "(fake journal) $* : notifier: Error: connect ECONNREFUSED 127.0.0.1:6379"
EOF
chmod +x "$FAKEBIN/systemctl" "$FAKEBIN/journalctl"
run_case "systemd unit not active (fake systemctl)" 1 PATH="$FAKEBIN:$PATH" HEALTH_GATE_SYSTEMD=1 HEALTH_TIMEOUT_SEC=3 \
  API_HEALTH_URL="$ok/api/health/ready" GATEWAY_HEALTH_URL="$ok/health" TRACKING_HEALTH_URL="$ok/api/health/tracking"
rm -rf "$FAKEBIN"

echo
echo "### release.sh --health-only (APP_DIR=$REPO, expect exit 1 and the rollback text)"
STATE="$(mktemp -d)"
echo "v1.8.0" >"$STATE/release-prev"
out="$(env APP_DIR="$REPO" STATE_DIR="$STATE" HEALTH_GATE_SYSTEMD=0 HEALTH_POLL_SEC=1 HEALTH_TIMEOUT_SEC=3 ROUTER_URL= GEOCODER_URL= MARTIN_URL= \
  API_HEALTH_URL="http://127.0.0.1:$BAD_PORT/api/health/ready" GATEWAY_HEALTH_URL="$ok/health" TRACKING_HEALTH_URL="$ok/api/health/tracking" \
  bash "$HERE/../release.sh" --health-only 2>&1)"
code=$?
echo "$out"
echo "--> exit $code"
if [[ "$code" != 1 ]] || ! grep -q 'REF=v1.8.0 bash' <<<"$out"; then
  echo "!!! release.sh --health-only: expected exit 1 with 'REF=v1.8.0 bash', got $code"
  FAILURES=$((FAILURES + 1))
fi
rm -rf "$STATE"

echo
if (( FAILURES )); then
  echo "health-gate-test: $FAILURES case(s) FAILED"
  exit 1
fi
echo "health-gate-test: all cases passed"
