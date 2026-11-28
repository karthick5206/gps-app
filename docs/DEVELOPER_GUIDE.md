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
| `gateway/` | TCP servers and protocol decoders: `gt06/`, `teltonika/`, `jt808/`, `ais140/`, `jt1078/` (video), `relay/` (data forwarding). `main.ts` starts the gateway process. **Jimi JC400 / JC261 dashcams** use the GT06 port: `gt06/codec.ts` decodes their 0x95 alarms (ADAS / DMS / seat belt / harsh events + clip names), 0x37, 0x94 types 07/08/0E and 0x9B (temperature, driver card); `DVR_ALARMS` in `gt06/decoder.ts` maps alarm types to the shared `alarm` / `adas` / `dms` names. Notes and server set-up commands: `docs/vendor/jimi-jc400/info.md`. Since v1.25.0 their clips arrive over HTTP (`dvr-upload/`, public `POST /api/dvr/jimi/upload`, signed with JIMI_UPLOAD_KEY) into the driver-event media pipeline, and live video is RTMP into MediaMTX (`ops/deploy/linux/install-mediamtx.sh`) proxied as HLS (`/api/video/hls/...`, `video/rtmp-live.ts`); `VideoService` treats protocol GT06 + capability `video` as an RTMP camera. Since v1.27.1 `commands/dvr-auto-setup.service.ts` sends the `JIMI_SETUP_COMMANDS` (.env, |-separated: UPLOAD / RSERVICE) to every connected Jimi camera until acknowledged. **Video controls (v1.28.0):** all channels play stacked by default (`LiveChannels` in web features/video/VideoPanel.tsx); `FloatingVideoPlayer` (mounted in AppShell, store `floating-video-store.ts`) keeps a live view open across pages (Pop out / Go live from the vehicle drawer and ADAS / DMS alerts); its expand button (v1.28.1) closes the floating copy and opens `/video?objectId=…&channel=…`, so the stream moves to the Video page instead of playing twice; `LiveControls` offers Snapshot, Record 10 s (Jimi) and the RTMP countdown with Extend: `POST /api/video/:objectId/capture` creates a MANUAL_CAPTURE driver event (not scored) that the uploaded photo / clip links to, `POST /api/video/:objectId/extend` resends RTMP,ON. The device form shows each model's server port (`DEVICE_PROTOCOL_PORTS` in packages/shared). **Recorded video (SD card) for Jimi cameras (v1.29.0):** the camera posts its file-name list after `FILELIST` to public `POST /api/dvr/jimi/filelist` (Caddy `http://track.veetrax.com/dvr/filelist`, 4 MB body limit in main.ts) → Valkey `vt:video:jimi:files:<imei>` (2 days); `video/jimi-recordings.ts` turns names (`yyyy_mm_dd_hh_mi_ss_<code>.mp4`, company time zone, code odd = road, even = driver, 03/04 HD 3-min, else 1-min) into recordings; `VideoService.recordings` asks again when the list is older than 60 s; `playback` sends `REPLAYLIST,<up to 5 files>` and plays MediaMTX path `live/<imei>` (mediamtx.yml) as HLS, `startsAt` = first file's start; leaving sends `REPLAYLIST,OFF`. The camera does one push at a time and refuses REPLAYLIST while live video runs ("live streaming pushing, can not executed"), so playback first stops live (`RTMP,OFF,INOUT`) and live first stops playback (`VideoService.stopPush`); replies are read with `CommandsService.sendInternalAndWait`, so a refusal shows at once. **Recordings page (v1.30.0):** web `RecordingTimeline` (scrolling lanes per camera, zoom 1–32×, ticks on local time, double-tap / double-click plays from that time, helpers `timelineSpans` / `recordingAt` in video-utils), `RecordingControls` (previous / next minute, back 10 s, play / pause, sound, 0.5×, save frame, full screen, download; faster than 1× is impossible because the camera sends in real time) and a *Download a time range* box. Downloads: `POST /api/video/:objectId/recordings/download` `{ fileNames }` (≤ 15) sends `HVIDEO,<yyyy_mm_dd_hh_mi_ss>,<1|2>` per minute and makes a MANUAL_CAPTURE driver event each; the upload is matched by IMEI or, when the name has none, by the camera minute kept in Valkey `vt:video:jimi:hv:<minute>` (DvrUploadService.pendingDownload) and appears in Video evidence (.ts = video/mp2t). The camera needs `FILELIST,http://track.veetrax.com/dvr/filelist` once (in JIMI_SETUP_COMMANDS). **ID card SOS without GPS (v1.30.1):**
  - SOS (0x99) and the card's call-SOS request (0x41 01) both raise `alarm: sos` with `noGpsFix`, and are answered with LOCATE (0x80), so the card reports a fresh fix.
  - The last fix per card is kept across connections in the gateway (`LAST_FIX`, bounded), so an SOS straight after a reconnect is at the real last position.
  - Events without GPS get unique, increasing times per session, so no history row is lost to the (deviceId, fixTime) key.
  - The alert rules raise SOS even with `locationValid: false`.
  - Parser hot path: fix time text built from the packet bytes (`zxIso`), receivedAt ISO memoised per chunk, and date replies built in one buffer: about 10 µs per frame (was 25). **ID card trackers** (v1.27.0, `docs/vendor/zhongxun-id-card/info.md`): the blue Zhongxun cards use their own port **ZHONGXUN_PORT 5032** (`gateway/zhongxun`: 78 78 framing without serial or checksum, length from each packet layout); 4G ID cards are JT/T 808-2011 on 6808 (battery 0x62 / heartbeat, temperature 2-byte 0x64, low battery 0x57, ICCID 0x0120, time 0x0121 → 0x8121 in `jt808/`). **Concox GK309E** ID card trackers (v1.24.1): 0x19 = LBS + status, the alarm packet without a GPS fix (SOS indoors), raised at the last known position (`noGpsFix`); 0x1A = fix sent on a phone request; 0x18 LBS extension acknowledged. Server SMS: `SERVER,1,<domain>,<port>,0#` or `SERVER,0,<ip>,<port>,,0#`. |
