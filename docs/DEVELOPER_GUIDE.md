# VeeTrax Developer Guide

How the code is organised, how to run it, the conventions to follow, and where to look when something goes wrong. Read sections 1–4 once; use section 6 (Debugging playbook) when you have a problem, section 7 for Git, and section 9 for deploying on any server.

## 1. The system in one page

| Part | Folder | What it does |
|---|---|---|
| Server (API + workers) | `apps/api` | NestJS API, device gateway, processor, notifier, summarizer. One code base, five processes. |
| Web app | `apps/web` | React single-page app (app.veetrax.com). |
| VeeTrax app | `apps/mobile` | React Native (Expo) app for owners and managers, Android and iPhone. |
| VeeTrax Tracker app | `apps/tracker` | React Native (Expo) app that turns an Android phone into a tracker. |
| Shared package | `packages/shared` | Types, business rules and translations used by all of the above. **Build it after every change** (`npm run build:shared`). |

How data moves (details in section 5):

1. A device sends a packet → **gateway** decodes it → position added to the Redis stream `vt:positions`.
2. **Processor** reads the stream → filters, status, sensors, alert rules → writes `Position`, updates live state `vt:live:<objectId>`, publishes `vt:live:updates` and `vt:alerts`.
3. **API** pushes live updates to browsers and apps over Socket.IO; serves REST under `/api`.
4. **Notifier** reads `vt:notify` → push / e-mail / SMS → writes `NotificationLog`.
5. **Summarizer** builds `Trip`, `Stop`, `DailySummary`, `AttendanceDay` from positions; rebuilds days listed in `SummaryDirtyDay`.

## 2. Repository map

### 2.1 Server modules (`apps/api/src`)

| Module | Look here for |
|---|---|
| `gateway/` | TCP servers and protocol decoders: `gt06/`, `teltonika/`, `jt808/`, `ais140/`, `jt1078/` (video), `relay/` (data forwarding). `main.ts` starts the gateway process. |
| `processor/` | `position-processor.ts` (the pipeline), `position-writer.ts` (batched DB writes), `rules/` (alert rules engine), `parked-thinning.ts` (phone points while parked). `main.ts` starts the process. |
| `tracking/` | `position-filter.ts`: jump, drift, rough-fix and clock checks. The first place to look for "wrong / jumping locations". |
| `notifier/` | `notifier.service.ts` (delivery), `push.ts` (Expo push), `sms.ts` (SMS provider), `arattai.ts` (Arattai Business: verification codes via the authentication template, alerts via the transactional template; OAuth refresh token), templates. Channels the Super Admin switched off in Platform Settings → Messaging (`MessagingSettings`: SMS, e-mail, WhatsApp, Arattai) are logged as SKIPPED. Customers see only switched-on channels (`GET /messaging/channels`; WhatsApp hidden for now); Push is on by default for every severity. Verification codes go by SMS + e-mail + Arattai (when on). Settings API and the Connect / callback flow: `templates/arattai-settings.controller.ts`. |
| `summarizer/` | Trips, stops, daily summaries (`summarizer.ts`, `segmenter.ts`), `outlier-flagger.ts`, time zones (`tz.ts`). |
| `attendance/` | Staff attendance rules and the attendance job. |
| `alerts/` | Alert settings, recipients, snoozes, offline alerts, acknowledgement. |
| `io-sensors/` | AC / door sensors (`io-logic.ts`). |
| `fuel/` | Fuel sensor calibration and refuel / drain events. |
| `mobile-tracker/` | Tracker app API: activation, uploads (`roughSpikes` filter), sessions, phone health. |
| `live/` | Live snapshot and the Socket.IO gateway (`live.gateway.ts`). |
| `history/`, `point-quality/` | History replay; "All points" analysis; Super Admin remove / restore point. |
| `reports/`, `report-schedules/` | Report queries and scheduled e-mail reports. |
| `masters/` | Companies, branches, users, roles, devices, objects, geofences, groups, audit log. |
| `access/` | Permissions, data scope and company scoping (`access-rules.ts`). Every query on business data must go through these rules. |
| `auth/` | Sign-in, OTP, JWT, sessions. |
| `licences/` | Licences, invoices, UPI / cash payments, pricing. |
| `stock/` | Purchases & sales (menu renamed from "Stock & sales"; platform + resellers only): items, suppliers, stores, one document type for PO → goods received → return to supplier, customer order → sale → customer return, adjustments; IMEI / SIM serials; sales invoices and credit notes; the inventory dashboard. Rules without the database in `stock-logic.ts` (moves per document, availability checks, PO progress); `stock.service.ts` saves a document and rewrites its stock moves in one transaction, refuses IMEIs not in that store, and refuses undoing goods that later documents used. Received trackers are created in Device Inventory and follow their IMEI (sold to a customer company → assigned to it; returned → back to stock) through `AdminDevicesService`. Invoices: `stock-invoices.service.ts` (platform owner details, own series `stockInvoicePrefix` / `stockCreditNotePrefix`, per-line HSN + GST). Dashboard: `stock-dashboard.service.ts` (reorder level, quantity on order, supplier lead time, POs due). **One stock register:** trackers are also kept in Stock & movements (`inventory/`, DeviceStock + StockMovement). After every save `inventory-link.service.ts` brings each touched tracker to the matching status / location there with one movement referencing `StockDoc:<number>` (rules in `inventory-link.ts`; stores / suppliers / receipts matched or created on first use and remembered in `StockStore.inventoryLocationId`, `StockSupplier.inventorySupplierId`, `StockDoc.inventoryReceiptId`). A platform sale may use trackers that are only in Stock & movements (brought in by an automatic adjustment). `POST /stock/sync-inventory?dryRun=` checks / repairs. **Supplier payments:** `StockSupplierPayment` rows against a DONE platform RECEIPT (several per bill); `supplierBill()` in `stock-logic.ts` = supplier invoice amount (else receipt total) − DONE purchase returns with `sourceId` = that receipt − payments, due on invoice date (else receipt date) + `StockSupplier.paymentTermsDays`; shown as `StockDocDto.supplierBill` and dashboard `supplierDues`; `POST /stock/docs/:id/supplier-payments` (no more than the balance), `DELETE /stock/supplier-payments/:id`; a receipt with payments cannot be cancelled or deleted. Workflow for users: `docs/inventory-modules/PURCHASES_AND_SALES_WORKFLOW.md`. Web: `apps/web/src/features/stock`. |
| `purge/` | "Delete permanently" and "Delete my account". |
| `developer/`, `public-api/`, `webhooks/` | Developer API keys, public API, signed webhooks. |
| `monitoring/` | System Health data. |
| `retention/` | Deleting old positions / raw packets per retention settings. |
| `prisma/` | Database client. Schema: `apps/api/prisma/schema.prisma`; migrations: `apps/api/prisma/migrations`. |
| `redis/keys.ts` | Every Redis key, stream and channel name in one place. |

