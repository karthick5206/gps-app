# VeeTrax Developer Guide

How the code is organised, how to run it, the conventions to follow, and where to look when something goes wrong. Read sections 1–4 once; use section 6 (Debugging playbook) when you have a problem, and section 7 for Git.

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
| `notifier/` | `notifier.service.ts` (delivery), `push.ts` (Expo push), `sms.ts` (SMS provider), templates. |
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
| `purge/` | "Delete permanently" and "Delete my account". |
| `developer/`, `public-api/`, `webhooks/` | Developer API keys, public API, signed webhooks. |
| `monitoring/` | System Health data. |
| `retention/` | Deleting old positions / raw packets per retention settings. |
| `prisma/` | Database client. Schema: `apps/api/prisma/schema.prisma`; migrations: `apps/api/prisma/migrations`. |
| `redis/keys.ts` | Every Redis key, stream and channel name in one place. |

### 2.2 Web app (`apps/web/src`)

`features/<area>/` holds each screen (live, history, dashboard, attendance, alerts, reports, masters, platform…). `components/` holds shared UI, `lib/` holds the API client (`lib/api.ts`), storage and formatting. Live map drawing is in `features/live/map/map-controller.ts`; history map in `features/history/history-map.ts`.

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
7. Apps: `npm run dev:mobile` (Expo). For the Android emulator against a local server, build with `EXPO_PUBLIC_SERVER_URL=http://10.0.2.2:<port>`.

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

**Trips / distance look wrong**
- Summaries are derived. Insert the object and day into `SummaryDirtyDay` (or use the tools that do it) and the summarizer rebuilds it on its next run.
- Check whether outliers are used in reports (`PointQualitySettings.useInReports`).

**An alert did not arrive**
1. Was the alert created? (`Alert` table / Alerts page). If not: alert setting off, snoozed, or rule not met (`processor/rules/`).
2. `NotificationLog` for that alert: `SENT` = accepted by the provider; `FAILED` with "Mobile app not signed in" = the recipient has no VeeTrax app signed in on any phone.
3. Recipient lists: Alert Settings → recipients.

**SOS rang without sound**
- App closed: native `AlarmService` (alarm volume). App open / opened from the notification: the SOS screen plays its own siren (media volume) – see `apps/mobile/src/features/notifications/siren.ts`.
- The phone may block the alarm service when Google downgrades the push; check battery saver / autostart and the "SOS alarm" channel.
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

## 9. Known gaps

- No automatic lint / format check and no CI running tests on each change – run tests and type checks by hand before every commit.
- Web and app screens have fewer comments than the server rules; the logic files are the best documentation of behaviour.
- The README in the repository root is older than this guide.
