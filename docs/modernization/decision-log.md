# Decision Log

Format: ID · date · decision or question · options · recommendation · status. Decisions marked **Open** block the items noted.

## Decisions recorded (from the assignment, treated as fixed)
| ID | Date | Decision | Source |
|---|---|---|---|
| D-001 | 2026-11-09 | Modernize, do not rebuild; keep the stack (NestJS/Prisma/PostgreSQL/Valkey, React/Vite/Tailwind, Expo) | Assignment §1, §2.8 |
| D-002 | 2026-11-09 | Keep the VeeTrax logo exactly; keep Teal/Plum/Sky and Light/Dark themes | §2.1–2.3 |
| D-003 | 2026-11-09 | Keep annual device licensing | §2.4 |
| D-004 | 2026-11-09 | India-first; international via configuration only | §2.5, §15 |
| D-005 | 2026-11-09 | Never use production data for fixtures or screenshots. Phase 0/2 used an isolated DB `veetrax_assess` with seed + synthetic data | §2.9 |
| D-006 | 2026-11-09 | Work on branch `feature/modernization-phase0`; no source changes until the discovery report is approved | user instruction |

## Open questions for the product owner
| ID | Question | Options | Recommendation | Blocks |
|---|---|---|---|---|
| Q-01 | **Engine-stop for offline vehicles** | (a) refuse; (b) queue with a short TTL and a delivery-time speed/freshness re-check; (c) current behaviour (24 h, no re-check) | (b) with TTL 5 min, freshness ≤ 30 s, speed ≤ the existing limit; never (c) | S0 / R-01 |
| Q-02 | Approve setting `NODE_ENV=production` on the live PC deployment | yes / schedule | Yes, in a maintenance window | S0 / R-02 |
| Q-03 | Backup target for uploaded files and the restore-test schedule | local disk / NAS / cloud | Off-machine copy + monthly restore test | S0 / R-03 |
| Q-04 | Report, History and dashboard timestamps: company time zone by default? | company TZ / browser TZ / user setting | Company TZ with a visible label; optional user override | P1, P2 |
| Q-05 | Should a licence seat follow its device on move/transfer, or stay with the company? | follow / stay | Decide once; apply to both move paths | P5 / R-20 |
| Q-06 | Do deactivated devices keep consuming seats? | keep / release | Release to the free pool (seat keeps ageing) | P5 |
| Q-07 | Should partner-pool seats age before allocation? | yes (today) / clock starts at allocation | Business decision | P5 |
| Q-08 | Partner-collected cash: supplier on the invoice, price (platform vs partner), settlement | — | Needs a commercial decision | P5 |
| Q-09 | May a back-dated `paidOn` shorten the licence year? | yes / no | No (start from the confirmation date) or require a reason | P5 |
| Q-10 | Should locked (expired) vehicles still raise alerts, webhooks and relay forwarding? | yes / no / safety alerts only | Safety alerts (SOS, power cut) only | P5 / R-34 |
| Q-11 | Offer UPI/cash claims when Razorpay is enabled, and to partners? | — | Business decision | P5 |
| Q-12 | Price honoured when a price changes between claim and confirmation | claim-time / confirm-time | Claim-time (the quote is stored) | P5 |
| Q-13 | Suspended tenants: stop ingestion? keep reminders and seat ageing? | — | Keep ingesting (safety and history), stop alerts to customers, fix the UI hint | P5 / R-21 |
| Q-14 | Currencies/taxes beyond INR/GST in scope for this programme? | — | Configuration hooks only | P5 |
| Q-15 | Separate payment receipt document, or the tax invoice as receipt? | — | Tax invoice is sufficient for India; confirm with the accountant | P5 |
| Q-16 | Which alert types should toast in the web UI? | all / critical only / user choice | Critical + user opt-in | P3 |
| Q-17 | Production geocoder (self-hosted Photon/Nominatim)? | yes / no | Yes; otherwise place names fall back to POI/geofence | P2, P3 |
| Q-18 | Keep the hand-rolled chart kit, or adopt a charting library? | kit / library | Kit (no new dependency) | P1 |
| Q-19 | Driver-score trends: weekly snapshots table, or compute on demand? | — | Snapshots (cheap at scale) | P3 |
| Q-20 | Support/ticketing: integrate an existing helpdesk (which?) or build minimal in-app tickets? | — | Integrate | P4/P6 |
| Q-21 | WhatsApp / second SMS provider (MSG91 or Gupshup) in scope? | — | Business decision (DLT templates needed) | P6 |
| Q-22 | Keep DISTANCE / ENGINE_HOURS report types (subsets of SUMMARY)? | keep / alias | Keep; improve descriptions (schedules may use them) | P2 |
| Q-23 | MFA for Admin and Super Admin? | TOTP / OTP / none | TOTP for Super Admin first | P4 |
| Q-24 | Should "system" theme (follow OS) be added as a 6th option? | yes / no | Yes (design doc required it) | P1 |
