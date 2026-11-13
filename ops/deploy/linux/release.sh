#!/usr/bin/env bash
# VeeTrax release on Linux: update the code, build, migrate, restart the services, then run the health gate.
#   REF=v1.8.1 bash release.sh   production: pin to a release tag (without REF: fast-forward $BRANCH)
#   bash release.sh --web-only    rebuild the web app only (no restart, no gate)
#   bash release.sh --health-only run only the post-deploy health gate (no checkout, build or restart); the dry run,
#                                 also for the test instance: API_HEALTH_URL=http://127.0.0.1:4100/api/health/ready
#                                 (or API_PORT=4100 in that instance's apps/api/.env, which this script loads)
# Run as the 'veetrax' user from anywhere; it needs sudo only for systemctl restart.
# Used for the production deploys since v1.8.0 (app.veetrax.com). The gate (health-gate.sh) checks the systemd units,
# /api/health/ready, the gateway /health and /api/health/tracking; on failure this script prints the journal tail and
# the rollback command and exits 1. It never rolls back by itself. The gate script is copied before the checkout, so a
# rollback to a tag without health-gate.sh (v1.8.0 and older) is still gated.
# The web app is built into apps/web/dist.next and checked for outside map hosts (G8) before it replaces the live
# apps/web/dist (the previous build is kept in apps/web/dist.prev); a failed build leaves the live web app untouched.
set -euo pipefail

# Everything runs inside main, which bash reads completely before running it, so the checkout below may change this
# file while it runs (a file edited in place would otherwise be read on at the old offsets).
main() {
  APP_DIR="${APP_DIR:-/opt/veetrax/app}"
  BRANCH="${BRANCH:-main}"
  # Set by the caller: used as given (no routing units added).
  if [[ -n "${SERVICES:-}" ]]; then SERVICES_EXPLICIT=1; else SERVICES_EXPLICIT=0; fi
  SERVICES="${SERVICES:-veetrax-api veetrax-gateway veetrax-processor veetrax-notifier veetrax-summarizer}"
  # ETMS E4 route planning (v1.16): once install-ubuntu.sh installed the two units (veetrax-routing-worker,
  # veetrax-optimizer) they are part of every release (venv refresh, restart, systemd check), whether the platform switch
  # "Automatic route planning" is on or off: switched off they run idle. The gate checks routing readiness only while the
  # switch is on (GET /api/health/routing). ETMS_ROUTING=off in apps/api/.env (emergency switch) leaves them out.
  # Remembers the release before the last one, for the rollback hint of --health-only.
  STATE_DIR="${STATE_DIR:-/var/lib/veetrax}"
  local mode="${1:-}"
  cd "$APP_DIR"

  GATE="$APP_DIR/ops/deploy/linux/health-gate.sh"
  if [[ "$mode" == "--health-only" ]]; then
    load_env $GATE_ENV_KEYS
    if routing_installed && [[ "$SERVICES_EXPLICIT" != 1 ]]; then SERVICES="$SERVICES veetrax-routing-worker veetrax-optimizer"; fi
    health_gate "$(cat "$STATE_DIR/release-prev" 2>/dev/null || echo '<previous tag>')"
    return
  fi

  # The release running now (its tag if it has one), for the rollback command.
  local prev prev_commit
  prev="$(git describe --tags --exact-match HEAD 2>/dev/null || git rev-parse --short HEAD)"
  prev_commit="$(git rev-parse HEAD)"
  # Keep this release's gate: the checkout below may go to a tag that has none (a rollback to v1.8.0 or older).
  if [[ -f "$GATE" ]]; then
    GATE_COPY="$(mktemp "${TMPDIR:-/tmp}/veetrax-health-gate.XXXXXX")"
    trap 'rm -f "$GATE_COPY"' EXIT
    cp "$GATE" "$GATE_COPY"
    GATE="$GATE_COPY"
  fi
  if [[ -n "${REF:-}" ]]; then
    # Production: pin to a release tag, e.g. REF=v1.7.1 bash release.sh
    echo "== code ($REF)"
    git fetch --tags origin
    git checkout --detach "$REF"
  else
    echo "== code ($BRANCH)"
    git fetch origin "$BRANCH"
    git merge --ff-only "origin/$BRANCH"
  fi
  git log --oneline -1
  if [[ "$(git rev-parse HEAD)" != "$prev_commit" ]]; then
    echo "$prev" > "$STATE_DIR/release-prev" 2>/dev/null || true
  else
    # Same commit again: keep the earlier rollback target if there is one.
    prev="$(cat "$STATE_DIR/release-prev" 2>/dev/null || echo "$prev")"
  fi

  if [[ "$mode" == "--web-only" ]]; then
    npm run build:shared
    build_web || web_build_failed "$prev" "nothing was restarted" web-only
    echo "Web rebuilt; Caddy serves the new files at once."
    return
  fi

  load_env ETMS ETMS_ROUTING
  if routing_installed && [[ "$SERVICES_EXPLICIT" != 1 ]]; then
    SERVICES="$SERVICES veetrax-routing-worker veetrax-optimizer"
  fi

  echo "== build"
  npm ci --no-audit --no-fund
  npm run build:shared
  build_web || web_build_failed "$prev" "nothing was migrated or restarted" full
  (cd apps/api && npx prisma generate && npm run build)

  if routing_installed; then
    echo "== route optimiser (units installed): venv from the hashed lock"
    optimizer_venv || {
      echo
      echo "OPTIMISER VENV FAILED (see above): nothing was migrated or restarted. Python 3.14 is required (doc 17 R-9)."
      echo "  Fix it (re-run install-ubuntu.sh), or set ETMS_ROUTING=off in apps/api/.env (emergency switch), and run the release again."
      exit 1
    }
  fi

  echo "== database"
  # Every apps/api/.env setting is exported (read literally, see load_env) so migrate and the seed see the same
  # settings as the services (systemd EnvironmentFile), as before; only inside this subshell, so the database
  # secrets do not reach the gate and its curl calls.
  # Idempotent seed: platform, Super Admin, device models, system lookups. With NODE_ENV=production it never creates
  # the demo company; the first run on an empty database needs SUPER_ADMIN_EMAIL + SUPER_ADMIN_PASSWORD.
  (
    load_env
    cd apps/api
    npx prisma migrate deploy
    npm run db:seed
  )

  echo "== restart"
  # Exactly this form ("systemctl restart" + the five units in this order) is what the installer's sudoers allows.
  # shellcheck disable=SC2086 # word splitting on purpose: one argument per unit
  sudo systemctl restart $SERVICES
  load_env $GATE_ENV_KEYS
  health_gate "$prev"
}