| `processor/` | `position-processor.ts` (the pipeline), `position-writer.ts` (batched DB writes), `rules/` (alert rules engine), `parked-thinning.ts` (phone points while parked). `main.ts` starts the process. |
| `tracking/` | `position-filter.ts`: jump, drift, rough-fix and clock checks. The first place to look for "wrong / jumping locations". |
| `notifier/` | `notifier.service.ts` (delivery), `push.ts` (Expo push), `sms.ts` (SMS provider), `arattai.ts` (Arattai Business: verification codes via the authentication template, alerts via the transactional template; OAuth refresh token), templates. Channels the Super Admin switched off in Platform Settings → Messaging (`MessagingSettings`: SMS, e-mail, WhatsApp, Arattai) are logged as SKIPPED. Customers see only switched-on channels (`GET /messaging/channels`; WhatsApp hidden for now); Push is on by default for every severity. Verification codes go by SMS + e-mail + Arattai (when on). Settings API and the Connect / callback flow: `templates/arattai-settings.controller.ts`. |
| `summarizer/` | Trips, stops, daily summaries (`summarizer.ts`, `segmenter.ts`), `outlier-flagger.ts`, time zones (`tz.ts`). |
| `attendance/` | Staff attendance rules and the attendance job. |
| `alerts/` | Alert settings, recipients, snoozes, offline alerts, acknowledgement. Dashcam alert types are in two categories, **ADAS (road camera)** and **DMS (driver camera)** (`ALERT_TYPES` in packages/shared/src/alerts.ts; the web/mobile Alert settings list categories in `CATEGORY_ORDER`, so a new category must be added there too). **SEATBELT_OFF** (v1.26.0) is raised from `attributes.dms = "seatbelt"` (Jimi 0xA7) via `DMS_ALERTS` in processor/rules/evaluate.ts. |
| `driver-events/` | Driver events (dashcam evidence): one per alert of `DRIVER_EVENT_TYPES`; overspeed, harsh driving and SOS only for devices with video / ADAS / DMS (`CAMERA_ONLY_EVENT_TYPES`). Photos and clips are linked by the notifier. `GET /driver-events/evidence` (menu `video_evidence`, web page Video evidence) lists events with media; filters `type`, `objectIds`, `hasMedia`. |
| `io-sensors/` | AC / door sensors (`io-logic.ts`). |
| `fuel/` | Fuel sensor calibration and refuel / drain events. |
| `mobile-tracker/` | Tracker app API: activation, uploads (`roughSpikes` filter), sessions, phone health. |
| `live/` | Live snapshot and the Socket.IO gateway (`live.gateway.ts`). |
| `history/`, `point-quality/` | History replay; "All points" analysis; Super Admin remove / restore point. |
| `reports/`, `report-schedules/` | Report queries and scheduled e-mail reports. **Times of day (v1.31.0):** `ReportRequest.fromTime` / `toTime` (HH:mm, company time zone, end minute inclusive) narrow the window of the event reports in `TIMED_REPORT_TYPES` (packages/shared history.ts: trips, stops, idle, halt, alerts, overspeed, positions, geofence / POI visits, mileage, AC / door, fuel events, trip safety, drivers, planned trips); `reportWindow` in report-data.service.ts builds it, other (whole-day) reports ignore the times; the period line of files / summaries shows them (`periodText`). Clients send the fields only when not 00:00–23:59, because the API rejects unknown fields (older servers). **TRIP_SAFETY** (v1.26.0, `trip-safety-report.ts`): stored trips with the violation alerts (`TRIP_SAFETY_TYPES`) bucketed by vehicle and time, counts, score (`TRIP_SAFETY_WEIGHTS`), occurrences with address / speed / evidence link; exports add an occurrences column; the web shows a details panel per trip (`TripSafetyDetails.tsx`). **BATTERY_HEALTH / IDLE_COST** (v1.32.0, `vehicle-health-report.ts`, pure rules in packages/shared `vehicle-health.ts`): battery health reads raw `extVoltage` (per vehicle per local day: median engine-off voltage 01:00–05:00, else all day; median while ignition on and > 5 km/h; devices whose extVoltage carries an AC / door sensor in `IoSensorConfig` are skipped) and `batteryVerdict` gives GOOD / WEAK / REPLACE / NOT_CHARGING / OVERCHARGING / NO_DATA with 12 V limits (resting ≥ 12.4 good, < 12.1 replace, falling 0.3 V = weak, charging < 13.0 or > 15.0), doubled for 24 V systems; points every 10–30 s are too sparse for the cranking dip, so it is not used; max 31 days (`BATTERY_REPORT_MAX_DAYS`). Idle cost turns DailySummary `idleSec` into litres (`IDLE_LITRES_PER_HOUR` by vehicle type, or option `idleLitresPerHour`) and ₹ (latest FUEL expense with litres in the last 120 days, ₹40–250 / L sanity range, else option `fuelPricePerL`, default ₹100). Both show on the vehicle panel (web `features/live/vehicle-health.tsx`, VeeTrax 0.8.9 `features/live/VehicleHealthRows.tsx`) through POST /reports/run, so only with the Reports permission. Tests: `vehicle-health.spec.ts`. |
| `masters/` | Companies, branches, users, roles, devices, objects, geofences, groups, audit log. **Import vehicles** (Super Admin, Device Inventory): `admin-devices/vehicle-import.ts` (pure row plan: model match, duplicates, NEW / LINK / STOCK / SKIP / ERROR, licence dates) + `vehicle-import.service.ts` (`POST /admin/devices/import/preview` and `/commit`, `GET /admin/devices/import/branches`). One sheet maps company → branch → vehicle (with Vehicle type: Car / Bus / Bike / Truck / Van / Auto…, `parseVehicleType`, empty or unknown = Car; sets the map icon, an existing vehicle keeps its type unless it has none) → device (IMEI, model, SIM) → vendor → driver → licence; only Vehicle name and IMEI are required, header names are matched loosely (`VEHICLE_IMPORT_HEADERS` in `packages/shared/src/vehicle-import.ts`). The browser reads .xls / .xlsx / .csv with SheetJS (`xlsx` from cdn.sheetjs.com, loaded on demand) and sends JSON rows. Commit is one transaction: devices, vehicles, `DeviceAssignment`, unknown vendors / drivers created, `TransportVendorVehicle` / `TransportVendorDriver`, `switchDriverTx` (MANUAL); each device takes a free seat of its company first, else an OVERRIDE seat (reason required) whose dates are the row's Licence from / until or the dialog's (default today + overrideDays). Audited as `vehicle_import` per company; caches invalidated. |
| `history-import/` | Super Admin **Import old history** (Device Inventory → Import old history): the browser reads the old platform's "Summary + Position" Excel with `parseOldPlatformSheet` (packages/shared/src/history-import.ts; columns found by header, one Positions table per day) and uploads compact rows in chunks of `HISTORY_IMPORT_CHUNK` (`POST admin/history-import` → `/:id/points` → `/:id/finish`). Points are written to `Position` for the vehicle's current device with `attributes.importId`, only before VeeTrax's own first fix (local times read in the company time zone, `localToUtcMs`; heading from consecutive points). Finish sets the company **migration hold** (`settings.historyHold` = { from: first imported day, until: today + retention days }; `heldRetentionDays` stretches retention in the summarizer meta, History and the nightly retention job until it ends) and a `SummaryDirtyDay`, so the summarizer rebuilds trips / stops / daily km with VeeTrax addresses. `finalizePending` (every minute) waits for the rebuild, then moves `odometerOffsetKm` so the odometer stays at the chosen value (+ km since it was read) and records `importedKm`. **Road snapping** (when `ROUTER_URL` is set): finish goes to MATCHING first; `runSnap` (in `finalizePending`) asks `RoutingService.roadPath` (uncached GraphHopper / Valhalla route) for each moving pair of imported points (`snapCandidate`: 10 s–15 min apart, ≥ 100 m), keeps plausible roads (`plausibleSnap`: ≤ 1.6 × straight or +400 m, ≤ 160 km/h and ≤ the faster reported end speed + 25 km/h, so gaps in the old data, e.g. stopped at both ends, stay straight lines without a made-up speed) and inserts points every 120 m along them (`pointsAlong`, attributes.roadSnapped, count in `snappedPoints`), then requests the rebuild. Old exports keep ~1 point a minute, so straight lines were ~3% short (more in towns). `/:id/road-snap` re-snaps a finished import (earlier snapped points replaced, odometer kept). `/:id/remove` deletes exactly the imported points (never the device's own) and rebuilds; the odometer stays. Records: `HistoryImport`; audited as `history_import`. |
| `access/` | Permissions, data scope and company scoping (`access-rules.ts`). Every query on business data must go through these rules. |
| `auth/` | Sign-in, OTP, JWT, sessions. |
| `licences/` | Licences, invoices, UPI / cash payments, pricing. **Invoice discount** (Super Admin Record payment only): the dialog takes % off, ₹ off or the final agreed amount (GST inclusive) → `discountPaise` on `POST licences/admin/pools/:kind/:id/quote` and `/payments`; `applyDiscount` (packages/shared/src/licences.ts) spreads it over the lines by value (largest remainder) and each line keeps `discountPaise`, so GST is charged on the discounted value. The invoice snapshot line stores `listPaise` and the discount before tax (`discountBeforeTax` = taxable value of the list price − taxable value paid); the PDF then shows Value (excl. GST), Discount and Taxable value columns and "Value before discount / Less: discount" in the totals. Partner and customer payments refuse a discount. Credit notes default to the paid share of a line. **Pro-forma** (Super Admin, same dialog → "Pro-forma PDF"): `POST licences/admin/pools/:kind/:id/proforma` saves a `LicenceProforma` (own series `<prefix>/PI/<FY>/<seq>`, `PROFORMA_VALID_DAYS` = 15, the printed snapshot from `InvoicesService.proformaSnapshot` → `buildSnapshot(..., { proforma })`, and the quoted selection `selectionOf(...)`), then the web shows it on screen (`PdfPreviewDialog`). Listed in Licences & Invoices → Invoices → Pro-forma invoices (`GET licences/admin/proformas`, `GET proformas/:id/pdf` inline, `POST proformas/:id/cancel`). Status OPEN / EXPIRED (past validUntil) / PAID / CANCELLED: recording a payment for the same selection (same seats, items and discount) marks the newest open one PAID with its tax invoice (`settleProforma`). Nothing is activated by a pro-forma and it is not a tax invoice. Audited as `licence_proforma`. Super Admin **Change dates**: `PATCH /licences/admin/pools/:kind/:id/seat-dates` (`PoolsService.setDates`; select seats in Licences → pool → Change dates). IST days (start 00:00, end 23:59:59.999), reason required, audited per seat as `licence_dates`, expiry notices reset, lock cache refreshed. |
| `stock/` | Purchases & sales (menu renamed from "Stock & sales"; platform + resellers only): items, suppliers, stores, one document type for PO → goods received → return to supplier, customer order → sale → customer return, adjustments; IMEI / SIM serials; sales invoices and credit notes; the inventory dashboard. Rules without the database in `stock-logic.ts` (moves per document, availability checks, PO progress); `stock.service.ts` saves a document and rewrites its stock moves in one transaction, refuses IMEIs not in that store, and refuses undoing goods that later documents used. Received trackers are created in Device Inventory and follow their IMEI (sold to a customer company → assigned to it; returned → back to stock) through `AdminDevicesService`. Invoices: `stock-invoices.service.ts` (platform owner details, own series `stockInvoicePrefix` / `stockCreditNotePrefix`, per-line HSN + GST). Dashboard: `stock-dashboard.service.ts` (reorder level, quantity on order, supplier lead time, POs due). **One stock register:** trackers are also kept in Stock & movements (`inventory/`, DeviceStock + StockMovement). After every save `inventory-link.service.ts` brings each touched tracker to the matching status / location there with one movement referencing `StockDoc:<number>` (rules in `inventory-link.ts`; stores / suppliers / receipts matched or created on first use and remembered in `StockStore.inventoryLocationId`, `StockSupplier.inventorySupplierId`, `StockDoc.inventoryReceiptId`). A platform sale may use trackers that are only in Stock & movements (brought in by an automatic adjustment). `POST /stock/sync-inventory?dryRun=` checks / repairs. **Supplier payments:** `StockSupplierPayment` rows against a DONE platform RECEIPT (several per bill); `supplierBill()` in `stock-logic.ts` = supplier invoice amount (else receipt total) − DONE purchase returns with `sourceId` = that receipt − payments, due on invoice date (else receipt date) + `StockSupplier.paymentTermsDays`; shown as `StockDocDto.supplierBill` and dashboard `supplierDues`; `POST /stock/docs/:id/supplier-payments` (no more than the balance), `DELETE /stock/supplier-payments/:id`; a receipt with payments cannot be cancelled or deleted. Workflow for users: `docs/inventory-modules/PURCHASES_AND_SALES_WORKFLOW.md`. Web: `apps/web/src/features/stock`. |
| `purge/` | "Delete permanently" and "Delete my account". |
| `developer/`, `public-api/`, `webhooks/` | Developer API keys, public API, signed webhooks. |
| `monitoring/` | System Health data. |
| `retention/` | Deleting old positions / raw packets per retention settings. |
| `prisma/` | Database client. Schema: `apps/api/prisma/schema.prisma`; migrations: `apps/api/prisma/migrations`. |
| `redis/keys.ts` | Every Redis key, stream and channel name in one place. |

