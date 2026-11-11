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
# ETMS E4 route planning (veetrax-routing-worker + veetrax-optimizer): installed only with ETMS_ROUTING=on (the same
# switch as in apps/api/.env). Off (default): no unit, no sudoers line, no token file — the install is unchanged.
ETMS_ROUTING="${ETMS_ROUTING:-off}"
routing_on() { [[ "$(echo "$ETMS_ROUTING" | tr '[:upper:]' '[:lower:]' | xargs)" == on ]]; }

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
# Last value of a setting in the conf file, surrounding quotes removed ('dir "/var/lib/valkey"' → /var/lib/valkey).
vk_conf() {
  sed -n "s/^$1[[:space:]]\{1,\}//p" "$VK" | tail -1 | sed 's/[[:space:]]*$//; s/^"\(.*\)"$/\1/'
}
# valkey-cli with the password: REDISCLI_AUTH from the environment, else requirepass from the conf file (passed in
# the environment, never on the command line, so it does not show in ps).
vk_cli() {
  local pw="${REDISCLI_AUTH:-$(vk_conf requirepass)}"
  if [[ -n "$pw" ]]; then REDISCLI_AUTH="$pw" valkey-cli "$@" 2>/dev/null || true; else valkey-cli "$@" 2>/dev/null || true; fi
}
# State of this Valkey, decided before the file is touched:
#   aof-on   running (authenticated) with appendonly yes, or stopped with 'appendonly yes' in the file and a
#            non-empty AOF directory (or no data on disk at all)
#   aof-missing  stopped with 'appendonly yes' in the file, a non-empty dump file and NO AOF: started like this it
#            would load nothing (Valkey ignores dump.rdb when AOF is on) and boot EMPTY. Treated as has data: the
#            file is not touched and Valkey is NOT started (QA-4)
#   empty    running with 0 keys in ALL databases (INFO keyspace), or stopped with no dump file and no AOF directory
#   data     running with keys in any database, or stopped with a non-empty dump file / AOF directory
#   unknown  running but no PONG with the password (NOAUTH, WRONGPASS, LOADING, ...) or an INFO keyspace answer that
#            cannot be read: treated like data (the safe side)
# Total keys over every dbN line of INFO keyspace (DBSIZE would count db0 only; a shared Valkey may use db1+).
# Prints nothing unless the answer is a well-formed keyspace section ("# Keyspace" + only dbN:keys=<n>,... lines).
vk_total_keys() {
  vk_cli INFO keyspace | tr -d '\r' | awk '
    /^# Keyspace$/ { hdr = 1; next }
    /^$/ { next }
    /^db[0-9]+:keys=[0-9]+(,|$)/ { split($0, a, /[=,]/); n += a[2]; next }
    { bad = 1 }
    END { if (hdr && !bad) print n + 0 }'
}
vk_state() {
  local pong dir dump aofdir has_dump=0 has_aof=0
  pong="$(vk_cli ping)"
  if [[ "$pong" == PONG ]]; then
    if [[ "$(vk_cli CONFIG GET appendonly | sed -n 2p)" == yes ]]; then echo aof-on; return; fi
    case "$(vk_total_keys)" in
      0) echo empty ;;
      '' | *[!0-9]*) echo unknown ;;
      *) echo data ;;
    esac
  elif [[ -n "$pong" ]]; then
    echo unknown
  else
    dir="$(vk_conf dir)"
    dump="$(vk_conf dbfilename)"
    aofdir="$(vk_conf appenddirname)"
    dir="${dir:-/var/lib/valkey}"
    [[ -s "$dir/${dump:-dump.rdb}" ]] && has_dump=1
    [[ -n "$(ls -A "$dir/${aofdir:-appendonlydir}" 2>/dev/null)" ]] && has_aof=1
    if [[ "$(vk_conf appendonly)" == yes ]]; then
      if (( has_aof == 0 && has_dump == 1 )); then echo aof-missing; else echo aof-on; fi
      return
    fi
    if (( has_dump || has_aof )); then
      echo data
    else
      echo empty
    fi
  fi
}
# With appendonly yes in the file and no AOF yet, a restarted Valkey starts EMPTY and ignores dump.rdb. So the file
# is changed only on a fresh (empty) Valkey or where AOF is already on; a server with data and AOF off must be
# switched online first (CONFIG SET appendonly yes, wait for the rewrite), see release-gate spec G4.
# Valkey is restarted only when it is empty. With AOF already on the file settings take effect at the next planned
# restart (so a restart can never hit a running AOF rewrite); data or an unknown state is never restarted here.
VK_STATE="$(vk_state)"
case "$VK_STATE" in
  empty | aof-on)
    vk_set appendonly yes
    vk_set appendfsync everysec
    vk_set auto-aof-rewrite-percentage 100
    vk_set auto-aof-rewrite-min-size 64mb
    vk_set aof-use-rdb-preamble yes
    vk_set aof-load-truncated yes
    vk_set no-appendfsync-on-rewrite no
    ;;
  data)
    echo "WARNING: Valkey already holds data with appendonly off; AOF settings NOT written (a restart would start it empty)."
    echo "         Turn AOF on online first (valkey-cli CONFIG SET appendonly yes, wait for aof_rewrite_in_progress:0), then re-run."
    ;;
  aof-missing)
    echo "WARNING: Valkey is stopped, its config says 'appendonly yes', and its data dir has a dump file but NO AOF."
    echo "         Started like this it would ignore the dump file and boot EMPTY. Config NOT changed, Valkey NOT started."
    echo "         Fix by hand: set 'appendonly no', start Valkey (it loads the dump), then CONFIG SET appendonly yes online"
    echo "         (wait for aof_rewrite_in_progress:0), and re-run this installer."
    ;;
  *)
    echo "WARNING: could not ask Valkey whether it holds data (no PONG / readable INFO keyspace with the configured password; REDISCLI_AUTH?)."
    echo "         Treated as holding data: AOF settings NOT written, Valkey NOT restarted."
    ;;
