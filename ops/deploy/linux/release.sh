#!/usr/bin/env bash
# VeeTrax release on Linux: update the code, build, migrate, restart the services, then run the health gate.
#   REF=v1.8.1 bash release.sh   production: pin to a release tag (without REF: fast-forward $BRANCH)
#   bash release.sh --web-only    rebuild the web app only (no restart, no gate)
#   bash release.sh --health-only run only the post-deploy health gate (no checkout, build or restart); the dry run,
#                                 also for the test instance: API_HEALTH_URL=http://127.0.0.1:4100/api/health/ready
# Run as the 'veetrax' user from anywhere; it needs sudo only for systemctl restart.
# Used for the production deploys since v1.8.0 (app.veetrax.com). The gate (health-gate.sh) checks the systemd units,
# /api/health/ready, the gateway /health and /api/health/tracking; on failure this script prints the journal tail and
# the rollback command and exits 1. It never rolls back by itself.
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

  if [[ "$mode" == "--health-only" ]]; then
    load_env
    health_gate "$(cat "$STATE_DIR/release-prev" 2>/dev/null || echo '<previous tag>')"
    return
  fi

  # The release running now (its tag if it has one), for the rollback command.
  local prev prev_commit
  prev="$(git describe --tags --exact-match HEAD 2>/dev/null || git rev-parse --short HEAD)"
  prev_commit="$(git rev-parse HEAD)"
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
    npm run build -w @veetracer/web
    echo "Web rebuilt; Caddy serves the new files at once."
    return
  fi

  echo "== build"
  npm ci --no-audit --no-fund
  npm run build:shared
  npm run build -w @veetracer/web
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

# Runs health-gate.sh; on failure prints the manual rollback and exits 1 (no automatic rollback).
health_gate() {
  local prev="$1"
  if SERVICES="$SERVICES" bash "$APP_DIR/ops/deploy/linux/health-gate.sh"; then
    echo "Release is healthy: $(git log --oneline -1)"
    return 0
  fi
  echo
  echo "RELEASE FAILED HEALTH GATE — nothing was rolled back automatically."
  echo "  1. Read the FAIL lines and the journal above. A slow start can be re-checked with:"
  echo "       bash $APP_DIR/ops/deploy/linux/release.sh --health-only"
  echo "  2. Roll back to the previous release:"
  echo "       REF=$prev bash $APP_DIR/ops/deploy/linux/release.sh"
  echo "     This does not undo database migrations of the failed release; check its release notes first."
  exit 1
}

main "$@"
exit
