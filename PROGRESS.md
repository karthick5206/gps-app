# VeeTrax Modernization — Progress

Master spec: *VeeTrax Complete Modernization Assignment*, plus *Device / SIM / Vehicle / Invoice Implementation*. Plans: [docs/modernization](docs/modernization/README.md) · [docs/inventory-modules](docs/inventory-modules/00-phase-a-plan-and-dependency-map.md). Risks: [05-technical-risk-register.md](docs/modernization/05-technical-risk-register.md). Decisions: [decision-log.md](docs/modernization/decision-log.md).

**Branches:** `feature/modernization-phase0` (Phase 0 docs) → `feature/s0-safety` (S0 work, branched from phase0).
**Test environment:** isolated instance (DB `veetrax_assess`, Valkey db 1, API :4100, web :5174, gateway :5123) with seed and synthetic data. Production data is never used.

_Last updated: 2026-11-09_

## Status overview
| Track | Status |
|---|---|
| Phase 0 discovery and baseline | ✅ Done (`876690e`) |
| **S0 safety and security track** | ✅ Code complete, tested; release checklist ready; **deployment awaits backup key pair + final approval** ([checklist](docs/modernization/release-s0-checklist.md)) |
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

## Round 2 (owner decisions 2026-11-09) — completed
| Item | Result |
|---|---|
| Alternative auth without providers | 503 + guidance for SMS-code login / e-mail reset; admin-assisted reset demonstrated (`10917bd`) |
| Production-like auth smoke tests | **21/21 pass** (staging: live config, isolated data, NODE_ENV=production) |
| Release checklist + PM2 runbook | [release-s0-checklist.md](docs/modernization/release-s0-checklist.md), [ops/run/README.md](ops/run/README.md) |
| Old e-mail copies | Tokens invalidated (0 outstanding), other copies checked, 18 files shredded, excluded from backups ([security-log](docs/modernization/security-log.md)) |
| `ops/run` committed | Secret-reviewed; watchdog/autostart documented (`41f2616`) |
| AWS S3 Mumbai plan | Prices from the AWS Price List API (2026-11-04); cost today < ₹10/month; IAM write-only, versioning + Object Lock, lifecycle, curl-SigV4 uploader (no new tools) — **nothing created** |
| Inventory decision document | [01-owner-decisions.md](docs/inventory-modules/01-owner-decisions.md): 24 questions in 7 groups; none blocks Phase B |
| Company deletion retention design | [company-retention-design.md](docs/modernization/company-retention-design.md): R-36 confirmed by code reading |
| Anti-theft immobilisation research | [anti-theft-immobilisation-proposal.md](docs/modernization/anti-theft-immobilisation-proposal.md): strict rules kept |
| Tests on HEAD | API **870/870**, web **95/95**, typechecks clean |

## Waiting for owner approval / decision
| # | Item | Why it needs you |
|---|---|---|
| A-1 | **S0 final deployment approval**, after the backup key pair (public key) is provided | Production deployment |
| A-2 | Generate the backup GPG key pair (commands in the checklist) and approve the S3 cost to activate off-site backups | Paid service / key custody |
| A-3 | Retention-safe company deletion: approve the design and the stop-gap (block purge of companies with financial records) | Data retention / legal |
| A-4 | Anti-theft immobilisation proposal (option 1 + 4) | Vehicle safety |
| A-6 | Inventory/SIM/Vehicle/Invoice owner decisions QI-1…24 (partner warehouses, SIM billing, invoice series, who issues invoices, HSN/SAC and GST, overdue rules, refunds…) | Commercial rules; see [Phase A §7.3](docs/inventory-modules/00-phase-a-plan-and-dependency-map.md) |

## Known limitations recorded during S0
- With no mail provider configured, notification logs still record e-mail as SENT (behaviour unchanged; noted for P4).
- Live production has **no SMS or mail provider**. OTP SMS and reset e-mails are not delivered to users today (startup now warns).

## Next (autonomous, no approval needed)
1. P0 remainder: Socket.IO / file-download / partner isolation probes; tenant-isolation e2e test suite.
2. P1 design-system foundation (Inter font, contrast fixes, chart kit, lazy map/locales, CI) behind feature flags.
3. Inventory Phase B (device inventory, additive schema), with care to never write `Device.companyId`/`isActive` from inventory code (licence-seat side effects).