### 2.2 Web app (`apps/web/src`)

`features/<area>/` holds each screen (live, history, dashboard, attendance, alerts, reports, masters, platform…). `components/` holds shared UI, `lib/` holds the API client (`lib/api.ts`), storage and formatting. Live map drawing is in `features/live/map/map-controller.ts`; history map in `features/history/history-map.ts`. Staff attendance Employee insights: the figures live in `packages/shared/src/attendance-insights.ts` (shared with the VeeTrax app; `features/attendance/employee-stats.ts` re-exports them, tests in `employee-stats.test.ts`) and compute the tiles, patterns and the plain-language summary (`employeeSummary`, unit-tested); `features/attendance/EmployeeCharts.tsx` draws the SVG "Hours worked each day" (within shift / overtime stacked against the shift line) and "When they worked each day" (first in to last out against the shift band) charts. Shift times come from `GET /attendance/settings` (the person's named shift, else the default); without them the charts still draw, just without the shift line. The period can be This month, Last month, Last 30 days, Last 3 months or a custom range (up to 6 months, `MAX_PERIOD_DAYS`); the calendar shows up to 93 days and the day-span chart up to 62. Each figure is compared with the previous period (`previousRange`: month to date ↔ the same dates last month) and the team (`teamFigures`, from the company timesheet, periods up to 62 days only). Patterns (`StatusSplit`, `LateByWeekday`, `TimeAway`) and the 12-month trend (`monthlyTrend` → `TrendCharts`) come from the same rows. One person's rows are fetched with `GET /attendance/timesheet?objectId=…`, which allows up to 366 days for one person (`MAX_PERSON_DAYS`; everyone stays at 62). Download: Excel (CSV) of the rows and PNG / PDF of the view through `components/page-capture.tsx`. **Basic vs advanced:** every company gets the tiles, summary, calendar, hours chart, details and CSV for This month / Last month / Last 30 days. The add-on **Advanced attendance insights** (`attendanceInsightsPlus`) adds comparisons, pattern cards, the day-span chart, the 12-month trend, Last 3 months / custom and PNG / PDF. A Super Admin switches it per company in Platform → Companies → Edit; it is stored in `Company.settings.features` (`apps/api/src/common/company-features.ts`, list in `COMPANY_FEATURES` in packages/shared) and reaches the apps as `me.company.features`; the platform company has every add-on. The API also refuses one-person timesheets over 62 days without it. VeeTrax app: Staff attendance → Employee chip lists today's staff; `apps/mobile/src/app/attendance-person.tsx` shows the same tiles, summary, calendar and hours chart, and with the add-on the comparisons, days split, late by weekday, time away and 12-month trend (periods up to 3 months; custom ranges and downloads stay on the web). To add another add-on: append it to `COMPANY_FEATURES`, add a switch to the company form and check `features.includes(...)` where it is used.

**Left menu (v1.29.0):** menus and their groups come from `MENUS` in `packages/shared/src/permissions.ts` (group order and labels: `GROUP_ORDER` / `GROUP_LABELS` in `features/shell/nav.ts`). Group *Video & safety* holds Video, Video evidence, Driver events and DMS dashboard. In `features/shell/Sidebar.tsx` each group heading opens / closes its menus (count shown when closed, Expand all / Collapse all on top); the open groups are kept per browser in localStorage `vt.nav.openGroups` (first time: Tracking only) and the group of the current page always opens. The phone / tablet drawer uses the same component.

**Public help pages (no sign-in):**
- `/guide` is the getting-started guide. Its content is `GUIDE_SECTIONS` in `packages/shared/src/guide.ts`, also used for the welcome-email PDF.
- `/guide/troubleshooting` is tracker troubleshooting for Concox / Jimi devices: first checks, GPS fix, M2M SIM whitelisting, sleep mode, alerts, power, SOS / password, filters and drift fixes. Its content is `TROUBLESHOOTING_SECTIONS` in `packages/shared/src/troubleshooting.ts`, and its server lines use `DEVICE_SERVER_HOST` / `DEVICE_SERVER_PORTS`.
- Both pages render through `features/guide/GuideSections.tsx`, which gives each command box a Copy button.
- The user menu links both pages. The getting-started guide links the troubleshooting page.
- Edit the text in `packages/shared`, not in the page.

**Grouped lists (`MasterPage` `groupBy`):**
- While the list is sorted by `groupBy.sortId`, a heading row starts each group (label plus "n on this page") and rows are numbered 1, 2, 3 inside it.
- The server must keep each group together in that sort.
- Used by Transport → Shifts & schedules → Schedules. Its default sort is `shiftName`, which gives one heading per shift and direction, e.g. "Evening (14:00–23:00) · Login".
- The API orders that sort by shift login time, then shift name, shift, direction (login first) and passenger A–Z (`listSchedules` in `etms/dispatch/schedules.service.ts`).
- Sorting by Passenger or Valid shows the plain list.

**Dispatch: Routing, Allocate vehicles, Copy yesterday (v1.16.3 trial):**

All three only fill the dispatcher's local draft. Nothing is saved until **Review & publish** (the existing change set).

- **Waiting list:** grouped by shift and time window, or by route after Routing. Each heading has a select-all box.
- **Routing:** `routeGroups` in `features/transport/dispatch/auto-allocate.ts`.
  - Bookings sharing shift, window and office end (IN drop / OUT pickup, ~100 m) are swept by bearing from the office.
  - A route closes at a 35° gap or at the largest vehicle's seats. Group rides stay together.
  - Routes are page state per day and direction. Each waiting row has a route select ("Move to route").
- **Allocate vehicles:** `allocateRoutes`.
  - Each route, biggest first, gets the smallest free vehicle that fits. Otherwise it's split over vehicles, largest first.
  - Busy vehicles, vehicles without seats and vehicles already in the draft are skipped.
  - Stop order is straight line: IN farthest first, OUT nearest first.
  - Without routes it routes first. The result becomes draft new trips with `ordered: true`.
- **Copy yesterday:** `copyDay` in `copy-day.ts`.
  - Loads yesterday's board (`fetchDispatchBoard`) and each trip (`fetchTransportTrip`).
  - Rebuilds each trip with the same vehicle, driver (`CREATE_TRIP driverId`), clock time (+1 day) and order, for people with a waiting, assignable booking today.
  - The summary dialog lists who wasn't waiting, overflow and skipped trips.
- **Draft new trips** (`dispatch-draft.ts`) gained:
  - `ordered` (the `bookingIds` order is the pickup / drop order) and `driverId` / `driverLabel`.
  - `moveInNewTrip` (↑ ↓), `moveToNewTrip`, `setNewTripVehicle`, `setNewTripDriver` and `newTripOrder`.
  - The trip card shows the stop order with ↑ ↓ and a menu (Move to another draft trip / Remove), plus Vehicle and Driver selects.
- **Tests:** `auto-allocate.test.ts`, `copy-day.test.ts`.
- **Trip sheets** (`trip-sheet.ts`): per trip (download icon on the trip card) or for every trip of the day (Trips → Trip sheets: PDF, one A4 page per trip, or one CSV). The sheet holds the vehicle, driver, shift, planned start, stops (planned and actual time, pick up / drop names), passengers (code, pickup, drop, Boarded pre-filled from outcomes, board time, signature) and odometer, signature, toll / parking and remarks lines. It's drawn with jsPDF (Latin fonts only, so Hindi / Tamil names don't print). `toSheet` / `tripSheetsCsv` are tested in `trip-sheet.test.ts`.
- **Daily transport (v1.16.5):** the Dispatch page is renamed in the menu (`etms_dispatch` label). The sidebar always hides **Route planning** (`etms_planning`); the page still opens by its address.
  - Tabs: **Roster** (shift commutes: `shiftId` set and not POINT_TO_POINT) and **Ad-hoc** (everything else). Ad-hoc shows **New ad-hoc booking** and **Group ride**.
  - A step bar shows riders waiting → routes → vehicles → started → done.
  - Desktop (v1.16.6): riders waiting are a full-width table grouped by shift and time (or by route), numbered, with Passenger, Shift, Direction, Pickup → destination, Window, Status and Route columns (`QueuePanel variant="table"`; phones keep the cards). Draft and Trips sit side by side below. The Assign helper shows only while riders are ticked. Vehicles are collapsed by default.
  - **Copy from…** offers yesterday, the same day last week or a chosen day (`copyDay` with the day difference).
  - **Add employee** opens the desk New booking dialog.
  - **▶ Start** on each published, scheduled trip card, plus **Start all**. Both use `POST /transport/trips/:id/start`.
  - The **Auto-start** switch is Transport setting `etms.autoStart`, default off.
