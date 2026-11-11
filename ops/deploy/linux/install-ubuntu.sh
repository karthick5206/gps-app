#!/usr/bin/env bash
# VeeTrax first install on Ubuntu 24.04 (run as root: DB_PASS=... bash install-ubuntu.sh).
# Installs Node.js 24, PostgreSQL 18 + TimescaleDB, Valkey (AOF on, fresh installs only), Caddy, Java 21 (GraphHopper / Photon / Planetiler);
# creates the 'veetrax' user, the database and the systemd services, and enables the firewall.
# First used for the production server (app.veetrax.com) on 2026-11-10. Safe to re-run.
# Afterwards: create apps/api/.env, REF=v1.x.y bash ops/deploy/linux/release.sh, Caddyfile (ops/deploy/linux/Caddyfile).
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

APP_DIR=/opt/veetrax/app
PG=18
DB_PASS="${DB_PASS:?set DB_PASS=<database password> before running}"
# Device ports: 5023 Concox, 5027 Teltonika, 6808 JT808 dashcam, 5030 AIS-140, 7612 JT1078 video, 7613 ADAS attachments.
DEVICE_PORTS="${DEVICE_PORTS:-5023,5027,6808,5030,7612,7613}"
# PostgreSQL memory budget (the rest of the RAM goes to the app, Valkey, GraphHopper and Photon).
PG_MEMORY="${PG_MEMORY:-8GB}"

