# 3. Repository Structure

> Source: `git ls-files` on `main` @ `17a2e63` (2026-11-08). 1,247 tracked files, 308 commits from 2026-10-18 to 2026-11-07.
> Status: **Confirmed** from the file tree and entry points, unless marked otherwise.

## 3.1 Monorepo layout

An npm-workspaces monorepo (`"workspaces": ["packages/*", "apps/*"]`, Node ≥ 22) — see [package.json](../../package.json). The npm package scope is still `@veetracer/*` (the original product name). The product is now branded **VeeTrax**.

| Path | Files | Purpose |
|---|---:|---|
| [packages/shared](../../packages/shared) | 40 | TypeScript types and constants shared by the API, web and mobile apps: menus and permissions, alert catalogue, DTOs, basemap config, brand constants, i18n strings. Built to `dist/` for Node and the web. Mobile consumes `src/` directly (the `react-native` field). |
| [apps/api](../../apps/api) | 557 | NestJS 11 backend. **One codebase, several processes**: the HTTP + Socket.IO API, the TCP device gateway, the stream processor, the notifier, the summarizer, and the device simulator. Prisma schema, migrations (51) and seed. |
| [apps/web](../../apps/web) | 318 | React 19 + Vite 8 + Tailwind 4 single-page web dashboard (MapLibre live map, history, reports, masters, admin, platform/Super Admin). |
| [apps/mobile](../../apps/mobile) | 212 | **VeeTrax** customer mobile app — Expo SDK 58 / React Native 0.88, expo-router, MapLibre RN. Includes a native module `veetrax-alarm` (SOS alarm). |
| [apps/tracker](../../apps/tracker) | 80 | **Phone-as-tracker** app — Expo, expo-location + task-manager, SQLite offline queue. Includes a native module `veetrax-tracker`. |
| [brand](../../brand) | 15 | Logo (PNG/SVG mark, white/teal variants), Manrope 700/800 fonts (OFL), store icons and feature graphic, email header images. |
| [docs](../../docs) | 10 | Design document v2.0 (PDF + HTML/Python source), milestone specs (M1, M2a), handoff, monitoring, relay, device setup, mobile-tracker API. |
| [scripts](../../scripts) | 7 | `dev-start.sh` / `dev-stop.sh` (whole dev stack), i18n extract/merge/missing, brand asset generation. |
| [tooling/expo](../../tooling/expo) | 1 | `with-release-signing.js` Expo config plugin (Android release signing). |
| [ops](../../ops) | 3 tracked + `run/` untracked | `backup/` nightly PostgreSQL backup and restore (PowerShell). `run/` (**untracked**) holds the PM2 ecosystem, watchdog and autostart for the current Windows self-hosting. |

## 3.2 `apps/api` — processes and modules

### Process entry points (Confirmed)

| Process | Entry | Start (prod build) | Role |
|---|---|---|---|
| API | [src/main.ts](../../apps/api/src/main.ts) | `node dist/main.js` | REST `/api/*`, Socket.IO, cron jobs (`@nestjs/schedule`) |
| Gateway | [src/gateway/main.ts](../../apps/api/src/gateway/main.ts) | `node dist/gateway/main.js` | TCP listeners for device protocols. Pushes decoded positions to Valkey streams |
| Processor | [src/processor/main.ts](../../apps/api/src/processor/main.ts) | `node dist/processor/main.js` | Stream consumer: filtering, status, live state, rules/alerts, position writes |
| Notifier | [src/notifier/main.ts](../../apps/api/src/notifier/main.ts) | `node dist/notifier/main.js` | Sends email/SMS/push/WhatsApp notifications |
| Summarizer | [src/summarizer/main.ts](../../apps/api/src/summarizer/main.ts) | `node dist/summarizer/main.js` | Trips, stops, daily summaries |
| Simulator | [src/simulator/](../../apps/api/src/simulator) | `npm run sim` | GT06/Teltonika device simulator and load-test device registration |

### Module folders under `apps/api/src` (55)