esac
systemctl enable valkey-server
if [[ "$VK_STATE" == empty ]]; then
  systemctl restart valkey-server
elif [[ "$VK_STATE" == aof-missing ]]; then
  echo "NOTE: Valkey was NOT started (aof-missing, see the warning above)."
else
  # Starts a stopped Valkey with its unchanged data; a running one is left alone.
  systemctl start valkey-server
  if [[ "$VK_STATE" == aof-on ]]; then
    echo "NOTE: Valkey was not restarted (aof-on); the settings above take effect at its next planned restart."
  else
    echo "NOTE: Valkey was not restarted ($VK_STATE); its config file was not changed."
  fi
fi

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
# and (health-gate.sh, on a failed gate) reads the journal tail of exactly these units. Every line is a full command
# with fixed arguments and no wildcard: a sudoers '*' also matches spaces and further arguments, so
# 'systemctl restart veetrax-*' would also allow 'systemctl restart veetrax-api postgresql ssh valkey-server' (Sec-M1)
# and 'journalctl -u veetrax-* -n *' far more than a read of 50 lines (--vacuum-time, --file, other units).
# The restart line with all five units is exactly what release.sh runs (sudo systemctl restart $SERVICES, the default
# SERVICES order); each unit alone is allowed too, for a manual restart of one service.
# Written to a temp file and checked with visudo first, so a mistake can never leave a broken sudoers.d file.
SUDOERS_TMP="$(mktemp)"
trap 'rm -f "$SUDOERS_TMP"' EXIT # also when visudo rejects it and set -e ends the installer
cat > "$SUDOERS_TMP" <<'EOF'
veetrax ALL=(root) NOPASSWD: /usr/bin/systemctl restart veetrax-api veetrax-gateway veetrax-processor veetrax-notifier veetrax-summarizer
veetrax ALL=(root) NOPASSWD: /usr/bin/systemctl restart veetrax-api, /usr/bin/systemctl restart veetrax-gateway, /usr/bin/systemctl restart veetrax-processor, /usr/bin/systemctl restart veetrax-notifier, /usr/bin/systemctl restart veetrax-summarizer
veetrax ALL=(root) NOPASSWD: /usr/bin/systemctl reload caddy
veetrax ALL=(root) NOPASSWD: /usr/bin/journalctl -u veetrax-api -n 50 --no-pager, /usr/bin/journalctl -u veetrax-gateway -n 50 --no-pager, /usr/bin/journalctl -u veetrax-processor -n 50 --no-pager, /usr/bin/journalctl -u veetrax-notifier -n 50 --no-pager, /usr/bin/journalctl -u veetrax-summarizer -n 50 --no-pager
EOF
if routing_on; then
  # release.sh restarts the seven units in exactly this order when ETMS_ROUTING=on.
  cat >> "$SUDOERS_TMP" <<'EOF'