- **TripAutoStartService** (`etms/dispatch/trip-auto-start.service.ts`):
  - Runs every minute behind a Valkey lock.
  - Starts published, not cancelled trips still SCHEDULED whose planned start has come (at most 2 h ago), in companies with autoStart on.
  - Same effect as Start: IN_PROGRESS, actualStart, the first pickup stays PENDING. Writes a STARTED event (actor and source SYSTEM) and a system audit row.
  - Skips a vehicle already on another active trip.
  - Kill switch: `ETMS_AUTO_START=off`.
  - The GPS start of the planned-trip tracker works either way.
- **v1.16.7 transport batch:**
  - **Compliance** (`packages/shared/src/transport-compliance.ts`, setting `etms.compliance` OFF / WARN / BLOCK, default WARN):
    - Required documents: vehicle RC, INSURANCE, FITNESS, PERMIT, PUC; driver DRIVING_LICENCE, POLICE_VERIFICATION.
    - The latest document of each type counts. None = MISSING; an expiry before the service date = EXPIRED.
    - The board carries `vehicles[].compliance` and `complianceMode`. WARN flags vehicles and Allocate puts compliant ones first.
    - BLOCK: Allocate skips them and `DispatchService.assertCompliant` refuses CREATE_TRIP / REASSIGN_* with 409 NOT_COMPLIANT.
  - **Vehicle form:** Masters → Objects → Add / Edit has an optional "Employee transport" section (seats, wheelchair, category, AC; `VehicleTransportFields.tsx`), saved with `PUT /transport/vehicles/:id/profile` after the vehicle. The separate Passenger seats button is gone.
  - **Transport dashboard:** `GET /transport/insights?from&to` (`etms/dispatch/transport-insights.ts`, pure `aggregateInsights` + spec).
    - KPIs: trips, carried, on-time pickups (pickup stops reached within 10 min of plan), seat use, GPS km, no-shows, missed bookings, incidents.
    - Breakdowns per day, per vehicle (the billing basis) and per shift, each downloadable as CSV.
  - **Needs attention** (`exceptions.ts` + `NeedsAttention.tsx`) on Daily transport (today): open SOS, not started 10+ min, late 10+ min, no driver, vehicle documents, boarding not recorded, waiting within 60 min, to approve, no pickup point, reached home not confirmed.
  - **Night safety** (`transport-safety.ts`, settings `nightSafety` / `nightFrom` / `nightTo` / `reachedHomeMin`):
    - Escort check (`night-safety.ts`) names the first pickup (IN) or last drop (OUT) alone inside the window, on draft trip cards and in the review.
    - `GET /transport/safety-watch` lists night drops without a passenger DROP confirmation after N minutes.
  - **Boarding OTP** (setting `etms.boardingOtp`; `etms/dispatch/boarding-code.ts`):
    - The 4-digit code is an HMAC of the passengerTripId with ETMS_BOARDING_SECRET / JWT_SECRET; nothing is stored.
    - `MeTripDto.boardingCode` is shown while the seat is PENDING. `DriverTripDetailDto.boardingCodeRequired` is set.
    - A driver BOARDED without the right `boardingCode` is REJECTED BOARDING_CODE_INVALID.
    - Mobile: the driver gets a code prompt (the queued `pin` is sent as `boardingCode`), and the passenger TripCard shows the code. Needs the next VeeTrax APK.
