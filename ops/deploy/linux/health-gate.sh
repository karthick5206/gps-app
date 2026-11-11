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
#   API_HEALTH_URL        default http://127.0.0.1:4000/api/health/ready  (503 while PostgreSQL / Valkey are down)
#   GATEWAY_HEALTH_URL    default http://127.0.0.1:4121/health
#   TRACKING_HEALTH_URL   default http://127.0.0.1:4000/api/health/tracking (200 = OK or WARN, 503 = CRITICAL)
#   HEALTH_TIMEOUT_SEC    whole gate deadline, default 90; HEALTH_POLL_SEC retry interval, default 3
#   HEALTH_GATE_SYSTEMD   auto (default: only where systemctl exists) | 1 | 0
#   HEALTH_GATE_GATEWAY / HEALTH_GATE_TRACKING / HEALTH_GATE_MAPS  1 (default) | 0 to skip that part
#                         (HEALTH_GATE_TRACKING=0 for a first install with no devices yet)
#   ROUTER_URL + ROUTER_ENGINE=graphhopper, GEOCODER=photon + GEOCODER_URL, MARTIN_URL: map services, probed once
#                         and reported as WARN only (release.sh does not deploy them, so they never fail the gate).
set -uo pipefail

SERVICES="${SERVICES:-veetrax-api veetrax-gateway veetrax-processor veetrax-notifier veetrax-summarizer}"
API_HEALTH_URL="${API_HEALTH_URL:-http://127.0.0.1:4000/api/health/ready}"
GATEWAY_HEALTH_URL="${GATEWAY_HEALTH_URL:-http://127.0.0.1:4121/health}"
TRACKING_HEALTH_URL="${TRACKING_HEALTH_URL:-http://127.0.0.1:4000/api/health/tracking}"
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
if ! command -v curl >/dev/null; then
  echo "health-gate: curl is required" >&2
  exit 2
fi
if [[ "$HEALTH_GATE_SYSTEMD" == auto ]]; then
  if command -v systemctl >/dev/null; then HEALTH_GATE_SYSTEMD=1; else HEALTH_GATE_SYSTEMD=0; fi
fi

FAILED=()        # names of failed checks
FAILED_UNITS=()  # units whose journal is printed on failure
BODY="$(mktemp)"
trap 'rm -f "$BODY"' EXIT
SECONDS=0

remaining() { echo $(( HEALTH_TIMEOUT_SEC - SECONDS )); }
line() { printf '%-5s %-9s %s\n' "$1" "$2" "$3"; }
add_unit() { local u; for u in "$@"; do [[ " ${FAILED_UNITS[*]-} " == *" $u "* ]] || FAILED_UNITS+=("$u"); done; }

# One GET; prints the HTTP code (000 = no answer) and leaves the body in $BODY.
http_code() {
  local url="$1" max="$2" code
  code="$(curl -s -o "$BODY" -w '%{http_code}' --connect-timeout "$max" --max-time "$max" "$url" 2>/dev/null)" || true
  echo "${code:-000}"
}

describe() {
  case "$1" in
    000) echo "no answer (not listening or timed out)" ;;
    *) echo "HTTP $1" ;;
  esac
}

# poll_http <name> <url> <units...>: retry until HTTP 200 or the gate deadline.
poll_http() {
  local name="$1" url="$2" code left max
  shift 2
  while :; do
    left="$(remaining)"
    max=$(( left < 5 ? (left < 1 ? 1 : left) : 5 ))
    code="$(http_code "$url" "$max")"
    if [[ "$code" == 200 ]]; then
      line PASS "$name" "$url HTTP 200 after ${SECONDS} s"
      return 0
    fi
    left="$(remaining)"
    if (( left <= 0 )); then
      line FAIL "$name" "$url last answer: $(describe "$code") after ${SECONDS} s"
      if [[ "$code" != 000 && -s "$BODY" ]]; then
        printf '      body: %s\n' "$(head -c 400 "$BODY" | tr -d '\r' | tr '\n' ' ')"
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

# Map services: one probe each, WARN only.
check_maps() {
  local name url impact code
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
    code="$(http_code "$url" 3)"
    if [[ "$code" =~ ^2 ]]; then
      line PASS maps "$name $url HTTP $code"
    else
      line WARN maps "$name $url $(describe "$code"): $impact (not deployed by release.sh; does not fail the gate)"
    fi
  done
}

echo "== health gate (deadline ${HEALTH_TIMEOUT_SEC} s)"
if [[ "$HEALTH_GATE_SYSTEMD" == 1 ]]; then check_units; else line SKIP systemd "HEALTH_GATE_SYSTEMD=0 (no systemctl)"; fi
poll_http api "$API_HEALTH_URL" veetrax-api
if [[ "$HEALTH_GATE_GATEWAY" == 1 ]]; then poll_http gateway "$GATEWAY_HEALTH_URL" veetrax-gateway; else line SKIP gateway "HEALTH_GATE_GATEWAY=0"; fi
if [[ "$HEALTH_GATE_TRACKING" == 1 ]]; then poll_http tracking "$TRACKING_HEALTH_URL" veetrax-processor veetrax-gateway; else line SKIP tracking "HEALTH_GATE_TRACKING=0"; fi
if [[ "$HEALTH_GATE_MAPS" == 1 ]]; then check_maps; else line SKIP maps "HEALTH_GATE_MAPS=0"; fi

if (( ${#FAILED[@]} )); then
  if [[ "$HEALTH_GATE_SYSTEMD" == 1 ]] && command -v journalctl >/dev/null; then
    for unit in "${FAILED_UNITS[@]}"; do
      echo "== journalctl -u $unit -n 50"
      journalctl -u "$unit" -n 50 --no-pager 2>&1 || true
    done
  fi
  echo "== HEALTH GATE: FAIL (${FAILED[*]}) after ${SECONDS} s"
  exit 1
fi
echo "== HEALTH GATE: PASS after ${SECONDS} s"
exit 0