| Group | Folders | Purpose (details in [05](05-feature-modules-and-api.md), [02](02-architecture-and-platform.md), [09](09-gps-tracking-architecture.md)) |
|---|---|---|
| Platform core | `common`, `config`, `prisma`, `redis`, `audit`, `health.controller.ts`, `monitoring` | Shared helpers (CSV, bulk, list query, Prisma error mapping, secrets/hashing, global HTTP exception filter), env config, DB/Redis clients, audit log, system health and metrics |
| Identity & access | `auth`, `access`, `signup`, `licences`, `developer`, `public-api`, `webhooks` | Login (password/OTP/reset), roles/menus/data scope, self-signup, licensing/billing, developer API keys, public REST API, outbound webhooks |
| Masters | `masters` (44 files) | Companies, branches, users, roles, vehicles/objects, devices, device models, groups, etc. |
| Device ingest | `gateway` (gt06, teltonika, ais140, jt808, jt1078, media, relay), `mobile-tracker`, `device-claim`, `relay`, `commands` | Device protocols (incl. JT808/JT1078 dashcam video), phone-tracker ingest, QR/claim pairing, forwarding to third parties, command downlink |
| Stream processing | `processor`, `point-quality`, `tracking`, `summarizer`, `notifier` | Position pipeline, data quality, trips/stops, notifications |
| Tracking features | `live`, `live-share`, `vehicle-shares`, `history`, `parking`, `routing`, `maps`, `geocoding`, `pois`, `smart-search` | Live map and sockets, public share links, history/playback, parking, routing, basemaps, reverse geocoding, points of interest, search |
| Alerts | `alerts`, `templates` | Alert rules, alert management, notification templates |
| Fleet operations | `drivers`, `driver-events`, `driver-scores`, `documents`, `expenses`, `fuel`, `attendance`, `dms`, `io-sensors`, `video` | Drivers, driver behaviour, scoring, document expiry, expenses, fuel, staff attendance, driver monitoring (DMS), IO sensors, dashcam video |
| Reporting | `reports`, `report-schedules`, `dashboard`, `downloads` | Report catalogue and exports, scheduled emails, dashboards, download centre |
| Data lifecycle | `retention`, `purge`, `transfer` | Retention enforcement, purge requests, transfers between companies |
| Misc | `guide`, `simulator`, `test-env.ts` | In-app guide content, simulator, test env |

Other API folders: [prisma/](../../apps/api/prisma) (schema, 51 migrations, seed), [assets/fonts](../../apps/api/assets/fonts) (PDF report fonts), [scripts/](../../apps/api/scripts) (GT06 send and synthetic-day test scripts), [.env.example](../../apps/api/.env.example).

## 3.3 `apps/web`

| Path | Purpose |
|---|---|
| [src/main.tsx](../../apps/web/src/main.tsx), [src/app/App.tsx](../../apps/web/src/app/App.tsx), [src/app/router.tsx](../../apps/web/src/app/router.tsx) | Bootstrap, providers, route table |
| [src/components/](../../apps/web/src/components) | shadcn-style UI kit (`ui/`: badge, button, card, checkbox, dialog, dropdown, empty-state, field, input, multi-select, popover, select, sheet, skeleton, spinner, switch, table, tabs, tooltip) plus app components (logo, page header, status badge, map tools, page capture, confirm dialog, full-screen loader) |
| [src/lib/](../../apps/web/src/lib) | API client, session, query client, i18n, formatting, geo helpers, status colour tokens, stale-build detection, storage |
| [src/features/](../../apps/web/src/features) (37 areas, 253 files) | live (28), billing (17), history (17), geofences (16), platform (16), alerts (15), shell (15), masters (20), reports (12), alerting (11), auth (10), developer (10), dashboard (8), driver-events (8), admin (6), pois (6), templates (5), video (5), documents (4), attendance (3), and single-file areas: ask, claim, display, dms, download, driver-scores, errors, expenses, family, fuel, geocoding, guide, io-sensors, legal, live-share, parking, theme |

## 3.4 `apps/mobile` and `apps/tracker`

| Path | Purpose |
|---|---|
| [apps/mobile/src/app](../../apps/mobile/src/app) (39) | expo-router screens |
| [apps/mobile/src/features](../../apps/mobile/src/features) (42), `components` (14), `lib` (10) | Feature logic, shared RN components, API/session helpers |
| [apps/mobile/modules/veetrax-alarm](../../apps/mobile/modules/veetrax-alarm) | Native module for the SOS alarm (full-screen/notification alarm) |
| [apps/mobile/assets](../../apps/mobile/assets) (84) | Icons, splash, images, sounds |
| [apps/mobile/app.config.js](../../apps/mobile/app.config.js), [app.json](../../apps/mobile/app.json), [eas.json](../../apps/mobile/eas.json) | Expo / EAS build configuration |
| [apps/tracker/src/app](../../apps/tracker/src/app) (7), `components` (10), `lib` (14) | Tracker screens and location/queue logic |
| [apps/tracker/modules/veetrax-tracker](../../apps/tracker/modules/veetrax-tracker) (31) | Native module for background location tracking |

See [08-mobile-apps.md](08-mobile-apps.md).

## 3.5 Documentation drift (Confirmed)

- [docs/HANDOFF.md](../HANDOFF.md) (last updated 2026-10-18) says the mobile apps are **Flutter** and "not started". They are **Expo React Native** and shipping (VeeTrax 0.6.7, build 67, per recent commits).
- The HANDOFF repo map lists about 10 API modules. There are 55. Many features (billing/licences, video/JT1078, DMS, attendance, fuel, expenses, developer API, webhooks, relay, family, AIS-140) were added after it.
- README links `docs/VeeTrax_Design_Document_v2.0.pdf`, but the file is `docs/VeeTracer_Design_Document_v2.0.pdf`.
- The README still says "mobile apps (later milestones)".
