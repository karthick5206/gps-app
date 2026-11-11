#!/usr/bin/env bash
# Tests the Valkey AOF block of install-ubuntu.sh (release-gate spec G4) on a temporary copy of a valkey.conf with a
# fake valkey-cli and a fake systemctl. Runs nothing as root and touches no real Valkey or service:
#   bash ops/deploy/linux/test/install-valkey-aof-test.sh
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
INSTALL="$HERE/../install-ubuntu.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
FAILURES=0

# The block under test: from the AOF comment up to (not including) the next section, so the restart decision is
# tested too.
sed -n '/^# AOF (release-gate spec G4)/,/^echo "== database"/p' "$INSTALL" | sed '$d' >"$WORK/block.sh"
if ! grep -q 'vk_set appendonly yes' "$WORK/block.sh" || ! grep -q 'systemctl restart valkey-server' "$WORK/block.sh"; then
  echo "AOF block not found in install-ubuntu.sh"
  exit 2
fi

mkdir -p "$WORK/bin" "$WORK/data"
# Fake valkey-cli. FAKE_DOWN=1: not running (no answer, exit 1). FAKE_PASS: the server's password; without the right
# REDISCLI_AUTH every command answers NOAUTH, as a real password-protected Valkey does. Logs its arguments.
# INFO keyspace answers like the real one (CRLF line ends, "# Keyspace" then one dbN line per non-empty database):
# from FAKE_DBSIZE keys in db0, or verbatim FAKE_KEYSPACE (printf %b) when set.
cat >"$WORK/bin/valkey-cli" <<'FAKE'
#!/usr/bin/env bash
echo "$*" >>"$FAKE_LOG.cli"
if [[ "${FAKE_DOWN:-0}" == 1 ]]; then echo "Could not connect to Valkey at 127.0.0.1:6379: Connection refused" >&2; exit 1; fi
if [[ -n "${FAKE_PASS:-}" && "${REDISCLI_AUTH:-}" != "$FAKE_PASS" ]]; then
  [[ -n "${REDISCLI_AUTH:-}" ]] && echo "AUTH failed: WRONGPASS invalid username-password pair or user is disabled." >&2
  echo "NOAUTH Authentication required."
  exit 0
fi
case "$*" in
  ping) echo PONG ;;
  "CONFIG GET appendonly") printf 'appendonly\n%s\n' "${FAKE_AOF:-no}" ;;
  DBSIZE) echo "${FAKE_DBSIZE:-0}" ;;
  "INFO keyspace")
    if [[ -n "${FAKE_KEYSPACE+x}" ]]; then printf '%b' "$FAKE_KEYSPACE"
    else
      printf '# Keyspace\r\n'
      [[ "${FAKE_DBSIZE:-0}" != 0 ]] && printf 'db0:keys=%s,expires=0,avg_ttl=0\r\n' "$FAKE_DBSIZE"
    fi ;;
esac
FAKE
cat >"$WORK/bin/systemctl" <<'FAKE'
#!/usr/bin/env bash
echo "$*" >>"$FAKE_LOG.systemctl"
FAKE
chmod +x "$WORK/bin/valkey-cli" "$WORK/bin/systemctl"

stock_conf() {
  rm -rf "$WORK/data" && mkdir -p "$WORK/data"
  cat >"$WORK/valkey.conf" <<CONF
bind 127.0.0.1 -::1
save 3600 1 300 100 60 10000
dir $WORK/data
appendonly no
# appendfsync always
appendfsync always
# appendfsync no
no-appendfsync-on-rewrite yes
auto-aof-rewrite-percentage 100
CONF
}

run_block() {
  rm -f "$WORK/log.cli" "$WORK/log.systemctl"
  (export PATH="$WORK/bin:$PATH" FAKE_LOG="$WORK/log"; VK="$WORK/valkey.conf"; set -euo pipefail; source "$WORK/block.sh") 2>&1
}

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
restarted() { grep -qx 'restart valkey-server' "$WORK/log.systemctl"; }
not_restarted() { ! grep -q '^restart' "$WORK/log.systemctl" && grep -qx 'start valkey-server' "$WORK/log.systemctl"; }