- **Mobile vehicle screen:** the address is under the status pill in the top card (`HeaderAddress`), no longer a Status row.
- **v1.16.9 vendors and billing (item 7 part A):**
  - Tables: `TransportVendor`, `TransportRateCard`, `TransportVendorVehicle`, `TransportVendorDriver` (migration `20261123090000_etms_vendors`, additive).
  - Code: `apps/api/src/etms/vendors/vendors.ts`, with endpoints `/transport/vendors` (CRUD, `/:id/assets`, `/:id/rate-cards`) and `GET /transport/billing/statement?month&vendorId&branchId`.
  - Menus `etms_vendors` and `etms_billing`; new Transport admin templates get them via `ETMS_VENDOR_TEMPLATE_PERMISSIONS`.
  - Rate engine (`packages/shared/src/transport-vendors.ts`, spec `etms/vendors/rate-engine.spec.ts`):
    - Models: TRIP, KM (min km, base fare), SLAB, MONTHLY (per vehicle, included km), PACKAGE (hours + km), SEAT.
    - Add-ons: night allowance and escort (company night window), waiting beyond plan + free minutes, dead km.
    - GST % per card. `pickRateCard` chooses the most specific active card valid on the day.
  - The statement prices COMPLETED / INCOMPLETE, not cancelled trips of the vendor's vehicles, from GPS `distanceKm`, actual times and employees carried, per trip and per vehicle, with GST.
  - Web: `features/transport/vendors/` (VendorsPage, RateCardsSheet, VendorBillingPage with CSV / PDF).
  - Part B (vendor bill upload, compare, approve, payments) not built.
  - v1.16.10–13:
    - Vendors are under Masters for every company (menu `etms_vendors` without the ETMS requirement); Vendor billing stays ETMS-only.
    - One page per vendor: `/vendors/:id` (`VendorDetailPage`) with branches, vehicles (type, seats, rate applied), drivers, simple rates per type (per trip / per km, from the 1st of the month) and Advanced rate cards. The vehicle form has a Vendor select (`/transport/vendors/by-vehicle/:objectId`).
    - MONTHLY card choices in params: `billIdle` (default on: billed even without trips), `prorate` (default on: fee and included km × attached days / days in month; attached = link date / card validity within the month), `extraKmSource` GPS (DailySummary km, default) / TRIPS.
    - `minMonthly` minimum guarantee on the other models (`minimumTopUp`).
    - Statement adjustments: table `TransportStatementAdjustment` (migration `20261124090000_etms_statement_adjustments`) with NOT_AVAILABLE (days; empty amount = monthly fee per day), PENALTY, TOLL_PARKING (no GST), EXTRA, DEDUCTION. Endpoints `POST` / `DELETE /transport/billing/adjustments` (etms_billing export).
    - The statement shows GPS km, idle days (attached days without trip or movement) and why a trip has no price (card not yet valid / ended / no card for the type).
  - **Open:** the ETMS isolation-matrix completeness test needs entries for the v1.16.7 / v1.16.9 routes (insights, safety-watch, vendors, billing).