echo "== packages"
apt-get update
apt-get install -y curl ca-certificates gnupg git ufw lsb-release jq unzip
CODENAME="$(. /etc/os-release && echo "$VERSION_CODENAME")"
install -d /etc/apt/keyrings
# Node.js 24 (NodeSource)
if ! command -v node >/dev/null || [[ "$(node -v)" != v24* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
fi
# PostgreSQL (PGDG)
curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor --yes -o /etc/apt/keyrings/pgdg.gpg
echo "deb [signed-by=/etc/apt/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt ${CODENAME}-pgdg main" > /etc/apt/sources.list.d/pgdg.list
# TimescaleDB
curl -fsSL https://packagecloud.io/timescale/timescaledb/gpgkey | gpg --dearmor --yes -o /etc/apt/keyrings/timescaledb.gpg
echo "deb [signed-by=/etc/apt/keyrings/timescaledb.gpg] https://packagecloud.io/timescale/timescaledb/ubuntu/ ${CODENAME} main" > /etc/apt/sources.list.d/timescaledb.list
# Caddy
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /etc/apt/keyrings/caddy.gpg
echo "deb [signed-by=/etc/apt/keyrings/caddy.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main" > /etc/apt/sources.list.d/caddy-stable.list
# apt reads keys as the unprivileged _apt user
chmod 644 /etc/apt/keyrings/*.gpg /etc/apt/sources.list.d/*.list
apt-get update
apt-get install -y nodejs "postgresql-${PG}" "timescaledb-2-postgresql-${PG}" valkey-server caddy openjdk-21-jre-headless

echo "== postgresql: timescaledb, tuning, no telemetry"
timescaledb-tune --quiet --yes --pg-version "$PG" --memory "$PG_MEMORY" --cpus 4
CONF="/etc/postgresql/${PG}/main/conf.d/90-veetrax.conf"
cat > "$CONF" <<EOF
# VeeTrax: nothing leaves the server
timescaledb.telemetry_level = off
listen_addresses = 'localhost'
EOF
systemctl restart "postgresql@${PG}-main"

echo "== valkey: localhost only, never evict the position stream, AOF persistence"
VK=/etc/valkey/valkey.conf
sed -i 's/^#\? *maxmemory-policy .*/maxmemory-policy noeviction/' "$VK"
grep -q '^maxmemory-policy' "$VK" || echo 'maxmemory-policy noeviction' >> "$VK"
grep -q '^bind 127.0.0.1' "$VK" || sed -i 's/^#\? *bind .*/bind 127.0.0.1 -::1/' "$VK"
# AOF (release-gate spec G4): queued positions, notification jobs and live state survive a Valkey restart; the RDB
# 'save' lines stay. No maxmemory is set here (separate decision). Only uncommented lines are replaced, else appended.
vk_set() {
  if grep -q "^$1 " "$VK"; then sed -i "s/^$1 .*/$1 $2/" "$VK"; else echo "$1 $2" >> "$VK"; fi
}
# Does this Valkey already hold data? (Running: any keys. Stopped: a non-empty dump.rdb in its 'dir'.)
vk_has_data() {
  local ks dir
  if [[ "$(valkey-cli ping 2>/dev/null)" == PONG ]]; then
    ks="$(valkey-cli INFO keyspace 2>/dev/null || true)"
    # Any unexpected answer (e.g. a password is set) counts as "has data": the safe side.
    [[ "$ks" == *"# Keyspace"* ]] || return 0
    grep -q '^db[0-9]' <<<"$ks"
  else
    dir="$(awk '$1 == "dir" { print $2 }' "$VK" | tail -1)"
    [[ -s "${dir:-/var/lib/valkey}/dump.rdb" ]]
  fi
}
# With appendonly yes in the file and no AOF yet, a restarted Valkey starts EMPTY and ignores dump.rdb. So the file
# is changed only on a fresh (empty) Valkey or where AOF is already on; a server with data and AOF off must be
# switched online first (CONFIG SET appendonly yes, wait for the rewrite), see release-gate spec G4.
if [[ "$(valkey-cli CONFIG GET appendonly 2>/dev/null | sed -n 2p)" == yes ]] || ! vk_has_data; then
  vk_set appendonly yes
  vk_set appendfsync everysec
  vk_set auto-aof-rewrite-percentage 100
  vk_set auto-aof-rewrite-min-size 64mb
  vk_set aof-use-rdb-preamble yes
  vk_set aof-load-truncated yes
  vk_set no-appendfsync-on-rewrite no
else
  echo "WARNING: Valkey already holds data with appendonly off; AOF settings NOT written (a restart would start it empty)."
  echo "         Turn AOF on online first (valkey-cli CONFIG SET appendonly yes, wait for aof_rewrite_in_progress:0), then re-run."
fi
systemctl enable valkey-server
systemctl restart valkey-server

echo "== database"
sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'veetracer') THEN CREATE ROLE veetracer LOGIN PASSWORD '${DB_PASS}'; END IF;
END \$\$;
SQL
sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname = 'veetracer'" | grep -q 1 || sudo -u postgres createdb -O veetracer veetracer
# The extension must be created by a superuser; the migration then only converts the table.
sudo -u postgres psql -d veetracer -c 'CREATE EXTENSION IF NOT EXISTS timescaledb;'

echo "== service user and folder"
id veetrax >/dev/null 2>&1 || useradd -r -m -d /opt/veetrax -s /bin/bash veetrax
install -d -o veetrax -g veetrax "$APP_DIR" /opt/veetrax/maps /var/lib/veetrax
# release.sh restarts the services as 'veetrax'
cat > /etc/sudoers.d/veetrax <<'EOF'
veetrax ALL=(root) NOPASSWD: /usr/bin/systemctl restart veetrax-*, /usr/bin/systemctl reload caddy
EOF
chmod 440 /etc/sudoers.d/veetrax

echo "== systemd services"
HERE="$(cd "$(dirname "$0")" && pwd)"
for s in api gateway processor notifier summarizer; do
  install -m 644 "$HERE/veetrax-$s.service" /etc/systemd/system/
done
systemctl daemon-reload

echo "== firewall"
ufw allow OpenSSH
ufw allow 80,443/tcp
ufw allow "${DEVICE_PORTS}/tcp"
ufw --force enable
ufw status

echo "Done: node $(node -v), $(psql --version), $(valkey-server --version | cut -d' ' -f1-3), $(caddy version | cut -d' ' -f1), java $(java -version 2>&1 | head -1)"
