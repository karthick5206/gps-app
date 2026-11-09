# Decision Log (summary)

Canonical log with options and rationale: [docs/modernization/decision-log.md](docs/modernization/decision-log.md). Inventory-module decisions: [docs/inventory-modules/01-owner-decisions.md](docs/inventory-modules/01-owner-decisions.md). _Updated 2026-11-09._

## Decided
| ID | Decision |
|---|---|
| Q-01 / D-104 | Engine stop only when online, telemetry ≤ 60 s, ≤ 20 km/h; never queued; re-validated before execution. Not relaxed for parked vehicles |
| Q-02 | `NODE_ENV=production` after staging validation (done) |
| Q-03 / D-102 | Encrypted off-site backups to AWS S3 Mumbai; no paid resources without approval |
| D-101 | S0 deployment only after the release checklist and final owner confirmation |
| D-103 | Old e-mail copies deleted (done) |
| D-105 | `ops/run` versioned (done) |
| D-106 | No commercial rule is assumed for inventory/SIM/invoices |
| D-107 | Legal invoices and payment history must survive company deletion (design first) |

## Awaiting the owner
| Item | Where |
|---|---|
| **S0 final deployment approval** (after the backup key pair) | [release-s0-checklist.md](docs/modernization/release-s0-checklist.md) |
| Backup key pair (public key to host) and S3 cost approval | [backup-plan.md](docs/modernization/backup-plan.md) |
| Retention-safe company deletion design + stop-gap | [company-retention-design.md](docs/modernization/company-retention-design.md) |
| Anti-theft immobilisation option | [anti-theft-immobilisation-proposal.md](docs/modernization/anti-theft-immobilisation-proposal.md) |
| Inventory QI-1…24 (none block Phase B) | [01-owner-decisions.md](docs/inventory-modules/01-owner-decisions.md) |
| Q-04…Q-24 (time zone, seat transfer, suspension, …) | [decision-log.md](docs/modernization/decision-log.md) |
