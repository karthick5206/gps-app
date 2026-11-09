#!/usr/bin/env bash
# VeeTrax full backup (risk R-03, decision Q-03). Runs inside WSL (Ubuntu) next to PostgreSQL and Valkey.
#
#   sudo bash ops/backup/veetrax-backup.sh /path/to/backup.conf
#
# One encrypted bundle per run:  veetrax-<UTC timestamp>.tar.gpg  containing
#   db.dump          pg_dump -Fc of the application database
#   valkey.rdb       Valkey snapshot (BGSAVE; live state, command queues, cursors)       [VALKEY_MODE=rdb]
#   uploads.tar.gz   apps/api/var (documents, selfies, media, invoices, reports), logs excluded
#   config.tar.gz    deployment configuration (.env files, PM2 ecosystem, ...) - holds secrets, hence encryption
#   manifest.json    sha256 of each part + row counts of key tables (checked by the restore script)
#
# Encryption: GPG to a PUBLIC key only (GPG_RECIPIENT_FILE). The private key never lives on this host, so a stolen
# server or bucket cannot decrypt backups. Upload: UPLOAD_CMD (e.g. rclone/aws/restic once a provider is approved);
# without it the bundle stays local. Retention: KEEP_LOCAL_DAYS locally; remote retention by bucket lifecycle rules.
# Needs only tools already on the host: pg_dump, psql, valkey-cli, tar, gzip, gpg, sha256sum.
set -euo pipefail

CONF="${1:?usage: veetrax-backup.sh <backup.conf>}"
# shellcheck disable=SC1090
source "$CONF"
: "${DB_URL:?DB_URL required}" "${OUT_DIR:?OUT_DIR required}" "${GPG_RECIPIENT_FILE:?GPG_RECIPIENT_FILE required}"
VALKEY_MODE="${VALKEY_MODE:-rdb}"            # rdb | skip
VALKEY_CLI="${VALKEY_CLI:-valkey-cli}"
UPLOADS_DIR="${UPLOADS_DIR:-}"
CONFIG_FILES="${CONFIG_FILES:-}"             # space-separated absolute paths
KEEP_LOCAL_DAYS="${KEEP_LOCAL_DAYS:-14}"
UPLOAD_CMD="${UPLOAD_CMD:-}"                 # '{file}' is replaced by the bundle path
COUNT_TABLES="${COUNT_TABLES:-Company User TrackedObject Device Position Trip Alert DriverEvent Invoice LicenceSeat LicenceOrder}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
STATUS="$OUT_DIR/last-status.json"
mkdir -p "$OUT_DIR"
log() { echo "$(date -u +%FT%TZ) $*"; }
fail() { log "FAILED: $*"; printf '{"ok":false,"at":"%s","error":%s}\n' "$STAMP" "$(printf '%s' "$*" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')" > "$STATUS"; exit 1; }

log "backup $STAMP → $OUT_DIR"

# 1. PostgreSQL. One exported snapshot is held open so the dump and the manifest row counts see exactly the same
#    data even while devices keep writing positions (custom format allows selective restore).
coproc PSQL { psql "$DB_URL" -Atq -v ON_ERROR_STOP=1; }
echo "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT pg_export_snapshot();" >&"${PSQL[1]}"
read -r -t 30 SNAP <&"${PSQL[0]}" || fail "could not export a snapshot"
pg_dump --format=custom --no-owner --snapshot="$SNAP" --dbname="$DB_URL" --file="$WORK/db.dump" || fail "pg_dump"
COUNTS="{"
for t in $COUNT_TABLES; do
  echo "SELECT count(*) FROM \"$t\";" >&"${PSQL[1]}"
  read -r -t 600 n <&"${PSQL[0]}" || fail "count $t"
  COUNTS+="\"$t\":${n:-null},"
done
COUNTS="${COUNTS%,}}"
echo "COMMIT;" >&"${PSQL[1]}"; exec {PSQL[1]}>&-; wait "$PSQL_PID" 2>/dev/null || true

# 2. Valkey snapshot.
if [ "$VALKEY_MODE" = "rdb" ]; then
  before=$($VALKEY_CLI LASTSAVE)
  $VALKEY_CLI BGSAVE >/dev/null || fail "valkey BGSAVE"
  for _ in $(seq 1 120); do [ "$($VALKEY_CLI LASTSAVE)" != "$before" ] && break; sleep 1; done
  [ "$($VALKEY_CLI LASTSAVE)" != "$before" ] || fail "valkey BGSAVE did not finish"
  rdb="$($VALKEY_CLI CONFIG GET dir | sed -n 2p)/$($VALKEY_CLI CONFIG GET dbfilename | sed -n 2p)"
  cp "$rdb" "$WORK/valkey.rdb" || fail "copy $rdb"
fi

# 3. Uploaded files (logs excluded).
if [ -n "$UPLOADS_DIR" ]; then
  [ -d "$UPLOADS_DIR" ] || fail "UPLOADS_DIR $UPLOADS_DIR missing"
  tar -czf "$WORK/uploads.tar.gz" -C "$UPLOADS_DIR" --exclude=./logs . || fail "tar uploads"
fi

# 4. Configuration.
if [ -n "$CONFIG_FILES" ]; then
  # shellcheck disable=SC2086
  tar -czf "$WORK/config.tar.gz" --absolute-names $CONFIG_FILES 2>/dev/null || fail "tar config"
fi

# 5. Manifest.
( cd "$WORK" && sha256sum -- * > SHA256SUMS )
printf '{"version":1,"createdAt":"%s","host":"%s","valkey":"%s","rowCounts":%s}\n' "$STAMP" "$(hostname)" "$VALKEY_MODE" "$COUNTS" > "$WORK/manifest.json"

# 6. Bundle + encrypt to the public key; plaintext never leaves $WORK.
BUNDLE="$OUT_DIR/veetrax-$STAMP.tar.gpg"
tar -cf - -C "$WORK" . | gpg --batch --yes --trust-model always --recipient-file "$GPG_RECIPIENT_FILE" --encrypt --output "$BUNDLE" || fail "encrypt"
SIZE=$(stat -c %s "$BUNDLE")
log "encrypted bundle $(basename "$BUNDLE") ($SIZE bytes)"

# 7. Off-site upload (configured once a provider is approved).
UPLOADED=false
if [ -n "$UPLOAD_CMD" ]; then
  eval "${UPLOAD_CMD//\{file\}/\"$BUNDLE\"}" || fail "upload"
  UPLOADED=true
  log "uploaded"
fi

# 8. Local retention.
find "$OUT_DIR" -maxdepth 1 -name 'veetrax-*.tar.gpg' -mtime +"$KEEP_LOCAL_DAYS" -delete
printf '{"ok":true,"at":"%s","bundle":"%s","bytes":%s,"uploaded":%s,"rowCounts":%s}\n' "$STAMP" "$(basename "$BUNDLE")" "$SIZE" "$UPLOADED" "$COUNTS" > "$STATUS"
log "done"
