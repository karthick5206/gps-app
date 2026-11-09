# 13 — Execution, Security, Performance, Operations and Code Quality

Discovery date: 2026-11-08 · Scope: whole monorepo (`packages/shared`, `apps/api`, `apps/web`, `apps/mobile`, `apps/tracker`,
`scripts/`, `ops/`, `tooling/`). Read-only review: nothing was built, run or changed. Secret values were **never** copied;
variables are named and marked "set" / "redacted".

Severity tags: **Critical / High / Medium / Low**. Evidence tags: **Confirmed** (read in code/config) / **Inferred**
(follows from code but not exercised at runtime).

---

## Top findings at a glance

| # | Sev | Finding | Evidence |
|---|---|---|---|
| 1 | High | The public deployment (PM2 on the Windows PC, `us.veetrax.com`) does not set `NODE_ENV=production`, so the production safety checks never run and the webhook SSRF guard allows private/loopback targets | Confirmed |
| 2 | High | Backups cover PostgreSQL only. Uploaded files under `apps/api/var/` (documents, selfies, driver media, invoices, expenses) are not backed up | Confirmed |
| 3 | High | The seed always creates a Super Admin with a published default password (`admin@veetracer.local`, password in README), production included, and re-running it reactivates that account | Confirmed |
| 4 | High | With no SMS/mail provider set (the live `.env` has none), OTP codes go to stdout/PM2 logs and `var/sms/sms.log`. Every e-mail, reset links included, is always written in plain text to `var/mail/` with no retention | Confirmed |
| 5 | Medium | No HTTP security headers (no helmet/CSP/HSTS), and the web stores the 30-day refresh token in `localStorage` | Confirmed |
| 6 | Medium | Live socket: authorization is re-checked every 60 s but **session revocation is not**, and it costs one DB round-trip per socket per minute | Confirmed |
| 7 | Medium | Password lockout is keyed only on the e-mail address, so anyone can lock out any account. Missing users skip bcrypt, which lets a timing attack enumerate accounts. OTP has no daily cap per mobile (SMS pumping) | Confirmed |
| 8 | Medium | No CI and no integration/e2e tests. `packages/shared`, `apps/mobile` and `apps/tracker` have 0 tests. 14 API modules have no spec, among them `live`, `live-share`, `masters`, `drivers` and `transfer` | Confirmed |

---

## A) Execution & Deployment Guide

