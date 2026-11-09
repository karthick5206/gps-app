#!/usr/bin/env bash
# VeeTrax first install on Ubuntu 22.04 / 24.04 (run as root: sudo bash install-ubuntu.sh).
# Installs Node.js 24, PostgreSQL 16, Redis, Caddy; creates the 'veetrax' user, the database and the systemd services.
# NOT yet run on a real server: try it on a staging machine first. Afterwards follow DEVELOPER_GUIDE.md section 9.2
# (create apps/api/.env, build, migrate, seed) and then: systemctl enable --now veetrax-api veetrax-gateway ...
set -euo pipefail

APP_DIR=/opt/veetrax/app
DB_PASS="${DB_PASS:?set DB_PASS=<database password> before running}"

echo "== packages"
apt-get update
apt-get install -y curl ca-certificates gnupg git ufw
# Node.js 24 (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt-get install -y nodejs
# PostgreSQL 16 (PGDG)
install -d /usr/share/postgresql-common/pgdg
curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt $(. /etc/os-release && echo "$VERSION_CODENAME")-pgdg main" > /etc/apt/sources.list.d/pgdg.list
# Caddy
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y postgresql-16 redis-server caddy

echo "== redis: never evict the position stream"
sed -i 's/^#\? *maxmemory-policy .*/maxmemory-policy noeviction/' /etc/redis/redis.conf
grep -q '^maxmemory-policy' /etc/redis/redis.conf || echo 'maxmemory-policy noeviction' >> /etc/redis/redis.conf
systemctl restart redis-server

echo "== database"
sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'veetracer') THEN CREATE ROLE veetracer LOGIN PASSWORD '${DB_PASS}'; END IF;
END \$\$;
SQL
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname = 'veetracer'" | grep -q 1 || sudo -u postgres createdb -O veetracer veetracer

echo "== service user and folder"
id veetrax >/dev/null 2>&1 || useradd -r -m -d /opt/veetrax -s /bin/bash veetrax
install -d -o veetrax -g veetrax "$APP_DIR"

echo "== systemd services"
HERE="$(cd "$(dirname "$0")" && pwd)"
for s in api gateway processor notifier summarizer; do
  install -m 644 "$HERE/veetrax-$s.service" /etc/systemd/system/
done
systemctl daemon-reload

echo "== firewall"
ufw allow OpenSSH
ufw allow 80,443/tcp
ufw allow 5023,5027,6808,5030,7612/tcp
ufw --force enable

cat <<EOF

Done. Next (as user veetrax, in $APP_DIR):
  1. git clone <repository> $APP_DIR   (or clone from a git bundle)
  2. cp apps/api/.env.example apps/api/.env  and fill it in (DATABASE_URL=postgresql://veetracer:<password>@127.0.0.1:5432/veetracer)
  3. bash ops/deploy/linux/release.sh      (build + migrate + seed + start)
  4. Put Caddyfile in /etc/caddy/Caddyfile (see ops/deploy/docker/Caddyfile for the site block) and: systemctl reload caddy
EOF
