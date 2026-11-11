#!/usr/bin/env bash
# VeeTrax post-deploy health gate (release-gate spec G6). release.sh runs it after restarting the services; it can
# also run on its own, e.g. against the test instance or local stubs:
#   bash ops/deploy/linux/health-gate.sh
#   HEALTH_GATE_SYSTEMD=0 API_HEALTH_URL=http://127.0.0.1:4100/api/health/ready bash ops/deploy/linux/health-gate.sh
# Prints one PASS / FAIL / WARN / SKIP line per check and a final verdict. Exit 0 = PASS, 1 = FAIL, 2 = usage error.
# It never rolls anything back; release.sh prints the rollback command when the gate fails.
#
# Settings (environment):
#   SERVICES              systemd units that must be active (default: the five veetrax-* services)
#   API_HEALTH_URL        default http://127.0.0.1:${API_PORT:-4000}/api/health/ready (503 while PostgreSQL / Valkey are down)
#   GATEWAY_HEALTH_URL    default http://127.0.0.1:${GATEWAY_HEALTH_PORT:-4121}/health (GATEWAY_HEALTH_PORT=0: skipped)
#   TRACKING_HEALTH_URL   default http://127.0.0.1:${API_PORT:-4000}/api/health/tracking (200 = OK or WARN, 503 = CRITICAL)
#                         API_PORT / GATEWAY_HEALTH_PORT are the API's own settings (release.sh loads apps/api/.env).
#   HEALTH_TIMEOUT_SEC    whole gate deadline, default 90; HEALTH_POLL_SEC retry interval, default 3. Every check is
#                         capped by the time left; a check reached after the deadline still gets one 1 s attempt, so
#                         the gate ends within HEALTH_TIMEOUT_SEC + about 3 s (plus the journal tail on failure).
#   HEALTH_GATE_SYSTEMD   auto (default: only where systemctl exists) | 1 | 0
#   HEALTH_GATE_GATEWAY / HEALTH_GATE_MAPS  1 (default) | 0 to skip that part
#   HEALTH_GATE_TRACKING  1 (default, spec G6): tracking is retried until the deadline (processor lag right after a
#                         restart); anything but 200 then FAILS the gate. ('strict' is accepted as the same.)
#                         warn = opt-in, operator's own choice: a 503 (tracking CRITICAL) at the deadline is only a WARN
#                         (no answer or any other code still fails); re-check later with release.sh --health-only.
#                         0 = skipped (a first install with no devices yet).
#   ROUTER_URL + ROUTER_ENGINE=graphhopper, GEOCODER=photon + GEOCODER_URL, MARTIN_URL: map services, probed once
#                         and reported as WARN only (release.sh does not deploy them, so they never fail the gate).
#                         Only loopback / private hosts are probed; a public host is reported (WARN) and not fetched
#                         unless MAP_PROBE_ALLOW_PUBLIC=1. Printed URLs never show userinfo or a query string.
#
# No `set -e` on purpose: this is a checker. Every check handles its own failure (records it and goes on), so one
# failed curl or systemctl must not end the script before the remaining checks, the journal and the verdict.
set -uo pipefail

SERVICES="${SERVICES:-veetrax-api veetrax-gateway veetrax-processor veetrax-notifier veetrax-summarizer}"
API_PORT="${API_PORT:-4000}"
API_HEALTH_URL="${API_HEALTH_URL:-http://127.0.0.1:$API_PORT/api/health/ready}"
if [[ -z "${GATEWAY_HEALTH_URL:-}" && "${GATEWAY_HEALTH_PORT:-}" == 0 ]]; then
  HEALTH_GATE_GATEWAY=0 # the gateway's health listener is disabled
fi
GATEWAY_HEALTH_URL="${GATEWAY_HEALTH_URL:-http://127.0.0.1:${GATEWAY_HEALTH_PORT:-4121}/health}"
TRACKING_HEALTH_URL="${TRACKING_HEALTH_URL:-http://127.0.0.1:$API_PORT/api/health/tracking}"
MAP_PROBE_ALLOW_PUBLIC="${MAP_PROBE_ALLOW_PUBLIC:-0}"
HEALTH_TIMEOUT_SEC="${HEALTH_TIMEOUT_SEC:-90}"
HEALTH_POLL_SEC="${HEALTH_POLL_SEC:-3}"
HEALTH_GATE_SYSTEMD="${HEALTH_GATE_SYSTEMD:-auto}"
HEALTH_GATE_GATEWAY="${HEALTH_GATE_GATEWAY:-1}"
HEALTH_GATE_TRACKING="${HEALTH_GATE_TRACKING:-1}"
HEALTH_GATE_MAPS="${HEALTH_GATE_MAPS:-1}"