- **Not yet built:** the road optimiser behind Routing, grouping on Bookings, masked calling, vendors / rate cards / billing.

### 2.3 Mobile apps

- `apps/mobile/src/app/` – screens (Expo Router: file name = route). `src/features/` – logic per area. `modules/veetrax-alarm/` – native Kotlin SOS alarm.
- Mobile reports: the list is `REPORT_DEFS` in `apps/mobile/src/features/reports/report-defs.ts` (columns shown as label/value cards), run and exported (Excel / PDF / CSV, same `/reports/run` and `/reports/export` as the web) by `src/app/reports/[type].tsx`. **Trip safety & violations** (`TRIP_SAFETY`, under Driving) shows per trip the driver, times, violation total and safety score, then only the non-zero per-type counts (`hideZero` columns; totals card likewise). The card's "N violations" button opens `features/reports/TripSafetySheet.tsx`: every occurrence with type, time, speed and address (else coordinates), **Open in maps** (Google Maps link, as on the attendance day screen) and **Watch clip / View evidence** to the driver event (with the `driver_events` permission). Pure helpers (headers, place, maps link, breakdown, score band) are in `features/reports/trip-safety.ts` with a `node --test` test. The event-type filter of the web report is not on mobile (all types, like the mobile Alerts report).
- Mobile 0.8.6: Reports → Custom shows a time next to each date for `TIMED_REPORT_TYPES`; the bottom tabs are Live map · Vehicles · Alerts · **History** (`(tabs)/history.tsx`: vehicle list, recently replayed first via `features/history/recent-vehicles.ts`) · More, and Dashboard opens from More (a stack page since 0.8.8); status count chips over the live map filter it (tap again for all); the map vehicle card lists today's finished trips (`features/history/TodayTrips.tsx`, GET /objects/:id/trips) and a tap opens History playing that trip (`playFrom` / `playTo` params). Mobile 0.8.7: with a vehicle chosen the live map shows only that vehicle (`onMap`; vehicles parked together used to pile up on it); the list header is one status chip row (statuses with no vehicles hidden) instead of the six cards, branch / group / type sit behind one Filters button with a count badge, Needs attention starts closed (remembered, `live.attention`), and list rows drop the day figures (they show on the vehicle card). Mobile 0.8.8: Dashboard is a normal stack page (`app/dashboard.tsx`, title in the root `_layout.tsx`) opened from More; as a hidden tab (`href: null`) More → Dashboard landed on the live map. Web: the shared `DateRangePicker` (alerts, driver events, video evidence, geofence visits) takes date + time (`datetime-local`, end minute inclusive) and the Reports page shows From time / To time for timed reports. Web live map (v1.31.1): a vehicle opened from a link (alert View / bell / toast, `?focus=` in `LiveMapOverlays`) goes through `focusFromLink` in `LiveMapPage`, which clears the search, status, branch / group / type and Selected only filters when they would hide it; the vehicle whose card is open always stays on the map (the map predicate keeps `activeId`). Before, opening an alert while the map was filtered to another vehicle showed the card but no icon. A new `?objectId=` while the map is open (Ask VeeTrax answer) also selects through `focusFromLink` (before, only the first one on page load was read).
- Native dashcam video (VeeTrax 0.8.0, expo-video, no new native modules): `src/app/video/[id].tsx` (params `name`, `at`, `tab`) with `features/video/LivePlayer.tsx` (every camera stacked; HLS for Jimi RTMP, progressive HTTP-FLV for JT/T 1078; sound, full screen, snapshot, record 10 s, Jimi countdown + Extend) and `features/video/RecordingsPanel.tsx` (day + time search, timeline with double-tap to play and zoom, player controls: previous / next minute, back 10 s, play / pause, sound, 0.5×, full screen, download; *Download a time range*; list). `src/app/video-evidence.tsx` lists `/driver-events/evidence` (period, clips only, optional vehicle) and plays MP4 / .ts clips in a modal; every file can be saved or shared (`lib/share-file.ts`). Players stop when the screen loses focus (`useFocusEffect`). Entry points: vehicle → Video, driver event / alert → Watch video (Recordings around the time), More → Video & safety. Helpers mirror the web's video-utils in `features/video/video.ts`.
- VeeTrax 0.8.1:
  - Vehicle screen: Status / Device are `components/CollapsibleSection.tsx`. Open state and the bigger-map toggle are remembered per phone in SecureStore (`vt.section.<id>`, `useRememberedToggle`).
  - History: a *Custom* chip for any days, at most `MOBILE_CUSTOM_MAX_DAYS` = 7 (`clampDayRange` / `dayRange` in `features/history/time-range.ts`; the API allows 31). Since 0.8.4 each end also has a time of day (`TimeField`, default 00:00 → 23:59, end minute inclusive, `dayTimeRange`; an end not after the start shows "End must be after start" and loads nothing). The time under the player bar is the current playback position. **Route with times (0.8.5):** each trip card opens `RouteTimeline` (features/history): `routeCheckpoints` picks the start, a point every 0.75 km (or trip length / 40 for long trips) and the end from the loaded track with their GPS times; addresses come from GET /geocode/reverse with the shared `['address', lat4, lng4]` query cache; the same street twice in a row shows once (`collapseSameAddress`); tapping a row replays from that time. **Quick actions (0.8.5):** `features/live/VehicleQuickActions.tsx` (History, Alerts, Share, Commands, Video and Driver events for dashcams, each only with permission) shows on the live map vehicle card and straight under the header on the vehicle page, so History is one tap from the map.
  - POI form: address search (`AddressAutocomplete` over `/geocode/search`, biased to the point). Tapping the map or "Use map centre" fills an empty Address from `/geocode/reverse`.
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

