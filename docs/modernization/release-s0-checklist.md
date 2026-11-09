# S0 Release Checklist: for owner deployment approval

Release: branch `feature/s0-safety` (from `main@17a2e63`), commits `5f8923f … HEAD`. **Not deployed.** Database migrations: **none**.
Owner conditions from 2026-11-09 and their status:

| # | Owner condition | Status | Evidence |
|---|---|---|---|
| 1 | Resolve the missing SMS/e-mail provider **or** document and demonstrate a tested alternative authentication and password-reset process | ✅ **Alternative demonstrated** (providers still not configured) | §1 below; smoke tests 21/21 |
| 2 | Production-like authentication, OTP, password-reset and login smoke tests | ✅ 21/21 pass | §2 |
| 3 | Verify `NODE_ENV=production` and all production security assertions | ✅ | §3 |
| 4 | Latest database **and file** backup available | ⛔ **Blocked**: needs your backup key pair (public key on the host); see §4 | backup-plan.md |
| 5 | PM2 restart and rollback procedures documented | ✅ | [ops/run/README.md](../../ops/run/README.md) |
| 6 | Confirm health after restart and monitor logs | ⏳ Executed at deployment (steps in §5) | — |

## 1. Authentication without SMS/e-mail providers (alternative process)
The live `.env` has **no SMS and no mail provider**. Today (before S0) OTP codes and reset links are never delivered, but the UI pretends they were sent. After S0:

| Need | Process | Tested |
|---|---|---|
| Sign in | E-mail + password (unchanged) | ✅ |
| "Send code" (SMS login) | Clear message: *"Sign-in with an SMS code is not available right now. Sign in with your e-mail and password, or ask your administrator."* (HTTP 503, identical for every number: no account discovery) | ✅ |
| "Forgot password" | Clear message: *"Password reset by e-mail is not available right now. Ask your administrator to set a temporary password for you."* (HTTP 503, identical for every address) | ✅ |
| Password reset | **Admin-assisted:** a company Admin (Users → edit → password) sets a temporary password and tells the user out of band. The user signs in and changes it under *My account → Change password*, which also signs out their other sessions. For a company's own Admin: the Super Admin uses "Act as company" → Users | ✅ end to end |
| Restore normal flows | Configure `SMTP_URL` or `ZOHO_MAIL_KEY` (+ `MAIL_FROM`) and `SMS_PROVIDER=smartping` with DLT credentials. The 503s disappear automatically and no code change is needed | — (needs your credentials; recommended soon) |

Known gaps (documented, not blockers):
- No "must change password at next sign-in" flag.
- Mobile tracker pairing still reports `smsSent: false` and relies on the e-mailed code, which is not delivered without a mail provider.

## 2. Smoke tests (staging = branch build + live `.env` values + `NODE_ENV=production`; isolated DB `veetrax_assess`, port 4300)
`PASS` all 21:
- startup refused with `OTP_DEV_ECHO=true` · health 200 · startup warning "no SMS provider"
- password login · wrong password 401 · `/auth/me` with/without token · lockout after 5 failures (429)
- OTP request 503, identical for an unknown number · forgot-password 503, identical for an unknown e-mail
- admin sets a temporary password → user signs in → changes it → temporary password rejected → own password works
- refresh rotation · old refresh token rejected · logout · refresh revoked after logout

Full test suites on the release commit: **API 870/870, web 95/95, both typechecks clean.**

## 3. Production mode and security assertions
- `ops/run/ecosystem.config.cjs` sets `NODE_ENV=production` for api, gateway, processor, notifier and summarizer (committed `41f2616`).
- Assertions verified in staging:
  - dev echo → startup refused;
  - example JWT secret → refused (unit test); the live secret is 64 characters and not the example (checked without printing).
- SSRF verified in staging:
  - webhooks to loopback, 10/8, 192.168/16, 169.254.169.254 and ::1 refused, public https accepted;
  - relay to a private IP refused (accepted without `NODE_ENV`).
- The existing production build from `main` also passes the assertions, so a restart alone would not fail.

## 4. Backup before deployment (blocking)
- Scripts are ready and the restore is verified ([backup-plan.md](backup-plan.md)).
- Before deploying I will run `veetrax-backup.sh` against the **live** DB, uploads, Valkey and config, and confirm `last-status.json` reports `ok: true`.
- **Needed from you:** generate the backup key pair on your PC and give me only the public key. Commands:
  ```bash
  gpg --quick-gen-key "VeeTrax backup <you@yourdomain>" rsa4096 encrypt never   # on YOUR PC, choose a strong passphrase
  gpg --armor --export "VeeTrax backup" > veetrax-backup.pub.asc                # give this file to the host
  gpg --armor --export-secret-keys "VeeTrax backup" > veetrax-backup.PRIVATE.asc  # keep OFFLINE (USB / password manager)
  ```
- Off-site S3 is **optional for this release**: the local encrypted bundle satisfies "backup available". S3 follows your cost approval.

## 5. Deployment steps (after your final approval)
1. Run the backup, check `ok: true` and record the bundle name.
2. `git rev-parse HEAD > apps/api/var/release-previous.txt`, then check out the release commit.
3. `npm ci`; `npm run build:shared`; build api and web (writes `apps/api/dist`, `apps/web/dist`).
4. `npx prisma migrate deploy` (expected: no pending migrations).
5. `pm2 start ops/run/ecosystem.config.cjs --update-env` (or `pm2 reload … --update-env`); `pm2 save`. The tunnel stays as you left it (currently stopped).
6. Verify:
   - `/api/health` 200; `pm2 ls` all online;
   - the API log shows the two expected `[env] WARNING` lines and no errors;
   - log in;
   - live updates (if devices are connected);
   - one report;
   - engine stop refused for an offline vehicle.
7. Monitor for 30 minutes (restarts, errors, stream lag).
8. **Rollback:** previous commit → rebuild → `pm2 reload --update-env` ([runbook](../../ops/run/README.md)).