echo "### fresh install (Valkey running, DBSIZE 0)"
stock_conf
out="$(FAKE_DBSIZE=0 run_block)"
expect fresh "AOF settings written" applied
expect fresh "RDB save line kept" grep -qx 'save 3600 1 300 100 60 10000' "$WORK/valkey.conf"
expect fresh "commented lines left alone" grep -qx '# appendfsync no' "$WORK/valkey.conf"
expect fresh "no warning" test -z "$out"
expect fresh "restarted (empty Valkey)" restarted
FAKE_DBSIZE=0 run_block >/dev/null
expect fresh "idempotent: each key once after a re-run" bash -c "$(declare -f once); WORK='$WORK'; once appendonly && once appendfsync && once aof-use-rdb-preamble && once no-appendfsync-on-rewrite"
expect fresh "no maxmemory line added" bash -c "! grep -q '^maxmemory ' '$WORK/valkey.conf'"
sed 's/^/      /' "$WORK/valkey.conf"

echo "### existing server: keys present, appendonly off"
stock_conf
out="$(FAKE_DBSIZE=42 run_block)"
expect data-aof-off "file unchanged" unchanged
expect data-aof-off "warning printed" grep -q 'AOF settings NOT written' <<<"$out"
expect data-aof-off "not restarted" not_restarted
expect data-aof-off "no 'settings take effect' note (nothing was written)" bash -c '! grep -q "take effect" <<<"$1"' _ "$out"
echo "$out" | sed 's/^/      /'

echo "### existing server: keys present, AOF already on (CONFIG SET done online; a rewrite may still run)"
stock_conf
out="$(FAKE_AOF=yes FAKE_DBSIZE=42 run_block)"
expect data-aof-on "AOF settings persisted to the file" applied
expect data-aof-on "not restarted (never during a possible AOF rewrite)" not_restarted
expect data-aof-on "note printed" grep -q 'not restarted (aof-on)' <<<"$out"

echo "### Valkey stopped, non-empty dump.rdb"
stock_conf
echo "REDIS0011 data" >"$WORK/data/dump.rdb"
out="$(FAKE_DOWN=1 run_block)"
expect stopped-dump "file unchanged" unchanged
expect stopped-dump "warning printed" grep -q 'AOF settings NOT written' <<<"$out"
expect stopped-dump "started with its data, not restarted" not_restarted

echo "### Valkey stopped, quoted dir and a custom dbfilename"
stock_conf
sed -i "s|^dir .*|dir \"$WORK/data\"|" "$WORK/valkey.conf"
echo 'dbfilename vt.rdb' >>"$WORK/valkey.conf"
echo "REDIS0011 data" >"$WORK/data/vt.rdb"
FAKE_DOWN=1 run_block >/dev/null
expect stopped-quoted "file unchanged (dump found via the unquoted dir + dbfilename)" unchanged

echo "### Valkey stopped, only an AOF directory on disk"
stock_conf
mkdir -p "$WORK/data/appendonlydir" && echo x >"$WORK/data/appendonlydir/appendonly.aof.1.base.rdb"
FAKE_DOWN=1 run_block >/dev/null
expect stopped-aofdir "file unchanged" unchanged

echo "### Valkey stopped, no data on disk"
stock_conf
FAKE_DOWN=1 run_block >/dev/null
expect stopped-empty "AOF settings written" applied
expect stopped-empty "restarted" restarted

echo "### password set on the server, none known to the installer (real NOAUTH path), no dump.rdb"
stock_conf
out="$(FAKE_PASS=s3cret FAKE_DBSIZE=0 run_block)"
expect noauth "file unchanged (unknown = has data)" unchanged
expect noauth "warning printed" grep -q 'could not ask Valkey' <<<"$out"
expect noauth "not restarted" not_restarted
echo "$out" | sed 's/^/      /'