- **Every request body arrives empty / login says "email must be a string" (v1.29.0):** a path-specific body parser was registered with `app.use(path, json(...))`. Nest skips its own global JSON parser when a middleware named `jsonParser` is already on the Express stack (`ExpressAdapter.isMiddlewareApplied`). Wrap such parsers in a differently named function (see `main.ts`), and after any change to main.ts check a real login (`POST /api/auth/login` with a wrong password must answer 401, not 400).

**A device is not showing on the map**
1. Is it listed under Platform → Unknown devices (Super Admin)? Then it connects but is not registered (wrong IMEI on the device record). JT808 terminals (dashcams) report their 12-digit id without leading zeros (014800018486 → 14800018486); since v1.23.2 a JT808 device is saved that way whatever is typed (`masters/device-unique-id.ts`, also used by Import vehicles and Purchases & sales).
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

**Low device battery (LOW_BATTERY) rules** (`processor/rules/evaluate.ts`, `battery()` / `onVehiclePower()`, since v1.18.1)
- Never raised while the tracker is on vehicle power: it reports `charging: true`, or a supply voltage (`extVoltage`) of at least 9 V (`ON_POWER_VOLTAGE`). This includes the tracker's own `lowBattery` alarm.
  - Reason: the Concox V5 (GT06) reports a coarse 0–6 level that `batteryFromVoltageLevel` turns into 0–100 %. It dips for seconds (100 → 17 → 100 %) when the vehicle voltage jumps at engine start, so one reading alerted falsely.