for n in HEALTH_TIMEOUT_SEC HEALTH_POLL_SEC; do
  if ! [[ "${!n}" =~ ^[0-9]+$ ]] || (( ${!n} < 1 )); then
    echo "health-gate: $n must be a positive whole number of seconds (got '${!n}')" >&2
    exit 2
  fi
done
if [[ ! "$HEALTH_GATE_TRACKING" =~ ^(0|1|strict|warn)$ ]]; then
  echo "health-gate: HEALTH_GATE_TRACKING must be 1 (strict), warn or 0 (got '$HEALTH_GATE_TRACKING')" >&2
  exit 2
fi
if ! command -v curl >/dev/null; then
  echo "health-gate: curl is required" >&2
  exit 2
fi
if [[ "$HEALTH_GATE_SYSTEMD" == auto ]]; then
  if command -v systemctl >/dev/null; then HEALTH_GATE_SYSTEMD=1; else HEALTH_GATE_SYSTEMD=0; fi
fi

FAILED=()        # names of failed checks
WARNED=()        # gate checks downgraded to WARN (tracking with HEALTH_GATE_TRACKING=warn)
FAILED_UNITS=()  # units whose journal is printed on failure
BODY="$(mktemp)"
trap 'rm -f "$BODY"' EXIT
SECONDS=0

remaining() { echo $(( HEALTH_TIMEOUT_SEC - SECONDS )); }
line() { printf '%-5s %-9s %s\n' "$1" "$2" "$3"; }
add_unit() { local u; for u in "$@"; do [[ " ${FAILED_UNITS[*]-} " == *" $u "* ]] || FAILED_UNITS+=("$u"); done; }

# One GET; prints the HTTP code (000 = no answer) and leaves the body in $BODY.
# -q (must come first): ignore ~/.curlrc; --proto: http / https only (no file:// etc.); `--`: a URL that starts with
# '-' is never read as an option. No -L: redirects are not followed (a 3xx is not 200 / 2xx, so not healthy).
http_code() {
  local url="$1" max="$2" code
  code="$(curl -q -s --proto '=http,https' -o "$BODY" -w '%{http_code}' --connect-timeout "$max" --max-time "$max" -- "$url" 2>/dev/null)" || true
  echo "${code:-000}"
}

describe() {
  case "$1" in
    000) echo "no answer (not listening or timed out)" ;;
    *) echo "HTTP $1" ;;
  esac
}

