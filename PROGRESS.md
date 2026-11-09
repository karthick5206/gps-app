# VeeTrax Modernization — Progress

Master spec: *VeeTrax Complete Modernization Assignment*, plus *Device / SIM / Vehicle / Invoice Implementation*. Plans: [docs/modernization](docs/modernization/README.md) · [docs/inventory-modules](docs/inventory-modules/00-phase-a-plan-and-dependency-map.md). Risks: [05-technical-risk-register.md](docs/modernization/05-technical-risk-register.md). Decisions: [decision-log.md](docs/modernization/decision-log.md).

**Branches:** `feature/modernization-phase0` (Phase 0 docs) → `feature/s0-safety` (S0 work, branched from phase0).
**Test environment:** isolated instance (DB `veetrax_assess`, Valkey db 1, API :4100, web :5174, gateway :5123) with seed and synthetic data. Production data is never used.

_Last updated: 2026-11-09_

## Status overview
| Track | Status |
|---|---|
| Phase 0 discovery and baseline | ✅ Done (`876690e`) |
| **S0 safety and security track** | ✅ **Code complete, tested; NOT deployed** (awaiting approval) |
| P1 Design-system foundation | ⏳ Next |
| Inventory/SIM/Vehicle/Invoice: Phase A discovery | ✅ Done (plan + 24 owner decisions) |
| Inventory/SIM/Vehicle/Invoice: Phases B–F | ⏳ After S0; Phase B (inventory) first |

## S0 — completed tasks
| Item | Risk | Commit | Tests / verification |
|---|---|---|---|
| S0.1 Engine stop needs fresh telemetry (≤60 s), online, ≤20 km/h; never queued; gateway drops queued/stale engine stops on reconnect | R-01 (Critical) | `5f8923f` | 14 unit + 1 gateway test. Live simulator e2e: moving → refused; no telemetry → refused; slow+fresh → sent; queued legacy stop → dropped on reconnect; locate still delivered |
| S0.2 Production mode validated in staging; OTP/SMS/mail content never stored in production; startup warnings | R-02 (Critical), R-28 | `81e945c` | Staging (live config, isolated data, `NODE_ENV=production`): boots; 6 private/loopback webhook targets refused, public accepted; private relay refused (accepted without NODE_ENV). `ops/run/ecosystem.config.cjs` now sets `NODE_ENV=production` (untracked file, not started) |
| S0.3 Encrypted full backup (DB snapshot + counts, Valkey, uploads, config) + verified restore | R-03 | `e570024` | Restore test: 11/11 counts equal under live writes, files identical, Valkey restored, non-empty target refused. **Off-site upload awaits provider approval** |
| S0.4 Seed: no default Super Admin password in production; never re-activates disabled users | R-04 | `53dfe31` | 3 unit tests; seed run on isolated DB in dev and production mode |
| S0.5 UPI/cash claim confirm atomic; confirm and reject audited | R-17 | `dc945a4` | 4 concurrency tests (double confirm → 1 invoice; confirm vs reject; failure rollback; audit) |

**Test results (API):** 869 / 869 passing (baseline was 834); `tsc --noEmit` clean.
Web tests have not changed in S0.

## Waiting for owner approval / decision
| # | Item | Why it needs you |
|---|---|---|
| A-1 | **Deploy S0 to production** (rebuild `dist`, `prisma migrate deploy` (no migrations in S0), restart PM2 with `NODE_ENV=production`) | Production deployment. The S0 fixes are not live until deployed |
| A-2 | **Backup storage provider** (AWS S3 Mumbai recommended for residency, or Cloudflare R2 free at today's size) and creating the backup key pair | Paid service; see [backup-plan.md](docs/modernization/backup-plan.md) |
| A-3 | Delete the 17 old mail copies in `apps/api/var/mail` (may contain reset links) | Deleting production data |
| A-4 | Q-25: engine stop for **parked** vehicles whose tracker reports rarely (keep strict 60 s window?) | Vehicle safety |
| A-5 | Commit `ops/run/` (PM2 config, watchdog, autostart; no secrets) to git (R-35)? | Repository policy |
| A-6 | Inventory/SIM/Vehicle/Invoice owner decisions QI-1…24 (partner warehouses, SIM billing, invoice series, who issues invoices, HSN/SAC and GST, overdue rules, refunds…) | Commercial rules; see [Phase A §7.3](docs/inventory-modules/00-phase-a-plan-and-dependency-map.md) |

## Known limitations recorded during S0
- With no mail provider configured, notification logs still record e-mail as SENT (behaviour unchanged; noted for P4).
- Live production has **no SMS or mail provider**. OTP SMS and reset e-mails are not delivered to users today (startup now warns).

## Next (autonomous, no approval needed)
1. P0 remainder: Socket.IO / file-download / partner isolation probes; tenant-isolation e2e test suite.
2. P1 design-system foundation (Inter font, contrast fixes, chart kit, lazy map/locales, CI) behind feature flags.
3. Inventory Phase B (device inventory, additive schema), with care to never write `Device.companyId`/`isActive` from inventory code (licence-seat side effects).