veetrax ALL=(root) NOPASSWD: /usr/bin/systemctl restart veetrax-api veetrax-gateway veetrax-processor veetrax-notifier veetrax-summarizer veetrax-routing-worker veetrax-optimizer
veetrax ALL=(root) NOPASSWD: /usr/bin/systemctl restart veetrax-routing-worker, /usr/bin/systemctl restart veetrax-optimizer
veetrax ALL=(root) NOPASSWD: /usr/bin/journalctl -u veetrax-routing-worker -n 50 --no-pager, /usr/bin/journalctl -u veetrax-optimizer -n 50 --no-pager
EOF
fi
visudo -cf "$SUDOERS_TMP"
install -m 440 -o root -g root "$SUDOERS_TMP" /etc/sudoers.d/veetrax
rm -f "$SUDOERS_TMP"
trap - EXIT

echo "== systemd services"
HERE="$(cd "$(dirname "$0")" && pwd)"
for s in api gateway processor notifier summarizer; do
  install -m 644 "$HERE/veetrax-$s.service" /etc/systemd/system/
done
if routing_on; then
  echo "== ETMS route planning (ETMS_ROUTING=on): veetrax-routing-worker + veetrax-optimizer"
  install -m 644 "$HERE/veetrax-routing-worker.service" "$HERE/veetrax-optimizer.service" /etc/systemd/system/
  install -d -o veetrax -g veetrax /opt/veetrax/venvs
  # Optimiser token (>= 24 chars): generated once, root:veetrax 0640, never printed. veetrax-api and
  # veetrax-routing-worker read it through OPTIMIZER_TOKEN_FILE (set in their units; E4 security review L9), so it is
  # NOT copied into apps/api/.env; the other VeeTrax units have the file made inaccessible. The optimiser gets no other
  # secret. Set OPTIMIZER_URL=http://127.0.0.1:8090 in apps/api/.env.
  # An existing /etc/veetrax (backup.conf lives there) keeps its owner and mode; only a missing one is created.
  [[ -d /etc/veetrax ]] || install -d -m 750 -o root -g veetrax /etc/veetrax
  if [[ ! -s /etc/veetrax/optimizer.env ]]; then
    (umask 027; echo "OPTIMIZER_TOKEN=$(head -c 32 /dev/urandom | base64 | tr -d '=+/')" > /etc/veetrax/optimizer.env)
    chown root:veetrax /etc/veetrax/optimizer.env
    echo "   created /etc/veetrax/optimizer.env (read by the optimiser, the API and the routing worker; add OPTIMIZER_URL=http://127.0.0.1:8090 to apps/api/.env)"
  fi
  # The optimiser needs Python 3.14 (ortools cp314 wheels, doc 17 R-9); release.sh builds the venv with the hashed lock.
  if ! command -v python3.14 >/dev/null; then
    echo "WARNING: python3.14 is not installed: veetrax-optimizer cannot start. Install Python 3.14 (+ venv) first;"
    echo "         this installer does not add a package source for it."
  fi
  systemctl daemon-reload
  systemctl enable veetrax-routing-worker veetrax-optimizer
else
  echo "   ETMS route planning not installed (ETMS_ROUTING is not on)"
fi
systemctl daemon-reload

echo "== firewall"
ufw allow OpenSSH
ufw allow 80,443/tcp
ufw allow "${DEVICE_PORTS}/tcp"
ufw --force enable
ufw status

echo "Done: node $(node -v), $(psql --version), $(valkey-server --version | cut -d' ' -f1-3), $(caddy version | cut -d' ' -f1), java $(java -version 2>&1 | head -1)"
