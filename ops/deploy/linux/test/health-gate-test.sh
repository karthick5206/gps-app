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
LATE_TRK_PORT=$((BASE_PORT + 4)) # starts late (tracking recovers during the wait)
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
  LAST_OUT="$out"
  LAST_NAME="$name"
  if [[ "$code" != "$expected" ]]; then
    echo "!!! $name: expected exit $expected, got $code"
    FAILURES=$((FAILURES + 1))
  fi
}

# expect_out <what> <regex...>: every regex matches the last run_case output.
expect_out() {
  local what="$1" re
  shift
  for re in "$@"; do
    if ! grep -qE -- "$re" <<<"$LAST_OUT"; then
      echo "!!! $LAST_NAME: $what: output does not match /$re/"
      FAILURES=$((FAILURES + 1))
    fi
  done
}

# expect_no_out <what> <regex...>: no regex matches the last run_case output.
expect_no_out() {
  local what="$1" re
  shift
  for re in "$@"; do
    if grep -qE -- "$re" <<<"$LAST_OUT"; then
      echo "!!! $LAST_NAME: $what: output matches /$re/"
      FAILURES=$((FAILURES + 1))
    fi
  done
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

run_case "tracking CRITICAL (503) until the deadline: WARN by default (processor lag after a restart)" 0 HEALTH_TIMEOUT_SEC=4 \
  API_HEALTH_URL="http://127.0.0.1:$TRK_PORT/api/health/ready" GATEWAY_HEALTH_URL="http://127.0.0.1:$TRK_PORT/health" TRACKING_HEALTH_URL="http://127.0.0.1:$TRK_PORT/api/health/tracking"
expect_out "WARN line and re-check hint" 'WARN  tracking.*HTTP 503' 'HEALTH_GATE_TRACKING=strict fails here' 'PASS after .* \(with warnings: tracking\)'

run_case "tracking CRITICAL (503) with HEALTH_GATE_TRACKING=strict" 1 HEALTH_TIMEOUT_SEC=4 HEALTH_GATE_TRACKING=strict \
  API_HEALTH_URL="http://127.0.0.1:$TRK_PORT/api/health/ready" GATEWAY_HEALTH_URL="http://127.0.0.1:$TRK_PORT/health" TRACKING_HEALTH_URL="http://127.0.0.1:$TRK_PORT/api/health/tracking"

run_case "tracking not answering is still a FAIL in the default mode" 1 HEALTH_TIMEOUT_SEC=3 \
  API_HEALTH_URL="$ok/api/health/ready" GATEWAY_HEALTH_URL="$ok/health" TRACKING_HEALTH_URL="http://127.0.0.1:$DEAD_PORT/api/health/tracking"

echo
echo "### tracking recovers during the wait (stub turns 200 after 3 s; expect exit 0, PASS for tracking)"
late="$(mktemp)"
env HEALTH_GATE_SYSTEMD=0 HEALTH_POLL_SEC=1 HEALTH_TIMEOUT_SEC=15 ROUTER_URL= GEOCODER_URL= MARTIN_URL= \
  API_HEALTH_URL="$ok/api/health/ready" GATEWAY_HEALTH_URL="$ok/health" TRACKING_HEALTH_URL="http://127.0.0.1:$LATE_TRK_PORT/api/health/tracking" \
  bash "$GATE" >"$late" 2>&1 &
gate_pid=$!
sleep 3
start_stub "$LATE_TRK_PORT" 200
wait "$gate_pid"
code=$?
cat "$late"
echo "--> exit $code"
if [[ "$code" != 0 ]] || ! grep -q 'PASS  tracking' "$late"; then
  echo "!!! late tracking: expected exit 0 with PASS tracking, got $code"
  FAILURES=$((FAILURES + 1))
fi
rm -f "$late"

run_case "bad HEALTH_GATE_TRACKING value" 2 HEALTH_GATE_TRACKING=maybe

run_case "tracking skipped for a first install" 0 HEALTH_GATE_TRACKING=0 \
  API_HEALTH_URL="$ok/api/health/ready" GATEWAY_HEALTH_URL="$ok/health" TRACKING_HEALTH_URL="http://127.0.0.1:$DEAD_PORT/x"

run_case "map service down is WARN only" 0 \
  API_HEALTH_URL="$ok/api/health/ready" GATEWAY_HEALTH_URL="$ok/health" TRACKING_HEALTH_URL="$ok/api/health/tracking" \
  MARTIN_URL="http://127.0.0.1:$DEAD_PORT" ROUTER_ENGINE=graphhopper ROUTER_URL="$ok" GEOCODER=photon GEOCODER_URL="http://127.0.0.1:$BAD_PORT"

# A public host is never fetched (photon.komoot.io would need the network; the WARN says "not probed"); userinfo and
# query strings never appear in the output.
run_case "map services: public host not probed, secrets not printed" 0 \
  API_HEALTH_URL="$ok/api/health/ready" GATEWAY_HEALTH_URL="$ok/health" TRACKING_HEALTH_URL="$ok/api/health/tracking" \
  GEOCODER=photon GEOCODER_URL="https://photon.komoot.io" \
  MARTIN_URL="http://ops:hunter2@127.0.0.1:$OK_PORT/?key=SECRETKEY" ROUTER_ENGINE=graphhopper ROUTER_URL="http://graphhopper:8989"
expect_out "public host reported" "WARN  maps .*photon https://photon.komoot.io/status not probed: 'photon.komoot.io' is not a loopback or private host" \
  "PASS  maps .*martin http://127.0.0.1:$OK_PORT/ HTTP 200" "WARN  maps .*graphhopper http://graphhopper:8989/health no answer"
expect_no_out "no secrets" 'hunter2' 'SECRETKEY' 'ops:'

run_case "MAP_PROBE_ALLOW_PUBLIC=1: a non-local host is probed" 0 MAP_PROBE_ALLOW_PUBLIC=1 \
  API_HEALTH_URL="$ok/api/health/ready" GATEWAY_HEALTH_URL="$ok/health" TRACKING_HEALTH_URL="$ok/api/health/tracking" \
  MARTIN_URL="http://203.0.113.9:9" # TEST-NET-3: never routed, so the probe just times out
expect_out "probed" "WARN  maps .*martin http://203.0.113.9:9/health no answer"

run_case "default URLs follow API_PORT; GATEWAY_HEALTH_PORT=0 skips the gateway" 0 API_PORT="$OK_PORT" GATEWAY_HEALTH_PORT=0
expect_out "port and skip" "PASS  api .*127.0.0.1:$OK_PORT/api/health/ready" "PASS  tracking .*127.0.0.1:$OK_PORT/api/health/tracking" "SKIP  gateway"

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
# Fake journalctl: readable unless FAKE_JOURNAL=denied (what the unprivileged 'veetrax' user sees).
cat >"$FAKEBIN/journalctl" <<'EOF'
#!/usr/bin/env bash
if [[ "${FAKE_JOURNAL:-ok}" == denied && "${FAKE_AS_ROOT:-0}" != 1 ]]; then
  echo "Hint: You are currently not seeing messages from other users and the system."
  echo "No journal files were opened due to insufficient permissions."
  exit 0
fi
echo "(fake journal) $* : notifier: Error: connect ECONNREFUSED 127.0.0.1:6379"
EOF
# Fake sudo (never the real one): FAKE_SUDO=allow grants exactly 'journalctl -u <unit> -n 50 --no-pager', like the
# installer's sudoers lines; anything else is refused.
cat >"$FAKEBIN/sudo" <<'EOF'
#!/usr/bin/env bash
[[ "$1" == -n ]] || exit 1
shift
list=0
[[ "$1" == -l ]] && { list=1; shift; }
[[ "${FAKE_SUDO:-deny}" == allow && "$1" == journalctl && "$2" == -u && "$4 $5 $6" == "-n 50 --no-pager" ]] || { echo "sudo: a password is required" >&2; exit 1; }
(( list )) && { echo "/usr/bin/$*"; exit 0; }
FAKE_AS_ROOT=1 "$@"
EOF
chmod +x "$FAKEBIN/systemctl" "$FAKEBIN/journalctl" "$FAKEBIN/sudo"
run_case "systemd unit not active (fake systemctl), journal readable" 1 PATH="$FAKEBIN:$PATH" HEALTH_GATE_SYSTEMD=1 HEALTH_TIMEOUT_SEC=3 \
  API_HEALTH_URL="$ok/api/health/ready" GATEWAY_HEALTH_URL="$ok/health" TRACKING_HEALTH_URL="$ok/api/health/tracking"
expect_out "journal tail" 'FAIL  systemd +veetrax-notifier' '\(fake journal\) -u veetrax-notifier -n 50 --no-pager'

run_case "journal not readable, sudoers grant present: tail via sudo -n" 1 PATH="$FAKEBIN:$PATH" HEALTH_GATE_SYSTEMD=1 HEALTH_TIMEOUT_SEC=3 \
  FAKE_JOURNAL=denied FAKE_SUDO=allow \
  API_HEALTH_URL="$ok/api/health/ready" GATEWAY_HEALTH_URL="$ok/health" TRACKING_HEALTH_URL="$ok/api/health/tracking"
expect_out "journal via sudo" '\(fake journal\) -u veetrax-notifier -n 50 --no-pager'
expect_no_out "no hint" 'run as root'

run_case "journal not readable, no sudo grant: hint with the root command" 1 PATH="$FAKEBIN:$PATH" HEALTH_GATE_SYSTEMD=1 HEALTH_TIMEOUT_SEC=3 \
  FAKE_JOURNAL=denied FAKE_SUDO=deny \
  API_HEALTH_URL="$ok/api/health/ready" GATEWAY_HEALTH_URL="$ok/health" TRACKING_HEALTH_URL="$ok/api/health/tracking"
expect_out "hint" 'run as root: sudo journalctl -u veetrax-notifier -n 50 --no-pager'
expect_no_out "no fake entries" '\(fake journal\)'

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

echo
echo "### release.sh --health-only with a bad gate setting (expect exit 2, no rollback text)"
out="$(env APP_DIR="$REPO" STATE_DIR="$STATE" HEALTH_GATE_SYSTEMD=0 HEALTH_TIMEOUT_SEC=abc bash "$HERE/../release.sh" --health-only 2>&1)"
code=$?
echo "$out"
echo "--> exit $code"
if [[ "$code" != 2 ]] || grep -q 'REF=' <<<"$out" || ! grep -q 'HEALTH GATE COULD NOT RUN' <<<"$out"; then
  echo "!!! release.sh exit 2: expected exit 2 with 'COULD NOT RUN' and no 'REF=', got $code"
  FAILURES=$((FAILURES + 1))
fi
rm -rf "$STATE"

# Full release.sh runs on a throw-away git repo (origin = a local bare repo) with fake npm / npx / sudo: tag v-old has
# no health-gate.sh (like v1.8.0), tag v-new has the current release.sh + health-gate.sh. Nothing real is built,
# migrated or restarted.
echo
echo "### release.sh full run: rollback to a tag without health-gate.sh, web build swap, failed web build"
SANDBOX="$(mktemp -d)"
G=(git -c user.name=test -c user.email=test@example.invalid -c init.defaultBranch=main -c advice.detachedHead=false)
"${G[@]}" init -q --bare "$SANDBOX/origin.git"
"${G[@]}" clone -q "$SANDBOX/origin.git" "$SANDBOX/src" 2>/dev/null
mkdir -p "$SANDBOX/src/apps/api" "$SANDBOX/src/apps/web" "$SANDBOX/src/ops/deploy/linux"
printf 'dist/\ndist.next/\ndist.prev/\n' >"$SANDBOX/src/apps/web/.gitignore"
echo old >"$SANDBOX/src/apps/api/VERSION"
(cd "$SANDBOX/src" && "${G[@]}" add -A && "${G[@]}" commit -qm old && "${G[@]}" tag v-old)
cp "$HERE/../release.sh" "$HERE/../health-gate.sh" "$SANDBOX/src/ops/deploy/linux/"
echo new >"$SANDBOX/src/apps/api/VERSION"
(cd "$SANDBOX/src" && "${G[@]}" add -A && "${G[@]}" commit -qm new && "${G[@]}" tag v-new && "${G[@]}" push -q origin main --tags 2>/dev/null)
"${G[@]}" clone -q "$SANDBOX/origin.git" "$SANDBOX/app" 2>/dev/null
(cd "$SANDBOX/app" && "${G[@]}" checkout -q --detach v-new)
mkdir -p "$SANDBOX/app/apps/web/dist" && echo live-v-new >"$SANDBOX/app/apps/web/dist/index.html"
mkdir -p "$SANDBOX/state"
cat >"$FAKEBIN/npm" <<'EOF'
#!/usr/bin/env bash
# Fake npm: the web build writes apps/web/$VEETRAX_WEB_OUTDIR (or fails with FAKE_WEB_FAIL=1, like the maps check).
if [[ "$*" == "run build -w @veetracer/web" ]]; then
  if [[ "${FAKE_WEB_FAIL:-0}" == 1 ]]; then
    mkdir -p "apps/web/${VEETRAX_WEB_OUTDIR:-dist}" && echo half >"apps/web/${VEETRAX_WEB_OUTDIR:-dist}/index.html"
    echo "check-no-external-maps: FAIL, 1 outside map host reference(s). (fake)" >&2
    exit 1
  fi
  mkdir -p "apps/web/${VEETRAX_WEB_OUTDIR:-dist}" && echo "built-$(cat apps/api/VERSION)" >"apps/web/${VEETRAX_WEB_OUTDIR:-dist}/index.html"
fi
exit 0
EOF
printf '#!/usr/bin/env bash\nexit 0\n' >"$FAKEBIN/npx"
cat >"$FAKEBIN/sudo" <<'EOF'
#!/usr/bin/env bash
[[ "$1 $2" == "systemctl restart" ]] && exit 0
exit 1
EOF
chmod +x "$FAKEBIN/npm" "$FAKEBIN/npx" "$FAKEBIN/sudo"
release() { # release <expected exit> <args/env...>: runs a release.sh in the sandbox, sets out/code
  local expected="$1"
  shift
  out="$(env PATH="$FAKEBIN:$PATH" APP_DIR="$SANDBOX/app" STATE_DIR="$SANDBOX/state" HEALTH_GATE_SYSTEMD=0 HEALTH_POLL_SEC=1 HEALTH_TIMEOUT_SEC=5 \
    ROUTER_URL= GEOCODER_URL= MARTIN_URL= API_HEALTH_URL="$ok/api/health/ready" GATEWAY_HEALTH_URL="$ok/health" TRACKING_HEALTH_URL="$ok/api/health/tracking" \
    "$@" 2>&1)"
  code=$?
  echo "$out" | sed 's/^/    /'
  echo "  --> exit $code"
  [[ "$code" == "$expected" ]]
}
check() { # check <description> <command...>
  local what="$1"
  shift
  if "$@"; then echo "  ok   $what"; else echo "  !!! FAIL $what"; FAILURES=$((FAILURES + 1)); fi
}
web() { cat "$SANDBOX/app/apps/web/$1/index.html" 2>/dev/null; }

echo "## REF=v-old bash release.sh (the v-new script, as an operator rolls back)"
release 0 REF=v-old bash "$SANDBOX/app/ops/deploy/linux/release.sh"
check "rollback exits 0" test "$code" == 0
check "gated with the copied gate: 'Release is healthy'" grep -q 'Release is healthy' <<<"$out"
check "no 'RELEASE FAILED HEALTH GATE'" bash -c '! grep -q "RELEASE FAILED" <<<"$1"' _ "$out"
check "checkout is v-old (no health-gate.sh in the tree)" test ! -e "$SANDBOX/app/ops/deploy/linux/health-gate.sh"
check "new web build swapped in" test "$(web dist)" == built-old
check "previous build kept in dist.prev" test "$(web dist.prev)" == live-v-new
check "no dist.next left" test ! -e "$SANDBOX/app/apps/web/dist.next"
check "no gate copy left in TMPDIR" bash -c '! ls "${TMPDIR:-/tmp}"/veetrax-health-gate.* >/dev/null 2>&1'

echo "## release.sh --health-only on a tree without a gate"
release 0 bash "$HERE/../release.sh" --health-only
check "skipped with a clear message, exit 0" grep -q 'health gate SKIPPED: no health-gate.sh in this release' <<<"$out"
check "no rollback text" bash -c '! grep -q "REF=" <<<"$1"' _ "$out"

echo "## REF=v-new with a failing web build (external-maps check)"
release 1 REF=v-new FAKE_WEB_FAIL=1 bash "$HERE/../release.sh"
check "exit 1" test "$code" == 1
check "WEB BUILD FAILED message with the rollback command" bash -c 'grep -q "WEB BUILD FAILED" <<<"$1" && grep -q "REF=v-old bash" <<<"$1"' _ "$out"
check "live dist untouched" test "$(web dist)" == built-old
check "half build removed" test ! -e "$SANDBOX/app/apps/web/dist.next"
check "nothing restarted / no gate run" bash -c '! grep -qE "== restart|health gate" <<<"$1"' _ "$out"
rm -rf "$SANDBOX" "$FAKEBIN"

echo
if (( FAILURES )); then
  echo "health-gate-test: $FAILURES case(s) FAILED"
  exit 1
fi
echo "health-gate-test: all cases passed"
