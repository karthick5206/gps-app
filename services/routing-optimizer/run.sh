#!/usr/bin/env bash
# Create/refresh the venv (WSL) and start the optimizer HTTP server on 127.0.0.1:${OPTIMIZER_PORT:-8090}.
#   ./run.sh            # server
#   ./run.sh test       # pytest (unit tests + corpus)
#   ./run.sh corpus     # corpus runner (PASS/FAIL + timing per scenario)
set -euo pipefail
cd "$(dirname "$0")"
VENV=${OPTIMIZER_VENV:-$HOME/.venvs/routing-optimizer}
# Python 3.14 is required: ortools 9.15.6755 ships cp314 wheels (requirements.lock).
PYTHON=${OPTIMIZER_PYTHON:-python3.14}
if [[ ! -x "$VENV/bin/python" ]]; then
  "$PYTHON" -m venv "$VENV"   # needs the matching pythonX.Y-venv package
  "$VENV/bin/pip" install -q --upgrade pip
fi
# Same pins and hashes as CI.
"$VENV/bin/pip" install -q --require-hashes --no-deps --only-binary=:all: -r requirements.lock
if [[ "${1:-}" == test ]]; then exec "$VENV/bin/python" -m pytest; fi
if [[ "${1:-}" == corpus ]]; then shift; exec "$VENV/bin/python" -m corpus_run "$@"; fi
# The server refuses to start without OPTIMIZER_TOKEN (phase 4). For local use keep one in a 0600 file outside the repo.
TOKEN_FILE=${OPTIMIZER_TOKEN_FILE:-$HOME/.config/veetrax/optimizer.token}
if [[ -z "${OPTIMIZER_TOKEN:-}" ]]; then
  if [[ ! -s "$TOKEN_FILE" ]]; then mkdir -p "$(dirname "$TOKEN_FILE")"; (umask 077; head -c 32 /dev/urandom | base64 | tr -d "=+/" > "$TOKEN_FILE"); fi
  export OPTIMIZER_TOKEN=$(cat "$TOKEN_FILE")
fi
exec "$VENV/bin/python" -m optimizer.server "$@"
