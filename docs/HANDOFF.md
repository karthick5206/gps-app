# VeeTracer — handoff and pending work

Last updated: 18 October 2026. Repository: https://github.com/karthick5206/gps-app

Start here on a new machine. A Claude Code session can read this file to pick up the work: it lists what's done,
how to run it, the product decisions already made, and everything still pending, in priority order.

## 1. Where things stand

| Milestone | Status | Spec |
|---|---|---|
| Design document v2.0 (approved, 369 features) | Done | `docs/VeeTracer_Design_Document_v2.0.pdf` (source `docs/design/build.py`) |
| **M1** Foundation: auth (password + OTP + reset), roles/menus/data scope, master pages, Concox GT06 gateway, processor, live map, simulator, light/dark | Done, on `main` | `docs/m1/M1_SPEC.md` |
| **M2a** Alerts engine + alert management, geofences, templates, notifier, summarizer, history playback, reports + scheduled reports | Done, on `main` | `docs/m2a/M2A_SPEC.md` |
| Device parsers (Concox GT800/V5/VL149 4G packets, Teltonika, iTriangle AIS-140) | **Started** — branch `wip/device-parsers` (3 skeleton files) | §4.1 below |
| M2b Mobile apps (Flutter), Firebase push, Razorpay billing | Not started | §4.4 |
| M3 Drivers → routes → planned trips, dashboards, driver app, production hardening | Not started | Design doc §19 |

Verified on the development Mac: api 136 jest tests, web 57 tests, full pipeline with 20 simulated devices, 2,000 devices at
~1,000 positions/s (processor + rules engine keep up), 10,000 simulated connections.

## 2. Set up a new development machine

Prerequisites: **Node 22+**, **PostgreSQL 16** (TimescaleDB optional — the positions table converts automatically when the
extension exists), **Valkey** (or Redis 7) on 6379, Git. macOS: `brew install node postgresql@16 valkey && brew services start postgresql@16 valkey`.
Ubuntu: `apt install postgresql-16`, Valkey/Redis from apt, Node 22 from NodeSource.

```bash
git clone https://github.com/karthick5206/gps-app.git && cd gps-app
npm install
createdb veetracer
cp apps/api/.env.example apps/api/.env      # set DATABASE_URL user/password for this machine; set a random JWT_SECRET
cp apps/web/.env.example apps/web/.env
npm run build:shared
cd apps/api && npx prisma migrate deploy && npm run db:seed && cd ../..
scripts/dev-start.sh 20                     # api :4000, gateway :5023, processor, notifier, summarizer, web :5173, 20 sim devices
scripts/dev-stop.sh
```
Accounts (development seed only): `admin@veetracer.local` / `Admin@12345` (Super Admin), `demo.admin@veetracer.local` /
`Demo@12345`, `chennai.manager@veetracer.local` / `Demo@12345`, `viewer@veetracer.local` / `Demo@12345`.
Dev outputs: emails → `apps/api/var/mail/`, SMS → `apps/api/var/sms/sms.log`, report files → `apps/api/var/reports/`, logs → `apps/api/var/logs/`.

Notes:
- The Nest API and notifier can't run under `tsx` (no decorator metadata) — use `npm run build` + `node dist/...` (what `dev-start.sh` does) or `nest start --watch`.
- Load testing: `cd apps/api && npm run sim:register -- --count 2000` then `npm run sim -- --count 2000 --interval 2`.
- Headless-browser checks: launch Chrome with `--mute-audio` (the alert sound otherwise plays out loud).

## 3. Product decisions already made (keep these)

- Market India; direct sales; later white-label partners. Exactly **one Super Admin** (the owner).
- Track anything: vehicles, people/delivery staff (phone), assets, pets, watches, OBD, dashcams (later). Everything — alerts, map fields,
  reports, commands — is driven by the **device model's capabilities**; the tracked object is separate from the device (swap keeps history).
- Organisation: Company → Branch (flat) → vehicles; roles Admin → Manager → User/Viewer; menu × View/Create/Edit/Delete permissions; data
  scope = branches + individually mapped vehicles. Account types Business and Individual.
- Alerts configurable at company → branch → vehicle group → vehicle; recipient lists per alert and channel (email/SMS/WhatsApp/push) with
  company default lists; editable templates (SMS must match DLT-registered templates); only SOS and power cut open the blocking pop-up.
- Retention up to 6 months per company; live tracking and alert latency are the top priority (target < 2 s).
- Stack: NestJS + Prisma + PostgreSQL (+TimescaleDB) + Valkey; React + Vite + Tailwind + shadcn-style UI + MapLibre; Flutter for apps.
  Open source first. Light/dark/system themes everywhere. Maps: OpenFreeMap now, self-hosted OSM tiles later.
- Apps: web; **VeeTracer Admin** mobile app (Super Admin, company admins/managers); **VeeTracer** role-based mobile app (drivers,
  employees, users, individuals, delivery staff); **VeeTracer Parent** app.