- Off vehicle power, the battery must stay below the threshold (`thresholdPct`, default 20 %) for `afterMin` (default 5 min, editable in Alert settings) before the alert is raised. The state is kept in `AlertState.batLowEp`.
- After an alert, it is raised again only once the battery has recovered to the threshold + 5 %.
- Running on the backup battery after the wire is cut is still reported straight away by POWER_CUT.

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

**Live app.veetrax.com extras** (`ops/deploy/linux/Caddyfile`, set 2026-11-27): other sites may load the self-hosted map files `/tiles/*` (styles, Martin tiles, fonts, sprites) cross-origin; the allow-list is one `header Origin` line per site in `@tilecors_ok`, `@tilecors_no` and `@tilepreflight` (now gps.mintplus.co.in, qr.mintplus.co.in, glens.mintplus.co.in, http://localhost:5173, http://localhost:8090, http://127.0.0.1:8090). The matching Origin is echoed back, others get no Access-Control-Allow-Origin (Martin's own header is removed with `defer`), OPTIONS answers 204. `/geo/api` and `/geo/reverse` proxy to the local Photon (127.0.0.1:2322) only for GET from the IPs in `remote_ip` (166.0.242.121, 202.83.45.102) with header `X-Geo-Key` = `GEO_KEY`; everything else on `/geo` is 403, no CORS. `GEO_KEY` lives only in root-only `/etc/caddy/geo.env`, loaded by the systemd drop-in `/etc/systemd/system/caddy.service.d/geo-key.conf` (`EnvironmentFile=`); never put the key in the Caddyfile or the repo. To change the Caddyfile: back it up, `set -a; . /etc/caddy/geo.env; caddy validate --config /etc/caddy/Caddyfile`, then `systemctl reload caddy`.

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
1. Is it listed under Platform → Unknown devices (Super Admin)? Then it connects but is not registered (wrong IMEI on the device record). JT808 terminals (dashcams) report their 12-digit id without leading zeros (014800018486 → 14800018486); since v1.23.2 a JT808 device is saved that way whatever is typed (`masters/device-unique-id.ts`, also used by Import vehicles and Purchases & sales).
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

**Low device battery (LOW_BATTERY) rules** (`processor/rules/evaluate.ts`, `battery()` / `onVehiclePower()`, since v1.18.1)
- Never raised while the tracker is on vehicle power: it reports `charging: true`, or a supply voltage (`extVoltage`) of at least 9 V (`ON_POWER_VOLTAGE`). This includes the tracker's own `lowBattery` alarm.
  - Reason: the Concox V5 (GT06) reports a coarse 0–6 level that `batteryFromVoltageLevel` turns into 0–100 %. It dips for seconds (100 → 17 → 100 %) when the vehicle voltage jumps at engine start, so one reading alerted falsely.
- Off vehicle power, the battery must stay below the threshold (`thresholdPct`, default 20 %) for `afterMin` (default 5 min, editable in Alert settings) before the alert is raised. The state is kept in `AlertState.batLowEp`.
- After an alert, it is raised again only once the battery has recovered to the threshold + 5 %.
- Running on the backup battery after the wire is cut is still reported straight away by POWER_CUT.

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

**Live app.veetrax.com extras** (`ops/deploy/linux/Caddyfile`, set 2026-11-27): other sites may load the self-hosted map files `/tiles/*` (styles, Martin tiles, fonts, sprites) cross-origin; the allow-list is one `header Origin` line per site in `@tilecors_ok`, `@tilecors_no` and `@tilepreflight` (now gps.mintplus.co.in, qr.mintplus.co.in, glens.mintplus.co.in, http://localhost:5173, http://localhost:8090, http://127.0.0.1:8090). The matching Origin is echoed back, others get no Access-Control-Allow-Origin (Martin's own header is removed with `defer`), OPTIONS answers 204. `/geo/api` and `/geo/reverse` proxy to the local Photon (127.0.0.1:2322) only for GET from the IPs in `remote_ip` (166.0.242.121, 202.83.45.102) with header `X-Geo-Key` = `GEO_KEY`; everything else on `/geo` is 403, no CORS. `GEO_KEY` lives only in root-only `/etc/caddy/geo.env`, loaded by the systemd drop-in `/etc/systemd/system/caddy.service.d/geo-key.conf` (`EnvironmentFile=`); never put the key in the Caddyfile or the repo. To change the Caddyfile: back it up, `set -a; . /etc/caddy/geo.env; caddy validate --config /etc/caddy/Caddyfile`, then `systemctl reload caddy`.

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
