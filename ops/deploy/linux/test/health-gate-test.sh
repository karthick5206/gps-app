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

run_case "tracking CRITICAL (503) until the deadline: FAIL by default (spec G6: 200 only)" 1 HEALTH_TIMEOUT_SEC=4 \
  API_HEALTH_URL="http://127.0.0.1:$TRK_PORT/api/health/ready" GATEWAY_HEALTH_URL="http://127.0.0.1:$TRK_PORT/health" TRACKING_HEALTH_URL="http://127.0.0.1:$TRK_PORT/api/health/tracking"
expect_out "FAIL line" 'FAIL  tracking.*HTTP 503' 'HEALTH GATE: FAIL \(tracking\)'
expect_no_out "no WARN downgrade" 'WARN  tracking'

run_case "tracking CRITICAL (503) with HEALTH_GATE_TRACKING=strict (same as the default)" 1 HEALTH_TIMEOUT_SEC=4 HEALTH_GATE_TRACKING=strict \
  API_HEALTH_URL="http://127.0.0.1:$TRK_PORT/api/health/ready" GATEWAY_HEALTH_URL="http://127.0.0.1:$TRK_PORT/health" TRACKING_HEALTH_URL="http://127.0.0.1:$TRK_PORT/api/health/tracking"
expect_out "FAIL line" 'FAIL  tracking.*HTTP 503'

run_case "tracking CRITICAL (503) with the opt-in HEALTH_GATE_TRACKING=warn: WARN, gate passes" 0 HEALTH_TIMEOUT_SEC=4 HEALTH_GATE_TRACKING=warn \
  API_HEALTH_URL="http://127.0.0.1:$TRK_PORT/api/health/ready" GATEWAY_HEALTH_URL="http://127.0.0.1:$TRK_PORT/health" TRACKING_HEALTH_URL="http://127.0.0.1:$TRK_PORT/api/health/tracking"
expect_out "WARN line and re-check hint" 'WARN  tracking.*HTTP 503' 'HEALTH_GATE_TRACKING=warn was chosen' 'PASS after .* \(with warnings: tracking\)'

run_case "tracking not answering is a FAIL even with HEALTH_GATE_TRACKING=warn" 1 HEALTH_TIMEOUT_SEC=3 HEALTH_GATE_TRACKING=warn \
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
# Fake journalctl, as systemd's behaves for a user outside systemd-journal / adm (unless run via the fake sudo):
#   FAKE_JOURNAL=denied     no journal file readable: the multi-line hint (not with -q) and the error, exit 1
#   FAKE_JOURNAL=userfiles  only the user's own journal readable: hint + "-- No entries --" (nothing with -q), exit 0
#   FAKE_JOURNAL=noisy      prints the whole 4-line notice even with -q and exits 0 (the content check must catch it)
cat >"$FAKEBIN/journalctl" <<'EOF'
#!/usr/bin/env bash
quiet=0
for a in "$@"; do [[ "$a" == -q ]] && quiet=1; done
hint() {
  echo "Hint: You are currently not seeing messages from other users and the system."
  echo "      Users in groups 'adm', 'systemd-journal' can see all messages."
  echo "      Pass -q to turn off this notice."
}
if [[ "${FAKE_AS_ROOT:-0}" != 1 ]]; then
  case "${FAKE_JOURNAL:-ok}" in
    denied) (( quiet )) || hint >&2; echo "No journal files were opened due to insufficient permissions." >&2; exit 1 ;;
    userfiles) (( quiet )) || { hint >&2; echo "-- No entries --"; }; exit 0 ;;
    noisy) hint >&2; echo "No journal files were opened due to insufficient permissions." >&2; exit 0 ;;
  esac