# The apps/api/.env settings the health gate reads (ports, map-service URLs) plus the gate's own settings.
GATE_ENV_KEYS="API_PORT GATEWAY_HEALTH_PORT ROUTER_URL ROUTER_ENGINE GEOCODER GEOCODER_URL MARTIN_URL MAP_PROBE_ALLOW_PUBLIC
  ETMS ETMS_ROUTING OPTIMIZER_URL HEALTH_GATE_ROUTING ROUTING_HEALTH_URL
  API_HEALTH_URL GATEWAY_HEALTH_URL TRACKING_HEALTH_URL HEALTH_TIMEOUT_SEC HEALTH_POLL_SEC
  HEALTH_GATE_SYSTEMD HEALTH_GATE_GATEWAY HEALTH_GATE_TRACKING HEALTH_GATE_MAPS"

# v1.16: the emergency kill switch (ETMS_ROUTING=off or ETMS=off in apps/api/.env), as the API reads it.
routing_killed() {
  local r e
  r="$(echo "${ETMS_ROUTING:-}" | tr '[:upper:]' '[:lower:]' | xargs)"
  e="$(echo "${ETMS:-}" | tr '[:upper:]' '[:lower:]' | xargs)"
  [[ "$r" == off || "$e" == off ]]
}

# v1.16: the routing units are installed (install-ubuntu.sh) and not killed: they are released with the others (idle
# while the platform switch is off). Exported for the gate's "installed / not installed, switched off" line.
routing_installed() {
  if [[ -f "${SYSTEMD_UNIT_DIR:-/etc/systemd/system}/veetrax-routing-worker.service" ]] && ! routing_killed; then
    export ROUTING_INSTALLED=1
    return 0
  fi
  export ROUTING_INSTALLED=0
  return 1
}

