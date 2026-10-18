# VeeTracer — Milestone M2a technical spec

Builds on M1 (`docs/m1/M1_SPEC.md`, all conventions still apply: list/CSV/bulk/history pattern, permission guard, data scope,
audit log, error shape, Super Admin `X-Company-Id`). Requirements and feature IDs: `docs/VeeTracer_Design_Document_v2.0.pdf`.

**Already done for you (don't redo):**
- Shared types: `packages/shared/src/alerts.ts` (alert catalogue `ALERT_TYPES`, settings/recipient/snooze/pack/alert/template DTOs),
  `history.ts` (track points, trips, stops, history, geofences, reports, schedules), `geo.ts`; new menus in `permissions.ts`
  (`history`, `alerts`, `reports`, `geofences`, `alert_settings`, `message_templates`, `report_schedules`; new menu group `alerting`).
- Prisma models + applied migrations: Geofence, GeofenceTarget, GeofenceVisit, AlertSetting, RecipientList, AlertSnooze, AlertPack,
  Alert, NotificationLog, MessageTemplate(+Version), Trip, Stop, DailySummary, SummaryCursor, SummaryDirtyDay, ReportSchedule,
  ReportRun, AddressCache; `VehicleGroup.alertPriority`. **Do not edit `schema.prisma` or create migrations.** If you believe a
  schema change is unavoidable, stop and describe it in your report instead.
- Valkey keys in `src/redis/keys.ts`: `alertsChannel`, `notifyStream`/`notifierGroup`, `rulesInvalidate`, `alertState(objectId)`.
- `GeocodingService` (global, `src/geocoding`): `reverse(lat,lng) → string|null`, cached. Never call it on the processor hot path;
  use it in async/background work only (alerts' address after insert, trips/stops, reports).

## Processes (apps/api)
| Process | Entry | New in M2a |
|---|---|---|
| api | `src/main.ts` | geofence/alert/template/report APIs, `alert` socket event, report scheduler (`@Interval`) |
| gateway | unchanged | |
| processor | `src/processor/main.ts` | **rules engine** runs after status computation for every non-LATE position |
| notifier | `src/notifier/main.ts` (new) | consumes `vt:notify`, renders templates, sends email/SMS, writes NotificationLog |
| summarizer | `src/summarizer/main.ts` (new) | trips, stops, daily summaries; late-data recomputation |
Add scripts `notifier:dev`, `summarizer:dev`, `start:notifier`, `start:summarizer`; add both to `scripts/dev-start.sh` (repo root).

## Part A — Geofences, alerts engine, alert management, templates, notifications (backend)
### Geofences [GEO-01..18]
`/api/geofences` (menu `geofences`) — standard master pattern returning `GeofenceDto`. Body = GeofenceDto fields minus ids/dates.
Validate geometry: circle radius 20 m–50 km; polygon 3–500 points, non-self-intersecting not required in M2a; rectangle = 4 points.
Compute bbox columns. `appliesTo` ↔ `appliesToAll` + GeofenceTarget rows. ASSIGNED-scope users only see/edit geofences owned by
their branches or company-wide ones (read-only for company-wide). `POST /api/geofences/import` accepts GeoJSON FeatureCollection
(Polygon / Point with `radius` property) or CSV `name,lat,lng,radiusM` → creates many, returns `{created, failed[]}`.
`GET /api/geofences/:id/visits?from&to` → `GeofenceVisitDto[]`. Every change publishes `vt:rules:invalidate`.

### Rules engine (in processor) [ALR-*, ALM-01..27]
- Per company, cache: effective alert settings per object (resolved Company → Branch → Groups (highest `alertPriority` wins on
  conflict) → Object, field by field, starting from catalogue defaults), active geofences with targets, active snoozes, object
  capabilities (from the device model of the open assignment). Invalidate on `vt:rules:invalidate` and `vt:cache:invalidate`.
- Per object state in `vt:alertstate:<objectId>` (JSON): inside-geofence set with enter times, overspeed episode (start, max, last
  alert), idle episode (start, anchor point, last alert), last ignition, last battery alert, cooldowns per alert type.
- Evaluate on each non-LATE, non-INVALID position: OVERSPEED (tolerance, min duration, night limit, Critical tier, repeat, end-of-event
  summary in `data`), IDLING (engine on = ignition, else extVoltage > 13.2 V; movement tolerance; Warning/Critical; repeat; geofence
  exclusions), IGNITION_ON/OFF, GEOFENCE_ENTER/EXIT (respect geofence `notifyEnter/notifyExit`, `mode` NO_GO ⇒ entry is CRITICAL,
  KEEP_IN ⇒ exit is CRITICAL, `timeWindows`), GEOFENCE_STAY (maxStayMin), GEOFENCE_OVERSPEED (geofence speedLimitKph),
  POWER_CUT/SOS (from `attributes.alarm` values `powerCut`/`sos` — check the gateway's actual attribute names), LOW_BATTERY.
  Geofence membership uses a 15 m boundary buffer and needs 2 consecutive points to flip (anti-flapping).
  **Always** write GeofenceVisit rows on enter/exit, even when the alert is disabled.
- Skip when: setting disabled, capability unsupported, outside schedule (company timezone), snoozed (mandatory SOS ignores snoozes and
  can't be disabled below COMPANY), within cooldown.
- DEVICE_OFFLINE: raised by the API's offline sweeper when it marks an object OFFLINE (respect `afterMin` override if larger than the
  company threshold).
- Creating an alert: insert `Alert` (batch with the position batch where possible), publish `vt:alerts` `{companyId, alert: AlertDto}`,
  `XADD vt:notify` one job `{alertId}`. Target: < 50 ms added per batch at 1,000 msg/s; measure and report.
- Address: the notifier fills `Alert.address` via GeocodingService before rendering.

### Alert settings API [ALM-01..12, 28..38]
All under menu `alert_settings` unless noted.
- `GET /api/alert-types` (any logged-in) → `ALERT_TYPES` plus, per type, `supportedBy: {count, total}` for the caller's company.
- `GET /api/alert-settings?level=&targetId=` → `AlertSettingDto[]` stored at that level/target. `PUT /api/alert-settings` body
  `{level, targetId, alertType, enabled?, params?, schedule?, cooldownMin?, severity?, channels?}` upserts (null = inherit; a body with
  everything null deletes the row). `DELETE /api/alert-settings/:id` = reset to inherited. Mandatory types: `enabled:false` rejected
  below COMPANY. Validate params against the catalogue (types, min/max).
- `GET /api/alert-settings/effective?objectId=` → `EffectiveAlertSetting[]` (all types) with `sources`.
- `GET /api/alert-settings/conflicts?objectId=` → groups with conflicting settings and which one wins.
- `POST /api/alert-settings/copy` `{fromObjectId, toObjectIds[]|toGroupIds[]}`; `POST /api/alert-settings/bulk-enable`
  `{level, targetIds[], alertType, enabled}`.
- Recipients: `GET/PUT/DELETE /api/recipient-lists` (same level/target model; `alertType '*'` + `severity '*'` = defaults).
  Validation: emails, `+91` 10-digit mobiles, dedupe; `GET /api/recipient-lists/resolve?objectId=&alertType=&severity=` → final
  recipients per channel (for the UI preview and the notifier). `POST /api/recipient-lists/test` `{objectId, alertType, severity}` sends
  a test notification through the notifier and returns the NotificationLog ids.
- Snoozes: `GET/POST/DELETE /api/alert-snoozes`. Packs: `GET/POST/PATCH/DELETE /api/alert-packs`, `POST /api/alert-packs/:id/apply`
  `{level, targetIds[]}` (seed system packs: School bus, Truck, Two-wheeler, Pet).
- Settings history: `GET /api/alert-settings/history?level=&targetId=` from the audit log.

### Alerts API [ALR-06..10, ALM-14]
Menu `alerts`. `GET /api/alerts?from&to&objectId&branchId&type&severity&status&q&page&pageSize&format=csv` (scoped) → `Paginated<AlertDto>`;
`GET /api/alerts/unread-count` → `{count}` (status NEW in scope, last 7 days); `POST /api/alerts/:id/ack` `{note?}` (needs `edit`);
`POST /api/alerts/ack-all` `{ids?}`; `GET /api/alerts/:id/notifications` → `NotificationLogDto[]`.
Socket `/live`: also emit **`alert`** (AlertDto) to sockets whose scope includes the object and who hold `alerts:view`, immediately (not batched).

### Templates [TPL-01..21]
Menu `message_templates`. `GET /api/templates` (master list: system rows + caller company's overrides, each with `level`,
`overridesId`, `usedByRules`, `overrideCount` (Super Admin)); filters channel, purpose, level, status, language, `overridden=true`,
`notApproved=true`; CSV. `GET /:id`, `PATCH /:id` (company admins editing a SYSTEM row create a company override instead;
Super Admin without X-Company-Id edits system rows), `POST /:id/duplicate`, `GET /:id/versions`, `POST /:id/restore/:version`,
`POST /:id/reset` (delete company override), `POST /api/templates/preview` `{templateId|body+subject, alertId?}` → rendered sample,
`POST /api/templates/:id/test` `{to}` sends via notifier. `GET /api/templates/placeholders?purpose=` → names.
Rendering: `{{name}}` placeholders for EMAIL/PUSH; SMS uses DLT `{#var#}` slots mapped positionally from `variables` order stored in
the template body metadata — store SMS bodies with `{{name}}` placeholders and a generated DLT text, and only allow activating
SMS templates whose `approvalStatus` is APPROVED (seeded system SMS templates are APPROVED with placeholder DLT ids `DLT-PENDING-<n>`).
Seed system templates for every alert type × (EMAIL, SMS, PUSH) and SYSTEM_* purposes (EMAIL; OTP also SMS) — sensible, concise
English wording; email bodies as simple responsive HTML with the company name and a "View on map" link.
Switch the existing auth mailer/OTP to render SYSTEM_PASSWORD_RESET / SYSTEM_OTP templates.

### Notifier process [ALR-04/05, ALM-28..38]
Consumer group `notifier` on `vt:notify`. For each job: load alert + object; fill address (GeocodingService) and update Alert;
resolve recipients per channel for the alert's severity (lists + modes, roles/users/dynamic, scope check for users); render the
company template (fallback system); send. Channels in M2a: EMAIL (existing MailerService — dev transport writes `var/mail`; add SMTP
config `SMTP_URL` for real sending), SMS (provider interface; `SMS_PROVIDER=console` logs + NotificationLog; leave a stub class for
MSG91/Gupshup), INAPP is the socket event (log SKIPPED not needed), PUSH/WHATSAPP → NotificationLog SKIPPED "not configured".
Retries: 3 attempts with backoff, then FAILED. Plan limits are out of scope (billing in M2b).

### Seed additions (prisma/seed.ts — Part A owns the seed)
System templates, system alert packs, GEOFENCE_CATEGORY lookups exist already; demo company: default recipient lists (demo admin email
+ mobile), company-level overrides (OVERSPEED tolerance 5, IDLING 10 min), 3 geofences around Chennai (Depot circle 300 m at the
seed's
demo area, a polygon "Industrial Estate", a NO_GO circle), and **sync new menus into existing system roles**: for each company's
system role, add menus present in `SYSTEM_ROLES` that the role doesn't have yet (never remove or alter existing grants).

## Part B — History, trips, summaries, reports (backend)
### Summarizer process [HIS-01..05, RPT-01..02, DATA-04]
- Every 60 s: find objects with positions received (`serverTime`) after their cursor's server watermark; process positions in fixTime
  order (valid, unflagged-or-DRIFT points only; DRIFT = stationary) from `processedUntil` forward, carrying open trip/stop state in
  `SummaryCursor.state`. Trips: movement (speed > runningSpeedKph or ignition on & moving) split by stops ≥ 5 min; drop trips < 0.2 km.
  Stops: stationary ≥ 3 min (`ignitionOn` true if ignition stayed on). Daily summary per local day (company timezone): distance (haversine
  of clean points, ignore gaps > 15 min unless speed suggests movement), running/idle/stop/offline seconds that add up to the elapsed part
  of the day (gap > offlineAfterSec counts as offline), overspeed seconds/count (vs effective limit), engine seconds, trip count, first
  start/last stop, max/avg moving speed. Upsert DailySummary, Trip, Stop (unique objectId+startTime keeps reruns idempotent).
- Late data: if newly received positions have fixTime < processedUntil, add SummaryDirtyDay rows; recompute those whole days
  (delete that day's trips/stops/summary and rebuild) in the same run.
- Fill trip/stop addresses asynchronously via GeocodingService (bounded concurrency).
- Backfill: on first run for an object without cursor, start from its oldest position (respect retention).
- Throughput target: keeps up with 2,000 objects at 1 pos/2 s on this Mac; report timing per run.

### History API [HIS-*, MAP-* playback]
Menu `history` (object must be in scope). `GET /api/objects/:id/history?from&to` → `HistoryResponse`: points as `TrackPoint`
(clean points; DRIFT points collapsed; status code per point), trips/stops overlapping the range (computed on the fly from positions
when the summarizer hasn't covered the range yet), alerts in range, summary. Cap 50,000 points; simplify (Douglas–Peucker, keep stops
and alert points) beyond that and set `truncated`. Range max 31 days, clamped to company retention. Must answer a 1-day/8,640-point
request in < 300 ms (gzip on). `GET /api/objects/:id/trips?from&to`, `GET /api/objects/:id/stops?from&to`; CSV via `format=csv`.

### Reports API [RPT-01..11]
Menu `reports` (export needs `export`). `POST /api/reports/run` body `ReportRequest` → `ReportResponse` (JSON, max 10,000 rows) or
`POST /api/reports/export` body `ReportRequest & {format}` → file download (XLSX via `exceljs`, PDF via `pdfmake`, CSV). Install
`exceljs` and `pdfmake` (+types) in the api workspace. Types: SUMMARY (DailySummary aggregated by DAY/WEEK(ISO, Monday)/MONTH in
company tz, per vehicle + totals row), TRIPS, STOPS, IDLE (stops with ignitionOn), ALERTS, GEOFENCE_VISITS (GeofenceVisit). Durations
in seconds in JSON; files show `hh:mm:ss`, local times, company name, period, generated-at, totals. PDF: landscape A4, clean table.
Scope: `ReportScope` intersected with caller's data scope; empty = everything in scope.

### Scheduled reports [RPT-07..10]
Menu `report_schedules`: standard master pattern for `ReportScheduleDto` (users see their own; COMPANY-scope admins see all).
Validate recipients (emails), compute `nextRunAt` in company tz. Scheduler in api (`@Interval(60_000)`, lock via Valkey `SET NX` so
only one api instance runs it): due schedules → ReportRun → generate with the **owner's current scope** for the previous complete
period (DAILY = yesterday, WEEKLY = last Mon–Sun, MONTHLY = last month) → save file under `var/reports/` → email with attachment
(extend MailerService additively: `attachments`) using template SYSTEM_SCHEDULED_REPORT → update lastRunAt/nextRunAt.
`GET /api/report-runs?scheduleId=` → `ReportRunDto[]`; `GET /api/report-runs/:id/file` download; `POST /api/report-schedules/:id/run-now`.

## Part C — Web: history, playback, reports [HIS-*, ANI-01..07, RPT-*]
- **History & Playback** (`/history`, deep link `?objectId=&from=&to=`): vehicle picker (search), date-range presets (Today, Yesterday,
  Last 7 days, custom with time), map with the track (line coloured by status/speed, toggle), start/end markers, stop markers
  (P = parked, I = idle) with durations, alert markers; **playback** per design ANI-01..07: play/pause, 1×/2×/4×/8×/16×, scrubber
  timeline with trip segments and alert ticks, moving vehicle icon rotating with course, progressively drawn path, follow camera
  toggle, live data panel (time, speed, ignition, status, address on pause via `/api/geocode/reverse` if available else coords),
  speed chart synced with the cursor (lightweight SVG/canvas, no heavy chart lib unless already installed), jump to stop/alert.
  Side panel tabs: Trips (click = zoom + play that trip), Stops, Alerts, Summary (distance, running/idle/stop time).
  60 fps target: interpolate on the client from the point array; never React-render per frame (imperative MapLibre updates).
  Respect reduced motion (no auto-camera animation). Light/dark map styles as on the live map (reuse `map-style.ts`).
- Live map drawer: add a "History" action that deep-links to playback for that object (today).
- **Reports** (`/reports`): report type cards, scope picker (branches, vehicle groups, vehicles — multi-selects; empty = all), date
  range, period (Summary), Run → results table (sortable, sticky header, totals row, durations `hh:mm`), export buttons XLSX/PDF/CSV
  (permission `export`), charts for Summary (daily distance bars, running/idle/stop stacked bar) — simple SVG components.
- **Scheduled Reports** (`/reports/schedules`): MasterPage with form (name, report types multi, scope, period, frequency + day + time,
  format, recipients chips with validation, active), row actions Run now, Runs history drawer with download links.

## Part D — Web: geofences, alerts, alert management, templates
- **Geofences** (`/masters/geofences`): MasterPage list + full-screen editor dialog/page with map: draw circle (click centre + drag
  radius, or numeric radius), polygon (click points, double-click to finish, drag vertices, delete vertex), rectangle (drag); search
  an address (`/api/geocode/search` if exposed, else skip) / "use vehicle location" picker; fields: name, category (lookup
  GEOFENCE_CATEGORY), colour, branch owner, mode (Normal / No-go / Keep-inside), notify enter/exit, max stay, zone speed limit, time
  windows editor, applies-to (all / branches / groups / vehicles); import GeoJSON/CSV dialog; visits tab. Implement drawing with
  MapLibre GeoJSON sources + pointer events yourself (no terra-draw/mapbox-gl-draw unless you judge it clearly better — then install
  it and say why).
- Live map: "Geofences" layer toggle (fill + outline + label, colour per geofence), alert markers layer toggle.
- **Alerts** (`/alerts`): list with filters (date range, vehicle, branch, type, severity, status, search), severity badges, ack /
  ack-all with note, row → detail sheet (map snippet, data fields, notification log). CSV export.
- **Realtime alerts** in the shell: bell with unread count (`/api/alerts/unread-count` + socket `alert`), dropdown of latest 20,
  toast slide-in per alert, **sound** for WARNING/CRITICAL (small bundled audio or WebAudio beep; user mute toggle saved locally),
  CRITICAL alerts open a modal that stays until acknowledged. Clicking an alert → live map focused on that vehicle.
- **Alert Settings** (`/alerting/settings`): left = level tree (Company → Branches; Vehicle groups; Vehicles search), right = alert
  type cards grouped by category. Each card: enable toggle, severity, params form from catalogue `params` (units, hints, null = inherit),
  schedule (days + from/to), cooldown, channels per severity (chips INAPP/EMAIL/SMS/WHATSAPP/PUSH), recipients section (per channel:
  mode select + entries editor with users/roles/dynamic/email/mobile; company default lists editable at Company level), "inherited from
  …" badges per field with Reset, mandatory lock icon for SOS, "supported by N of M" at group level / "Not supported by this device"
  at object level, conflict warning at object level. Extra panels: Effective settings (object), Snoozes (create with until + types),
  Packs (apply to targets), Copy settings, History. Send test button.
- **Message Templates** (`/alerting/templates`): Template Master table (columns per design TPL-17; filters; badges for level/status),
  row actions (view, edit, preview, test, duplicate, history, reset, activate). Editor: subject + body (email: textarea with HTML
  preview toggle; no WYSIWYG lib needed), placeholder picker inserting `{{name}}` at the cursor, live preview pane rendering with sample
  data via `/api/templates/preview`, SMS character/part counter (GSM 160/153, Unicode 70/67) and DLT fields + approval status.
- Sidebar: label for the new `alerting` group = "Alert Management". Router: add the new pages.

## Coordination rules (parallel builders)
- Part A owns: `src/masters/geofences*`, `src/alerts/**`, `src/templates/**`, `src/notifier/**`, rules engine files under
  `src/processor/rules/**` plus the minimal hook in `position-processor.ts`, offline-sweeper alert hook, `live.gateway.ts` alert emit,
  `prisma/seed.ts`, auth OTP/reset template switch.
- Part B owns: `src/summarizer/**`, `src/history/**`, `src/reports/**`, `src/report-schedules/**`, MailerService attachment extension.
- Part C owns: `apps/web/src/features/history/**`, `features/reports/**`. Part D owns: `features/geofences/**`, `features/alerts/**`,
  `features/alerting/**`, `features/templates/**`, live-map geofence/alert layers, shell bell.
- Shared files (`app.module.ts`, `apps/api/package.json` scripts, `scripts/dev-start.sh`, `apps/web/src/app/router.tsx`,
  shell nav): re-read immediately before editing and make minimal, additive edits only.
- Don't change `packages/shared` or the Prisma schema; report needed changes instead.
- Keep all M1 tests green; add tests for your pure logic (rules evaluation incl. inheritance, anti-flapping, schedules/timezones,
  trip/stop/summary segmentation incl. late data, report aggregation by period, SMS part counting, recipient resolution).

## Definition of done
1. Simulator 20 devices: alerts appear in the web bell + toast within ~2 s (overspeed, idling, ignition, geofence enter/exit on the
   seeded geofences, SOS), emails rendered into `var/mail`, SMS logged, NotificationLog rows. Settings changes (e.g. disable overspeed
   for one vehicle, snooze a group) take effect within seconds.
2. History playback of a vehicle's last hours runs smoothly with trips/stops/alerts.
3. Summary report day/week/month matches DailySummary; XLSX/PDF/CSV open correctly; a scheduled report (run-now) arrives in `var/mail`
   with the attachment.
4. 2,000 devices at ~1,000 msg/s: processor + rules engine keep up (report numbers), summarizer keeps up.
5. Builds/tests green: api `npm run build && npm test`, web `npm run build && npm test`.
