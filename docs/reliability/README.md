# Production cache reliability (release 1.6)

**Owner decided 2026-11-09: Valkey replaces Memurai. Hosting: Mintplus same-DC Linux VM (quote/order pending owner).** Release 1.6 (`f0b35b8`) is deployed on Memurai first; the cut-over follows once the VM exists (DECISION_LOG D-108, D-109).

| Document | Contents |
|---|---|
| [valkey-cutover-runbook.md](valkey-cutover-runbook.md) | **The cut-over runbook.** Variant A (same DC, private network, primary) and variant B (TLS); pre-flight, exact commands, verification, rollback, downtime |
| [../../ops/valkey/README.md](../../ops/valkey/README.md) | Valkey host kit for Ubuntu 24.04: install, ACL, TLS, firewall, backup, health, upgrades, how to verify the private network is isolated |
| [valkey-sizing.md](valkey-sizing.md) | Measured memory per stream entry and per vehicle; why 2 GB is enough |
| [mintplus-quote-request.md](mintplus-quote-request.md) | Quote request text for the VM |
| [cache-assessment.md](cache-assessment.md) | Every cache command used (file:line); Memurai, Valkey and Garnet compared; licensing (Memurai Developer Edition is prohibited in production); costs in INR; recommendation |
| [ingestion-reliability.md](ingestion-reliability.md) | Durable gateway spool, device ACK semantics, dedupe and ordering, health endpoints (`/api/health/live`, `/ready`, `/tracking`), NSSM recovery, watchdog and alerts |
| [test-evidence.md](test-evidence.md) | Chaos scenarios (sent vs persisted, health shown, alerts fired) and suite results |
| [production-rollout.md](production-rollout.md) | Deploying 1.6, the zero-loss Memurai → Valkey cut-over, rollback, open decisions |

Code:
- `apps/api/src/gateway/spool/`
- `apps/api/src/monitoring/health-probe.service.ts`
- `apps/api/src/redis/stream-groups.ts`
- `apps/api/src/monitoring/alert-cli.ts`
- `apps/api/scripts/chaos/`
- `apps/api/scripts/cache-copy.ts`
- `ops/deploy/windows/install-reliability.ps1`
- `ops/deploy/windows/veetrax-watchdog.ps1`
