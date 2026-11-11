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
  SERVICES="${SERVICES:-veetrax-api veetrax-gateway veetrax-processor veetrax-notifier veetrax-summarizer}"
  # Remembers the release before the last one, for the rollback hint of --health-only.
  STATE_DIR="${STATE_DIR:-/var/lib/veetrax}"
  local mode="${1:-}"
  cd "$APP_DIR"

  GATE="$APP_DIR/ops/deploy/linux/health-gate.sh"
  if [[ "$mode" == "--health-only" ]]; then
    load_env
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
    build_web || web_build_failed "$prev" "nothing was restarted"
    echo "Web rebuilt; Caddy serves the new files at once."
    return
  fi

  echo "== build"
  npm ci --no-audit --no-fund
  npm run build:shared
  build_web || web_build_failed "$prev" "nothing was migrated or restarted"
  (cd apps/api && npx prisma generate && npm run build)

  echo "== database"
  # Load apps/api/.env so migrate and the seed see the same settings as the services (systemd EnvironmentFile).
  load_env
  (cd apps/api && npx prisma migrate deploy)
  # Idempotent seed: platform, Super Admin, device models, system lookups. With NODE_ENV=production it never creates
  # the demo company; the first run on an empty database needs SUPER_ADMIN_EMAIL + SUPER_ADMIN_PASSWORD.
  (cd apps/api && npm run db:seed)

  echo "== restart"
  # shellcheck disable=SC2086 # word splitting on purpose: one argument per unit
  sudo systemctl restart $SERVICES
  health_gate "$prev"
}

# apps/api/.env: database settings for migrate and the seed, map-service URLs for the gate's WARN lines.
load_env() {
  if [[ -f apps/api/.env ]]; then
    set -a
    # shellcheck disable=SC1091
    source apps/api/.env
    set +a
  fi
}

# Builds the web app into apps/web/dist.next (vite build + the G8 external-maps check, VEETRAX_WEB_OUTDIR), then swaps
# it in for the live apps/web/dist; the previous build stays in apps/web/dist.prev. On any failure the live dist is
# untouched. Called as `build_web || ...`, so set -e is off inside: every step checks its own status.
build_web() {
  local web="$APP_DIR/apps/web"
  rm -rf "$web/dist.next" || return 1
  if ! VEETRAX_WEB_OUTDIR=dist.next npm run build -w @veetracer/web; then
    rm -rf "$web/dist.next"
    return 1
  fi
  rm -rf "$web/dist.prev" || return 1
  if [[ -d "$web/dist" ]]; then mv "$web/dist" "$web/dist.prev" || return 1; fi
  mv "$web/dist.next" "$web/dist" || return 1
}

web_build_failed() {
  local prev="$1" what="$2"
  echo
  echo "WEB BUILD FAILED (vite build or the external-maps check above) — the live web app was NOT replaced; $what."
  echo "  The code checkout and node_modules are now at the new release while the services still run the old one."
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
    recheck="git -C $APP_DIR show $prev:ops/deploy/linux/health-gate.sh > /tmp/health-gate.sh && bash /tmp/health-gate.sh"
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