### 2.2 Web app (`apps/web/src`)

`features/<area>/` holds each screen (live, history, dashboard, attendance, alerts, reports, masters, platform…). `components/` holds shared UI, `lib/` holds the API client (`lib/api.ts`), storage and formatting. Live map drawing is in `features/live/map/map-controller.ts`; history map in `features/history/history-map.ts`. Staff attendance Employee insights: the figures live in `packages/shared/src/attendance-insights.ts` (shared with the VeeTrax app; `features/attendance/employee-stats.ts` re-exports them, tests in `employee-stats.test.ts`) and compute the tiles, patterns and the plain-language summary (`employeeSummary`, unit-tested); `features/attendance/EmployeeCharts.tsx` draws the SVG "Hours worked each day" (within shift / overtime stacked against the shift line) and "When they worked each day" (first in to last out against the shift band) charts. Shift times come from `GET /attendance/settings` (the person's named shift, else the default); without them the charts still draw, just without the shift line. The period can be This month, Last month, Last 30 days, Last 3 months or a custom range (up to 6 months, `MAX_PERIOD_DAYS`); the calendar shows up to 93 days and the day-span chart up to 62. Each figure is compared with the previous period (`previousRange`: month to date ↔ the same dates last month) and the team (`teamFigures`, from the company timesheet, periods up to 62 days only). Patterns (`StatusSplit`, `LateByWeekday`, `TimeAway`) and the 12-month trend (`monthlyTrend` → `TrendCharts`) come from the same rows. One person's rows are fetched with `GET /attendance/timesheet?objectId=…`, which allows up to 366 days for one person (`MAX_PERSON_DAYS`; everyone stays at 62). Download: Excel (CSV) of the rows and PNG / PDF of the view through `components/page-capture.tsx`. **Basic vs advanced:** every company gets the tiles, summary, calendar, hours chart, details and CSV for This month / Last month / Last 30 days. The add-on **Advanced attendance insights** (`attendanceInsightsPlus`) adds comparisons, pattern cards, the day-span chart, the 12-month trend, Last 3 months / custom and PNG / PDF. A Super Admin switches it per company in Platform → Companies → Edit; it is stored in `Company.settings.features` (`apps/api/src/common/company-features.ts`, list in `COMPANY_FEATURES` in packages/shared) and reaches the apps as `me.company.features`; the platform company has every add-on. The API also refuses one-person timesheets over 62 days without it. VeeTrax app: Staff attendance → Employee chip lists today's staff; `apps/mobile/src/app/attendance-person.tsx` shows the same tiles, summary, calendar and hours chart, and with the add-on the comparisons, days split, late by weekday, time away and 12-month trend (periods up to 3 months; custom ranges and downloads stay on the web). To add another add-on: append it to `COMPANY_FEATURES`, add a switch to the company form and check `features.includes(...)` where it is used.

**Public help pages (no sign-in):**
- `/guide` is the getting-started guide. Its content is `GUIDE_SECTIONS` in `packages/shared/src/guide.ts`, also used for the welcome-email PDF.
- `/guide/troubleshooting` is tracker troubleshooting for Concox / Jimi devices: first checks, GPS fix, M2M SIM whitelisting, sleep mode, alerts, power, SOS / password, filters and drift fixes. Its content is `TROUBLESHOOTING_SECTIONS` in `packages/shared/src/troubleshooting.ts`, and its server lines use `DEVICE_SERVER_HOST` / `DEVICE_SERVER_PORTS`.
- Both pages render through `features/guide/GuideSections.tsx`, which gives each command box a Copy button.
- The user menu links both pages. The getting-started guide links the troubleshooting page.
- Edit the text in `packages/shared`, not in the page.

### 2.3 Mobile apps

- `apps/mobile/src/app/` – screens (Expo Router: file name = route). `src/features/` – logic per area. `modules/veetrax-alarm/` – native Kotlin SOS alarm.
- `apps/tracker/src/` – Tracker screens and state. `modules/veetrax-tracker/android/` – native Kotlin tracking engine (`Uploader.kt`, `Health.kt`, location service).

## 3. Running it locally

**Needs:** Node.js 24, PostgreSQL 16, a Redis-compatible server (Redis or Memurai), Android SDK for app builds.

1. `npm ci` at the repository root.
2. Copy `apps/api/.env.example` (or ask for a development `.env`) – at least `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`.
3. `npm run build:shared`
4. `cd apps/api && npm run db:deploy && npm run db:seed` (creates tables and the first Super Admin).
5. Start what you need, each in its own terminal: `npm run dev:api`, `npm run dev:gateway`, `npm run dev:processor`, `npm run dev:web`; notifier / summarizer: `npm run notifier:dev` / `npm run summarizer:dev -w @veetracer/api`.
6. Fake devices: `npm run sim` (simulator sends GT06 traffic to the local gateway).
7. Apps: `npm run dev:mobile` (Expo). For the Android emulator against a local server, build with `EXPO_PUBLIC_SERVER_URL=http://10.0.2.2:<port>`. The VeeTrax app uses the live server (`app.veetrax.com`) by default; the **Demo account** switch (with a short tip) on its sign-in screen moves it to the demo server (`gps.mintplus.co.in`, `EXPO_PUBLIC_DEMO_SERVER_URL`); the Tracker app has the same switch on its activation screen (native `setServerUrl`, kept through deactivation). See `apps/mobile/README.md` and `apps/tracker/README.md`.

### Important settings (`apps/api/.env`)

| Setting | Meaning |
|---|---|
| `DATABASE_URL`, `REDIS_URL` | Database and Redis connections. |
| `JWT_SECRET` | Signs access tokens. Changing it signs everyone out. |
| `GT06_PORT`, `TELTONIKA_PORT`, `JT808_PORT`, `AIS140_PORT`, `MEDIA_PORT` | Device ports (defaults 5023, 5027, 6808, 5030, 7612). |
| `GATEWAY_CAPTURE` | Comma-separated IMEIs whose raw packets are kept (`RawPacket`) – turn on to debug one device. |
| `GEOCODER`, `GEOCODER_URL` | Address lookup (Photon). |
| `ROUTER_ENGINE`, `ROUTER_URL` | Road routing / map matching (Valhalla or GraphHopper). |
| `PUSH_PROVIDER`, `EXPO_ACCESS_TOKEN` | Push notifications. |
| `SMTP_URL`, `MAIL_FROM`, `MAIL_REPLY_TO` | E-mail. |
| `SMS_PROVIDER`, `MSG91_AUTH_KEY` | SMS (the default provider only logs). |
| `OTP_DEV_ECHO`, `MAIL_DEV_ECHO` | Development: return codes / mails in the response instead of sending. |
| `RULES_ENGINE`, `REMINDERS`, `RETENTION`, `REPORT_SCHEDULER`, `ATTENDANCE_JOB`, `LICENCE_JOB`, `SYSTEM_MONITOR` | Switch individual background jobs on or off. |
| `RAW_PACKET_RETENTION_DAYS`, `NOTIFICATION_LOG_RETENTION_DAYS` | How long diagnostic rows are kept. |

## 4. Coding standards

1. **TypeScript strict everywhere.** No `any` unless unavoidable; types shared between server and clients live in `packages/shared`.
2. **Keep rules pure and tested.** Business logic sits in `*.logic.ts` / plain functions (e.g. `position-filter.ts`, `io-logic.ts`, `mobile-tracker.logic.ts`) with a `*.spec.ts` next to it. Services only load, call the logic and save.
3. **Comment the "why".** Exported functions and non-obvious rules carry a short doc comment explaining the reason (often with the real case that caused it, e.g. "seen: 2.5 km Wi-Fi spike on 6 Nov"). Don't comment what the code already says.
4. **Tenant safety.** Every query on business data is scoped by company and data scope through `access/access-rules.ts`. Never query a business table by id alone from a controller.
5. **Database changes = migrations.** Edit `schema.prisma`, create a migration (`npm run db:migrate`), commit both. Never change the live database by hand.
6. **No hard deletes in normal flows.** Permanent deletion goes through `purge/`; normal "Delete" should be reversible (soft delete is being introduced).
7. **Translations.** Every new user-facing string goes through `t('…')` and gets Hindi and Tamil entries in `packages/shared/src/i18n/hi.ts` and `ta.ts`.
8. **Redis names** only from `redis/keys.ts`.
9. **New npm packages need approval** from the product owner.
10. **Line endings**: files are CRLF (Windows); Git normalises them.
11. **Version bumps**: every app release bumps `version` and `versionCode` in `app.json`.

## 5. Testing

| What | Command | Notes |
|---|---|---|
| Server | `cd apps/api && npx jest` | ~840 tests. One file: `npx jest src/tracking/position-filter.spec.ts`. |
| Web | `cd apps/web && npm test` | Node test runner, ~95 tests. |
| Types | `npx tsc -b` (web), `npx tsc --noEmit -p .` (api, mobile, tracker) | Run before every commit. |
| Shared | rebuild with `npm run build:shared` | Server and apps use the built output. |
| Stock on a real database | Start a throwaway Postgres (`initdb` + `pg_ctl -o "-p 5499"`), `createdb veetrax_test`, `DATABASE_URL=postgresql://postgres@localhost:5499/veetrax_test npx prisma migrate deploy`, then `npx jest --testRegex 'stock\.db-test\.ts$' --runInBand` | Runs the whole purchase → sale → return → invoice flow (`src/stock/stock.db-test.ts`); never point it at the live database. |

Good practice when fixing a bug: write a test that replays the real case first (several specs replay real device data), then fix.

## 6. Debugging playbook

### 6.1 Where to look first

| Tool | Where | Use it for |
|---|---|---|
| Service logs | Server: `C:\apps\veetracer\logs` (one file per service) | Errors, start-up problems, delivery failures. |
| System Health | Web → Platform → System Health (Super Admin, `/platform/system-health`) | Stream length / consumers, each device port (listening, connections, msg/s), recent issues. |
| History → All points | Web → History, switch on All points | Every stored and raw phone point with its quality label (good, drift, spike, jump, inaccurate…). |
| Raw packets | `RawPacket` table (needs `GATEWAY_CAPTURE` for hardware; phones always) | What the device actually sent. |
| Notification log | `NotificationLog` table / alert detail in the web | Was a push / e-mail / SMS sent, to whom, and why it failed. |
| Audit log | Web → Admin → Audit Log (`/admin/audit-log`); `AuditLog` table | Who changed a setting, vehicle or user, and when. |
| Device health | Web → Devices → device → Tracker app / health | Phone permissions, battery saver, app version, last seen. |

### 6.2 Common problems

**A device is not showing on the map**
1. Is it listed under Platform → Unknown devices (Super Admin)? Then it connects but is not registered (wrong IMEI on the device record).
2. System Health → is its port listening and does the connection count rise?
3. Turn on `GATEWAY_CAPTURE` for its IMEI and check `RawPacket`: packets arriving but no positions = decoder issue (`gateway/<protocol>/`).
4. Positions in the table but not on the map: check the object is active, the device assignment is open (`DeviceAssignment.toTime` empty), and the company is ACTIVE.

**Locations jump or drift**
- History → All points shows the label of each point. Filters live in `tracking/position-filter.ts` (live) and `point-quality/analyze.ts` (analysis); phone uploads also pass `mobile-tracker/mobile-tracker.logic.ts` → `roughSpikes`.
- A wrong point can be removed by the Super Admin from History (kept for restore, day recomputed).

**Impossible speed or false overspeed (e.g. 84 km/h right after ignition on)**
- Usually a weak GPS fix (6 satellites or fewer), often the first fix after the ignition is switched on. `tracking/position-filter.ts` treats such a speed as noise when the movement since the last good point does not confirm it (`speedNoise`): live status, overspeed and the stored speed use 0, and the raw value is kept in the point's `attributes.rawSpeedKph` (`speedNoise: true`).
- Check the point in History → All points or the `Position` row: `satellites`, `valid`, and the distance to the neighbouring points.

**Trips / distance look wrong**
- Summaries are derived. Insert the object and day into `SummaryDirtyDay` (or use the tools that do it) and the summarizer rebuilds it on its next run.
- Check whether outliers are used in reports (`PointQualitySettings.useInReports`).

**An alert did not arrive**
1. Was the alert created? (`Alert` table / Alerts page). If not: alert setting off, snoozed, or rule not met (`processor/rules/`).
2. `NotificationLog` for that alert: `SENT` = accepted by the provider; `FAILED` with "Mobile app not signed in" = the recipient has no VeeTrax app signed in on any phone.
3. Recipient lists: Alert Settings → recipients.

**SOS rang without sound**
- Android: one siren everywhere – the native `AlarmService` (`modules/veetrax-alarm`) on the alarm volume, raised to maximum. With the app closed the push starts it (`AlarmMessagingService`); with the app open or after tapping the alert, the SOS screen keeps it running through `useSiren` (`features/notifications/siren.ts`) and stops it on Silence / Acknowledge / leaving the screen. Up to 0.6.7 the SOS screen swapped it for a media-volume player, which was silent when the media volume was low.
- If Android refuses to start the alarm service (Google can downgrade a push's priority), `AlarmMessagingService` posts an **insistent** notification on the `sos_insistent` channel (alarm volume, siren sound) that repeats until opened. Log tag `VeetraxAlarm` ("Alarm not started, insistent notification instead") shows when this happened (`adb logcat -s VeetraxAlarm`).
- Still silent: check battery saver / autostart (Xiaomi, Oppo, Vivo, Realme), the "SOS alarm" channel in the app's notification settings, and Do Not Disturb (More → Emergency alerts → Allow through Do Not Disturb).
- No sound because nobody received it: `NotificationLog` "Mobile app not signed in" = the recipient has no VeeTrax app signed in.
- Full-screen alarm on Android 14+ needs the user's permission (More → Emergency alerts → Allow).

**Voice alerts silent**
- VeeTrax app: speaks only while the app is open on screen (`features/notifications/voice.ts`).
- Web: the browser blocks speech until the user clicks the page once.

**Tracker app phone stops sending**
- Devices → phone health: location "always", battery optimisation, data saver, background restriction.
- `MobileTrackerSession` revoked = the number was activated on another phone.

**User sees "Object not found" / missing vehicles**
- Data scope: role is "assigned" and the vehicle is not assigned to the user (UserObject / UserBranch).
- Opening an old link of another company's vehicle after switching accounts.

**Web page shows "Something went wrong"**
- Browser console shows the real error. A build error like "Cannot access X before initialization" means a variable is used before it is declared in that component.

### 6.3 Restarting and checking services (server)

- Services: `veetracer-api`, `veetracer-gateway`, `veetracer-processor`, `veetracer-notifier`, `veetracer-summarizer`, database `veetracer-pg`, Redis `Memurai`.
- Check data is flowing: latest `Position.serverTime` should be seconds old.
- After a restart the first start can take ~90 s (antivirus scanning).

## 7. Git: repository, branches and workflow

### 7.1 Repository

| Item | Value |
|---|---|
| Code repository | `https://github.com/karthick5206/gps-app` (private) – the whole monorepo: server, web, both apps, shared package, docs |
| Production branch | `main` – what runs on the server and what app releases are built from |
| Database backups | Separate private repository `veetrax/dailydbbackup` (GitHub Releases, encrypted files only) |
| Tag | `ui-classic-2026-11-06` – the code before the enterprise redesign (also branch `backup/classic-ui`) |

### 7.2 Branches

| Branch | Purpose |
|---|---|
| `main` | Production. Every deploy is a fast-forward of `main`; never rewrite its history. |
| `feature/<name>` | New work (e.g. `feature/soft-delete`, `feature/attendance-shifts`). Branch from `main`, merge back when tested. |
| `fix/<name>` | Bug fixes that need their own branch. |
| `wip/<name>` | Experiments not ready to merge. |
| `backup/<name>` | Snapshots kept for reference (e.g. `backup/classic-ui`). |

Older feature branches that are already merged into `main` can be deleted once no one needs them.

### 7.3 Day-to-day workflow

1. `git checkout main && git pull` – start from the latest production code.
2. `git checkout -b feature/<short-name>`.
3. Commit small, focused changes. Message: first line says what changed for the user ("Live map: hide map buttons while the list is open"), then a short body with the why and any real case. Revert commits keep Git's default "Revert …" message.
4. Before pushing: type-check and run the tests (section 5).
5. `git push -u origin feature/<short-name>`.
6. When tested and approved: bring it into `main` as a fast-forward (`git push origin feature/<short-name>:main` when `main` has not moved, otherwise merge `main` into the branch first), then deploy.
7. Undo a released change with `git revert <commit>` (a new commit), never by rewriting `main`.

### 7.4 What must never be committed

- `.env` files (only `.env.example` is tracked – see `.gitignore`).
- The Android release keystore (`veetrax-release.jks`) and its passwords, the backup private key, server passwords, API keys.
- Build output (`dist/`, `android/`, `ios/` folders generated by Expo prebuild, `node_modules/`).
- Database dumps (backups go encrypted to the backup repository only).

### 7.5 How code reaches the server

The server has no access to GitHub. A deploy packs the branch as a Git bundle (`git bundle create gps-app.bundle main`), copies it to the server, and the deploy script fast-forwards `C:\apps\veetracer\app` from the bundle before building. So the server's code is always a commit you can find in GitHub: `git log -1` on the server shows which.

## 8. Build and release

| What | How |
|---|---|
| Web only | On the server: fast-forward the code, `npm run build:shared`, `npm run build -w @veetracer/web`. No restart. |
| Server | Deploy script: stop services → update code → `npm ci` → build shared / web / API → `prisma generate` → `migrate deploy` → seed → start services. |
| Android apps | `npx expo prebuild --platform android`, then `./gradlew assembleRelease` (APK) or `bundleRelease` (AAB for Play). Release key: kept offline by the owner – never commit it. |
| iPhone | EAS Build (`eas build --platform ios`). |
| Backups | Encrypted weekly full + 8-hourly diff to a private GitHub repo; restore steps in the backup key folder README. |

All deploy scripts are in `ops/deploy` (`windows/`, `linux/`, `docker/`; see `ops/deploy/README.md`), with a copy in `C:\Build\Scripts` on the owner's PC. The Windows deploy scripts are in `ops/deploy/windows` (`deploy-release.ps1` = full release, `update-web-only.ps1` = web only, `deploy-veetracer.ps1` = first install). They ask for the server password; never write it into a script.

## 9. Deploying on any server (Windows, Linux, Docker, cloud)

VeeTrax is plain Node.js + PostgreSQL + Redis, so it runs the same on Windows, Linux or containers. Only the way the processes are kept running differs.

### 9.1 What has to run

| Piece | Command (in `apps/api` after build) | Port | Notes |
|---|---|---|---|
| API | `node dist/main.js` | 4100 (`API_PORT`), local only | Behind the reverse proxy. |
| Gateway | `node dist/gateway/main.js` | 5023, 5027, 6808, 5030, 7612 (TCP, public) | Devices connect here directly – open these in the firewall. |
| Processor | `node dist/processor/main.js` | – | More than one instance may run (consumer group). |
| Notifier | `node dist/notifier/main.js` | – | |
| Summarizer | `node dist/summarizer/main.js` | – | |
| PostgreSQL 16 | – | 5432 (local only) | Database `veetracer`. |
| Redis 7 (or Memurai on Windows) | – | 6379 (local only) | `maxmemory-policy noeviction` – the position stream must never be evicted. |
| Reverse proxy (Caddy or Nginx) | – | 80, 443 (public) | Serves `apps/web/dist`, proxies `/api` and `/socket.io` to 4100, HTTPS certificates. |

Sizing: a small fleet runs on 2 vCPU / 4 GB; plan 4 vCPU / 8 GB and an SSD for a few thousand devices.

### 9.2 Steps common to every platform

1. Install Node.js 24, PostgreSQL 16, Redis 7 (Memurai on Windows) and Caddy.
2. Create the database and its user: `CREATE USER veetracer WITH PASSWORD '…'; CREATE DATABASE veetracer OWNER veetracer;`
3. Get the code: `git clone` (or copy a Git bundle and `git clone gps-app.bundle app`).
4. Create `apps/api/.env` from `apps/api/.env.example`: at least `NODE_ENV=production`, `API_PORT=4100`, `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET` (long random), `WEB_URL`, `PUBLIC_API_URL`, mail, push and geocoder settings (section 3).
5. Build: `npm ci` → `npm run build:shared` → `npm run build -w @veetracer/web` → `cd apps/api && npx prisma generate && npm run build`.
6. Database: `npx prisma migrate deploy` (every release) and `npm run db:seed` (first install creates the Super Admin; safe to repeat).
7. Start the five processes as services (9.3–9.5) and the reverse proxy.
8. Point DNS: the web / API name to the proxy, and the device name (e.g. `track.<domain>`) to the gateway's public IP.
9. Check: web sign-in works, System Health shows every port listening, a test device appears on the live map.

Reverse proxy example (Caddyfile):

| Caddyfile line | Purpose |
|---|---|
| `app.example.com {` | Site name; Caddy fetches the HTTPS certificate. |
| `  encode gzip` | Compression. |
| `  handle /api/* { reverse_proxy 127.0.0.1:4100 }` | REST API (also video streams). |
| `  handle /socket.io/* { reverse_proxy 127.0.0.1:4100 }` | Live updates (WebSockets). |
| `  handle { root * /path/to/app/apps/web/dist`, `try_files {path} /index.html`, `file_server }` | Web app with single-page fallback. |
| `}` | |

### 9.3 Windows Server (current production)

- Services are created with NSSM, one per process. Example for the API (repeat for `gateway`, `processor`, `notifier`, `summarizer` with their `dist` path):
  - `nssm install veetracer-api "C:\Program Files\nodejs\node.exe" "--max-old-space-size=256 dist\main.js"`
  - `nssm set veetracer-api AppDirectory C:\apps\veetracer\app\apps\api`
  - `nssm set veetracer-api AppStdout C:\apps\veetracer\logs\api.log` and the same for `AppStderr`
  - `nssm set veetracer-api AppRotateFiles 1` and **AppRotateOnline 0** (1 makes service stops hang)
  - `nssm set veetracer-api DependOnService veetracer-pg Memurai`
- PostgreSQL runs as its own service (`veetracer-pg`, port 5433 on the shared server); Memurai as a service.
- Firewall: add inbound TCP rules for the device ports.
- Releases: `ops/deploy/windows/deploy-release.ps1`. Before `prisma generate`, stop api / processor / notifier / summarizer (they lock the Prisma engine file); the script does this.
- First start after a rebuild can take ~90 s (antivirus scanning).

### 9.4 Linux (Ubuntu 22.04 / 24.04)

Ready-made scripts: `ops/deploy/linux/install-ubuntu.sh` does steps 1–3 and 5 (run `sudo DB_PASS=… bash install-ubuntu.sh`), `ops/deploy/linux/release.sh` does step 6, and the five unit files are in the same folder. The manual steps:

1. Packages: PostgreSQL 16 (PGDG repository), `redis-server`, `caddy`, Node.js 24 (NodeSource). In `/etc/redis/redis.conf` set `maxmemory-policy noeviction`.
2. A service user and folder: `sudo useradd -r -m -d /opt/veetrax veetrax`, code in `/opt/veetrax/app`.
3. One systemd unit per process, e.g. `/etc/systemd/system/veetrax-api.service`:

| Section | Lines |
|---|---|
| `[Unit]` | `Description=VeeTrax API` · `After=network-online.target postgresql.service redis-server.service` |
| `[Service]` | `User=veetrax` · `WorkingDirectory=/opt/veetrax/app/apps/api` · `EnvironmentFile=/opt/veetrax/app/apps/api/.env` · `ExecStart=/usr/bin/node --max-old-space-size=512 dist/main.js` · `Restart=always` · `RestartSec=5` |
| `[Install]` | `WantedBy=multi-user.target` |

   Copy it to `veetrax-gateway`, `veetrax-processor`, `veetrax-notifier`, `veetrax-summarizer`, changing `Description` and `ExecStart` (`dist/gateway/main.js` etc.). Then `sudo systemctl daemon-reload && sudo systemctl enable --now veetrax-api veetrax-gateway veetrax-processor veetrax-notifier veetrax-summarizer`.
4. Logs: `journalctl -u veetrax-processor -f`. Status: `systemctl status veetrax-*`.
5. Firewall: `sudo ufw allow 80,443/tcp` and `sudo ufw allow 5023,5027,6808,5030,7612/tcp`.
6. Release: `git pull` (or fetch the bundle) → build (9.2 step 5) → `npx prisma migrate deploy` → `sudo systemctl restart veetrax-api veetrax-gateway veetrax-processor veetrax-notifier veetrax-summarizer`. Web-only change: rebuild the web, no restart.
7. Backups: the backup scripts in `ops/backup` are PowerShell for Windows. On Linux run them with PowerShell 7 after changing the paths, or use a cron job that runs `pg_dump -Fc`, encrypts with `age -r <public key>` and uploads – keep the same weekly full + 8-hourly schedule.

### 9.5 Docker (example – test on a staging server first)

Files: `ops/deploy/docker/Dockerfile`, `docker-compose.yml`, `Caddyfile`, `.dockerignore.example` (copy to the repository root as `.dockerignore`). Start: set `DB_PASSWORD` and `SITE`, create `.env` next to the compose file, then `docker compose build && docker compose run --rm migrate && docker compose up -d`. The layout:

- One image for all five server processes, built from the repository root: base `node:24-bookworm-slim`; `npm ci`, `npm run build:shared`, `npm run build -w @veetracer/web`, then in `apps/api` `npx prisma generate && npm run build`. Working directory `/app/apps/api`.
- `docker-compose.yml` services:

| Service | Image / command | Ports |
|---|---|---|
| `db` | `postgres:16`, volume for data | – |
| `redis` | `redis:7` with `--maxmemory-policy noeviction`, volume for data | – |
| `migrate` | app image, `npx prisma migrate deploy && npm run db:seed` (runs once per release) | – |
| `api` | app image, `node dist/main.js` | 4100 (internal) |
| `gateway` | app image, `node dist/gateway/main.js` | 5023, 5027, 6808, 5030, 7612 published |
| `processor`, `notifier`, `summarizer` | app image, `node dist/<name>/main.js` | – |
| `proxy` | `caddy:2` with the Caddyfile and the built `apps/web/dist` mounted | 80, 443 published |

- All app services read the same `.env` (`env_file`); inside compose `DATABASE_URL` points at `db`, `REDIS_URL` at `redis`.
- Release: build a new image tag → run `migrate` → `docker compose up -d`.

### 9.6 Cloud (AWS, Azure, Google Cloud, DigitalOcean)

- Any of the above works on a cloud VM. Managed PostgreSQL 16 and managed Redis can replace the local ones (set `DATABASE_URL` / `REDIS_URL`; keep Redis eviction off).
- Device ports carry raw TCP, not HTTP: use the VM's public IP or a TCP (network) load balancer – an HTTP load balancer will not pass tracker traffic.
- Give the gateway a static IP and point the device domain at it.
- Keep the PostgreSQL and Redis ports closed to the internet.

### 9.7 Moving to a new server (checklist)

1. Lower the DNS time-to-live of the web and device names a day before.
2. Build and test the new server with a copy of the database (`pg_dump -Fc` on the old, `pg_restore` on the new) while the old one keeps running.
3. Devices must be configured with the **domain name**, not the IP – otherwise each tracker needs re-configuring.
4. At cut-over: stop the old services, take a final dump, restore it, start the new services, switch DNS.
5. Copy secrets (`.env`, push / mail keys) – never through Git. Firebase / push credentials and the app id stay the same, so phones keep receiving notifications.
6. Watch System Health and the latest position time for an hour; keep the old server for a few days in case of rollback.

## 10. Known gaps

- No automatic lint / format check and no CI running tests on each change – run tests and type checks by hand before every commit.
- Web and app screens have fewer comments than the server rules; the logic files are the best documentation of behaviour.
- The README in the repository root is older than this guide.
 --runInBand` | Runs the whole purchase → sale → return → invoice flow (`src/stock/stock.db-test.ts`); never point it at the live database. |

Good practice when fixing a bug: write a test that replays the real case first (several specs replay real device data), then fix.

## 6. Debugging playbook

### 6.1 Where to look first

| Tool | Where | Use it for |
|---|---|---|
| Service logs | Server: `C:\apps\veetracer\logs` (one file per service) | Errors, start-up problems, delivery failures. |
| System Health | Web → Platform → System Health (Super Admin, `/platform/system-health`) | Stream length / consumers, each device port (listening, connections, msg/s), recent issues. |
| History → All points | Web → History, switch on All points | Every stored and raw phone point with its quality label (good, drift, spike, jump, inaccurate…). |
| Raw packets | `RawPacket` table (needs `GATEWAY_CAPTURE` for hardware; phones always) | What the device actually sent. |
| Notification log | `NotificationLog` table / alert detail in the web | Was a push / e-mail / SMS sent, to whom, and why it failed. |
| Audit log | Web → Admin → Audit Log (`/admin/audit-log`); `AuditLog` table | Who changed a setting, vehicle or user, and when. |
| Device health | Web → Devices → device → Tracker app / health | Phone permissions, battery saver, app version, last seen. |

### 6.2 Common problems

**A device is not showing on the map**
1. Is it listed under Platform → Unknown devices (Super Admin)? Then it connects but is not registered (wrong IMEI on the device record).
2. System Health → is its port listening and does the connection count rise?
3. Turn on `GATEWAY_CAPTURE` for its IMEI and check `RawPacket`: packets arriving but no positions = decoder issue (`gateway/<protocol>/`).
4. Positions in the table but not on the map: check the object is active, the device assignment is open (`DeviceAssignment.toTime` empty), and the company is ACTIVE.

**Locations jump or drift**
- History → All points shows the label of each point. Filters live in `tracking/position-filter.ts` (live) and `point-quality/analyze.ts` (analysis); phone uploads also pass `mobile-tracker/mobile-tracker.logic.ts` → `roughSpikes`.
- A wrong point can be removed by the Super Admin from History (kept for restore, day recomputed).

**Impossible speed or false overspeed (e.g. 84 km/h right after ignition on)**
- Usually a weak GPS fix (6 satellites or fewer), often the first fix after the ignition is switched on. `tracking/position-filter.ts` treats such a speed as noise when the movement since the last good point does not confirm it (`speedNoise`): live status, overspeed and the stored speed use 0, and the raw value is kept in the point's `attributes.rawSpeedKph` (`speedNoise: true`).
- Check the point in History → All points or the `Position` row: `satellites`, `valid`, and the distance to the neighbouring points.

**Trips / distance look wrong**
- Summaries are derived. Insert the object and day into `SummaryDirtyDay` (or use the tools that do it) and the summarizer rebuilds it on its next run.
- Check whether outliers are used in reports (`PointQualitySettings.useInReports`).

**An alert did not arrive**
1. Was the alert created? (`Alert` table / Alerts page). If not: alert setting off, snoozed, or rule not met (`processor/rules/`).
2. `NotificationLog` for that alert: `SENT` = accepted by the provider; `FAILED` with "Mobile app not signed in" = the recipient has no VeeTrax app signed in on any phone.
3. Recipient lists: Alert Settings → recipients.

**SOS rang without sound**
- Android: one siren everywhere – the native `AlarmService` (`modules/veetrax-alarm`) on the alarm volume, raised to maximum. With the app closed the push starts it (`AlarmMessagingService`); with the app open or after tapping the alert, the SOS screen keeps it running through `useSiren` (`features/notifications/siren.ts`) and stops it on Silence / Acknowledge / leaving the screen. Up to 0.6.7 the SOS screen swapped it for a media-volume player, which was silent when the media volume was low.
- If Android refuses to start the alarm service (Google can downgrade a push's priority), `AlarmMessagingService` posts an **insistent** notification on the `sos_insistent` channel (alarm volume, siren sound) that repeats until opened. Log tag `VeetraxAlarm` ("Alarm not started, insistent notification instead") shows when this happened (`adb logcat -s VeetraxAlarm`).
- Still silent: check battery saver / autostart (Xiaomi, Oppo, Vivo, Realme), the "SOS alarm" channel in the app's notification settings, and Do Not Disturb (More → Emergency alerts → Allow through Do Not Disturb).
- No sound because nobody received it: `NotificationLog` "Mobile app not signed in" = the recipient has no VeeTrax app signed in.
- Full-screen alarm on Android 14+ needs the user's permission (More → Emergency alerts → Allow).

**Voice alerts silent**
- VeeTrax app: speaks only while the app is open on screen (`features/notifications/voice.ts`).
- Web: the browser blocks speech until the user clicks the page once.

**Tracker app phone stops sending**
- Devices → phone health: location "always", battery optimisation, data saver, background restriction.
- `MobileTrackerSession` revoked = the number was activated on another phone.

**User sees "Object not found" / missing vehicles**
- Data scope: role is "assigned" and the vehicle is not assigned to the user (UserObject / UserBranch).
- Opening an old link of another company's vehicle after switching accounts.

**Web page shows "Something went wrong"**
- Browser console shows the real error. A build error like "Cannot access X before initialization" means a variable is used before it is declared in that component.

### 6.3 Restarting and checking services (server)

- Services: `veetracer-api`, `veetracer-gateway`, `veetracer-processor`, `veetracer-notifier`, `veetracer-summarizer`, database `veetracer-pg`, Redis `Memurai`.
- Check data is flowing: latest `Position.serverTime` should be seconds old.
- After a restart the first start can take ~90 s (antivirus scanning).

## 7. Git: repository, branches and workflow

### 7.1 Repository

| Item | Value |
|---|---|
| Code repository | `https://github.com/karthick5206/gps-app` (private) – the whole monorepo: server, web, both apps, shared package, docs |
| Production branch | `main` – what runs on the server and what app releases are built from |
| Database backups | Separate private repository `veetrax/dailydbbackup` (GitHub Releases, encrypted files only) |
| Tag | `ui-classic-2026-11-06` – the code before the enterprise redesign (also branch `backup/classic-ui`) |

### 7.2 Branches

| Branch | Purpose |
|---|---|
| `main` | Production. Every deploy is a fast-forward of `main`; never rewrite its history. |
| `feature/<name>` | New work (e.g. `feature/soft-delete`, `feature/attendance-shifts`). Branch from `main`, merge back when tested. |
| `fix/<name>` | Bug fixes that need their own branch. |
| `wip/<name>` | Experiments not ready to merge. |
| `backup/<name>` | Snapshots kept for reference (e.g. `backup/classic-ui`). |

Older feature branches that are already merged into `main` can be deleted once no one needs them.

### 7.3 Day-to-day workflow

1. `git checkout main && git pull` – start from the latest production code.
2. `git checkout -b feature/<short-name>`.
3. Commit small, focused changes. Message: first line says what changed for the user ("Live map: hide map buttons while the list is open"), then a short body with the why and any real case. Revert commits keep Git's default "Revert …" message.
4. Before pushing: type-check and run the tests (section 5).
5. `git push -u origin feature/<short-name>`.
6. When tested and approved: bring it into `main` as a fast-forward (`git push origin feature/<short-name>:main` when `main` has not moved, otherwise merge `main` into the branch first), then deploy.
7. Undo a released change with `git revert <commit>` (a new commit), never by rewriting `main`.

### 7.4 What must never be committed

- `.env` files (only `.env.example` is tracked – see `.gitignore`).
- The Android release keystore (`veetrax-release.jks`) and its passwords, the backup private key, server passwords, API keys.
- Build output (`dist/`, `android/`, `ios/` folders generated by Expo prebuild, `node_modules/`).
- Database dumps (backups go encrypted to the backup repository only).

### 7.5 How code reaches the server

The server has no access to GitHub. A deploy packs the branch as a Git bundle (`git bundle create gps-app.bundle main`), copies it to the server, and the deploy script fast-forwards `C:\apps\veetracer\app` from the bundle before building. So the server's code is always a commit you can find in GitHub: `git log -1` on the server shows which.

## 8. Build and release

| What | How |
|---|---|
| Web only | On the server: fast-forward the code, `npm run build:shared`, `npm run build -w @veetracer/web`. No restart. |
| Server | Deploy script: stop services → update code → `npm ci` → build shared / web / API → `prisma generate` → `migrate deploy` → seed → start services. |
| Android apps | `npx expo prebuild --platform android`, then `./gradlew assembleRelease` (APK) or `bundleRelease` (AAB for Play). Release key: kept offline by the owner – never commit it. |
| iPhone | EAS Build (`eas build --platform ios`). |
| Backups | Encrypted weekly full + 8-hourly diff to a private GitHub repo; restore steps in the backup key folder README. |

All deploy scripts are in `ops/deploy` (`windows/`, `linux/`, `docker/`; see `ops/deploy/README.md`), with a copy in `C:\Build\Scripts` on the owner's PC. The Windows deploy scripts are in `ops/deploy/windows` (`deploy-release.ps1` = full release, `update-web-only.ps1` = web only, `deploy-veetracer.ps1` = first install). They ask for the server password; never write it into a script.

## 9. Deploying on any server (Windows, Linux, Docker, cloud)

VeeTrax is plain Node.js + PostgreSQL + Redis, so it runs the same on Windows, Linux or containers. Only the way the processes are kept running differs.

### 9.1 What has to run

| Piece | Command (in `apps/api` after build) | Port | Notes |
|---|---|---|---|
| API | `node dist/main.js` | 4100 (`API_PORT`), local only | Behind the reverse proxy. |
| Gateway | `node dist/gateway/main.js` | 5023, 5027, 6808, 5030, 7612 (TCP, public) | Devices connect here directly – open these in the firewall. |
| Processor | `node dist/processor/main.js` | – | More than one instance may run (consumer group). |
| Notifier | `node dist/notifier/main.js` | – | |
| Summarizer | `node dist/summarizer/main.js` | – | |
| PostgreSQL 16 | – | 5432 (local only) | Database `veetracer`. |
| Redis 7 (or Memurai on Windows) | – | 6379 (local only) | `maxmemory-policy noeviction` – the position stream must never be evicted. |
| Reverse proxy (Caddy or Nginx) | – | 80, 443 (public) | Serves `apps/web/dist`, proxies `/api` and `/socket.io` to 4100, HTTPS certificates. |

Sizing: a small fleet runs on 2 vCPU / 4 GB; plan 4 vCPU / 8 GB and an SSD for a few thousand devices.

### 9.2 Steps common to every platform

1. Install Node.js 24, PostgreSQL 16, Redis 7 (Memurai on Windows) and Caddy.
2. Create the database and its user: `CREATE USER veetracer WITH PASSWORD '…'; CREATE DATABASE veetracer OWNER veetracer;`
3. Get the code: `git clone` (or copy a Git bundle and `git clone gps-app.bundle app`).
4. Create `apps/api/.env` from `apps/api/.env.example`: at least `NODE_ENV=production`, `API_PORT=4100`, `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET` (long random), `WEB_URL`, `PUBLIC_API_URL`, mail, push and geocoder settings (section 3).
5. Build: `npm ci` → `npm run build:shared` → `npm run build -w @veetracer/web` → `cd apps/api && npx prisma generate && npm run build`.
6. Database: `npx prisma migrate deploy` (every release) and `npm run db:seed` (first install creates the Super Admin; safe to repeat).
7. Start the five processes as services (9.3–9.5) and the reverse proxy.
8. Point DNS: the web / API name to the proxy, and the device name (e.g. `track.<domain>`) to the gateway's public IP.
9. Check: web sign-in works, System Health shows every port listening, a test device appears on the live map.

Reverse proxy example (Caddyfile):

| Caddyfile line | Purpose |
|---|---|
| `app.example.com {` | Site name; Caddy fetches the HTTPS certificate. |
| `  encode gzip` | Compression. |
| `  handle /api/* { reverse_proxy 127.0.0.1:4100 }` | REST API (also video streams). |
| `  handle /socket.io/* { reverse_proxy 127.0.0.1:4100 }` | Live updates (WebSockets). |
| `  handle { root * /path/to/app/apps/web/dist`, `try_files {path} /index.html`, `file_server }` | Web app with single-page fallback. |
| `}` | |

### 9.3 Windows Server (current production)

- Services are created with NSSM, one per process. Example for the API (repeat for `gateway`, `processor`, `notifier`, `summarizer` with their `dist` path):
  - `nssm install veetracer-api "C:\Program Files\nodejs\node.exe" "--max-old-space-size=256 dist\main.js"`
  - `nssm set veetracer-api AppDirectory C:\apps\veetracer\app\apps\api`
  - `nssm set veetracer-api AppStdout C:\apps\veetracer\logs\api.log` and the same for `AppStderr`
  - `nssm set veetracer-api AppRotateFiles 1` and **AppRotateOnline 0** (1 makes service stops hang)
  - `nssm set veetracer-api DependOnService veetracer-pg Memurai`
- PostgreSQL runs as its own service (`veetracer-pg`, port 5433 on the shared server); Memurai as a service.
- Firewall: add inbound TCP rules for the device ports.
- Releases: `ops/deploy/windows/deploy-release.ps1`. Before `prisma generate`, stop api / processor / notifier / summarizer (they lock the Prisma engine file); the script does this.
- First start after a rebuild can take ~90 s (antivirus scanning).

### 9.4 Linux (Ubuntu 22.04 / 24.04)

Ready-made scripts: `ops/deploy/linux/install-ubuntu.sh` does steps 1–3 and 5 (run `sudo DB_PASS=… bash install-ubuntu.sh`), `ops/deploy/linux/release.sh` does step 6, and the five unit files are in the same folder. The manual steps:

1. Packages: PostgreSQL 16 (PGDG repository), `redis-server`, `caddy`, Node.js 24 (NodeSource). In `/etc/redis/redis.conf` set `maxmemory-policy noeviction`.
2. A service user and folder: `sudo useradd -r -m -d /opt/veetrax veetrax`, code in `/opt/veetrax/app`.
3. One systemd unit per process, e.g. `/etc/systemd/system/veetrax-api.service`:

| Section | Lines |
|---|---|
| `[Unit]` | `Description=VeeTrax API` · `After=network-online.target postgresql.service redis-server.service` |
| `[Service]` | `User=veetrax` · `WorkingDirectory=/opt/veetrax/app/apps/api` · `EnvironmentFile=/opt/veetrax/app/apps/api/.env` · `ExecStart=/usr/bin/node --max-old-space-size=512 dist/main.js` · `Restart=always` · `RestartSec=5` |
| `[Install]` | `WantedBy=multi-user.target` |

   Copy it to `veetrax-gateway`, `veetrax-processor`, `veetrax-notifier`, `veetrax-summarizer`, changing `Description` and `ExecStart` (`dist/gateway/main.js` etc.). Then `sudo systemctl daemon-reload && sudo systemctl enable --now veetrax-api veetrax-gateway veetrax-processor veetrax-notifier veetrax-summarizer`.
4. Logs: `journalctl -u veetrax-processor -f`. Status: `systemctl status veetrax-*`.
5. Firewall: `sudo ufw allow 80,443/tcp` and `sudo ufw allow 5023,5027,6808,5030,7612/tcp`.
6. Release: `git pull` (or fetch the bundle) → build (9.2 step 5) → `npx prisma migrate deploy` → `sudo systemctl restart veetrax-api veetrax-gateway veetrax-processor veetrax-notifier veetrax-summarizer`. Web-only change: rebuild the web, no restart.
7. Backups: the backup scripts in `ops/backup` are PowerShell for Windows. On Linux run them with PowerShell 7 after changing the paths, or use a cron job that runs `pg_dump -Fc`, encrypts with `age -r <public key>` and uploads – keep the same weekly full + 8-hourly schedule.

### 9.5 Docker (example – test on a staging server first)

Files: `ops/deploy/docker/Dockerfile`, `docker-compose.yml`, `Caddyfile`, `.dockerignore.example` (copy to the repository root as `.dockerignore`). Start: set `DB_PASSWORD` and `SITE`, create `.env` next to the compose file, then `docker compose build && docker compose run --rm migrate && docker compose up -d`. The layout:

- One image for all five server processes, built from the repository root: base `node:24-bookworm-slim`; `npm ci`, `npm run build:shared`, `npm run build -w @veetracer/web`, then in `apps/api` `npx prisma generate && npm run build`. Working directory `/app/apps/api`.
- `docker-compose.yml` services:

| Service | Image / command | Ports |
|---|---|---|
| `db` | `postgres:16`, volume for data | – |
| `redis` | `redis:7` with `--maxmemory-policy noeviction`, volume for data | – |
| `migrate` | app image, `npx prisma migrate deploy && npm run db:seed` (runs once per release) | – |
| `api` | app image, `node dist/main.js` | 4100 (internal) |
| `gateway` | app image, `node dist/gateway/main.js` | 5023, 5027, 6808, 5030, 7612 published |
| `processor`, `notifier`, `summarizer` | app image, `node dist/<name>/main.js` | – |
| `proxy` | `caddy:2` with the Caddyfile and the built `apps/web/dist` mounted | 80, 443 published |

- All app services read the same `.env` (`env_file`); inside compose `DATABASE_URL` points at `db`, `REDIS_URL` at `redis`.
- Release: build a new image tag → run `migrate` → `docker compose up -d`.

### 9.6 Cloud (AWS, Azure, Google Cloud, DigitalOcean)

- Any of the above works on a cloud VM. Managed PostgreSQL 16 and managed Redis can replace the local ones (set `DATABASE_URL` / `REDIS_URL`; keep Redis eviction off).
- Device ports carry raw TCP, not HTTP: use the VM's public IP or a TCP (network) load balancer – an HTTP load balancer will not pass tracker traffic.
- Give the gateway a static IP and point the device domain at it.
- Keep the PostgreSQL and Redis ports closed to the internet.

### 9.7 Moving to a new server (checklist)

1. Lower the DNS time-to-live of the web and device names a day before.
2. Build and test the new server with a copy of the database (`pg_dump -Fc` on the old, `pg_restore` on the new) while the old one keeps running.
3. Devices must be configured with the **domain name**, not the IP – otherwise each tracker needs re-configuring.
4. At cut-over: stop the old services, take a final dump, restore it, start the new services, switch DNS.
5. Copy secrets (`.env`, push / mail keys) – never through Git. Firebase / push credentials and the app id stay the same, so phones keep receiving notifications.
6. Watch System Health and the latest position time for an hour; keep the old server for a few days in case of rollback.

## 10. Known gaps

- No automatic lint / format check and no CI running tests on each change – run tests and type checks by hand before every commit.
- Web and app screens have fewer comments than the server rules; the logic files are the best documentation of behaviour.
- The README in the repository root is older than this guide.
