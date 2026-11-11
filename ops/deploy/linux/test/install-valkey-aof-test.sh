#!/usr/bin/env bash
# Tests the Valkey AOF block of install-ubuntu.sh (release-gate spec G4) on a temporary copy of a valkey.conf with a
# fake valkey-cli. Runs nothing as root and touches no real Valkey:
#   bash ops/deploy/linux/test/install-valkey-aof-test.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
INSTALL="$HERE/../install-ubuntu.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FAILURES=0

# The block under test: from the AOF comment up to (not including) 'systemctl enable valkey-server'.
sed -n '/^# AOF (release-gate spec G4)/,/^systemctl enable valkey-server/p' "$INSTALL" | sed '$d' >"$WORK/block.sh"
grep -q 'vk_set appendonly yes' "$WORK/block.sh" || { echo "AOF block not found in install-ubuntu.sh"; exit 2; }

mkdir -p "$WORK/bin" "$WORK/data"
cat >"$WORK/bin/valkey-cli" <<'EOF'
#!/usr/bin/env bash
case "$*" in
  ping) echo "${FAKE_PING-PONG}" ;;
  "CONFIG GET appendonly") printf 'appendonly\n%s\n' "${FAKE_AOF:-no}" ;;
  "INFO keyspace") printf '%b' "${FAKE_KEYSPACE:-# Keyspace\r\n}" ;;
esac
EOF
chmod +x "$WORK/bin/valkey-cli"

stock_conf() {
  cat >"$WORK/valkey.conf" <<EOF
bind 127.0.0.1 -::1
save 3600 1 300 100 60 10000
dir $WORK/data
appendonly no
# appendfsync always
appendfsync always
# appendfsync no
no-appendfsync-on-rewrite yes
auto-aof-rewrite-percentage 100
EOF
}

run_block() { (export PATH="$WORK/bin:$PATH"; VK="$WORK/valkey.conf"; set -euo pipefail; source "$WORK/block.sh") 2>&1; }

expect() { # expect <case> <description> <command...>
  local name="$1" what="$2"
  shift 2
  if "$@"; then echo "  ok   $name: $what"; else echo "  FAIL $name: $what"; FAILURES=$((FAILURES + 1)); fi
}
applied() {
  grep -qx 'appendonly yes' "$WORK/valkey.conf" && grep -qx 'appendfsync everysec' "$WORK/valkey.conf" &&
    grep -qx 'auto-aof-rewrite-min-size 64mb' "$WORK/valkey.conf" && grep -qx 'aof-use-rdb-preamble yes' "$WORK/valkey.conf" &&
    grep -qx 'aof-load-truncated yes' "$WORK/valkey.conf" && grep -qx 'no-appendfsync-on-rewrite no' "$WORK/valkey.conf" &&
    grep -qx 'auto-aof-rewrite-percentage 100' "$WORK/valkey.conf"
}
unchanged() { grep -qx 'appendonly no' "$WORK/valkey.conf" && ! grep -q 'aof-use-rdb-preamble' "$WORK/valkey.conf"; }
once() { [[ "$(grep -c "^$1 " "$WORK/valkey.conf")" == 1 ]]; }

echo "### fresh install (Valkey running, no keys)"
stock_conf
out="$(FAKE_KEYSPACE='# Keyspace\r\n' run_block)"
expect fresh "AOF settings written" applied
expect fresh "RDB save line kept" grep -qx 'save 3600 1 300 100 60 10000' "$WORK/valkey.conf"
expect fresh "commented lines left alone" grep -qx '# appendfsync no' "$WORK/valkey.conf"
expect fresh "no warning" test -z "$out"
FAKE_KEYSPACE='# Keyspace\r\n' run_block >/dev/null
expect fresh "idempotent: each key once after a re-run" bash -c "$(declare -f once); WORK='$WORK'; once appendonly && once appendfsync && once aof-use-rdb-preamble && once no-appendfsync-on-rewrite"
expect fresh "no maxmemory line added" bash -c "! grep -q '^maxmemory ' '$WORK/valkey.conf'"
cat "$WORK/valkey.conf" | sed 's/^/      /'

echo "### existing server: keys present, appendonly off"
stock_conf
out="$(FAKE_KEYSPACE='# Keyspace\r\ndb1:keys=42,expires=0\r\n' run_block)"
expect data-aof-off "file unchanged" unchanged
expect data-aof-off "warning printed" grep -q 'AOF settings NOT written' <<<"$out"
echo "$out" | sed 's/^/      /'

echo "### existing server: keys present, AOF already on (CONFIG SET done online)"
stock_conf
FAKE_AOF=yes FAKE_KEYSPACE='# Keyspace\r\ndb0:keys=42\r\n' run_block >/dev/null
expect data-aof-on "AOF settings persisted to the file" applied

echo "### Valkey stopped, non-empty dump.rdb"
stock_conf
echo "REDIS0011 data" >"$WORK/data/dump.rdb"
out="$(FAKE_PING='' run_block)"
expect stopped-dump "file unchanged" unchanged
expect stopped-dump "warning printed" grep -q 'AOF settings NOT written' <<<"$out"

echo "### Valkey stopped, no dump.rdb"
stock_conf
rm -f "$WORK/data/dump.rdb"
FAKE_PING='' run_block >/dev/null
expect stopped-empty "AOF settings written" applied

echo "### unexpected INFO answer (e.g. password set)"
stock_conf
out="$(FAKE_KEYSPACE='(error) NOAUTH Authentication required.\n' run_block)"
expect noauth "file unchanged (treated as has data)" unchanged

echo
if (( FAILURES )); then echo "install-valkey-aof-test: $FAILURES check(s) FAILED"; exit 1; fi
echo "install-valkey-aof-test: all checks passed"
