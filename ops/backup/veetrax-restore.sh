#!/usr/bin/env bash
# VeeTrax restore (risk R-03). Decrypts a bundle made by veetrax-backup.sh, verifies checksums, restores into a
# TARGET database / directories, and compares row counts with the manifest. Never targets a live database by default.
#
#   bash ops/backup/veetrax-restore.sh <bundle.tar.gpg> <private-key.asc> <restore.conf>
#
# restore.conf: TARGET_DB_URL (must be an EMPTY database; created if missing via TARGET_ADMIN_URL),
#               TARGET_UPLOADS_DIR, TARGET_CONFIG_DIR, TARGET_RDB (path to write valkey.rdb; optional)
# The private key is imported into a throw-away GPG home that is deleted on exit.
set -euo pipefail

BUNDLE="${1:?bundle}"; KEY="${2:?private key file}"; CONF="${3:?restore.conf}"
# shellcheck disable=SC1090
source "$CONF"
: "${TARGET_DB_URL:?TARGET_DB_URL required}"
WORK="$(mktemp -d)"; GNUPGHOME="$(mktemp -d)"; export GNUPGHOME
trap 'rm -rf "$WORK" "$GNUPGHOME"' EXIT
log() { echo "$(date -u +%FT%TZ) $*"; }

gpg --batch --quiet --import "$KEY"
gpg --batch --quiet --decrypt "$BUNDLE" | tar -xf - -C "$WORK"
( cd "$WORK" && sha256sum --quiet -c SHA256SUMS ) && log "checksums OK"

# Database: refuse a non-empty target.
if [ -n "${TARGET_ADMIN_URL:-}" ]; then
  db="${TARGET_DB_URL##*/}"; db="${db%%\?*}"
  psql "$TARGET_ADMIN_URL" -Atc "SELECT 1 FROM pg_database WHERE datname='$db'" | grep -q 1 || psql "$TARGET_ADMIN_URL" -qc "CREATE DATABASE \"$db\""
fi
existing=$(psql "$TARGET_DB_URL" -Atc "SELECT count(*) FROM pg_tables WHERE schemaname='public'")
[ "$existing" = "0" ] || { log "REFUSED: target database is not empty ($existing tables)"; exit 2; }
pg_restore --no-owner --exit-on-error --dbname="$TARGET_DB_URL" "$WORK/db.dump"
log "database restored"

if [ -f "$WORK/uploads.tar.gz" ] && [ -n "${TARGET_UPLOADS_DIR:-}" ]; then
  mkdir -p "$TARGET_UPLOADS_DIR" && tar -xzf "$WORK/uploads.tar.gz" -C "$TARGET_UPLOADS_DIR" && log "uploads restored to $TARGET_UPLOADS_DIR"
fi
if [ -f "$WORK/config.tar.gz" ] && [ -n "${TARGET_CONFIG_DIR:-}" ]; then
  mkdir -p "$TARGET_CONFIG_DIR" && tar -xzf "$WORK/config.tar.gz" -C "$TARGET_CONFIG_DIR" && log "config restored under $TARGET_CONFIG_DIR"
fi
if [ -f "$WORK/valkey.rdb" ] && [ -n "${TARGET_RDB:-}" ]; then
  cp "$WORK/valkey.rdb" "$TARGET_RDB" && log "valkey snapshot written to $TARGET_RDB (load by starting valkey with this file)"
fi

# Verification: row counts must equal the manifest.
python3 - "$WORK/manifest.json" "$TARGET_DB_URL" <<'PY'
import json, subprocess, sys
m = json.load(open(sys.argv[1])); url = sys.argv[2]; bad = 0
for t, want in m["rowCounts"].items():
    if want is None: continue
    got = int(subprocess.check_output(["psql", url, "-Atc", f'SELECT count(*) FROM "{t}"']).decode().strip())
    print(f"  {t:<15} manifest={want:<8} restored={got:<8} {'OK' if got == want else 'MISMATCH'}"); bad += got != want
print("VERIFY:", "PASS" if not bad else f"FAIL ({bad} mismatches)"); sys.exit(1 if bad else 0)
PY
