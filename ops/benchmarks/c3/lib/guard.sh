#!/usr/bin/env bash
# C3 benchmark kit: shared safety guard. Every b*/r5 script sources this file FIRST and calls `c3_guard <id> <mode>`.
#   mode onhost  = the script measures on the machine it runs on (solver caps, local CPU): the AVX check, the
#                  "this machine is not production" check and the C3 marker file apply to this machine.
#   mode offbox  = the script only sends traffic (doc 11 §5.4 rule 4: load generators run off-box); the AVX check runs
#                  on the C3 host over ssh (C3_SSH), the local machine only has to be not production.
# Refuses (exit 3) unless:
#   - C3_TARGET is set (the C3 staging host name or IP) and neither it, nor what it resolves to, nor any service URL
#     (C3_GH_URL, C3_API_URL, C3_OPTIMIZER_URL, C3_GATEWAY_HOST) is production (veetrax.com hosts, 103.176.85.69);
#   - C3_CONFIRM_NOT_PRODUCTION=yes;
#   - the measured CPU has no AVX (doc 16 §3.1), unless C3_ALLOW_AVX=1: then every result is labelled
#     "AVX present, not production-comparable";
#   - onhost: /etc/veetrax/c3-staging exists (created by hand on the C3 host, RUNBOOK step 2).
# Dry run (--dry-run or C3_DRY_RUN=1): the same checks (a missing marker or an unreachable ssh is only a warning), then
# the plan is printed and nothing is sent.
set -uo pipefail

C3_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
C3_REPO="$(cd "$C3_DIR/../../.." && pwd)"
C3_PROD_HOST_RE='(^|\.)veetrax\.com\.?$'
C3_PROD_IPS='103.176.85.69'
C3_LABEL=""
C3_DRY=0

c3_die() { echo "C3 GUARD REFUSED: $*" >&2; exit 3; }
c3_warn() { echo "C3 GUARD WARN: $*" >&2; }