fi
echo "(fake journal) $* : notifier: Error: connect ECONNREFUSED 127.0.0.1:6379"
echo "    at TCPConnectWrap.afterConnect (node:net:1611:16)"
EOF
# Fake sudo (never the real one): FAKE_SUDO=allow grants exactly 'journalctl -u <unit> -n 50 --no-pager', like the
# installer's sudoers lines; anything else is refused.
cat >"$FAKEBIN/sudo" <<'EOF'
#!/usr/bin/env bash
[[ "$1" == -n ]] || exit 1
shift
list=0
[[ "$1" == -l ]] && { list=1; shift; }
[[ "${FAKE_SUDO:-deny}" == allow && $# == 6 && "$1" == journalctl && "$2" == -u && "$4 $5 $6" == "-n 50 --no-pager" ]] || { echo "sudo: a password is required" >&2; exit 1; }
(( list )) && { echo "/usr/bin/$*"; exit 0; }
FAKE_AS_ROOT=1 "$@"
EOF
chmod +x "$FAKEBIN/systemctl" "$FAKEBIN/journalctl" "$FAKEBIN/sudo"
run_case "systemd unit not active (fake systemctl), journal readable" 1 PATH="$FAKEBIN:$PATH" HEALTH_GATE_SYSTEMD=1 HEALTH_TIMEOUT_SEC=3 \
  API_HEALTH_URL="$ok/api/health/ready" GATEWAY_HEALTH_URL="$ok/health" TRACKING_HEALTH_URL="$ok/api/health/tracking"
expect_out "journal tail" 'FAIL  systemd +veetrax-notifier' '\(fake journal\) -q -u veetrax-notifier -n 50 --no-pager' 'at TCPConnectWrap'

for mode in denied userfiles noisy; do
  run_case "journal not readable ($mode), sudoers grant present: tail via sudo -n" 1 PATH="$FAKEBIN:$PATH" HEALTH_GATE_SYSTEMD=1 HEALTH_TIMEOUT_SEC=3 \
    FAKE_JOURNAL="$mode" FAKE_SUDO=allow \
    API_HEALTH_URL="$ok/api/health/ready" GATEWAY_HEALTH_URL="$ok/health" TRACKING_HEALTH_URL="$ok/api/health/tracking"
  # Exactly the sudoers arguments (no -q), else the fake sudo refuses.
  expect_out "journal via sudo" '\(fake journal\) -u veetrax-notifier -n 50 --no-pager'
  expect_no_out "no hint, no notice as entries" 'run as root' 'Users in groups' 'Hint: '

  run_case "journal not readable ($mode), no sudo grant: hint with the root command" 1 PATH="$FAKEBIN:$PATH" HEALTH_GATE_SYSTEMD=1 HEALTH_TIMEOUT_SEC=3 \
    FAKE_JOURNAL="$mode" FAKE_SUDO=deny \
    API_HEALTH_URL="$ok/api/health/ready" GATEWAY_HEALTH_URL="$ok/health" TRACKING_HEALTH_URL="$ok/api/health/tracking"
  expect_out "hint" 'journal not readable as .*run as root: sudo journalctl -u veetrax-notifier -n 50 --no-pager'
  expect_no_out "no fake entries" '\(fake journal\)'
done

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

# Full release.sh runs on a throw-away git repo (origin = a local bare repo) with fake npm / npx / sudo / mv. Nothing
# real is built, migrated or restarted. Three tags:
#   v-old  like v1.8.0: no health-gate.sh, no external-maps check, and a vite config WITHOUT VEETRAX_WEB_OUTDIR, so its
#          web build ignores the variable and rebuilds apps/web/dist in place (emptied first, as vite does);
#   v-mid  the same legacy vite, but with scripts/check-no-external-maps.mjs (a fake that fails with FAKE_CHECK_FAIL=1);
#   v-new  the current release.sh + health-gate.sh and a vite config that honours VEETRAX_WEB_OUTDIR.
# After every run, apps/web/dist must exist (checked through its content).
echo
echo "### release.sh full run: rollbacks to legacy tags, web build swap, failed builds, checks and renames"
SANDBOX="$(mktemp -d)"
G=(git -c user.name=test -c user.email=test@example.invalid -c init.defaultBranch=main -c advice.detachedHead=false)
"${G[@]}" init -q --bare "$SANDBOX/origin.git"
"${G[@]}" clone -q "$SANDBOX/origin.git" "$SANDBOX/src" 2>/dev/null
mkdir -p "$SANDBOX/src/apps/api" "$SANDBOX/src/apps/web" "$SANDBOX/src/ops/deploy/linux" "$SANDBOX/src/scripts"
printf 'dist/\ndist.next/\ndist.prev/\n' >"$SANDBOX/src/apps/web/.gitignore"
echo "export default { build: { outDir: 'dist' } };" >"$SANDBOX/src/apps/web/vite.config.ts"
echo old >"$SANDBOX/src/apps/api/VERSION"
(cd "$SANDBOX/src" && "${G[@]}" add -A && "${G[@]}" commit -qm old && "${G[@]}" tag v-old)
cat >"$SANDBOX/src/scripts/check-no-external-maps.mjs" <<'EOF'
// Fake G8 check: fails with FAKE_CHECK_FAIL=1.
if (process.env.FAKE_CHECK_FAIL === '1') {
  console.error('check-no-external-maps: FAIL, 1 outside map host reference(s). (fake)');
  process.exit(1);
}
console.log(`check-no-external-maps: OK (fake) ${process.argv.slice(2).join(' ')} VEETRAX_WEB_OUTDIR=${process.env.VEETRAX_WEB_OUTDIR ?? '(unset)'}`);
EOF
echo mid >"$SANDBOX/src/apps/api/VERSION"
(cd "$SANDBOX/src" && "${G[@]}" add -A && "${G[@]}" commit -qm mid && "${G[@]}" tag v-mid)
cp "$HERE/../release.sh" "$HERE/../health-gate.sh" "$SANDBOX/src/ops/deploy/linux/"
echo "export default { build: { outDir: process.env.VEETRAX_WEB_OUTDIR?.trim() || 'dist' } };" >"$SANDBOX/src/apps/web/vite.config.ts"
echo new >"$SANDBOX/src/apps/api/VERSION"
(cd "$SANDBOX/src" && "${G[@]}" add -A && "${G[@]}" commit -qm new && "${G[@]}" tag v-new && "${G[@]}" push -q origin main --tags 2>/dev/null)
"${G[@]}" clone -q "$SANDBOX/origin.git" "$SANDBOX/app" 2>/dev/null
(cd "$SANDBOX/app" && "${G[@]}" checkout -q --detach v-new)
mkdir -p "$SANDBOX/app/apps/web/dist" && echo live-v-new >"$SANDBOX/app/apps/web/dist/index.html"
mkdir -p "$SANDBOX/state"
cat >"$FAKEBIN/npm" <<'EOF'
#!/usr/bin/env bash
# Fake npm. The web build writes apps/web/$VEETRAX_WEB_OUTDIR only when the checked-out vite config reads that variable
# (v1.8.1+); an older tree builds into apps/web/dist whatever the variable says. Like vite, the output folder is emptied
# first. FAKE_WEB_FAIL=1: a half build, then exit 1 (as when tsc / vite / the maps check fails).
if [[ "$*" == "run build -w @veetracer/web" ]]; then
  out=dist
  grep -q VEETRAX_WEB_OUTDIR apps/web/vite.config.ts && out="${VEETRAX_WEB_OUTDIR:-dist}"
  rm -rf "apps/web/$out" && mkdir -p "apps/web/$out"
  if [[ "${FAKE_WEB_FAIL:-0}" == 1 ]]; then
    echo half >"apps/web/$out/index.html"
    echo "web build FAILED (fake)" >&2
    exit 1
  fi
  echo "built-$(cat apps/api/VERSION)" >"apps/web/$out/index.html"
fi
exit 0
EOF
printf '#!/usr/bin/env bash\nexit 0\n' >"$FAKEBIN/npx"
cat >"$FAKEBIN/sudo" <<'EOF'
#!/usr/bin/env bash
[[ "$1 $2" == "systemctl restart" ]] && exit 0
exit 1
EOF
# Fake mv: FAKE_MV_FAIL=1 refuses to move apps/web/dist.next (the second rename of the swap); everything else is the
# real mv.
REAL_MV="$(command -v mv)"
cat >"$FAKEBIN/mv" <<EOF
#!/usr/bin/env bash
src=""
for a in "\$@"; do [[ "\$a" == -* ]] || { src="\$a"; break; }; done
if [[ "\${FAKE_MV_FAIL:-0}" == 1 && "\$src" == */dist.next ]]; then echo "mv: cannot move '\$src': Permission denied (fake)" >&2; exit 1; fi
exec "$REAL_MV" "\$@"
EOF
chmod +x "$FAKEBIN/npm" "$FAKEBIN/npx" "$FAKEBIN/sudo" "$FAKEBIN/mv"
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
no_next() { test ! -e "$SANDBOX/app/apps/web/dist.next"; }
out_has() { grep -qE -- "$1" <<<"$out"; }
out_lacks() { ! grep -qE -- "$1" <<<"$out"; }
RELEASE="$HERE/../release.sh"

echo "## 1. REF=v-old bash release.sh (the v-new script, as an operator rolls back to a legacy tag)"
release 0 REF=v-old bash "$SANDBOX/app/ops/deploy/linux/release.sh"
check "rollback exits 0" test "$code" == 0
check "gated with the copied gate: 'Release is healthy'" out_has 'Release is healthy'
check "no 'RELEASE FAILED' / 'WEB BUILD FAILED'" out_lacks 'RELEASE FAILED|WEB BUILD FAILED'
check "checkout is v-old (no health-gate.sh in the tree)" test ! -e "$SANDBOX/app/ops/deploy/linux/health-gate.sh"
check "live dist = the in-place v-old build (no swap)" test "$(web dist)" == built-old
check "copy of the previous live build in dist.prev" test "$(web dist.prev)" == live-v-new
check "no dist.next left" no_next
check "says the build was not checked (tree has no check script)" out_has 'was not checked for outside map hosts'
check "no gate copy left in TMPDIR" bash -c '! ls "${TMPDIR:-/tmp}"/veetrax-health-gate.* >/dev/null 2>&1'

echo "## 2. release.sh --health-only on a tree without a gate"
release 0 bash "$RELEASE" --health-only
check "skipped with a clear message, exit 0" out_has 'health gate SKIPPED: no health-gate.sh in this release'
check "no rollback text" out_lacks 'REF='

echo "## 3. REF=v-old with a failing legacy build (dist emptied in place, then the build fails)"
release 1 REF=v-old FAKE_WEB_FAIL=1 bash "$RELEASE"
check "exit 1 with WEB BUILD FAILED" out_has 'WEB BUILD FAILED'
check "live dist restored to the build that was live before" test "$(web dist)" == built-old
check "restore reported" out_has 'apps/web/dist restored from apps/web/dist.prev'
check "nothing restarted / no gate run" out_lacks '== restart|health gate'

echo "## 4. REF=v-mid: legacy in-place build passes, the external-maps check on dist FAILS"
release 1 REF=v-mid FAKE_CHECK_FAIL=1 bash "$RELEASE"
check "exit 1 with the check failure and WEB BUILD FAILED" bash -c 'grep -q "check-no-external-maps: FAIL" <<<"$1" && grep -q "WEB BUILD FAILED" <<<"$1"' _ "$out"
check "live dist restored (the unchecked v-mid build is not served)" test "$(web dist)" == built-old
check "nothing restarted / no gate run" out_lacks '== restart|health gate'

echo "## 5. REF=v-mid: legacy in-place build, the check runs on apps/web/dist and passes"
release 0 REF=v-mid bash "$RELEASE"
check "exit 0 (the release.sh run has no gate copy and the v-mid tree no gate: not gated)" bash -c 'test "$1" == 0 && grep -q "Release finished (not gated)" <<<"$2"' _ "$code" "$out"
check "check ran on apps/web/dist (variable unset)" out_has 'check-no-external-maps: OK \(fake\) apps/web/dist VEETRAX_WEB_OUTDIR=\(unset\)'
check "live dist = v-mid build" test "$(web dist)" == built-mid
check "previous build in dist.prev" test "$(web dist.prev)" == built-old
check "no dist.next left" no_next

echo "## 6. REF=v-new with a failing web build (into dist.next)"
release 1 REF=v-new FAKE_WEB_FAIL=1 bash "$RELEASE"
check "WEB BUILD FAILED message with the rollback command" bash -c 'grep -q "WEB BUILD FAILED" <<<"$1" && grep -q "REF=v-mid bash" <<<"$1"' _ "$out"
check "live dist untouched" test "$(web dist)" == built-mid
check "half build removed" no_next
check "nothing restarted / no gate run" out_lacks '== restart|health gate'

echo "## 7. REF=v-new: build passes, the second rename (dist.next -> dist) fails"
release 1 REF=v-new FAKE_MV_FAIL=1 bash "$RELEASE"
check "WEB BUILD FAILED" out_has 'WEB BUILD FAILED'
check "live dist moved back from dist.prev" test "$(web dist)" == built-mid
check "restore reported" out_has 'apps/web/dist restored from apps/web/dist.prev'
check "no dist.next left" no_next
check "nothing restarted / no gate run" out_lacks '== restart|health gate'

echo "## 8. REF=v-new: normal release, swap"
release 0 REF=v-new bash "$RELEASE"
check "exit 0, healthy" out_has 'Release is healthy'
check "new build swapped in" test "$(web dist)" == built-new
check "previous build in dist.prev" test "$(web dist.prev)" == built-mid
check "no dist.next left" no_next
check "no legacy note" out_lacks 'builds the web app in place'

echo "## 9. --web-only with a failing build: no 'node_modules' claim (npm ci did not run)"
release 1 FAKE_WEB_FAIL=1 bash "$RELEASE" --web-only
check "WEB BUILD FAILED" out_has 'WEB BUILD FAILED'
check "says nothing was restarted" out_has 'nothing was restarted'
check "no node_modules claim" out_lacks 'node_modules'
check "live dist untouched" test "$(web dist)" == built-new
rm -rf "$SANDBOX" "$FAKEBIN"

echo
if (( FAILURES )); then
  echo "health-gate-test: $FAILURES case(s) FAILED"
  exit 1
fi
echo "health-gate-test: all cases passed"
