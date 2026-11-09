# 10 — Release & Rollback Plan

Branch `feature/modernization-phase0` · 2026-11-09 · Proposal.

## 1. Branching and PRs
- Work branches off `main`, one per focused change (`feature/<phase>-<topic>`). Phase 0 documentation lives on `feature/modernization-phase0`.
- Small PRs: one concern each, with tests, before/after screenshots and a rollback note.
- Commits and pushes happen only when the product owner asks.

## 2. Feature flags
- **Web-only UI changes:** a company-level setting (`Company.settings` JSON already exists) or env flag, for example `ui.reportsHubV2`. Default off until the gate is passed; then on for the demo tenant, then all.
- **Behavioural changes** (engine-stop guard, permission ceiling, toasts): an env flag with a safe default. The engine-stop guard defaults **on** once approved; it is never silently disabled.

## 3. Database migrations
- Additive only by default (new nullable columns, new tables, new indexes created `CONCURRENTLY` via raw SQL migration).
- Every migration PR states: forward SQL, backfill plan, rollback SQL (or why it is irreversible), and data-size impact.
- Destructive changes (drop or rename column, type change such as `timestamp` → `timestamptz`) need a backup, a dry run on a production-sized copy, and a written rollback, and run in a maintenance window.

## 4. Deployment (current Windows/PM2 host; future Linux)
1. Take a backup (DB plus uploaded files) and confirm it completed.
2. `git pull`; `npm ci`; `npm run build:shared`; build api and web.
3. `npx prisma migrate deploy`.
4. `pm2 reload` api, gateway, processor, notifier and summarizer one at a time. Device connections reconnect automatically.
5. Smoke test: `/api/health`, login, live map updates, one report, one simulator device on a staging port.
6. Watch logs and metrics for 30 minutes (error rate, stream lag).

## 5. Rollback
| Change type | Rollback |
|---|---|
| Web-only | Redeploy the previous web build (keep the last 3 builds), or turn off the feature flag |
| API, no migration | `git checkout <previous tag>`, rebuild, `pm2 reload` |
| API + additive migration | Roll back code; leave additive schema in place (harmless) |
| Destructive migration | Restore from the pre-release backup per the runbook (tested in S0-4) |
| Configuration (for example `NODE_ENV`) | Revert the env value and reload; record it in the decision log |

## 6. Release notes
Each release lists: user-visible changes (with screenshots), behaviour changes (especially safety, permissions, billing), migrations, flags, and known issues.