# URL without userinfo, query or fragment, for printing (a probe URL may carry a key or a password).
safe_url() {
  local u="${1%%[?#]*}" scheme="" rest
  [[ "$u" == *://* ]] && scheme="${u%%://*}://"
  rest="${u#"$scheme"}"
  local auth="${rest%%/*}" path=""
  [[ "$rest" == */* ]] && path="/${rest#*/}"
  echo "${scheme}${auth##*@}${path}"
}

# Host of a URL (no userinfo, port or brackets), lower case.
url_host() {
  local u="${1#*://}"
  u="${u%%[/?#]*}"
  u="${u##*@}"
  if [[ "$u" == \[* ]]; then u="${u#\[}"; u="${u%%\]*}"; else u="${u%%:*}"; fi
  echo "$u" | tr '[:upper:]' '[:lower:]'
}

# Loopback / private / single-label hosts only (same rule as apps/api/src/monitoring/map-services.ts isLocalHost).
is_local_host() {
  local h="$1" a b
  case "$h" in
    localhost | *.localhost | *.local | *.internal | *.lan | ::1 | fc*:* | fd*:* | fe[89ab]?:*) return 0 ;; # IPv6 only with a ':'
  esac
  if [[ "$h" =~ ^([0-9]+)\.([0-9]+)\.[0-9]+\.[0-9]+$ ]]; then
    a="${BASH_REMATCH[1]}" b="${BASH_REMATCH[2]}"
    (( a == 127 || a == 10 || (a == 172 && b >= 16 && b <= 31) || (a == 192 && b == 168) || (a == 169 && b == 254) )) && return 0
    return 1
  fi
  [[ -n "$h" && "$h" != *.* && "$h" != *:* ]] # single-label name, e.g. a compose service
}

# poll_http <FAIL|WARN> <name> <url> <units...>: retry until HTTP 200 or the gate deadline; at the deadline the check
# FAILS the gate, or (WARN) is only reported.
poll_http() {
  local level="$1" name="$2" url="$3" code left max shown
  shift 3
  shown="$(safe_url "$url")"
  while :; do
    left="$(remaining)"
    max=$(( left < 5 ? (left < 1 ? 1 : left) : 5 ))
    code="$(http_code "$url" "$max")"
    if [[ "$code" == 200 ]]; then
      line PASS "$name" "$shown HTTP 200 after ${SECONDS} s"
      return 0
    fi
    left="$(remaining)"
    if (( left <= 0 )); then
      # WARN level: only the "CRITICAL" answer (503) is downgraded; no answer or any other code still fails.
      local verdict=FAIL
      [[ "$level" == WARN && "$code" == 503 ]] && verdict=WARN
      line "$verdict" "$name" "$shown last answer: $(describe "$code") after ${SECONDS} s"
      if [[ "$code" != 000 && -s "$BODY" ]]; then
        printf '      body: %s\n' "$(head -c 400 "$BODY" | tr -d '\r' | tr '\n' ' ')"
      fi
      if [[ "$verdict" == WARN ]]; then
        echo "      not failing the gate only because HEALTH_GATE_TRACKING=warn was chosen (the default fails here)."
        echo "      Re-check in a few minutes with release.sh --health-only; tracking must reach 200."
        WARNED+=("$name")
        return 0
      fi
      FAILED+=("$name")
      add_unit "$@"
      return 1
    fi
    sleep $(( HEALTH_POLL_SEC < left ? HEALTH_POLL_SEC : left ))
  done
}

# systemd units must become active (retry for up to 30 s, within the gate deadline).
check_units() {
  local unit limit=$(( HEALTH_TIMEOUT_SEC < 30 ? HEALTH_TIMEOUT_SEC : 30 ))
  for unit in $SERVICES; do
    until systemctl is-active --quiet "$unit"; do
      if (( SECONDS >= limit )); then
        line FAIL systemd "$unit is $(systemctl is-active "$unit" 2>/dev/null || true) after ${SECONDS} s"
        FAILED+=("systemd:$unit")
        add_unit "$unit"
        continue 2
      fi
      sleep 1
    done
    line PASS systemd "$unit active"
  done
}

# Map services: one probe each, WARN only. They run inside the gate deadline: each probe's curl --max-time is the
# remaining time (at most 3 s), and once the deadline has passed the rest are reported as not probed (QA-3).
check_maps() {
  local name url impact code host left max
  local engine geocoder
  engine="$(echo "${ROUTER_ENGINE:-valhalla}" | tr '[:upper:]' '[:lower:]')"
  geocoder="$(echo "${GEOCODER:-none}" | tr '[:upper:]' '[:lower:]')"
  for name in graphhopper photon martin; do
    case "$name" in
      graphhopper) url="${ROUTER_URL:-}"; [[ "$engine" == graphhopper ]] || url=""; url="${url:+${url%/}/health}"; impact="routing, ETAs and road snapping are skipped" ;;
      photon) url="${GEOCODER_URL:-}"; [[ "$geocoder" == photon ]] || url=""; url="${url:+${url%/}/status}"; impact="addresses and place search unavailable" ;;
      martin) url="${MARTIN_URL:-}"; url="${url:+${url%/}/health}"; impact="map tiles unavailable: maps are blank" ;;
    esac
    if [[ -z "$url" ]]; then
      line SKIP maps "$name not configured"
      continue
    fi
    host="$(url_host "$url")"
    if [[ "$MAP_PROBE_ALLOW_PUBLIC" != 1 ]] && ! is_local_host "$host"; then
      line WARN maps "$name $(safe_url "$url") not probed: '$host' is not a loopback or private host (misconfiguration? MAP_PROBE_ALLOW_PUBLIC=1 allows it)"
      continue
    fi
    left="$(remaining)"
    if (( left <= 0 )); then
      line WARN maps "$name $(safe_url "$url") not probed: the gate deadline (${HEALTH_TIMEOUT_SEC} s) was reached (does not fail the gate)"
      continue
    fi
    max=$(( left < 3 ? left : 3 ))
    code="$(http_code "$url" "$max")"
    if [[ "$code" =~ ^2 ]]; then
      line PASS maps "$name $(safe_url "$url") HTTP $code"
    else
      line WARN maps "$name $(safe_url "$url") $(describe "$code"): $impact (not deployed by release.sh; does not fail the gate)"
    fi
  done
}