echo "### wrong requirepass in the conf file"
stock_conf
echo 'requirepass wrong' >>"$WORK/valkey.conf"
FAKE_PASS=s3cret FAKE_DBSIZE=0 run_block >/dev/null
expect wrongpass "file unchanged" unchanged
expect wrongpass "not restarted" not_restarted

echo "### requirepass (quoted) in the conf file, empty server"
stock_conf
echo 'requirepass "s3cret"' >>"$WORK/valkey.conf"
FAKE_PASS=s3cret FAKE_DBSIZE=0 run_block >/dev/null
expect conf-pass "authenticated: AOF settings written" applied
expect conf-pass "restarted (empty)" restarted
expect conf-pass "password never on the valkey-cli command line" bash -c "! grep -q s3cret '$WORK/log.cli'"

echo "### REDISCLI_AUTH from the environment, server with keys"
stock_conf
out="$(REDISCLI_AUTH=envpw FAKE_PASS=envpw FAKE_DBSIZE=5 run_block)"
expect env-pass "file unchanged (data)" unchanged
expect env-pass "data warning, not the unknown one" grep -q 'already holds data' <<<"$out"

echo "### keys only in db1 (DBSIZE of db0 would say 0): a shared Valkey is not empty"
stock_conf
out="$(FAKE_DBSIZE=0 FAKE_KEYSPACE='# Keyspace\r\ndb1:keys=7,expires=0,avg_ttl=0\r\n' run_block)"
expect db1-only "file unchanged (data)" unchanged
expect db1-only "data warning" grep -q 'already holds data' <<<"$out"
expect db1-only "not restarted" not_restarted
expect db1-only "keyspace asked, not DBSIZE" bash -c "grep -qx 'INFO keyspace' '$WORK/log.cli' && ! grep -q DBSIZE '$WORK/log.cli'"

echo "### keyspace header only (CRLF), i.e. 0 keys in every database"
stock_conf
FAKE_KEYSPACE='# Keyspace\r\n' run_block >/dev/null
expect keyspace-empty "AOF settings written" applied
expect keyspace-empty "restarted (empty)" restarted

echo "### unreadable INFO keyspace answers count as has data (unknown)"
# An error reply, no reply, a non-number count, an unexpected line, no "# Keyspace" header.
for ks in 'ERR unknown command\r\n' '' '# Keyspace\r\ndb0:keys=abc,expires=0\r\n' '# Keyspace\r\nsomething else\r\n' 'db0:keys=0,expires=0\r\n'; do
  stock_conf
  out="$(FAKE_KEYSPACE="$ks" run_block)"
  expect "unparseable '$ks'" "file unchanged" unchanged
  expect "unparseable '$ks'" "unknown warning" grep -q 'could not ask Valkey' <<<"$out"
  expect "unparseable '$ks'" "not restarted" not_restarted
done

echo "### the total is summed over every database"
# Only the three helper functions, sourced on their own (no config write, no systemctl).
total="$(export PATH="$WORK/bin:$PATH" FAKE_LOG="$WORK/log" VK="$WORK/valkey.conf" \
  FAKE_KEYSPACE='# Keyspace\r\ndb0:keys=3,expires=1,avg_ttl=5\r\ndb2:keys=4,expires=0,avg_ttl=0\r\ndb15:keys=10\r\n'
  # shellcheck disable=SC1090
  source <(sed -n '/^vk_conf()/,/^}/p; /^vk_cli()/,/^}/p; /^vk_total_keys()/,/^}/p' "$WORK/block.sh"); vk_total_keys)"
expect sum "db0 3 + db2 4 + db15 10 = 17" test "$total" == 17

echo
if (( FAILURES )); then echo "install-valkey-aof-test: $FAILURES check(s) FAILED"; exit 1; fi
echo "install-valkey-aof-test: all checks passed"
