# Chaos run 2026-11-09T15:15:33.181Z

Devices 40, one GT06 0x22 fix every 2 s each (no device ACK for these frames). Valkey: Valkey server v=9.1.3 sha=00000000:0 malloc=jemalloc-5.3.0 bits=64 build=7d3d15ca57f5c7db.

| Scenario | Sent | Persisted | Lost | Extra | Dup rows in DB | Stream dups dropped (mid) | Max spooled | Drain after fault | /api/health | /api/health/tracking | gateway /health | Alert e-mails | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| baseline | 802 | 802 | 0 | 0 | 0 | 0 | 0 | 4 s | 200 | 200 OK | 200 ok | — |  |
| net-cut | 1350 | 1350 | 0 | 0 | 0 | 0 | 813 | 4 s | 200 → 503 → 200 | 200 OK → 503 CRITICAL → 200 OK | 200 ok → 200 degraded → 200 ok | [VeeTrax] CRITICAL: Valkey is not reachable: PING timed out after 2000 ms. Gateways spool positions to disk and replay them when it is back; live m…; [VeeTrax] Resolved: valkey |  |
| cache-kill | 1786 | 1786 | 0 | 0 | 0 | 0 | 40 | 4 s | 200 → 503 → 200 | 200 OK | 200 ok → 200 degraded → 200 ok | — |  |
| dup-ooo | 884 | 884 | 0 | 0 | 0 | 1 | 0 | 6 s | 200 | 200 OK | 200 ok | — | one entry XADDed twice with the same mid (expect 1 row, 1 duplicate dropped); live 868120009000003: 2026-11-09T15:20:25.000Z OK (newest fix); live 868120009000005: 2026-11-09T15:20:23.000Z OK (newest fix); live 868120009000001: 2026-11-09T15:20:23.000Z OK (newest fix); live 868120009000002: 2026-11-09T15:20:22.000Z OK (newest fix); live 868120009000004: 2026-11-09T15:20:24.000Z OK (newest fix) |
| WHOLE RUN | 5441 | 5441 | 0 | 0 | 0 | 1 | 0 | 4 s | 200 | 200 OK | 200 ok | [VeeTrax] CRITICAL: Valkey is not reachable: PING timed out after 2000 ms. Gateways spool positions to disk and replay them when it is back; live m…; [VeeTrax] Resolved: valkey |  |