# Journal tail of one unit, best effort. The 'veetrax' user that runs release.sh is not in systemd-journal / adm, so:
#   1. journalctl -q (works as root or for a member of those groups); used only when it exits 0 AND prints real entries;
#   2. sudo -n journalctl -u <unit> -n 50 --no-pager, only when sudoers allows exactly this command (install-ubuntu.sh
#      grants it per unit; no -q there, the arguments must match the sudoers line);
#   3. otherwise a hint with the command to run as root.
# Without permission journalctl prints a multi-line notice instead of entries ("Hint: You are currently not seeing
# messages ...", indented continuation lines, "No journal files were opened due to insufficient permissions.") and
# exits 1; with only the user's own journal readable it exits 0 with no entries. Neither counts as readable.
journal_tail() {
  local unit="$1" out code=0
  local cmd=(journalctl -u "$unit" -n 50 --no-pager)
  out="$(journalctl -q -u "$unit" -n 50 --no-pager 2>&1)" || code=$?
  if (( code == 0 )) && journal_has_entries "$out"; then
    printf '%s\n' "$out"
    return
  fi
  if command -v sudo >/dev/null && sudo -n -l "${cmd[@]}" >/dev/null 2>&1; then
    sudo -n "${cmd[@]}" 2>&1 || true
    return
  fi
  if (( code == 0 )) && [[ "$(id -u 2>/dev/null)" == 0 ]]; then
    echo "      (no journal entries for $unit)"
    return
  fi
  echo "      (journal not readable as $(id -un 2>/dev/null || echo this user); run as root: sudo journalctl -u $unit -n 50 --no-pager)"
}

# True when journalctl output holds at least one log entry: a line that is not one of journalctl's own notices
# ("-- No entries --", "Hint: ...", "No journal files were ...", "Failed to ...") and not indented (the notice's
# continuation lines; an entry's own continuation lines only follow an entry line).
journal_has_entries() {
  grep -vqE '^([[:space:]]|-- |Hint: |No journal files were |Failed to |$)' <<<"$1"
}

echo "== health gate (deadline ${HEALTH_TIMEOUT_SEC} s)"
if [[ "$HEALTH_GATE_SYSTEMD" == 1 ]]; then check_units; else line SKIP systemd "HEALTH_GATE_SYSTEMD=0 (no systemctl)"; fi
poll_http FAIL api "$API_HEALTH_URL" veetrax-api
if [[ "$HEALTH_GATE_GATEWAY" == 1 ]]; then poll_http FAIL gateway "$GATEWAY_HEALTH_URL" veetrax-gateway; else line SKIP gateway "HEALTH_GATE_GATEWAY=0"; fi
case "$HEALTH_GATE_TRACKING" in
  1 | strict) poll_http FAIL tracking "$TRACKING_HEALTH_URL" veetrax-processor veetrax-gateway ;;
  warn) poll_http WARN tracking "$TRACKING_HEALTH_URL" veetrax-processor veetrax-gateway ;;
  *) line SKIP tracking "HEALTH_GATE_TRACKING=0" ;;
esac
if [[ "$HEALTH_GATE_MAPS" == 1 ]]; then check_maps; else line SKIP maps "HEALTH_GATE_MAPS=0"; fi

if (( ${#FAILED[@]} )); then
  if [[ "$HEALTH_GATE_SYSTEMD" == 1 ]] && command -v journalctl >/dev/null; then
    for unit in "${FAILED_UNITS[@]}"; do
      echo "== journalctl -u $unit -n 50"
      journal_tail "$unit"
    done
  fi
  echo "== HEALTH GATE: FAIL (${FAILED[*]}) after ${SECONDS} s"
  exit 1
fi
echo "== HEALTH GATE: PASS after ${SECONDS} s${WARNED[*]:+ (with warnings: ${WARNED[*]})}"
exit 0