# Builds / refreshes the optimiser venv (veetrax-optimizer.service) from services/routing-optimizer/requirements.lock:
# hashes required, wheels only, no dependency resolution. Returns non-zero on any failure.
optimizer_venv() {
  local venv="${OPTIMIZER_VENV:-/opt/veetrax/venvs/routing-optimizer}" py="${OPTIMIZER_PYTHON:-python3.14}"
  local lock="$APP_DIR/services/routing-optimizer/requirements.lock"
  [[ -f "$lock" ]] || { echo "no $lock in this release" >&2; return 1; }
  command -v "$py" >/dev/null || { echo "$py not found" >&2; return 1; }
  if [[ ! -x "$venv/bin/python" ]]; then "$py" -m venv "$venv" || return 1; fi
  "$venv/bin/pip" install -q --disable-pip-version-check --require-hashes --no-deps --only-binary=:all: -r "$lock"
}

# load_env [KEY...]: exports settings from apps/api/.env (all of them, or only the named keys) WITHOUT running the
# file as bash (Sec-L5): the file has systemd EnvironmentFile syntax, so `&`, `;`, `$`, backticks or `$(...)` in a
# value (a password, a DATABASE_URL query) are taken literally, as the services see them, never executed or
# expanded. Lines are KEY=VALUE (an optional leading `export ` is ignored); one pair of surrounding "..." or '...' is
# removed; blank lines, comments and anything else are skipped; a later line wins. Keys that would change how this
# script or its child processes run (PATH, IFS, BASH_ENV, LD_*, ...) are never taken from the file.
load_env() {
  local f="$APP_DIR/apps/api/.env" line key val
  [[ -f "$f" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    key="${BASH_REMATCH[2]}"
    val="${BASH_REMATCH[3]}"
    if (( $# )) && [[ " $* " != *" $key "* ]]; then continue; fi
    case "$key" in
      PATH | IFS | HOME | SHELL | ENV | BASH_ENV | SHELLOPTS | BASHOPTS | PS4 | LD_* | BASH_FUNC_* | GATE | GATE_COPY | APP_DIR | SERVICES | STATE_DIR) continue ;;
    esac
    val="${val%"${val##*[![:space:]]}"}" # trailing whitespace
    if [[ "$val" =~ ^\"(.*)\"$ || "$val" =~ ^\'(.*)\'$ ]]; then val="${BASH_REMATCH[1]}"; fi
    export "$key=$val"
  done <"$f"
}

# Builds the web app and makes it live; returns 1 on any failure. apps/web/dist exists afterwards in every case.
#   v1.8.1+ tree: vite build + the G8 external-maps check into apps/web/dist.next (VEETRAX_WEB_OUTDIR), then two renames
#     (dist -> dist.prev, dist.next -> dist). On a failed build the live dist is untouched; if the second rename fails,
#     dist.prev is moved back. Between the two renames dist is missing for the time of one rename() system call
#     (microseconds); a request in exactly that instant gets a 404 and a reload fixes it (accepted, see README).
#   Older tree (a rollback to v1.8.0 or older): its vite ignores VEETRAX_WEB_OUTDIR and rebuilds the live dist in place.
#     The live build is copied to dist.prev first; after the build the external-maps check runs on dist (when the tree
#     has the check script). If the build or the check fails, dist.prev is put back as dist.
# Called as `build_web || ...`, so set -e is off inside: every step checks its own status.
build_web() {
  local web="$APP_DIR/apps/web" legacy=0
  rm -rf "$web/dist.next" || return 1
  if [[ -d "$web/dist" ]] && ! grep -qs VEETRAX_WEB_OUTDIR "$web"/vite.config.*; then
    legacy=1
    echo "   This release builds the web app in place (its vite ignores VEETRAX_WEB_OUTDIR): live build copied to apps/web/dist.prev first."
    { rm -rf "$web/dist.prev" && cp -a "$web/dist" "$web/dist.prev"; } || return 1
  fi
  if ! VEETRAX_WEB_OUTDIR=dist.next npm run build -w @veetracer/web; then
    rm -rf "$web/dist.next"
    if (( legacy )) || [[ ! -d "$web/dist" ]]; then restore_prev_web "$web"; fi
    return 1
  fi
  if [[ ! -d "$web/dist.next" ]]; then
    # The build ignored VEETRAX_WEB_OUTDIR (an older tree) and rebuilt dist in place: no swap; check dist itself.
    if [[ ! -d "$web/dist" ]]; then
      echo "web build produced neither apps/web/dist.next nor apps/web/dist" >&2
      restore_prev_web "$web"
      return 1
    fi
    if [[ -f "$APP_DIR/scripts/check-no-external-maps.mjs" ]]; then
      if ! (cd "$APP_DIR" && env -u VEETRAX_WEB_OUTDIR node scripts/check-no-external-maps.mjs apps/web/dist); then
        restore_prev_web "$web"
        return 1
      fi
    else
      echo "NOTE: this release has no scripts/check-no-external-maps.mjs; its web build was not checked for outside map hosts."
    fi
    return 0
  fi
  # v1.8.1+ tree: swap dist.next in.
  if ! rm -rf "$web/dist.prev"; then rm -rf "$web/dist.next"; return 1; fi
  if [[ -d "$web/dist" ]] && ! mv -T "$web/dist" "$web/dist.prev"; then rm -rf "$web/dist.next"; return 1; fi
  if ! mv -T "$web/dist.next" "$web/dist"; then
    [[ -e "$web/dist" ]] || restore_prev_web "$web"
    rm -rf "$web/dist.next"
    return 1
  fi
}

# Puts apps/web/dist.prev back as the live apps/web/dist (after a failed in-place build, check or swap).
restore_prev_web() {
  local web="$1"
  [[ -d "$web/dist.prev" ]] || return 0
  if rm -rf "$web/dist" && mv -T "$web/dist.prev" "$web/dist"; then
    echo "   apps/web/dist restored from apps/web/dist.prev (the build that was live before)."
  else
    echo "WARNING: could not restore apps/web/dist from apps/web/dist.prev; do it by hand:" >&2
    echo "         rm -rf $web/dist && mv $web/dist.prev $web/dist" >&2
  fi
}

web_build_failed() {
  local prev="$1" what="$2" mode="$3"
  echo
  echo "WEB BUILD FAILED (vite build, the external-maps check or the swap, see above) — the live web app was NOT replaced"
  echo "  (or the previous build was put back); $what."
  if [[ "$mode" == web-only ]]; then
    echo "  The code checkout is now at the new release while the services still run the old one."
  else
    echo "  The code checkout and node_modules are now at the new release while the services still run the old one."
  fi
  echo "  Fix the cause (e.g. VITE_MAP_STYLE_* in apps/web/.env pointing at an outside host) and run the release again,"
  echo "  or return to the running release:"
  echo "       REF=$prev bash $APP_DIR/ops/deploy/linux/release.sh"
  exit 1
}

# Runs the health gate; on failure prints the manual rollback and exits 1 (no automatic rollback).
health_gate() {
  local prev="$1" code=0
  if [[ ! -f "$GATE" ]]; then
    echo "== health gate SKIPPED: no health-gate.sh in this release ($GATE)."
    echo "   Check by hand: systemctl is-active $SERVICES; curl -fsS http://127.0.0.1:${API_PORT:-4000}/api/health/ready"
    echo "Release finished (not gated): $(git log --oneline -1)"
    return 0
  fi
  SERVICES="$SERVICES" bash "$GATE" || code=$?
  if (( code == 0 )); then
    echo "Release is healthy: $(git log --oneline -1)"
    return 0
  fi
  # How to re-run the gate: the checked-out release may have no gate of its own (after a rollback to v1.8.0).
  local recheck="bash $APP_DIR/ops/deploy/linux/release.sh --health-only"
  if [[ ! -f "$APP_DIR/ops/deploy/linux/health-gate.sh" ]]; then
    # A private temp file, and apps/api/.env loaded (API_PORT, map URLs) as release.sh --health-only would.
    recheck="g=\$(mktemp) && git -C $APP_DIR show $prev:ops/deploy/linux/health-gate.sh > \"\$g\" && (set -a; . $APP_DIR/apps/api/.env; set +a; bash \"\$g\"); rm -f \"\$g\""
  fi
  if (( code == 2 )); then
    echo
    echo "HEALTH GATE COULD NOT RUN (bad setting or curl missing, see above): the release was NOT checked."
    echo "  Fix the setting and run: $recheck"
    exit 2
  fi
  echo
  echo "RELEASE FAILED HEALTH GATE — nothing was rolled back automatically."
  echo "  1. Read the FAIL lines and the journal above. A slow start can be re-checked with:"
  echo "       $recheck"
  echo "  2. Roll back to the previous release:"
  echo "       REF=$prev bash $APP_DIR/ops/deploy/linux/release.sh"
  echo "     This does not undo database migrations of the failed release; check its release notes first."
  exit 1
}

main "$@"
exit