- Production domains: **gps.mintplus.co.in** (web + API, HTTPS 443) and **track.mintplus.co.in** (devices, TCP).

## 4. Pending work (priority order)

### 4.1 Device parsers — IN PROGRESS (branch `wip/device-parsers`)
Customer devices now: **Concox GT800, Concox V5, Concox VL149 (4G), Teltonika, iTriangle**.

**Status (18 Oct 2026):**

Done and tested (174 api tests). The work is on the branch and deployed to the test server.
- **Multi-protocol gateway:** `gateway/tcp-server.ts` provides one generic listener per decoder. `gateway/main.ts` runs GT06 on 5023 and Teltonika on 5027.
- **GT06 family:** extensions in `gateway/gt06/codec.ts` and `decoder.ts`:
  - 2-byte MNC
  - 0x10/0x12/0x22, 0xA0 4G
  - 0x13/0x23 heartbeats, 0x16/0x26/0x27/0xA4 alarms
  - 0x8A time reply, 0x94 voltage/ICCID
  - 0x15/0x21 command responses, LBS/Wi-Fi recognised
  - Login time zone, with per-connection detection of a local vs UTC device clock
- **Teltonika:** `gateway/teltonika/*`. Codec 8/8E/16, CRC-16/IBM and the IO mapping are verified against Teltonika's public sample packets.
- **Offline sweeper:** a parked device that only sends heartbeats stays online, because it still holds its `vt:conn` key.
- **Simulator:** `--protocol gt06|gt06-4g|teltonika` and `--tz`.
- **Seed:** device models GT800/V5/VL149, FMB920/FMB120/FMC130 and TS101.
- **Docs:** `docs/devices/DEVICE_SETUP.md`.
- **Real-device capture:** `GATEWAY_CAPTURE=<imeis>` writes raw frames to `var/logs/capture-<protocol>.log`.

Still open:
- Item 4, AIS-140: waiting for iTriangle's document.
- Real-device fixtures from the capture logs: V5 359647091912738, plus 867440069681286 and 352503093516521.
- Command downlink (`encodeCommand` and Codec 12 exist; nothing sends them yet).
- Teltonika UDP.

Original plan (kept for reference):
1. **Multi-protocol gateway**: one TCP listener per protocol — `GT06_PORT` 5023, `TELTONIKA_PORT` 5027, `AIS140_PORT` 5030 — sharing
   the existing pipeline (XADD `vt:positions`, raw hex, connection registry, unknown devices, idle timeout, frame-size guards).
2. **Concox GT06 family extensions** for GT800/V5/VL149: 0x01 login variants, 0x10/0x11, 0x12/0x22, 0x13, 0x23 heartbeat, 0x16/0x26/0x27
   alarms, 0x8A time request (reply with UTC time), 0x94 info (external voltage, ICCID), **0xA0 / 0xA1 / 0xA4 4G packets**, 0x15/0x21
   command responses, LBS/Wi-Fi packets, `79 79` frames, correct ACKs. (Traccar's open-source `Gt06ProtocolDecoder` is a good public
   reference for layouts.)
3. **Teltonika**: IMEI handshake, Codec 8 / 8E / 16 with CRC-16/IBM, ACK = record count, Codec 12 responses; IO mapping (239 ignition,
   240 movement, 66 ext voltage, 67/113 battery, 21 GSM, 16 odometer, 1–3 DIN, 179/180 DOUT, 9 AIN1, 72–74 temperature, 78 iButton,
   247 crash, 252 unplug, 246 towing, 249 jamming, 253/254 green driving; others as `io<id>`). Test with the public sample packets from
   Teltonika's documentation.
4. **iTriangle / AIS-140**: ASCII `$…*checksum` packets per the AIS-140 standard field order (login, NR/L live, H history, EA emergency,
   alerts, health). Field-mapping table per vendor variant. **Blocked on the customer:** iTriangle's protocol document or sample packets.
5. Normalised attributes: use the names in `attributes.ts`; alarms map to `sos`, `powerCut`, `lowBattery`, `overspeed`, `tamper`,
   `harshAcceleration|Braking|Cornering`, `crash`, `towing`, `jamming` (check `src/processor/rules/evaluate.ts` for what the rules engine reads).
6. Simulator `--protocol gt06|gt06-4g|teltonika|ais140`; jest tests with known vectors, fragmentation, garbage, bad CRC.
7. Device models: add Concox GT800 / V5 / VL149, Teltonika FMB920 / FMB120 / FMC130, iTriangle TS101 to the seed with capabilities.
8. `docs/devices/DEVICE_SETUP.md`: per family, port + SMS/configurator commands to point at `track.mintplus.co.in`
   (Concox `SERVER,1,track.mintplus.co.in,5023,0#`; Teltonika `setparam 2004:track.mintplus.co.in;2005:5027;2006:0`).

