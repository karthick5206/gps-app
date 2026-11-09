# Production cache reliability (release 1.6)

| Document | Contents |
|---|---|
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
