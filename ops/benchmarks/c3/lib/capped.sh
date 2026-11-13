#!/usr/bin/env bash
# Runs a command under the same resource caps as veetrax-optimizer.service (doc 06 §7 production limits; the unit file
# ops/deploy/linux/veetrax-optimizer.service): CPUQuota=150%, MemoryMax=3G, MemorySwapMax=0, Nice=10.
#   lib/capped.sh <command...>        (needs systemd + root or a user manager with the cpu/memory controllers)
# Override with C3_CAP_CPU (default 150%) / C3_CAP_MEM (default 3G) only to measure headroom; record it in the results.
# The scope's peak memory and OOM kills are written to $C3_CAP_REPORT (JSON) when that variable is set.
set -uo pipefail
CPU="${C3_CAP_CPU:-150%}"; MEM="${C3_CAP_MEM:-3G}"
UNIT="c3-capped-$$-$RANDOM"
if ! command -v systemd-run >/dev/null; then echo "capped.sh: systemd-run not found (the C3 host runs systemd)" >&2; exit 2; fi
USER_FLAG=(); [[ $EUID -ne 0 ]] && USER_FLAG=(--user)
# --scope keeps stdout/stderr attached; -p MemoryPeak needs systemd >= 255 (Ubuntu 24.04 ships 255).
systemd-run "${USER_FLAG[@]}" --scope --quiet --unit="$UNIT" --collect \
  -p CPUQuota="$CPU" -p MemoryMax="$MEM" -p MemorySwapMax=0 -p OOMPolicy=continue \
  nice -n 10 "$@"
rc=$?
if [[ -n "${C3_CAP_REPORT:-}" ]]; then
  # A collected scope is gone; the kernel's OOM kill shows as exit 137 (SIGKILL).
  echo "{\"unit\":\"$UNIT\",\"cpuQuota\":\"$CPU\",\"memoryMax\":\"$MEM\",\"exit\":$rc,\"oomKilledLikely\":$([[ $rc == 137 ]] && echo true || echo false)}" > "$C3_CAP_REPORT"
fi
exit $rc