c3_host_of() { # URL or host -> lower-case host (no userinfo, no port, no brackets)
  local s="${1,,}"
  s="${s#*://}"; s="${s%%/*}"; s="${s##*@}"
  if [[ "$s" == \[* ]]; then s="${s#[}"; s="${s%%]*}"; else s="${s%%:*}"; fi
  echo "$s"
}

c3_is_prod_host() {
  local h; h="$(c3_host_of "$1")"
  [[ -z "$h" ]] && return 1
  [[ "$h" =~ $C3_PROD_HOST_RE ]] && return 0
  local ip
  for ip in $C3_PROD_IPS; do [[ "$h" == "$ip" ]] && return 0; done
  # what the name resolves to (getent may be absent: then only the literal checks above apply)
  if command -v getent >/dev/null 2>&1; then
    local r
    for r in $(getent ahosts "$h" 2>/dev/null | awk '{print $1}' | sort -u); do
      for ip in $C3_PROD_IPS; do [[ "$r" == "$ip" ]] && return 0; done
    done
  fi
  return 1
}

c3_avx_count_local() { grep -c -w avx /proc/cpuinfo 2>/dev/null || echo 0; }

c3_guard() {
  local id="$1" mode="${2:-onhost}"; shift 2 || true
  [[ "${C3_DRY_RUN:-0}" == 1 ]] && C3_DRY=1
  local a; for a in "${C3_ARGS[@]:-}"; do [[ "$a" == --dry-run ]] && C3_DRY=1; done

  [[ -n "${C3_TARGET:-}" ]] || c3_die "C3_TARGET is not set (the C3 staging host). Nothing runs without an explicit target."
  [[ "${C3_CONFIRM_NOT_PRODUCTION:-}" == yes ]] || c3_die "set C3_CONFIRM_NOT_PRODUCTION=yes to confirm $C3_TARGET is the C3 staging host, not production."
  local v
  for v in C3_TARGET C3_GH_URL C3_API_URL C3_OPTIMIZER_URL C3_GATEWAY_HOST C3_SSH; do
    [[ -n "${!v:-}" ]] || continue
    if c3_is_prod_host "${!v}"; then c3_die "$v points at production ($(c3_host_of "${!v}")). Benchmarks never run on production (doc 11 §5.4 rule 1)."; fi
  done
  # The machine running the script must not be production either.
  local me; me="$(hostname -f 2>/dev/null || hostname)"
  if c3_is_prod_host "$me"; then c3_die "this machine ($me) is production."; fi
  if command -v hostname >/dev/null && hostname -I >/dev/null 2>&1; then
    for v in $(hostname -I); do [[ " $C3_PROD_IPS " == *" $v "* ]] && c3_die "this machine has production address $v."; done
  fi

  local avx
  if [[ "$mode" == onhost ]]; then
    avx="$(c3_avx_count_local)"
    if [[ ! -e /etc/veetrax/c3-staging ]]; then
      if [[ $C3_DRY == 1 ]]; then c3_warn "/etc/veetrax/c3-staging is missing (a real run would be refused; RUNBOOK step 2)."
      else c3_die "/etc/veetrax/c3-staging is missing: this does not look like the C3 host (RUNBOOK step 2)."; fi
    fi
  else
    if [[ -n "${C3_SSH:-}" && $C3_DRY != 1 ]]; then
      avx="$(ssh -o BatchMode=yes -o ConnectTimeout=10 "$C3_SSH" 'grep -c -w avx /proc/cpuinfo || true' 2>/dev/null)" || avx=""
      [[ "$avx" =~ ^[0-9]+$ ]] || c3_die "could not read the C3 host's /proc/cpuinfo over ssh ($C3_SSH)."
      ssh -o BatchMode=yes -o ConnectTimeout=10 "$C3_SSH" 'test -e /etc/veetrax/c3-staging' || c3_die "$C3_SSH has no /etc/veetrax/c3-staging marker."
    elif [[ $C3_DRY == 1 ]]; then
      c3_warn "dry run: the C3 host AVX check over ssh (C3_SSH) is skipped; checking this machine instead."
      avx="$(c3_avx_count_local)"
    else
      c3_die "offbox mode needs C3_SSH (ssh alias of the C3 host) for the AVX check and the marker check."
    fi
  fi
  if [[ "${avx:-0}" -gt 0 ]]; then
    [[ "${C3_ALLOW_AVX:-0}" == 1 ]] || c3_die "the measured CPU has AVX ($avx flags). Production has none (doc 16 §3.1). Set C3_ALLOW_AVX=1 to run anyway; results are then labelled 'AVX present, not production-comparable'."
    C3_LABEL="AVX present, not production-comparable"
  else
    C3_LABEL="no AVX (production-class CPU)"
  fi

  C3_STAMP="${C3_STAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
  C3_RESULTS="${C3_RESULTS_DIR:-$C3_DIR/results}/$C3_STAMP/$id"
  export C3_LABEL C3_STAMP C3_RESULTS C3_DRY C3_REPO C3_DIR
  export C3_GUARD_PASSED="$id:$C3_STAMP"   # helpers refuse to run without it (see lib/guard.ts, lib/c3guard.py)
  if [[ $C3_DRY == 1 ]]; then
    echo "== $id DRY RUN (nothing is sent) | target $C3_TARGET | $C3_LABEL | results would go to $C3_RESULTS"
  else
    mkdir -p "$C3_RESULTS"
    { echo "{\"id\":\"$id\",\"target\":\"$C3_TARGET\",\"label\":\"$C3_LABEL\",\"avxFlags\":${avx:-0},\"startedUtc\":\"$C3_STAMP\","
      echo " \"kernel\":\"$(uname -r)\",\"nproc\":$(nproc),\"memTotalKb\":$(awk '/MemTotal/{print $2}' /proc/meminfo),\"gitSha\":\"$(git -C "$C3_REPO" rev-parse --short HEAD 2>/dev/null || echo unknown)\"}"
    } > "$C3_RESULTS/meta.json"
    echo "== $id | target $C3_TARGET | $C3_LABEL | results in $C3_RESULTS"
  fi
}

# Runs a command, or prints it in a dry run.
c3_run() { if [[ $C3_DRY == 1 ]]; then printf '   would run:'; printf ' %q' "$@"; echo; else "$@"; fi; }

# Checks that each named variable is set; in a dry run only reports.
c3_need() {
  local v miss=0
  for v in "$@"; do if [[ -z "${!v:-}" ]]; then echo "   MISSING: $v" >&2; miss=1; fi; done
  if [[ $miss == 1 ]]; then
    if [[ $C3_DRY == 1 ]]; then c3_warn "a real run would stop here: required settings are missing (see config.example.env)."
    else echo "C3: required settings missing (see config.example.env)" >&2; exit 2; fi
  fi
}

# Writes the verdict file and prints one line. $1 = PASS|FAIL|MEASURED|TBD, $2 = text
c3_verdict() {
  [[ $C3_DRY == 1 ]] && return 0
  echo "$1 $2" | tee -a "$C3_RESULTS/verdict.txt"
}

# The tsx runner of apps/api (helpers import the API's matrix code instead of copying it).
c3_tsx() { (cd "$C3_REPO/apps/api" && npx --no-install tsx "$@"); }
C3_PY="${C3_PYTHON:-${OPTIMIZER_VENV:-/opt/veetrax/venvs/routing-optimizer}/bin/python}"
c3_python_or_die() {
  [[ -x "$C3_PY" ]] && return 0
  if [[ $C3_DRY == 1 ]]; then c3_warn "python $C3_PY not found (set C3_PYTHON); the dry run uses python3"; C3_PY=python3
  else echo "C3: $C3_PY not found (set C3_PYTHON to the optimiser venv's python)" >&2; exit 2; fi
}
