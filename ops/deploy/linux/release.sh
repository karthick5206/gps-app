#!/usr/bin/env bash
# VeeTrax release on Linux: update the code, build, migrate, restart the services.
#   bash release.sh            full release (server + web)
#   bash release.sh --web-only rebuild the web app only (no restart)
# Run as the 'veetrax' user from anywhere; it needs sudo only for systemctl restart.
# NOT yet run on a real server: try it on a staging machine first.
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/veetrax/app}"
BRANCH="${BRANCH:-main}"
SERVICES="veetrax-api veetrax-gateway veetrax-processor veetrax-notifier veetrax-summarizer"
cd "$APP_DIR"

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

if [[ "${1:-}" == "--web-only" ]]; then
  npm run build:shared
  npm run build -w @veetracer/web
  echo "Web rebuilt; Caddy serves the new files at once."
  exit 0
fi

echo "== build"
npm ci --no-audit --no-fund
npm run build:shared
npm run build -w @veetracer/web
(cd apps/api && npx prisma generate && npm run build)

echo "== database"
# Load apps/api/.env so migrate and the seed see the same settings as the services (systemd EnvironmentFile).
set -a; source apps/api/.env; set +a
(cd apps/api && npx prisma migrate deploy)
# Idempotent seed: platform, Super Admin, device models, system lookups. With NODE_ENV=production it never creates
# the demo company; the first run on an empty database needs SUPER_ADMIN_EMAIL + SUPER_ADMIN_PASSWORD.
(cd apps/api && npm run db:seed)

echo "== restart"
sudo systemctl restart $SERVICES
sleep 5
systemctl --no-pager --lines=0 status $SERVICES | grep -E '●|Active:'