### 4.2 Production deployment (gps.mintplus.co.in / track.mintplus.co.in)
Being done on another machine. Checklist:
- Processes: api, gateway, processor, notifier, summarizer (+ PostgreSQL, Valkey). Web = static build of `apps/web` behind the
  reverse proxy, which also proxies `/api` and `/socket.io` (WebSocket) to the API on 4000. `npx prisma migrate deploy` on each release.
- Ports open to the internet: 443 (and 80 → redirect), **TCP 5023** (Concox), later **5027** (Teltonika) and **5030** (AIS-140).
  Never expose 4000, 5432, 6379. `track.mintplus.co.in` must be **DNS-only** (no HTTP proxy such as Cloudflare orange cloud).
- Env for production: `OTP_DEV_ECHO=false`, `MAIL_DEV_ECHO=false`, new random `JWT_SECRET`, `CORS_ORIGINS` and `WEB_URL` =
  `https://gps.mintplus.co.in`, `SMTP_URL` + `MAIL_FROM`, `SMS_PROVIDER` (real provider once DLT is ready), `GEOCODER` (self-hosted
  Photon/Nominatim; the public Nominatim is ≤ 1 req/s and dev only), `REPORT_SCHEDULER` on in one instance.
- Don't run the demo seed in production (or change every demo password and delete demo companies immediately). Change the Super Admin
  credentials on first login.
- Windows server 166.0.242.121: Linux (Ubuntu 22.04/24.04) is strongly preferred for this stack; if Windows is kept, Valkey needs WSL2.
  Change the Administrator password (it was shared in chat) and restrict RDP 3389 / WinRM 5985 to known IPs.

### 4.3 Known gaps from M2a (small)
- Date presets on History/Reports use the browser timezone instead of the company timezone.
- No address search endpoint (`/api/geocode/search`) → geofence editor can't search places; address fill is slow with public Nominatim.
- Alert acknowledgement isn't pushed over the socket to other open sessions.
- Default cooldowns per alert type and `VehicleGroup.alertPriority` aren't in `packages/shared` (web copies them locally).
- Alert pack create/edit UI missing (apply only). Settings tree/pickers load the first 100 vehicles/users (search narrows).
- Alerts/Templates tables scroll sideways at 375 px.
- Playback smoothness verified only in software rendering (≈16–19 fps there; our per-frame work is 0.25 ms) — confirm 60 fps on a real GPU.
- Raw-SQL time comparisons: Prisma `DateTime` columns without `@db.Timestamptz` store UTC as `timestamp` — compare in UTC.
- PUSH and WhatsApp channels are logged as SKIPPED until M2b; SMS provider is console-only (MSG91 stub).

### 4.4 M2b — mobile apps and billing
- Flutter monorepo app(s): **VeeTracer Admin** and **VeeTracer** (role-based menus from `/api/auth/me` permissions): live map,
  playback, alerts, reports view, commands; tracker mode (phone GPS, background service, `/api/ingest`-style endpoint to add), driver /
  employee screens per design §11. Share theme tokens with the web (light/dark).
- Push notifications via Firebase Cloud Messaging (needs a Firebase project; add a PUSH provider to the notifier and device-token APIs).
- Razorpay subscriptions: plans (monthly/annual, INR), plan limits enforcement, GST invoices, webhooks (needs Razorpay test keys).

### 4.5 Later milestones (design doc §19)
M3: drivers → vehicles → routes → planned trips with stop in/out times, driver app, dashboards, 10k load test in production.
P2: AIS-140 government forwarding, OBD/watches/pets, fuel, driver score, maintenance, passengers + Parent app, WhatsApp, webhooks.
P3: dashcams (JT808/1078, ZLMediaKit). P4: white-label, ad-hoc tracking, languages.

## 5. Waiting on the customer
- iTriangle protocol document or sample packets; exact Teltonika models in use.
- SMS: DLT registration (entity, sender ID, templates) and provider account (MSG91/Gupshup).
- Email: SMTP credentials / domain for `MAIL_FROM` (e.g. alerts@mintplus.co.in) with SPF/DKIM.
- Firebase project, Razorpay test keys, Google Play and Apple developer accounts.
- Plan prices; dashcam model; AIS-140 states.

## 6. Repository map
| Path | What |
|---|---|
| `packages/shared` | Types/constants shared by api and web (menus, permissions, alert catalogue, DTOs) |
| `apps/api/src/gateway` | TCP device gateway (GT06 today) |
| `apps/api/src/processor` | Stream consumer: filtering, status, live state, rules engine (`rules/`) |
| `apps/api/src/notifier`, `src/summarizer` | Notification sender; trips/stops/daily summaries |
| `apps/api/src/{auth,access,masters,live,alerts,templates,history,reports,report-schedules,geocoding}` | API modules |
| `apps/api/prisma` | Schema, migrations, seed |
| `apps/web/src/features` | Web pages by area (live, history, reports, alerts, alerting, geofences, templates, masters, admin, platform) |
| `scripts/dev-start.sh`, `dev-stop.sh` | Run/stop the whole dev stack |