### A.1 Prerequisites
- Node **≥ 22** (root [package.json](../../package.json) `engines`; PC has v22.23.4 at `C:\Program Files\nodejs`, not on the agent PATH).
- PostgreSQL 16+ (PC: PostgreSQL 18 in WSL Ubuntu). TimescaleDB is optional: the init migration turns `Position` into a hypertable only if the extension is available ([migration.sql:505](../../apps/api/prisma/migrations/20261018002831_init/migration.sql#L505)).
- Valkey/Redis 7+ (PC: Valkey 9 in WSL). Production should run AOF `appendonly yes` + `noeviction` ([MONITORING.md §7](../MONITORING.md)).
- Optional external services: SMTP or Zoho CPaaS mail, Smartping SMS (DLT), Expo push, Razorpay, Nominatim/Photon geocoder, Valhalla/OSRM router, Esri basemap key, OpenFreeMap or self-hosted vector tiles.

### A.2 Install & configure (fresh clone)
```bash
npm install                                    # npm workspaces: packages/*, apps/*
cp apps/api/.env.example apps/api/.env         # then set JWT_SECRET (>=32 chars), DATABASE_URL, etc.
cp apps/web/.env.example apps/web/.env         # optional map style overrides
npm run build:shared                           # packages/shared → CommonJS dist used by api
cd apps/api
npx prisma migrate deploy     # (dev: npm run db:migrate) — 51 migrations
npm run db:seed               # platform company + Super Admin; demo data unless NODE_ENV=production / SEED_DEMO=0
```
`loadEnv()` reads `apps/api/.env` with `process.loadEnvFile` ([env.ts:44](../../apps/api/src/config/env.ts#L44)). It fails fast if
`DATABASE_URL` or `JWT_SECRET` is missing, or if `JWT_SECRET` is shorter than 32 characters.

### A.3 Processes

| Process | Dev command | Prod command (after `npm run build -w @veetracer/api`) | Ports |
|---|---|---|---|
| api (REST + Socket.IO `/live` + crons) | `npm run dev:api` | `node dist/main.js` | 4000 (HTTP) |
| gateway (device TCP, media) | `npm run dev:gateway` | `node dist/gateway/main.js` | 5023 GT06, 5027 Teltonika, 6808 JT808, 5030 AIS-140, 7612 media, 7613 attachments, 4110 localhost HTTP-FLV |
| processor (stream → DB, rules) | `npm run dev:processor` | `node dist/processor/main.js` | — |
| notifier (email/SMS/push/webhooks/relay) | `npm run notifier:dev -w @veetracer/api` | `node dist/notifier/main.js` | — |
| summarizer (trips/stops/addresses) | `npm run summarizer:dev -w @veetracer/api` | `node dist/summarizer/main.js` | — |
| web | `npm run dev:web` (Vite :5173, proxies `/api` + `/socket.io`) | static `apps/web/dist` behind a reverse proxy | — |
| simulator | `npm run sim -- --count 20` | — | — |

Build commands: `npm run build:shared`, `npm run build -w @veetracer/api` (nest build), `npm run build -w @veetracer/web` (vite build), mobile/tracker via EAS (`apps/mobile/eas.json`) with local release signing from [with-release-signing.js](../../tooling/expo/with-release-signing.js). The keystore stays outside the repo and is read from `~/.gradle/gradle.properties`.

`scripts/dev-start.sh` builds and starts all five Node processes, the web app and the simulator. It is **macOS-only**: it runs `brew services start valkey` ([dev-start.sh:16](../../scripts/dev-start.sh#L16)), so on Windows you need Git-Bash plus WSL Valkey, or must start each process by hand.

### A.4 Current topology: Windows PC (Confirmed, from `ops/run`, untracked)
```
Internet ──(Cloudflare Tunnel "veetrax", HTTP only)──► cloudflared (PM2 "tunnel")
     /api, /socket.io ──► api :4000        everything else ──► `vite preview` :4173 (PM2 "web")
PM2: wsl-db (keeps WSL alive) · api · gateway · processor · notifier · summarizer · web · tunnel
WSL Ubuntu: PostgreSQL 18 + Valkey 9 (systemd)      Device TCP ports: NOT exposed (no port-forward)
Scheduled task "VeeTrax watchdog" (logon + every 5 min) → pm2 resurrect / restart errored
```
- [ecosystem.config.cjs:14-21](../../ops/run/ecosystem.config.cjs#L14) sets `cwd`, `max_memory_restart: 1500M` and `restart_delay`. It sets **no `env` block, so no `NODE_ENV`** (see C-1).
- The web app is served by `vite preview` ([ecosystem.config.cjs:39-45](../../ops/run/ecosystem.config.cjs#L39)). Vite documents `preview` as a local preview tool, not a production server. **Medium, Confirmed.**
- [install-autostart.ps1](../../ops/run/install-autostart.ps1) registers the watchdog with `LogonType Interactive`, so nothing runs until the user logs on after a reboot. It also turns off sleep and hibernate. **Medium, Confirmed.**
- `ops/run/` is untracked in git (git status `?? ops/run/`), so the live deployment's config is not under version control. **Medium, Confirmed.**
- PM2 log rotation (`pm2-logrotate`) is not configured anywhere in the repo, so logs grow without limit. **Low, Inferred.**
- Backups ([ops/backup](../../ops/backup/README.md)) are written for a *different* Windows "production server" layout (`C:\apps\veetracer`, Windows `pg_dump.exe`, SYSTEM task). They are not wired to the WSL PostgreSQL on this PC. **High, Inferred:** the live public instance may have no automated backups at all.

### A.5 Planned production: Linux (from [HANDOFF §4.2](../HANDOFF.md) / [MONITORING §6-7](../MONITORING.md))
- Hosts: `gps.mintplus.co.in` (web + API behind a reverse proxy, 443) and `track.mintplus.co.in` (DNS-only, device TCP ports). The mobile apps hardcode `https://gps.mintplus.co.in` as their fallback server ([config.ts:2](../../apps/mobile/src/lib/config.ts#L2), [api.ts:6](../../apps/tracker/src/lib/api.ts#L6)).
- Open ports 443/80 and 5023/5027/5030/6808. Keep 4000/5432/6379 private. `prisma migrate deploy` runs on each release. Run ≥ 2 processors (distinct `PROCESSOR_CONSUMER`), run gateways behind a TCP LB, and enable `REPORT_SCHEDULER` on exactly one API.
- **Missing from the repo:** systemd units / PM2 Linux config, reverse-proxy (nginx/Caddy) config, Dockerfiles/compose, a CI pipeline, a deploy script, a log-shipping config and a secrets-management approach. **Medium, Confirmed** (none of these files are tracked).

### A.6 What's missing for a clean local run
1. README tells Windows users to run `brew`. Nothing documents the Windows/WSL path except the untracked `ops/run`.
2. The README design-doc link is broken: it points to `docs/VeeTrax_Design_Document_v2.0.pdf`, but the file is `docs/VeeTracer_Design_Document_v2.0.pdf` ([README.md:6](../../README.md#L6)). **Low, Confirmed.**
3. `.env.example` leaves out many variables the code reads, including `SMTP_URL`, `ZOHO_MAIL_KEY`, `SMS_PROVIDER`, `SMARTPING_*`, `PUSH_PROVIDER`, `EXPO_ACCESS_TOKEN`, `ROUTER_*`, `ESRI_BASEMAP_KEY`, `NODE_ENV`, `WEBHOOK_ALLOW_PRIVATE`, `RETENTION` and the job toggles (see the table in B).
4. `packages/shared` must be built before the API (the API imports its CJS dist), while the web app compiles the TS source through a Vite alias ([vite.config.ts:16](../../apps/web/vite.config.ts#L16)). This is easy to forget after shared changes.
5. The local `.env.example` sets `GEOCODER=nominatim` with the public OSM endpoint. That is fine for dev, but the live PC `.env` also uses `nominatim` (C-14).

---

## B) Environment variables

Source: `grep process.env|env.X` across `apps/*`. "Prod req." = must be set deliberately for a public deployment.

### B.1 API / workers (`apps/api/.env`)

| Name | Used by | Purpose | Default | Prod req. |
|---|---|---|---|---|
| `DATABASE_URL` | all processes, [env.ts](../../apps/api/src/config/env.ts) | PostgreSQL connection | — (required) | **Yes** |
| `REDIS_URL` | all | Valkey connection | `redis://localhost:6379` | Yes |
| `JWT_SECRET` | api, auth, video/media tokens, OTP HMAC, tracker install hash | HS256 signing + HMAC key (≥32 chars; refuses `change-me…` in prod) | — (required) | **Yes** (set, redacted) |
| `NODE_ENV` | env.ts, url-guard, seed | `production` enables safety checks, https-only webhooks, skips demo seed | unset | **Yes** (currently unset on PC) |
| `API_PORT` | api | HTTP port | 4000 | — |
| `GT06_PORT` / `TELTONIKA_PORT` / `JT808_PORT` / `AIS140_PORT` | gateway | Device TCP listeners (0 disables) | 5023 / 5027 / 6808 / 5030 | Yes |
| `MEDIA_PORT` / `MEDIA_PUBLIC_HOST` / `MEDIA_HTTP_PORT` / `MEDIA_MAX_STREAMS` | gateway, video | JT/T 1078 video | 7612 / `track.mintplus.co.in` / 4110 / 8 | If video |
| `ATTACH_PORT` | gateway | ADAS/DMS attachment server | 7613 | If dashcams |
| `GATEWAY_ID` / `GATEWAY_CAPTURE` | gateway | Instance id / raw-frame capture (IMEIs or `all`) | `gw-<host>` / empty | Capture off in prod |
| `PROCESSOR_CONSUMER` / `RULES_ENGINE` | processor | Stream consumer name / `off` disables rules | `processor-<host>` / on | Distinct per instance |
| `POSITIONS_STREAM_MAXLEN` | gateway | `vt:positions` cap | 2,000,000 | Size for outage window |
| `NOTIFIER_CONSUMER` | notifier, webhooks, relay, driver events | Consumer name | `notifier-<host>` | Distinct per instance |
| `DRIVER_EVENT_EMAIL_WAIT_MS` | notifier | Wait for media before e-mailing | 25000 | — |
| `SUMMARIZER_INTERVAL_MS` / `SUMMARIZER_ADDRESSES_PER_RUN` | summarizer | Run cadence / geocode budget | 60000 / 60 | — |
| `WEB_URL` | api (links in mails, share URLs) | Public web origin | `http://localhost:5173` | **Yes** |
| `CORS_ORIGINS` | api, socket gateway | Comma list; empty = no cross-origin | empty | **Yes** |
| `OTP_DEV_ECHO` / `MAIL_DEV_ECHO` | auth | Return OTP / reset link in API response | false | **Must be false** (currently false on PC) |
| `SMTP_URL` / `MAIL_FROM` / `MAIL_REPLY_TO` | mailer | SMTP delivery | none (files only) / `no-reply@veetracer.local` | **Yes** (unset on PC) |
| `ZOHO_MAIL_KEY` / `ZOHO_MAIL_URL` | mailer | Zoho CPaaS mail (wins over SMTP) | none / `https://cpaas.zoho.in` | Alt. to SMTP |
| `SMS_PROVIDER` | notifier/auth | `smartping` / `msg91` (stub) / `console` | `console` | **Yes** |
| `SMARTPING_USERNAME` / `SMARTPING_PASSWORD` / `SMARTPING_SENDER` / `SMARTPING_ENTITY_ID` / `SMARTPING_URL` | sms.ts | DLT SMS | — | If smartping |
| `MSG91_AUTH_KEY` | sms.ts | Not implemented (throws) | — | No |
| `PUSH_PROVIDER` / `EXPO_ACCESS_TOKEN` | push.ts | Expo push | `expo` / none | Token recommended |
| `GEOCODER` / `GEOCODER_URL` | geocoding | `none` / `nominatim` / `photon` | `none` / — | Self-hosted in prod |
| `ROUTER_ENGINE` / `ROUTER_URL` | routing, point-quality | Valhalla/OSRM | `valhalla` / empty | Optional |
| `ESRI_BASEMAP_KEY` | maps.controller | Satellite basemap key (exposed to clients) | none | Optional |
| `PUBLIC_API_URL` | openapi.controller | Server URL in OpenAPI | `/api` | Optional |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` / `RAZORPAY_WEBHOOK_SECRET` | licences | Online payments (all three or none) | none | If billing (set on PC, redacted) |
| `LICENCE_JOB` / `ATTENDANCE_JOB` / `REMINDERS` / `REPORT_SCHEDULER` / `RETENTION` / `RELAY` / `SYSTEM_MONITOR` | api crons, notifier | `on`/`off` job toggles | on | One instance for schedulers |
| `RAW_PACKET_RETENTION_DAYS` / `NOTIFICATION_LOG_RETENTION_DAYS` / `WEBHOOK_LOG_RETENTION_DAYS` | retention | Retention windows | 7 / 90 / shared const | — |
| `RELAY_MAX_TARGETS` / `RELAY_MAX_SOCKETS_PER_TARGET` / `RELAY_BUFFER_KB` / `RELAY_BUFFER_FRAMES` / `RELAY_HTTP_QUEUE` | relay guard | Forwarding limits | 20 / 5000 / 64 / 500 / 10000 | — |
| `WEBHOOK_ALLOW_PRIVATE` | url-guard | Allow private webhook targets in prod | false (but **true whenever NODE_ENV≠production**) | Keep false |
| `METRICS_TOKEN` | /api/metrics | Prometheus bearer | none | Yes if scraped |
| `SYSTEM_ALERT_EMAILS` / `SYSTEM_ALERT_COOLDOWN_MIN` / `SYSTEM_HEALTH_ROLES` / `HEALTH_DATA_DIR` / `HEALTH_*` (17 thresholds) | monitoring | System Health | see [.env.example](../../apps/api/.env.example) | Recommended |
| `DOWNLOADS_DIR` | downloads | APK directory | `<repo>/../downloads` | Optional |
| `TRACKER_REVIEW_MOBILE` / `TRACKER_REVIEW_CODE` | mobile-tracker, seed | Fixed OTP for store review | none | Unset after review |
| `PLAY_REVIEW_EMAIL` / `PLAY_REVIEW_PASSWORD` | seed | Play review account | none | Unset after review |
| `SEED_DEMO` | seed | Force/skip demo data | by `NODE_ENV` | `0` in prod |

### B.2 Web / mobile / tooling

| Name | Used by | Purpose | Default |
|---|---|---|---|
| `VITE_MAP_STYLE_LIGHT` / `_DARK` / `_STANDARD`, `VITE_MAP_FONT` | web | MapLibre styles / label font | OpenFreeMap / `Noto Sans Bold` |
| `API_TARGET`, `WEB_PORT` | vite.config (dev) | Dev proxy target / port | `http://localhost:4000` / 5173 |
| `EXPO_PUBLIC_SERVER_URL` | mobile, tracker | API origin | `https://gps.mintplus.co.in` (hardcoded fallback + eas.json) |
| `EXPO_PUBLIC_MAP_STYLE_*`, `EXPO_PUBLIC_BRAND` | mobile / tracker | Map style / brand | — |
| `GOOGLE_SERVICES_JSON` | mobile app.config.js | FCM config path (EAS secret) | — |
| `VEETRAX_SIGNING_STORE_FILE` / `VEETRAX_SIGNING_PASSWORD` | gradle (with-release-signing.js) | Android release signing | must be set in `~/.gradle/gradle.properties` |

Current PC `apps/api/.env` holds 20 keys (`DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `API_PORT`, media ports, `TELTONIKA_PORT`, `WEB_URL`, both dev-echo flags (false), `CORS_ORIGINS`, `GEOCODER(=nominatim)`, `GEOCODER_URL`, 3× Razorpay, `LICENCE_JOB`). Values are redacted. **Not set:** `NODE_ENV`, `SMTP_URL`/`ZOHO_MAIL_KEY`, `SMS_PROVIDER`, `METRICS_TOKEN`, `EXPO_ACCESS_TOKEN`.

### B.3 Secrets hygiene
- `.gitignore` ignores `.env`, `.env.*` (except `.env.example`), `var/`, `dist/`, `*.log`. `apps/mobile/.gitignore` ignores `*.jks *.p8 *.p12 *.key`. **Confirmed.**
- `git ls-files | grep -iE "env|key|secret|keystore|jks|p12|pem"` matches only source files and the two `.env.example` files. No keystores, certificates or real `.env` files are tracked. **Confirmed.**
- Tracked dev credentials: the seed's Super Admin and demo passwords ([seed.ts:193](../../apps/api/prisma/seed.ts#L193), [seed.ts:394](../../apps/api/prisma/seed.ts#L394)) are repeated in [README.md:35](../../README.md#L35) and [HANDOFF.md:40](../HANDOFF.md#L40). [HANDOFF.md:125](../HANDOFF.md#L125) records a production server's public IP and notes that its Administrator password "was shared in chat". The password itself is not in the repo. **Low, Confirmed.**
- `apps/mobile/.claude/settings.json` and `.vscode/*` are tracked (tooling noise). **Low.**

---

## C) Security analysis

### C.1 Deployment / configuration

**C-1 High (Confirmed): the public instance runs without `NODE_ENV=production`.** `assertProductionSafe` runs only when
`NODE_ENV === 'production'` ([env.ts:70](../../apps/api/src/config/env.ts#L70)), and the PM2 config sets no env ([ecosystem.config.cjs:14](../../ops/run/ecosystem.config.cjs#L14)). The `.env` does not set it either. Consequences:
- The webhook/relay SSRF policy becomes `allowPrivate = !production`, i.e. **true** ([url-guard.ts:61](../../apps/api/src/webhooks/url-guard.ts#L61)). Any company admin with Developer API access can then register webhook URLs aimed at `localhost`/LAN addresses: the gateway's HTTP-FLV server on :4110, the Windows host, router admin pages and so on. (Valkey drops HTTP-looking commands, which limits the Redis impact.)
- The dev-echo flags and the `change-me` JWT secret are no longer blocked at boot (today the flags happen to be false).
- A re-run of `db:seed` would create the demo companies and users with the published passwords ([seed.ts:332-336](../../apps/api/prisma/seed.ts#L332)).
Fix: put `env: { NODE_ENV: 'production' }` in every PM2 app (or in `.env`), and have `loadEnv()` refuse to start when `WEB_URL` is non-localhost and `NODE_ENV` is unset.

**C-2 High (Confirmed): the seed always provisions a Super Admin with a published password.** [seed.ts:188-195](../../apps/api/prisma/seed.ts#L188) creates `admin@veetracer.local` (mobile `+919999900000`) with the README password on any fresh database, production included. Only the *demo* data is skipped in production. `upsertUser` also forces `isActive: true` on re-run ([seed.ts:153-157](../../apps/api/prisma/seed.ts#L153)), which re-enables a deliberately disabled admin. Fix: in production, take the Super Admin credentials from env or require a one-time setup token, and never reactivate.

**C-3 High (Confirmed): OTPs and reset links end up in logs and files.**
- The default SMS provider is `console` ([sms.ts:103](../../apps/api/src/notifier/sms.ts#L103)). It logs the full SMS text, OTP code included, to stdout (PM2 logs) and appends it to `var/sms/sms.log` ([sms.ts:31-35](../../apps/api/src/notifier/sms.ts#L31)). The live `.env` sets no provider.
- `MailerService.send` **always** writes the HTML body to `var/mail/*.html`, even when SMTP or Zoho is configured ([mailer.service.ts:49](../../apps/api/src/auth/mailer.service.ts#L49)). That includes password-reset links (30-min tokens), tracker activation codes, signup codes and scheduled reports with attachments. No retention job covers `var/mail` or `var/sms`.
- Addresses and mobiles are logged on many paths ([auth.service.ts:186](../../apps/api/src/auth/auth.service.ts#L186), [family.service.ts:100](../../apps/api/src/mobile-tracker/family.service.ts#L100), [signup.service.ts:123](../../apps/api/src/signup/signup.service.ts#L123)). That is personal data in plain logs.
Fix: write disk copies only when `NODE_ENV !== 'production'` (or behind a flag), and refuse `SMS_PROVIDER=console` in production.

**C-4 Medium (Confirmed): no security headers.** No `helmet` and no CSP/HSTS/X-Frame-Options are set in [main.ts](../../apps/api/src/main.ts). The web app is served by `vite preview`, which adds none either. Because of C-5, a CSP matters more than usual.

**C-5 Medium (Confirmed): the refresh token sits in `localStorage`.** [storage.ts:34](../../apps/web/src/lib/storage.ts#L34) / [session.ts:25](../../apps/web/src/lib/session.ts#L25) store the 30-day refresh token ([token.service.ts:11](../../apps/api/src/auth/token.service.ts#L11)), so any XSS can steal it. Mobile correctly uses SecureStore ([mobile session.ts:2](../../apps/mobile/src/lib/session.ts#L2)). The innerHTML sinks reviewed escape their input ([alert-layer.ts:143](../../apps/web/src/features/live/map/layers/alert-layer.ts#L143)). `UpiPay.tsx:104` injects server-generated SVG through `dangerouslySetInnerHTML` (**Low**; the source is trusted). Consider an httpOnly SameSite cookie for refresh.

**C-6 Medium (Confirmed): the deployment depends on Cloudflare loopback trust.** `trust proxy: 'loopback'` ([main.ts:14](../../apps/api/src/main.ts#L14)) is correct for cloudflared and a local nginx. But the per-IP throttling and the audit IPs both rely on `X-Forwarded-For`, which is correct only while the API listens solely behind a loopback proxy. The API listens on all interfaces at :4000 ([main.ts:22](../../apps/api/src/main.ts#L22)), so the firewall must block 4000.

### C.2 Authentication

| Item | Status | Ref |
|---|---|---|
| JWT | HS256 via `@nestjs/jwt`, 15-min access token, secret ≥32 chars enforced | [token.service.ts:10](../../apps/api/src/auth/token.service.ts#L10), [env.ts:46-47](../../apps/api/src/config/env.ts#L46) |
| Session binding | Every request re-checks the session row (revoked/expired) and the user/company status. Good, but 2–4 DB queries per request (D-2) | [auth-context.service.ts:34-56](../../apps/api/src/access/auth-context.service.ts#L34) |
| Refresh rotation | Hashed at rest (sha256 of 48 random bytes), rotated with compare-and-swap. **No reuse detection:** replaying an old token simply fails and the session family is not revoked. **Low** | [token.service.ts:47-63](../../apps/api/src/auth/token.service.ts#L47) |
| bcrypt | bcryptjs cost 12. Password policy: ≥8 characters, a letter and a digit | [secrets.ts:4-7](../../apps/api/src/common/secrets.ts#L4) |
| Reset tokens | 32 random bytes, sha256 at rest, 30 min, single use, revokes all sessions. Earlier unused tokens stay valid until they expire. **Low** | [auth.service.ts:125-160](../../apps/api/src/auth/auth.service.ts#L125) |
| OTP | 6 digits from `crypto.randomInt`, HMAC at rest, 5-min TTL, 5 attempts per code, 30 s resend gap | [auth.service.ts:26-111](../../apps/api/src/auth/auth.service.ts#L26) |

- **C-7 Medium (Confirmed): lockout DoS.** The login failure counter is keyed only on the e-mail address ([auth.service.ts:53-62](../../apps/api/src/auth/auth.service.ts#L53)). Five bad attempts from anywhere lock the real user out for 15 minutes. Key it on email+IP, or add a CAPTCHA/backoff.
- **C-8 Low (Confirmed): user enumeration by timing.** For unknown e-mails the bcrypt compare is skipped ([auth.service.ts:60](../../apps/api/src/auth/auth.service.ts#L60)), so the response is about 200 ms faster. Compare against a dummy hash instead.
- **C-9 Medium (Confirmed): OTP abuse and SMS pumping.** A new code can be requested every 30 s with no per-day cap per mobile ([auth.service.ts:74-77](../../apps/api/src/auth/auth.service.ts#L74)). Each code allows 5 guesses, so one IP can try about 10 codes per minute. Besides brute force, this costs real SMS money once Smartping is live. Add per-mobile hourly/daily caps and a global SMS budget.
- **C-10 Low (Confirmed): key reuse.** `JWT_SECRET` is also the OTP HMAC key ([auth.service.ts:227](../../apps/api/src/auth/auth.service.ts#L227)), the video/media token key and the tracker install-id HMAC key. The last one falls back to the literal `'veetrax'` if the variable is unset ([mobile-tracker.service.ts:42](../../apps/api/src/mobile-tracker/mobile-tracker.service.ts#L42)). Rotating the JWT secret therefore invalidates outstanding OTPs and install hashes. Derive separate keys with HKDF.
- **C-11 Low (Confirmed): tracker and signup activation codes are stored in plain text** (`code` column, [mobile-tracker.service.ts:153](../../apps/api/src/mobile-tracker/mobile-tracker.service.ts#L153)), unlike login OTPs.
- **C-12 Low (Confirmed): store-review bypass.** `TRACKER_REVIEW_MOBILE` + `TRACKER_REVIEW_CODE` give a fixed OTP ([mobile-tracker.service.ts:98-102](../../apps/api/src/mobile-tracker/mobile-tracker.service.ts#L98)). It is scoped to one number and off unless both are set, but nothing reminds anyone to unset them.
- **C-13 Medium (Inferred): throttler misconfiguration.** `ThrottlerModule` is `@Global`, and `forRoot` is called in four modules with different defaults ([auth.module.ts:10](../../apps/api/src/auth/auth.module.ts#L10) 20/min, guide 30, signup 30, mobile-tracker 60). Only one options provider wins, so the module-level defaults are not what they appear to be. Per-route `@Throttle` overrides still apply. Storage is in-memory per process, so limits are not shared across API instances. Configure one root `ThrottlerModule` backed by Valkey storage.

### C.3 Authorization / tenant isolation
- Global guards `JwtAuthGuard` + `PermissionGuard` (APP_GUARD, [access.module.ts:13-14](../../apps/api/src/access/access.module.ts#L13)) deny by default unless a route has `@Public()`. `X-Company-Id` is honoured only for the Super Admin ([auth-context.service.ts:58-65](../../apps/api/src/access/auth-context.service.ts#L58)). API keys (`vtx_`) are refused on app routes ([auth.guard.ts:24](../../apps/api/src/access/auth.guard.ts#L24)). **Confirmed, good.**
- 376 route handlers. Most declare `@RequirePermission`. About 37 rely on **imperative checks in services** (`if (!ctx.isSuperAdmin) throw …`): vehicle-shares ([vehicle-shares.service.ts:40](../../apps/api/src/vehicle-shares/vehicle-shares.service.ts#L40)), transfer ([transfer.service.ts:145](../../apps/api/src/transfer/transfer.service.ts#L145)), purge ([purge.service.ts:118](../../apps/api/src/purge/purge.service.ts#L118)), point-quality ([point-quality.service.ts:57](../../apps/api/src/point-quality/point-quality.service.ts#L57)). All sampled ones are correct, but the pattern is fragile: a new handler that forgets the call is open to any signed-in user. **Medium (Confirmed, pattern risk).** Add a declarative `@SuperAdminOnly()` guard.
- IDOR sampling: unscoped `findUnique({ where: { id } })` appears 14 times. Every sampled case either re-checks scope (`live-share.revoke` → `this.object(ctx, row.objectId)` [live-share.service.ts:100](../../apps/api/src/live-share/live-share.service.ts#L100); templates [templates.service.ts:421](../../apps/api/src/templates/templates.service.ts#L421)) or is Super-Admin-only (admin-devices, device-models, partners, relay, purge). About 150 queries scope by `companyId: ctx.companyId`. **No IDOR found in the sample (Inferred for the rest).**
- **Super-Admin DB-down fallback** ([system-health.controller.ts:32-44](../../apps/api/src/monitoring/system-health.controller.ts#L32)): when PostgreSQL is unreachable, the `sa` claim of a valid JWT is accepted without the session check, so a revoked SA session keeps health access for up to 15 minutes. **Low, by design.**
- `GET /api/geocode/search|reverse` is open to any signed-in user ([history.controller.ts:112-123](../../apps/api/src/history/history.controller.ts#L112)) and proxies to the configured geocoder (C-14).

### C.4 Input validation & injection
- Global `ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true })` ([main.ts:19](../../apps/api/src/main.ts#L19)). **Confirmed, good.** Some handlers take raw `@Query('q') q: string` without a DTO (e.g. geocode search, which truncates the input to 120 characters).
- Raw SQL: `$queryRawUnsafe`/`$executeRawUnsafe` appear in purge ([purge.service.ts:40,86](../../apps/api/src/purge/purge.service.ts#L40)) and transfer ([transfer.service.ts:62](../../apps/api/src/transfer/transfer.service.ts#L62)). The interpolated ids are UUID-validated ([purge-plan.ts:41-43](../../apps/api/src/purge/purge-plan.ts#L41)), identifiers come from the schema catalogue and are quoted, and transfer uses `$1` parameters. Every other raw query uses tagged `$queryRaw` templates. **Low, no injection found (Confirmed).**
- Uploads use multer memory storage with size caps (documents 10 MB, expenses 10 MB, selfie 8 MB, video 30 MB, POI/geofence 5 MB). The type comes from the **client-declared** mimetype, checked against an allow-list, with no magic-byte check ([documents.service.ts:241](../../apps/api/src/documents/documents.service.ts#L241), [expenses.service.ts:123](../../apps/api/src/expenses/expenses.service.ts#L123)). Files are stored under `var/<kind>/<companyId>/<id>-<uuid>.<ext>`, so client filenames cannot cause path traversal. **Low.**
- `sharp` processes phone selfies without `limitInputPixels`, falling back to the default of about 268 MP ([selfie-stamp.ts:25](../../apps/api/src/attendance/selfie-stamp.ts#L25)). A decompression-bomb JPEG could cost seconds of CPU and hundreds of MB. **Low.** Tesseract runs only in the browser (`apps/web` expenses), not on the server.

### C.5 Outbound requests (SSRF)
- Webhooks: https only in production, credentials in URLs rejected, a broad private-range block-list, and a connect-time `guardedLookup` against DNS rebinding ([url-guard.ts:93-107](../../apps/api/src/webhooks/url-guard.ts#L93)). **Good, but only when `NODE_ENV=production`** (C-1).
- Relay (Super Admin only): the TCP target DNS is checked when the target is created ([guard.ts:83-94](../../apps/api/src/relay/guard.ts#L83)). Nothing re-checks at connect time for RAW_TCP, so a rebinding window exists. **Low.**
- **C-14 Medium (Confirmed): the live PC uses public `nominatim.openstreetmap.org`** (`GEOCODER=nominatim`). The summarizer and any signed-in user drive requests to it. OSM policy allows ≤1 req/s with no heavy use, and every reverse lookup sends vehicle coordinates to a third party (location privacy).

### C.6 Realtime / public links / media
- Socket.IO `/live`: a handshake JWT is required, plus the `live_map` or `alerts` permission ([live.gateway.ts:63-77](../../apps/api/src/live/live.gateway.ts#L63)). CORS = `CORS_ORIGINS`.
  **C-15 Medium (Confirmed):** the 60-second re-check calls `forUser()` and **not** `fromToken()`, so a revoked session or a logout keeps the socket streaming live positions until it disconnects ([live.gateway.ts:257](../../apps/api/src/live/live.gateway.ts#L257)). The access token's 15-minute expiry is never enforced on an open socket either. Store the `sid` on the client and check the session row in `refreshAll`.
- Public live-share: 24 random bytes (192-bit, base64url), sha256 at rest, expiry ≤ `LIVE_SHARE_MAX_HOURS`, revocable, throttled to 40/min ([live-share.service.ts:81](../../apps/api/src/live-share/live-share.service.ts#L81), [live-share.controller.ts:55](../../apps/api/src/live-share/live-share.controller.ts#L55)). **Good.**
- Media/video are `@Public` but need signed short-lived tokens: video tokens are HMAC'd with `JWT_SECRET` ([video.controller.ts:81-88](../../apps/api/src/video/video.controller.ts#L81)), driver media uses a token query ([driver-events.controller.ts:44](../../apps/api/src/driver-events/driver-events.controller.ts#L44)). Tokens in URLs can leak through Referer and logs. **Low.**
- `/api/metrics`: either `METRICS_TOKEN` (non-constant-time `!==` compare, **Low**) or a Super Admin JWT ([system-health.controller.ts:130](../../apps/api/src/monitoring/system-health.controller.ts#L130)).

### C.7 Device TCP gateway
- Limits: `maxConnections = 20,000` ([tcp-server.ts:135](../../apps/api/src/gateway/tcp-server.ts#L135)), a 2-minute login timeout and a 10-minute idle timeout ([tcp-server.ts:12-14](../../apps/api/src/gateway/tcp-server.ts#L12)). The partial-frame buffer is discarded beyond `maxFrameBytes` ([tcp-server.ts:225](../../apps/api/src/gateway/tcp-server.ts#L225)), decode errors are isolated per frame, and unparsed-frame logging is rate-limited and size-capped ([unparsed-log.ts:5-8](../../apps/api/src/gateway/unparsed-log.ts#L5)). **Good.**
- **C-16 Medium (Inferred):** there is no per-IP connection cap or accept-rate limit. A single host can hold 20k sockets (each with a 2-minute login window) and starve real devices.
- **C-17 Medium (Inferred, protocol-inherent):** GT06, Teltonika and AIS-140 have no device authentication. Anyone who knows or guesses an IMEI can inject positions or alarms, which can trigger SOS/geofence alerts and webhooks. Unknown IMEIs are accepted and recorded ([teltonika/decoder.ts:190](../../apps/api/src/gateway/teltonika/decoder.ts#L190)), which also lets unknown-device rows grow. Mitigations: source-IP plausibility checks, a pre-registration requirement in production, anomaly detection.

---

## D) Performance analysis

**Hot path (Confirmed):** gateway → `XADD vt:positions` (gated ACKs) → processor batch `INSERT INTO "Position"` ([position-writer.ts:94](../../apps/api/src/processor/position-writer.ts#L94)) + rules → `PUBLISH` live → API socket fan-out batched every 1 s ([live.gateway.ts:17](../../apps/api/src/live/live.gateway.ts#L17)). Measured on a dev Mac: about 11k positions/s end to end ([MONITORING.md §8](../MONITORING.md)). The design is sound.

| # | Sev | Finding | Ref |
|---|---|---|---|
| D-1 | Medium (Confirmed) | `Position` is a plain table (hypertable only if TimescaleDB is installed; the WSL Postgres 18 install is not confirmed to have it). The PK is `(deviceId, fixTime)` with an index on `(objectId, fixTime desc)`. Retention deletes in batches with `DELETE … IN (SELECT … JOIN TrackedObject)` per company. At fleet scale (1k devices × 10 s ≈ 8.6 M rows/day) this causes bloat and vacuum pressure. Use native monthly partitions (or Timescale) and drop old partitions | [schema.prisma:545-562](../../apps/api/prisma/schema.prisma#L545), [retention.service.ts:112](../../apps/api/src/retention/retention.service.ts#L112) |
| D-2 | Medium (Confirmed) | Each authenticated HTTP request runs a session lookup, a user lookup with roles→permissions, branches and objects, and for company scope a `vehicleShare` query. That is 2–4 queries before the handler starts, with no cache. Cache the resolved context in Valkey for about 30 s, invalidated by `cacheInvalidate` | [auth-context.service.ts:35-92](../../apps/api/src/access/auth-context.service.ts#L35) |
| D-3 | Medium (Confirmed) | Socket scope refresh every 60 s re-resolves each socket **sequentially**: `forUser` plus allowed/locked object queries. 1,000 sockets mean 3,000+ queries per minute in one loop | [live.gateway.ts:252-260](../../apps/api/src/live/live.gateway.ts#L252) |
| D-4 | Medium (Inferred) | Reports are built entirely in memory in the **API process**: up to 50k rows for XLSX/CSV and 5k for PDF, rendered with exceljs/pdfmake `getBuffer()`. PDF layout is CPU-bound and blocks the event loop that also serves sockets. Move rendering to a worker or the notifier, and use the exceljs streaming `WorkbookWriter` | [report-files.ts:12](../../apps/api/src/reports/report-files.ts#L12) |
| D-5 | Medium (Confirmed) | The web `i18n` chunk is about 762 KB minified because all languages (`hi.ts` and `ta.ts`, 3,411 lines each) load eagerly. Other large chunks: maplibre-gl 1.03 MB (lazy, OK), jspdf 341 KB, mpegts 272 KB, html2canvas 199 KB. Lazy-load language resources per selected language | [apps/web/dist/assets](../../apps/web/vite.config.ts#L27), [lib/i18n.ts:1](../../apps/web/src/lib/i18n.ts#L1) |
| D-6 | Low (Confirmed) | API `compression()` gzips the live snapshot (about 6 MB at 10k objects). Fine, but costs CPU on the same process. Prefer brotli at the reverse proxy | [main.ts:16](../../apps/api/src/main.ts#L16) |
| D-7 | Low (Inferred) | Each of the 5–6 Node processes opens its own default Prisma pool (num_cpus×2+1), which can exceed `max_connections` on a small server. Set `connection_limit` per role | [prisma.service.ts](../../apps/api/src/prisma/prisma.service.ts) |
| D-8 | Low (Confirmed) | All uploaded media live on the local disk (`var/*`), so a second API instance cannot serve them and backups miss them (A.4/E). Move them to object storage (S3/MinIO) | [documents.service.ts:32](../../apps/api/src/documents/documents.service.ts#L32) |
| D-9 | Low (Confirmed) | The public geocoder at ≤1 req/s throttles address fill (`SUMMARIZER_ADDRESSES_PER_RUN` = 60/min) | [address-filler.ts](../../apps/api/src/summarizer/address-filler.ts) |
| D-10 | Low (Confirmed) | `MailerService` is provided separately in about 5 modules, each creating its own transports | [auth.module.ts:12](../../apps/api/src/auth/auth.module.ts#L12) |

The API process also hosts 23 cron/interval jobs (retention, licences, attendance, reminders, report scheduler, system monitor). Env toggles let you run them on a single instance. **Recommendation:** run them in a dedicated "jobs" role rather than in every API replica.

---

## E) Code quality & technical debt

**Size (tracked TS/TSX):** api 397 source files / ~60k lines · web 280 / ~40.7k · shared 38 / ~12.7k · mobile 106 / ~12.9k · tracker 33 / ~3.6k. Prisma schema: 2,002 lines, 51 migrations.

**25 largest source files (lines):**

| Lines | File | Lines | File |
|---|---|---|---|
| 3411 | [shared/i18n/ta.ts](../../packages/shared/src/i18n/ta.ts) | 651 | [mobile reports/report-defs.ts](../../apps/mobile/src/features/reports/report-defs.ts) |
| 3411 | [shared/i18n/hi.ts](../../packages/shared/src/i18n/hi.ts) | 642 | [prisma/seed.ts](../../apps/api/prisma/seed.ts) |
| 1104 | [web AttendancePage.tsx](../../apps/web/src/features/attendance/AttendancePage.tsx) | 637 | [web live/map/map-controller.ts](../../apps/web/src/features/live/map/map-controller.ts) |
| 907 | [api processor/rules/evaluate.ts](../../apps/api/src/processor/rules/evaluate.ts) | 623 | [web alerting/panels.tsx](../../apps/web/src/features/alerting/panels.tsx) |
| 787 | [api gateway/gt06/codec.ts](../../apps/api/src/gateway/gt06/codec.ts) | 602 | [api reports/report-columns.ts](../../apps/api/src/reports/report-columns.ts) |
| 770 | [shared/licences.ts](../../packages/shared/src/licences.ts) | 585 | [api processor/position-processor.ts](../../apps/api/src/processor/position-processor.ts) |
| 758 | [web reports/report-columns.tsx](../../apps/web/src/features/reports/report-columns.tsx) | 584 | [api reports/report-queries.ts](../../apps/api/src/reports/report-queries.ts) |
| 731 | [api attendance/attendance.service.ts](../../apps/api/src/attendance/attendance.service.ts) | 552 | [api summarizer/summarizer.ts](../../apps/api/src/summarizer/summarizer.ts) |
| 724 | [web history/HistoryPage.tsx](../../apps/web/src/features/history/HistoryPage.tsx) | 551 | [web geofences/draw/geofence-draw.ts](../../apps/web/src/features/geofences/draw/geofence-draw.ts) |
| 703 | [api mobile-tracker.service.ts](../../apps/api/src/mobile-tracker/mobile-tracker.service.ts) | 547 | [shared/alerts.ts](../../packages/shared/src/alerts.ts) |
| 693 | [web masters/MasterPage.tsx](../../apps/web/src/features/masters/MasterPage.tsx) | 522 | [api smart-search.service.ts](../../apps/api/src/smart-search/smart-search.service.ts) |
| 660 | [web history/history-map.ts](../../apps/web/src/features/history/history-map.ts) | 519 | [web alerts/AlertsPage.tsx](../../apps/web/src/features/alerts/AlertsPage.tsx) |
| 658 | [web SystemHealthPage.tsx](../../apps/web/src/features/platform/SystemHealthPage.tsx) | | |

Files are moderately sized overall; no god-files above about 1.1k lines except the generated i18n dictionaries.

| # | Sev | Finding | Ref |
|---|---|---|---|
| E-1 | Medium (Confirmed) | **Report column definitions exist three times:** api `report-columns.ts` (602), web `report-columns.tsx` (758) and mobile `report-defs.ts` (651). All three import the same shared types but re-declare columns and labels, so a report change needs three edits. `lib/format.ts` and `geo.ts` are also duplicated between web and mobile (66 diff lines in format.ts). Move column metadata and formatters into `packages/shared` | see links |
| E-2 | Medium (Confirmed) | Authorization is split between declarative decorators and ad-hoc `isSuperAdmin` checks in services (C.3) | — |
| E-3 | Medium (Confirmed) | Outdated docs. [HANDOFF.md](../HANDOFF.md) still describes **Flutter** apps (lines 17, 59, 140) while the repo ships Expo RN. It uses the "VeeTracer" brand (8 hits each in README/HANDOFF) while the product is VeeTrax, and package scopes are still `@veetracer/*`. It lists "no `/api/geocode/search`" (line 130), but that endpoint exists, and "SMS console-only", but Smartping exists. README says "mobile apps (later milestones)" and links a misnamed PDF | [README.md:3-6](../../README.md#L3) |
| E-4 | Medium (Confirmed) | Dependency drift: NestJS 11 vs 12 latest, Prisma 6.19 vs 7.x, maplibre-gl 5 vs 6, react-router 7 vs 8, zod 3 vs 4, TypeScript 5.9/6.0 vs 7. **jspdf 2.5.2** is behind the 3.x line, which fixed published DoS/ReDoS advisories; upgrade. tesseract.js 5 vs 7. Expo 58 patch updates are pending. `npm audit` was not run (read-only constraint) | `npm outdated` |
| E-5 | Low (Confirmed) | Only 2 TODO/FIXME/HACK markers in the whole codebase, both about Razorpay refunds ([credit-notes.service.ts:130](../../apps/api/src/licences/credit-notes.service.ts#L130)). The MSG91 provider is a stub that always throws ([sms.ts:46-51](../../apps/api/src/notifier/sms.ts#L46)), so it is dead code unless implemented | — |
| E-6 | Low (Confirmed) | Env access is inconsistent. Core settings go through typed `loadEnv()`, but about 50 variables are read ad hoc via `process.env` in services: unvalidated, undocumented in `.env.example`, and sometimes with silent fallbacks (e.g. `'veetrax'` HMAC key). Centralise and validate them with a schema (zod/class-validator) at boot | [mobile-tracker.service.ts:42](../../apps/api/src/mobile-tracker/mobile-tracker.service.ts#L42) |
| E-7 | Low (Confirmed) | Error handling: the global filter hides stack traces and maps Prisma errors ([http-exception.filter.ts](../../apps/api/src/common/http-exception.filter.ts)). Good. Fire-and-forget `.catch(log)` on mail/SMS is used consistently. Nothing reports uncaught errors (no Sentry or similar); only logs | — |
| E-8 | Low (Confirmed) | Deployment config (`ops/run`) is untracked, and the backup scripts target a different host layout | A.4 |
| E-9 | Low (Confirmed) | Generated i18n dictionaries are hand-maintained through `scripts/i18n-extract.mjs`/`i18n-merge.mjs`. `scripts/i18n-missing.json` is a committed work file | [scripts/](../../scripts/i18n-extract.mjs) |

Overall, code quality is **good**: consistent NestJS module layout, typed shared DTOs, thorough comments explaining intent, defensive gateway code and carefully built SSRF/token primitives. The debt is mostly operational (config, docs, deployment), not structural.

---

## F) Test coverage

| Workspace | Test files | Test cases (approx.) | Runner | Notes |
|---|---|---|---|---|
| `apps/api` | **97** `*.spec.ts` | **~834** `it/test` | Jest + ts-jest ([package.json:69](../../apps/api/package.json#L69)), `test-env.ts` sets dummy env vars | All unit tests with mocked Prisma/Redis. No DB/Redis integration tests and no `Test.createTestingModule` e2e |
| `apps/web` | **21** `*.test.ts` | **~96** | `node --test` | Pure helpers: geo, format, playback core, geofence geometry/import, alert inheritance, health formatting. No component or E2E tests |
| `packages/shared` | 0 | 0 | — | 12.7k lines of permissions, licences and alert logic, exercised only indirectly through API specs |
| `apps/mobile` | 0 | 0 | — | — |
| `apps/tracker` | 0 | 0 | — | Background location/upload logic untested |

API specs per module: gateway 16 (GT06/Teltonika/JT808/AIS-140/JT1078 codecs, real-device frames, tcp-server), reports 9, processor 7, licences 7, alerts 5, tracking 4, point-quality 3, notifier 3, and 1–2 each for webhooks, relay, purge, mobile-tracker, developer (API keys, guard), auth (me-profile, zoho-mail), access-rules, documents, attendance, signup, retention, monitoring, and others.

**Gaps (Medium, Confirmed):**
- **No spec in 14 API modules:** `audit`, `common`, `config`, `dashboard`, `drivers`, `live` (socket fan-out/scope), `live-share` (public token path), `maps`, `masters` (all CRUD incl. users/roles/devices), `parking`, `prisma`, `redis`, `simulator`, `transfer`.
- **Untested security-critical paths:** the `AuthService` login lockout and OTP flow, `TokenService` rotation, `AuthContextService` tenant resolution (`X-Company-Id`), `JwtAuthGuard`/`PermissionGuard` wiring, and the live socket handshake. `access-rules.spec.ts` tests only the permission maths.
- No tenant-isolation test suite (e.g. "user of company A cannot GET company B's object/:id" across all `:id` routes).
- No CI (`.github/` absent), so tests and type checks run only when someone runs them by hand. No coverage reporting.
- No load test in CI. The simulator exists (`npm run sim`) and MONITORING §8 records manual measurements.

**Recommendation:** add a Postgres+Valkey-backed e2e harness (testcontainers or docker compose). Seed two tenants and assert isolation on every `:id` route. Unit-test the auth services. Add a GitHub Actions workflow running `tsc`, `jest`, `node --test` and `vite build`.
