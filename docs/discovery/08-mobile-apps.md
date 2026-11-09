# 08 · Mobile apps (VeeTrax customer app and VeeTrax Tracker)

Scope: `apps/mobile` (customer app **VeeTrax**), `apps/tracker` (phone-as-GPS-tracker **VeeTrax Tracker**), `tooling/expo`, `brand/store`, `docs/mobile-tracker/`.
Method: read-only static review of the source at `main` @ `17a2e63` (2026-11-08). Nothing was built or run.

**Legend:** **Confirmed** = read in code/config. **Inferred** = reasoned from code, not verified at runtime or against the server.
**Screenshots: pending.** No device or emulator was used; all UI descriptions come from the code.

> **Correction to `docs/HANDOFF.md`:** it says the mobile apps are Flutter ([HANDOFF.md:17](../HANDOFF.md#L17), [:59](../HANDOFF.md#L59), [:140](../HANDOFF.md#L140)) and "Not started". That is wrong. Both apps are **Expo SDK 58 / React Native 0.88 / React 19.3 / TypeScript 6** with expo-router, and both have shipped Play releases (VeeTrax 0.6.7 build 67, Tracker 1.4.3 build 28). Confirmed.

Recent history (`git log -- apps/mobile apps/tracker`), newest first:
- `17a2e63` reverts the server-side "AC/door last reading not 'now' when offline" change (it touched only `apps/api`).
- `47924fa` VeeTrax **0.6.7 (67)**.
- `c97de1d` "SOS without the full-screen permission". Play did not pre-grant `USE_FULL_SCREEN_INTENT`. Instead, the alarm wakes the screen, re-posts its banner every 20 s and opens the SOS screen when the app is opened.
- `b167219` 0.6.6, account-deletion wording.
- `9c0db5b` **Tracker 1.4.3**.
- Earlier: the Enterprise restyle (0.6.2 / Tracker 1.4.1), check-in photo/video proof, SOS alarm with the app closed (0.6.0), and Tamil/Hindi in the Tracker (1.3.9).

---

## Part A — VeeTrax (customer app, `apps/mobile`)

### A1. Stack and configuration

| Item | Value | Evidence |
|---|---|---|
| Name / slug / scheme | `VeeTrax` / `veetracer` / `veetrax://` | [app.json:3-8](../../apps/mobile/app.json#L3) |
| Version | `0.6.7`, Android `versionCode` 67 | [app.json:5](../../apps/mobile/app.json#L5), [:27](../../apps/mobile/app.json#L27) |
| Bundle IDs | Android `com.sasvata.veetrax`, iOS `com.sasvata.veetrax`. Portrait only, no tablet | [app.json:12](../../apps/mobile/app.json#L12), [:26](../../apps/mobile/app.json#L26) |
| Theme | `userInterfaceStyle: automatic`, adaptive icon background `#0E5E57`, predictive back off | [app.json:9-25](../../apps/mobile/app.json#L9) |
| Blocked permissions | SYSTEM_ALERT_WINDOW, READ/WRITE_EXTERNAL_STORAGE, USE_BIOMETRIC/FINGERPRINT, READ_MEDIA_IMAGES/VIDEO, RECORD_AUDIO | [app.json:28-37](../../apps/mobile/app.json#L28) |
| Permissions actually added (Inferred from plugins and modules) | INTERNET, POST_NOTIFICATIONS, VIBRATE, CAMERA (expo-image-picker, for bill photos), plus from the alarm module: FOREGROUND_SERVICE, **FOREGROUND_SERVICE_MEDIA_PLAYBACK**, **USE_FULL_SCREEN_INTENT**, WAKE_LOCK, MODIFY_AUDIO_SETTINGS. No location permission (the customer app never reads the phone's GPS) | [veetrax-alarm AndroidManifest.xml:2-7](../../apps/mobile/modules/veetrax-alarm/android/src/main/AndroidManifest.xml#L2) |
| Camera features | `android.hardware.camera*` marked optional, so Play does not hide the app on phones without a camera | [app.config.js:14-25](../../apps/mobile/app.config.js#L14) |
| iOS | Only `ITSAppUsesNonExemptEncryption:false`. No background modes. No Critical Alerts entitlement | [app.json:14-16](../../apps/mobile/app.json#L14), [README.md](../../apps/mobile/README.md) |
| Plugins | expo-router, expo-splash-screen, MapLibre RN, expo-secure-store, datetimepicker, expo-sharing, expo-notifications (icon, colour, `sos_siren.wav`), expo-localization, `tooling/expo/with-release-signing.js` (alias `veetrax`), expo-image-picker (camera only) | [app.json:42-81](../../apps/mobile/app.json#L42) |
| Experiments | `typedRoutes`, `reactCompiler: true` | [app.json:82-85](../../apps/mobile/app.json#L82) |
| Firebase | `app.config.js` adds `googleServicesFile` only when `google-services.json` (git-ignored) or the `GOOGLE_SERVICES_JSON` env var exists. **The file is not in the working tree**, so a local build made here has no FCM and push stays off (Inferred) | [app.config.js:27-31](../../apps/mobile/app.config.js#L27) |
| EAS | `projectId` set, owner `karthick5206`. Profiles `base` (Node 22.22.2, `EXPO_PUBLIC_SERVER_URL=https://gps.mintplus.co.in`), `preview` (internal), `production` (store, `autoIncrement`), `appVersionSource: remote` | [eas.json](../../apps/mobile/eas.json), [app.json:92-96](../../apps/mobile/app.json#L92) |
| Native folders | None committed (CNG / `expo prebuild`). One local Expo module: `modules/veetrax-alarm` (Kotlin: FCM service subclass, alarm foreground service, JS bridge) | [modules/veetrax-alarm](../../apps/mobile/modules/veetrax-alarm/index.ts) |
| Routes root | `src/app/` (not `app/`) | [AGENTS.md](../../apps/mobile/AGENTS.md) |

**API base URL.** `SERVER_URL = EXPO_PUBLIC_SERVER_URL || 'https://gps.mintplus.co.in'` and `API_URL = ${SERVER_URL}/api`. The socket.io namespace is `${SERVER_URL}/live` (websocket transport only, token in the `auth` callback, `companyId` for Super Admin). Basemaps are OpenFreeMap liberty, positron and dark, each overridable by env var. Satellite settings come from `GET /maps/config`. Sources: [config.ts:2-11](../../apps/mobile/src/lib/config.ts#L2), [realtime.ts:65-68](../../apps/mobile/src/features/live/realtime.ts#L65), [basemap.ts](../../apps/mobile/src/features/map/basemap.ts). Confirmed.

**Auth and token storage** (Confirmed):
- **Access token** in memory only. **Refresh token** and the Super-Admin `companyId` live in `expo-secure-store` (`vt.refreshToken`, `vt.companyId`): [session.ts:10-21](../../apps/mobile/src/lib/session.ts#L10).
- Single-flight refresh on 401 via `POST /auth/refresh`, then sign-out: [api.ts:117-145](../../apps/mobile/src/lib/api.ts#L117).
- `X-Company-Id` header for the Super Admin: [api.ts:69-79](../../apps/mobile/src/lib/api.ts#L69).
- Sign-in methods: e-mail + password (`/auth/login`) and mobile OTP (`/auth/otp/request`, `/auth/otp/verify`): [login.tsx:27-69](../../apps/mobile/src/app/login.tsx#L27).
- Permissions come from `/auth/me` through `can(menu, action)` in `@veetracer/shared`: [auth.tsx:118](../../apps/mobile/src/features/auth/auth.tsx#L118).
- Sign-out unregisters push, calls `/auth/logout` and clears the query cache: [auth.tsx:51-59](../../apps/mobile/src/features/auth/auth.tsx#L51).

**Push notifications** (Confirmed unless marked):
- Server → Expo push → FCM/APNs. The app registers its Expo token with `POST /auth/push-token` after sign-in and removes it with `/auth/push-token/remove` on sign-out. A test send goes through `/auth/push-token/test`: [push.ts:65-101](../../apps/mobile/src/features/notifications/push.ts#L65).
- Android channels: `alerts` (HIGH) and `sos` (MAX, siren `sos_siren.wav`, `bypassDnd`, public on the lock screen, red light): [push.ts:43-62](../../apps/mobile/src/features/notifications/push.ts#L43).
- In the foreground, emergency notifications are shown without sound, because the SOS screen plays the siren itself: [push.ts:26-33](../../apps/mobile/src/features/notifications/push.ts#L26).
- `AlarmMessagingService` extends Expo's FCM service. For pushes on the `sos` channel with the app **not** in the foreground, it starts `AlarmService`: [AlarmMessagingService.kt:13-24](../../apps/mobile/modules/veetrax-alarm/android/src/main/java/com/sasvata/veetrax/alarm/AlarmMessagingService.kt#L13).
- `AlarmService` is a mediaPlayback foreground service. It loops the siren on `USAGE_ALARM`, **raises the alarm stream to maximum** (restored afterwards), vibrates, holds a wake lock, rings for at most 5 minutes, posts a full-screen-intent notification, and re-posts the banner every 20 s when full-screen is not allowed: [AlarmService.kt:73-190](../../apps/mobile/modules/veetrax-alarm/android/src/main/java/com/sasvata/veetrax/alarm/AlarmService.kt#L73).

### A2. Navigation map

Root: a `Stack` with `Stack.Protected` guards (signed-in group and `login`), themed with the brand band: [_layout.tsx:43-78](../../apps/mobile/src/app/_layout.tsx#L43).
Tabs (lucide icons, saffron bar over the active tab, unread badge on Alerts): [(tabs)/_layout.tsx:76-103](../../apps/mobile/src/app/%28tabs%29/_layout.tsx#L76).
The tabs layout also:
- opens the socket (`useLiveConnection`);
- registers push;
- opens the SOS screen for an alarm that is ringing natively (`ringingAlertId`) when the app comes to the foreground;
- opens the SOS screen for alarm-type alerts that arrive live over the socket.

**37 screens** (5 tabs + 32 stack routes) and 2 layouts. "Role visibility" means the `can()` checks in the client; the server also enforces permissions (Inferred).

| Screen | File | Purpose | Layout and components | Actions | Data / API | Role visibility |
|---|---|---|---|---|---|---|
| Live map (tab) | [(tabs)/index.tsx](../../apps/mobile/src/app/%28tabs%29/index.tsx#L100) | Fleet map plus list | MapLibre `FleetMap`, draggable `LiveSheet` bottom sheet, status cards, branch/group filters, basemap switcher (Standard/Light/Satellite), POI layer, Ask FAB | Select a vehicle → Details; add a POI at the map centre; filter | Socket `/live` (live-store), `/pois?bbox`, `/branches`, `/vehicle-groups` | Always shown. POIs need `pois`; filters need `branches` / `vehicle_groups` |
| Vehicles (tab) | [(tabs)/vehicles.tsx](../../apps/mobile/src/app/%28tabs%29/vehicles.tsx#L13) | Searchable list of live objects | Cards | Open vehicle | live-store | Always |
| Alerts (tab) | [(tabs)/alerts.tsx](../../apps/mobile/src/app/%28tabs%29/alerts.tsx#L70) | Infinite alert list with type tabs and unread tint | Cards, Chips | Mark all read; acknowledge all | `/alerts`, `/alerts/unread-count`, `/alerts/ack-all`, `/alerts/read-all` | Tab hidden without `alerts`. Acknowledge-all needs `alerts:edit` |
| Dashboard (tab) | [(tabs)/dashboard.tsx](../../apps/mobile/src/app/%28tabs%29/dashboard.tsx#L136) | Status tiles (share of fleet), top lists, AC/door sensors, alert types | Tiles, bars | Drill into vehicles / alerts | `/dashboard/overview?top=5` | Tab hidden without `dashboard` |
| More (tab) | [(tabs)/more.tsx](../../apps/mobile/src/app/%28tabs%29/more.tsx#L48) | Grouped menu plus settings | MenuGroup/MenuItem, ThemePicker, DisplaySizeCard, LanguageChips, VoiceAlertsCard, EmergencyAlertsCard, PushTestButton | Navigate; sign out; "Track this phone" (opens `veetrax-tracker://` or the Play Store) | — | Each item gated ([more.tsx:102-129](../../apps/mobile/src/app/%28tabs%29/more.tsx#L102)) |
| Sign-in | [login.tsx](../../apps/mobile/src/app/login.tsx#L104) | Password or mobile-OTP sign-in | Brand band, Chips (method), LanguageChips | Sign in; request/verify OTP | `/auth/login`, `/auth/otp/request`, `/auth/otp/verify` | Signed-out users only |
| Vehicle details | [vehicle/[id].tsx](../../apps/mobile/src/app/vehicle/%5Bid%5D.tsx#L34) | Live figures (speed, ignition, AC, door, fuel, power, battery, GSM, satellites, odometer, today km), driver, SIM, maintenance | InfoRows, action tiles | History, Alerts, Share, Commands, Video, Driver events, Call | live-store, `/video/{id}/channels` | Tiles: `history`, `alerts`, `live_map:command`, `video`, `driver_events`. **Share is not gated by permission** ([:143](../../apps/mobile/src/app/vehicle/%5Bid%5D.tsx#L143)) |
| History / playback | [history/[id].tsx](../../apps/mobile/src/app/history/%5Bid%5D.tsx#L44) | Track playback | Map, SeekBar, TrackLegend, minimisable playback card, PlaybackAddress | Play/pause, speed, seek, period; live reload every 20 s when the period includes now | `/objects/{id}/history?from&to` | Reached through the `history` tile |
| Alert detail | [alert/[id].tsx](../../apps/mobile/src/app/alert/%5Bid%5D.tsx#L22) | One alert, dashcam snapshot, acknowledge with a note | Card, image | Acknowledge; open vehicle / driver event | `/alerts/{id}`, `/driver-events/by-alert/{id}`, `/alerts/{id}/ack` | Acknowledge needs `alerts:edit` |
| SOS alarm | [sos/[id].tsx](../../apps/mobile/src/app/sos/%5Bid%5D.tsx#L61) | Full-screen red alarm (fullScreenModal, no swipe-back) | Big buttons | Acknowledge, Silence, Call (driver or SIM), Navigate; `?test=1` makes no API calls | `/alerts/{id}`, `/alerts/{id}/ack` | Acknowledge needs `alerts:edit`. Rings even when the alert can't be loaded |
| Commands | [commands/[id].tsx](../../apps/mobile/src/app/commands/%5Bid%5D.tsx#L25) | Send a device command and follow its delivery | List plus form, monospace output | Send | `/objects/{id}/commands/available`, `/objects/{id}/commands` (GET/POST) | `live_map:command` |
| Share live location | [share/[id].tsx](../../apps/mobile/src/app/share/%5Bid%5D.tsx#L17) | Time-limited share link, optional destination | Form, list | Create, revoke, share | `/live-shares`, `/live-shares/{id}/revoke`, `/geocode/search` | Not gated in the client |
| Ask VeeTrax | [ask.tsx](../../apps/mobile/src/app/ask.tsx#L38) | Plain-language questions ("no AI"); answer links mapped to app screens | Chat-like cards | Ask | `POST /ask` | `live_map` |
| Reports list | [reports/index.tsx](../../apps/mobile/src/app/reports/index.tsx#L12) | 31 report types in sections | SectionList | Open a report | — (`report-defs.ts`) | `reports`; the attendance section needs `attendance` |
| Report run | [reports/[type].tsx](../../apps/mobile/src/app/reports/%5Btype%5D.tsx#L91) | Filters, run, row cards | Cards | Run; export XLSX/PDF/CSV through the share sheet | `/reports/run`, `/reports/export` | Export needs `reports:export` |
| Geofences | [geofences/index.tsx](../../apps/mobile/src/app/geofences/index.tsx#L16) / [[id].tsx](../../apps/mobile/src/app/geofences/%5Bid%5D.tsx#L24) | List, then a map editor (circle/polygon, place search) | Map, PlaceSearch | CRUD | `/geofences` | `geofences:*` |
| POIs | [pois/index.tsx](../../apps/mobile/src/app/pois/index.tsx#L14) / [[id].tsx](../../apps/mobile/src/app/pois/%5Bid%5D.tsx#L28) | Points of interest | List, map form | CRUD | `/pois`, `/branches` | `pois:*` |
| Parking mode | [parking/index.tsx](../../apps/mobile/src/app/parking/index.tsx#L28) / [[id].tsx](../../apps/mobile/src/app/parking/%5Bid%5D.tsx#L68) | Weekly armed windows per vehicle | Cards, schedule editor | Save schedule | `PUT /parking-mode` | `parking_mode` / `:edit` |
| Alert settings | [alert-settings.tsx](../../apps/mobile/src/app/alert-settings.tsx#L266) | Per-type thresholds and channels by level (company/branch/object) | Cards, RecipientsCard | Save | `/alert-settings`, `/alert-settings/effective` | `alert_settings` (+ edit/create) |
| Documents and service | [documents/index.tsx](../../apps/mobile/src/app/documents/index.tsx#L152), [documents/[id].tsx](../../apps/mobile/src/app/documents/%5Bid%5D.tsx#L30), [documents/service/[id].tsx](../../apps/mobile/src/app/documents/service/%5Bid%5D.tsx#L65) | Expiring documents; service reminders and records | Tabs, lists, forms | CRUD; mark service done (can end maintenance) | `/documents`, `/service-reminders`, `/service-reminders/records`, `/service-reminders/{id}/done` | `documents:*`; ending maintenance needs `objects:edit` |
| Driver events | [driver-events/index.tsx](../../apps/mobile/src/app/driver-events/index.tsx#L33) / [[id].tsx](../../apps/mobile/src/app/driver-events/%5Bid%5D.tsx#L19) | ADAS/DMS/crash events with cabin snapshots | List, image | Review; watch the video (opens the web page) | `/driver-events`, `/driver-events/{id}/review` | `driver_events`, `video` |
| Driver scorecard | [driver-scores.tsx](../../apps/mobile/src/app/driver-scores.tsx#L16) | Safety leaderboard | List | Change period / by | `/driver-scores` | `driver_scores` |
| Staff attendance | [attendance.tsx](../../apps/mobile/src/app/attendance.tsx#L97), [attendance-day.tsx](../../apps/mobile/src/app/attendance-day.tsx#L104) | Day board and timesheet; one person's day with selfie/video proof | Lists, `expo-video` player | Decide outings; manual correction | `/attendance`, `/attendance/timesheet`, `/attendance/outing`, `/attendance/correction` | `attendance` / `:edit` |
| Fuel and expenses | [expenses.tsx](../../apps/mobile/src/app/expenses.tsx#L19) | Recent entries; add with a bill photo (camera) | List, form | Add | `/expenses`, `/expenses/{id}/photo` (multipart via XHR) | `expenses` / `:create` |
| Licences and invoices | [licences.tsx](../../apps/mobile/src/app/licences.tsx#L18) | Seats, expiries, invoices, credit notes | Cards | Share PDFs; "Buy on the web" (Android only) | `/licences/overview`, `/invoices`, `/credit-notes` | `billing`, not Super Admin. **No `Stack.Screen` entry**, so the header shows the raw route name (Confirmed by absence in [_layout.tsx](../../apps/mobile/src/app/_layout.tsx#L43)) |
| Manage list / record | [manage/[kind]/index.tsx](../../apps/mobile/src/app/manage/%5Bkind%5D/index.tsx#L16), [[id].tsx](../../apps/mobile/src/app/manage/%5Bkind%5D/%5Bid%5D.tsx#L269) | Generic CRUD for `vehicles`, `devices`, `drivers` (`features/manage/kinds.ts`) | List, forms, choice fields | CRUD | `/objects`, `/devices`, `/drivers`, `/branches` | `objects` / `devices` / `drivers` (+ create/edit/delete) |
| Profile | [profile.tsx](../../apps/mobile/src/app/profile.tsx#L20) | Name, e-mail, mobile, password; **delete account** (store requirement) | Form | Save; change password; delete | `PATCH /auth/me`, `/auth/me/password`, `/me/account/delete` | Any user |
| Switch company | [company.tsx](../../apps/mobile/src/app/company.tsx#L20) | Super Admin company switcher | Infinite list | Pick a company | `/admin/companies` | Super Admin (menu) |
| Family members | [family.tsx](../../apps/mobile/src/app/family.tsx#L19) | Add a family phone with OTP consent | Form, list | Request/verify | `/family/members*` | Non-business accounts with `devices:create` |

Hidden or modal routes: `sos/[id]` (fullScreenModal), `login` (signed-out only), and `commands`, `share`, `history`, which open only from Vehicle details. The `Licences` header bug is noted in the table.

### A3. Visual design

- **Theme tokens** ([lib/theme.ts](../../apps/mobile/src/lib/theme.ts)) mirror the web `index.css`. There are five themes: **Teal & Saffron** (default: primary `#0e5e57`, brand band `#0b3b36`, accent `#ffb443`), **Plum & Pink**, **Sky & Cobalt**, **Light** and **Dark** (background `#08121d`, primary `#2bb3a3`). There are soft status pairs for chips. The theme preference is saved to the user profile, so web and app match ([auth.tsx:105-108](../../apps/mobile/src/features/auth/auth.tsx#L105)). Confirmed.
- **Look:** an "Enterprise" brand header band on every screen, with the status bar following the band (`useBrandBarStyle`). A white tab bar with a saffron marker over the active tab. Cards with hairline borders.
- **Typography:** system font only. No custom fonts are loaded; `expo-font` is unused, and monospace is used only for command output ([commands/[id].tsx:104](../../apps/mobile/src/app/commands/%5Bid%5D.tsx#L104)). Users can change text size and map icon size (`DisplaySizeCard`, synced to the profile).
- **Icons:** `lucide-react-native` everywhere. Vehicle map icons are PNGs rendered from the web icon code (`scripts/gen-vehicle-icons.mjs`), so both maps match.
- **Declared but unused (Confirmed by grep):** `expo-glass-effect`, `expo-haptics`, `expo-symbols`, `@expo/ui`, `expo-font`. The app has no glass effects and no haptics. Vibration is used only by the siren.
- **Motion:** [lib/motion.ts](../../apps/mobile/src/lib/motion.ts) respects Reduce Motion and pauses while the app is in the background. Marker pulses, a blinking live dot, list fade-ins, and walking/running person figures on the map.
- **States:** shared `EmptyState`, `ErrorBanner` (with retry) and `ActivityIndicator` from [components/ui.tsx:158-195](../../apps/mobile/src/components/ui.tsx#L158). There is a "Vehicle not found / no longer have access" state. The SOS screen is solid red `#c62828`.
- **Web parity:** same themes, same vehicle icons, same basemaps, same report definitions, and shared i18n (`@veetracer/shared` en/hi/ta). Good consistency (Confirmed by design; visual parity unverified until screenshots exist).

### A4. Features

| Feature | Status | Evidence / notes |
|---|---|---|
| Live map (MapLibre, rotated status-tinted icons, filters, basemaps, POIs, bottom sheet) | **Implemented** | [FleetMap.tsx](../../apps/mobile/src/features/map/FleetMap.tsx#L79), [LiveSheet.tsx](../../apps/mobile/src/features/live/LiveSheet.tsx#L7) |
| Realtime (socket.io `/live`, token refresh on reconnect) | **Implemented** | [realtime.ts:65-92](../../apps/mobile/src/features/live/realtime.ts#L65) |
| Vehicle list / details | **Implemented** | see A2 |
| History playback (rAF engine, interpolation, seek, live reload) | **Implemented** | [playback-engine.ts:25](../../apps/mobile/src/features/history/playback-engine.ts#L25) |
| Alerts list / detail / acknowledge / read sync across devices | **Implemented** | [(tabs)/_layout.tsx:62-73](../../apps/mobile/src/app/%28tabs%29/_layout.tsx#L62) |
| SOS alarm: foreground (socket or push) | **Implemented**: siren loop with expo-audio, plays in iOS silent mode, vibration, Ack/Silence/Call/Navigate | [siren.ts](../../apps/mobile/src/features/notifications/siren.ts), [sos/[id].tsx](../../apps/mobile/src/app/sos/%5Bid%5D.tsx#L61) |
| SOS alarm: app closed (Android) | **Implemented**: native foreground service with siren, wake, re-posted banner, full-screen intent when allowed | [AlarmService.kt](../../apps/mobile/modules/veetrax-alarm/android/src/main/java/com/sasvata/veetrax/alarm/AlarmService.kt#L73) |
| SOS alarm: app closed (iOS) | **Partial**: an ordinary notification sound (at most 30 s), respects the silent switch, no Critical Alerts | [README.md](../../apps/mobile/README.md) |
| Emergency settings (test alarm, DND override channel, full-screen permission prompt) | **Implemented** | [EmergencyAlertsCard.tsx](../../apps/mobile/src/components/EmergencyAlertsCard.tsx) |
| Voice announcements (expo-speech) | **Implemented** (app open only) | [voice.ts:7-53](../../apps/mobile/src/features/notifications/voice.ts#L7) |
| Reports (31 types) with XLSX/PDF/CSV export to the share sheet | **Implemented** | [reports/[type].tsx:49-139](../../apps/mobile/src/app/reports/%5Btype%5D.tsx#L49), [share-file.ts](../../apps/mobile/src/lib/share-file.ts) |
| Device commands | **Implemented** | [commands/[id].tsx](../../apps/mobile/src/app/commands/%5Bid%5D.tsx#L25) |
| Live-location sharing | **Implemented** | [share/[id].tsx](../../apps/mobile/src/app/share/%5Bid%5D.tsx#L17) |
| Geofences / POIs / parking mode / documents / service / expenses / attendance / driver events / scores / Ask | **Implemented** | see A2 |
| Video (live / playback) | **Partial**: opens the web `/video` page in an in-app browser, which needs a separate web sign-in (Inferred) | [vehicle/[id].tsx:145](../../apps/mobile/src/app/vehicle/%5Bid%5D.tsx#L145) |
| Admin masters (vehicles/devices/drivers CRUD) | **Partial**: those three only. Users, roles, branches, groups and companies are web-only | [more.tsx:119-121](../../apps/mobile/src/app/%28tabs%29/more.tsx#L119) |
| Billing / buying licences | **Partial** (view only, by design; buying happens on the web, with no link on iOS) | [licences.tsx:81](../../apps/mobile/src/app/licences.tsx#L81) |
| Settings: theme, language (en/hi/ta), text and icon size, basemap, time zone display | **Implemented** | [more.tsx](../../apps/mobile/src/app/%28tabs%29/more.tsx) |
| Account deletion in-app | **Implemented** | [profile.tsx:109-117](../../apps/mobile/src/app/profile.tsx#L109) |
| Offline support / cached data | **Missing**: no persisted query cache; on a cold start offline the user is signed out (see Findings M-1) | — |
| Biometric lock, deep links into screens (other than notification taps) | **Missing** (biometric permissions are explicitly blocked) | [app.json:32-33](../../apps/mobile/app.json#L32) |
| Tablet / landscape | **Missing** (`supportsTablet:false`, portrait) | [app.json:6](../../apps/mobile/app.json#L6) |

---

## Part B — VeeTrax Tracker (`apps/tracker`)

### B1. Stack and configuration

| Item | Value | Evidence |
|---|---|---|
| Name / slug / scheme | `VeeTrax Tracker` / `veetrax-tracker` / `veetrax-tracker://` | [app.json:3-8](../../apps/tracker/app.json#L3) |
| Version | `1.4.3`, `versionCode` 28 | [app.json:5](../../apps/tracker/app.json#L5), [:20](../../apps/tracker/app.json#L20) |
| IDs | `com.sasvata.veetrax.tracker` on both platforms. `allowBackup:false` | [app.json:12](../../apps/tracker/app.json#L12), [:19-21](../../apps/tracker/app.json#L19) |
| Permissions | FINE/COARSE/**BACKGROUND_LOCATION**, FOREGROUND_SERVICE(+_LOCATION), POST_NOTIFICATIONS, CAMERA, **REQUEST_IGNORE_BATTERY_OPTIMIZATIONS**, WAKE_LOCK, RECEIVE_BOOT_COMPLETED, INTERNET | [app.json:36-47](../../apps/tracker/app.json#L36), [app.plugin.js:14-25](../../apps/tracker/modules/veetrax-tracker/app.plugin.js#L14) |
| Blocked | READ/WRITE_EXTERNAL_STORAGE, SYSTEM_ALERT_WINDOW, biometric | [app.json:29-35](../../apps/tracker/app.json#L29) |
| Plugins | expo-router, splash, secure-store, **expo-location** (usage strings, Android background + FGS, iOS background), expo-sqlite, **expo-camera** (no audio, no barcode scanner), expo-image-picker, local `modules/veetrax-tracker/app.plugin.js`, release signing (alias `veetrax-tracker`) | [app.json:49-95](../../apps/tracker/app.json#L49) |
| Manifest additions | `TrackerService` (exported=false, `foregroundServiceType=location`, `stopWithTask=false`). `BootReceiver` (**exported=true**: BOOT_COMPLETED, QUICKBOOT, MY_PACKAGE_REPLACED). Camera features optional | [app.plugin.js:39-80](../../apps/tracker/modules/veetrax-tracker/app.plugin.js#L39) |
| React Compiler | off | [app.json:98](../../apps/tracker/app.json#L98) |
| EAS / Firebase / push | **None**: no EAS project, no FCM. Built locally | [README.md](../../apps/tracker/README.md) |
| Branding | `EXPO_PUBLIC_BRAND=proser` switches to the second "ProSer" palette at build time | [theme.ts:25-51](../../apps/tracker/src/lib/theme.ts#L25) |
| API base | `${EXPO_PUBLIC_SERVER_URL or https://gps.mintplus.co.in}/api/tracker/v1`. The native engine keeps its own copy (`DEFAULT_SERVER_URL` is the same) | [api.ts:6-7](../../apps/tracker/src/lib/api.ts#L6), [Prefs.kt:9](../../apps/tracker/modules/veetrax-tracker/android/src/main/java/com/sasvata/veetrax/trackerengine/Prefs.kt#L9) |
| Web links | Privacy and delete-account links point to a **hard-coded `https://app.veetrax.com`**, a different host from the API default | [HomeMenu.tsx:10](../../apps/tracker/src/components/HomeMenu.tsx#L10) |
| Token storage | JS side: `expo-secure-store` key `veetrax_tracker_token` ([state.ts:11](../../apps/tracker/src/lib/state.ts#L11)). Native side: **plain `SharedPreferences`** `veetrax_tracker_engine` (MODE_PRIVATE, not encrypted) ([Prefs.kt:96-98](../../apps/tracker/modules/veetrax-tracker/android/src/main/java/com/sasvata/veetrax/trackerengine/Prefs.kt#L96)) | Confirmed |
| UI key/value | SQLite `tracker.db` table `kv` (session, config, notice, language). It drops the legacy JS `queue` table | [db.ts:9-17](../../apps/tracker/src/lib/db.ts#L9) |

### B2. Navigation map (6 screens plus a modal menu)

Root: a `Stack` with a `Stack.Protected` guard on `hasToken && session`. On start it tries `restoreActivation()` for up to 8 s, then `startup()` (crash report, stop-reason sync, resume, `/me`, flush): [_layout.tsx:22-110](../../apps/tracker/src/app/_layout.tsx#L22).

| Screen | File | Purpose | Layout and components | Actions | Data / API | Visibility |
|---|---|---|---|---|---|---|
| Activate | [activate.tsx](../../apps/tracker/src/app/activate.tsx#L31) | Pair the phone by mobile number and a 6-digit code | HeaderBand, LanguagePicker, TrackingScene hero, InfoSteps, notice card | Send code (number + e-mail + name), verify, resend, change number | `/activate/lookup`, `/activate/request`, `/activate/verify` | Signed out |
| Home | [index.tsx](../../apps/tracker/src/app/index.tsx#L29) | Tracking status and controls | HeaderBand (Company – person), StatusPulse card, NeedsAttention, AttendanceCard, SosButton, LanguagePicker, "Open VeeTrax" card (personal accounts) | Start (→ Disclosure if permissions are missing), Stop (refused when `required`), SOS hold 2 s, menu | native `getStatus()` every 2 s while visible; `/me` re-check every 5 min while INACTIVE | Signed in |
| Disclosure (modal) | [disclosure.tsx](../../apps/tracker/src/app/disclosure.tsx#L15) | Play "prominent disclosure" before the system dialogs | Icon, paragraphs, hint | Agree → `beginTracking()`; Cancel | — | Signed in |
| Details | [details.tsx](../../apps/tracker/src/app/details.tsx#L12) | Technical status: last fix, accuracy, speed, mode, queue, last upload, filtered/mock counts, last error | Rows, PermissionsCard, OemCard | Upload now | native status | Signed in (menu) |
| Profile | [profile.tsx](../../apps/tracker/src/app/profile.tsx#L12) | Who the phone tracks, account type, trial/licence end, version | Avatar, rows, legal links | Privacy policy and Delete account (open the web) | kv session | Signed in (menu) |
| Check-in camera | [checkin-camera.tsx](../../apps/tracker/src/app/checkin-camera.tsx#L24) | 10-second muted 480p check-in video; a photo is taken from second 4 | CameraView full screen, REC dot, countdown | Start/Stop recording (auto-start with `?auto=1`), falls back to the back camera | `/attendance/selfie`, `/attendance/video` (multipart via XHR) | Signed in, from AttendanceCard |
| Home menu (modal component) | [HomeMenu.tsx](../../apps/tracker/src/components/HomeMenu.tsx#L37) | Profile, Details, Sign out, Deactivate. **Sign out and Deactivate run the same action** | Popover | Deactivate uploads up to 20 s, then `/signout` and clears local data | `/signout` | Refused when tracking is `required` |

### B3. Visual design

The theme comes from [theme.ts](../../apps/tracker/src/lib/theme.ts#L53):
- light background `#f2f5f4`, header band `#0b3b36`, primary `#0f766e`, accent `#ffb443`, plus danger/success/idle soft tints;
- a dark palette (background `#0b1514`, primary `#14b8a6`);
- status bar always light;
- system fonts, lucide icons, an SVG `TrackerMark` logo;
- `StatusPulse` and `BlinkDot` animations, an SOS pulse ring, and a progress fill on the 2-second hold with a 300 ms vibration. [motion.ts](../../apps/tracker/src/lib/motion.ts) handles reduce-motion.

Strings exist in English, Hindi and Tamil ([strings*.ts](../../apps/tracker/src/lib/strings.ts)). The language is pushed to the native engine for its notifications ([language.ts:26-31](../../apps/tracker/src/lib/language.ts#L26)). The Tracker uses its own token set, not the web themes, though it is visually aligned with the VeeTrax teal/saffron brand.

### B4–B5. Tracking engine (the core)

**Architecture: a native Kotlin foreground service, not expo-task-manager.** [index.ts:1](../../apps/tracker/index.ts#L1) says "no JS background task". `expo-task-manager` is still a dependency but is unused ([package.json:26](../../apps/tracker/package.json#L26)). `expo-location` is used **only** for permission prompts and checks ([tracking.ts:8-11](../../apps/tracker/src/lib/tracking.ts#L8)). Confirmed.

| Topic | Implementation | Evidence |
|---|---|---|
| Permission flow | Start → if foreground and background are not both granted, the Disclosure screen. Agree → `requestForegroundPermissionsAsync` → `requestBackgroundPermissionsAsync` ("Allow all the time") → POST_NOTIFICATIONS (Android 13+) → `enableNetworkProviderAsync` (Google high-accuracy prompt) → native `start`. A denied background permission still starts, with a warning | [control.ts:17-38](../../apps/tracker/src/lib/control.ts#L17), [tracking.ts:41-50](../../apps/tracker/src/lib/tracking.ts#L41), [disclosure.tsx:19-26](../../apps/tracker/src/app/disclosure.tsx#L19) |
| Battery optimisation | `expo-battery.isBatteryOptimizationEnabledAsync`. The fix button sends the `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` intent through **expo-intent-launcher**, falling back to the settings list. OEM autostart screens (Xiaomi/Oppo/Vivo/OnePlus/Samsung/Huawei) via `OemSettings.kt` | [device.ts:16-30](../../apps/tracker/src/lib/device.ts#L16), [ChecksCards.tsx:65-89](../../apps/tracker/src/components/ChecksCards.tsx#L65) |
| Service | `TrackerService` with FGS type location, `START_STICKY`, a low-importance notification. `onTaskRemoved` / `onDestroy` schedule a restart alarm | [TrackerService.kt:55-130](../../apps/tracker/modules/veetrax-tracker/android/src/main/java/com/sasvata/veetrax/trackerengine/TrackerService.kt#L55) |
| Survival | `BootReceiver` (boot, update, restart action). A `WatchdogWorker` runs every 15 min (WorkManager) and also asks the server whether tracking is **required** | [BootReceiver.kt:23](../../apps/tracker/modules/veetrax-tracker/android/src/main/java/com/sasvata/veetrax/trackerengine/BootReceiver.kt#L23), [WatchdogWorker.kt:51-55](../../apps/tracker/modules/veetrax-tracker/android/src/main/java/com/sasvata/veetrax/trackerengine/WatchdogWorker.kt#L51), [Engine.kt:201-207](../../apps/tracker/modules/veetrax-tracker/android/src/main/java/com/sasvata/veetrax/trackerengine/Engine.kt#L201) |
| Accuracy / interval / distance | Server-controlled `config`: intervalSec 10, stoppedIntervalSec 60, distanceM 10, maxAccuracyM 100, batchMax 100, clamped natively. **MOVING** mode: `PRIORITY_HIGH_ACCURACY`, interval and min distance from config. **STATIONARY** mode (after 2 min still or 2 min without a fix): `BALANCED_POWER`, stopped interval, batched delivery (3× interval). A high-accuracy **GPS probe every 3 min** while stationary (15 s timeout) | [Prefs.kt:12-33](../../apps/tracker/modules/veetrax-tracker/android/src/main/java/com/sasvata/veetrax/trackerengine/Prefs.kt#L12), [TrackerService.kt:98-112](../../apps/tracker/modules/veetrax-tracker/android/src/main/java/com/sasvata/veetrax/trackerengine/TrackerService.kt#L98), [Engine.kt:34-52](../../apps/tracker/modules/veetrax-tracker/android/src/main/java/com/sasvata/veetrax/trackerengine/Engine.kt#L34), [Engine.kt:220-250](../../apps/tracker/modules/veetrax-tracker/android/src/main/java/com/sasvata/veetrax/trackerengine/Engine.kt#L220) |
| Filtering | `JumpFilter` now **labels** doubtful fixes (`flt`: mock / inaccurate / jump / still) and still queues them, so the server does the real filtering. Only invalid or old fixes are skipped | [Engine.kt:256-290](../../apps/tracker/modules/veetrax-tracker/android/src/main/java/com/sasvata/veetrax/trackerengine/Engine.kt#L256) |
| Offline queue | **Native** SQLite (`PointQueue.kt`, WAL, PK = fix time `t`, cap **50 000**, oldest trimmed with an event). Not expo-sqlite | [PointQueue.kt:18-54](../../apps/tracker/modules/veetrax-tracker/android/src/main/java/com/sasvata/veetrax/trackerengine/PointQueue.kt#L18) |
| Sync / retry | Event-driven uploads, at least 20 s apart while moving and 60 s while stationary. Exponential backoff from 5 s to 10 min. **Every non-401 / non-INACTIVE error is retried and never dropped**. 401 REVOKED/INVALID stops the engine and clears the token and queue. 403 INACTIVE stops and keeps the token. A `revoked:true` flag drains the queue, then signs out. A 30 s partial wake lock is held per HTTP call | [Uploader.kt:83-160](../../apps/tracker/modules/veetrax-tracker/android/src/main/java/com/sasvata/veetrax/trackerengine/Uploader.kt#L83), [Engine.kt:319-360](../../apps/tracker/modules/veetrax-tracker/android/src/main/java/com/sasvata/veetrax/trackerengine/Engine.kt#L319) |
| Payload | `POST /api/tracker/v1/positions`, `{positions:[{t,lat,lng,acc,spd,brg,alt,bat,chg,mock,sos,flt?,prov?,sacc?,sat?,mode?}], health:{wanted,running,mode,failures,lastError,start/stop/refused,events[],mfr,model,sdk,queue,lastFixAt}}`. The response may carry `config`, `required`, `revoked`, `attention{id,title,text}` (shown once as a notification) | [Point.kt:35-51](../../apps/tracker/modules/veetrax-tracker/android/src/main/java/com/sasvata/veetrax/trackerengine/Point.kt#L35), [Health.kt:60-70](../../apps/tracker/modules/veetrax-tracker/android/src/main/java/com/sasvata/veetrax/trackerengine/Health.kt#L60), [Uploader.kt:119-134](../../apps/tracker/modules/veetrax-tracker/android/src/main/java/com/sasvata/veetrax/trackerengine/Uploader.kt#L119), [API.md §3](../mobile-tracker/API.md) |
| Pairing / claim | The admin adds the device (uniqueId = E.164 mobile) on the web. The phone enters a **+91-only** 10-digit number with e-mail and name, gets the code by SMS or e-mail (or the admin reads it out), then verifies. Activating revokes earlier tokens. **There is no QR / camera pairing** (`barcodeScannerEnabled:false`). **Silent restore**: after a reinstall, `POST /activate/restore` with `installId = Settings.Secure.ANDROID_ID` returns a new token without a code | [activate.tsx:24-105](../../apps/tracker/src/app/activate.tsx#L24), [control.ts:60-81](../../apps/tracker/src/lib/control.ts#L60), [VeetraxTrackerModule.kt:132-133](../../apps/tracker/modules/veetrax-tracker/android/src/main/java/com/sasvata/veetrax/trackerengine/VeetraxTrackerModule.kt#L132) |
| "Required" tracking | When the server says `required`, the phone **restarts tracking itself** and Stop / Sign-out are refused | [Engine.kt:164-171](../../apps/tracker/modules/veetrax-tracker/android/src/main/java/com/sasvata/veetrax/trackerengine/Engine.kt#L164), [index.tsx:80-84](../../apps/tracker/src/app/index.tsx#L80), [HomeMenu.tsx:16-23](../../apps/tracker/src/components/HomeMenu.tsx#L16) |
| SOS | Hold 2 s. A fresh fix (up to 15 s) or the last known one is queued and sent alone at once, ignoring backoff. Results: sent / queued / no_location / … | [SosButton.tsx:9-60](../../apps/tracker/src/components/SosButton.tsx#L9), [Engine.kt:380-455](../../apps/tracker/modules/veetrax-tracker/android/src/main/java/com/sasvata/veetrax/trackerengine/Engine.kt#L380) |
| Battery telemetry | `bat` and `chg` on every point (native `Battery.read`), plus the health report | [Engine.kt:259](../../apps/tracker/modules/veetrax-tracker/android/src/main/java/com/sasvata/veetrax/trackerengine/Engine.kt#L259) |
| Photo / video | Attendance proof. **Selfie**: `ImagePicker.launchCameraAsync` with the front camera, quality 0.5. **Video**: expo-camera 10 s muted 480p, with a thumbnail at 4 s as the photo. Uploaded to `/attendance/selfie` and `/attendance/video`. Outing answers (OFFICIAL / PERSONAL) | [AttendanceCard.tsx:71-78](../../apps/tracker/src/components/AttendanceCard.tsx#L71), [checkin-camera.tsx:40-62](../../apps/tracker/src/app/checkin-camera.tsx#L40) |
| Diagnostics | JS and native crash logs are sent to `/diagnostics` (unauthenticated) at start | [crash.ts](../../apps/tracker/src/lib/crash.ts), [api.ts:151](../../apps/tracker/src/lib/api.ts#L151) |
| iOS | **Missing**: the native engine is Android-only, and `start()` rejects with "only available on Android" | [modules/veetrax-tracker/index.ts:80-83](../../apps/tracker/modules/veetrax-tracker/index.ts#L80) |

---

## 6. Asset inventory

| Asset | Path | Use |
|---|---|---|
| App icon 1024² | [apps/mobile/assets/images/icon.png](../../apps/mobile/assets/images/icon.png), [apps/tracker/assets/images/icon.png](../../apps/tracker/assets/images/icon.png) | `expo.icon`, iOS icon |
| Adaptive icon fg / bg / monochrome (1024²) | `apps/*/assets/images/android-icon-{foreground,background,monochrome}.png` | Android adaptive icon (background `#0E5E57`) |
| Splash 1024² | `apps/*/assets/images/splash-icon.png` | expo-splash-screen, width 200 on `#0E5E57` |
| Notification icon 96² | `apps/*/assets/images/notification-icon.png` | expo-notifications (mobile). The Tracker uses its own vector `res/drawable/veetrax_tracker_notification.xml` |
| Favicon 48² | `apps/mobile/assets/images/favicon.png` | web build only |
| Tracker brand SVG sources | `apps/tracker/assets/brand/*.svg` | sources for the PNGs (generator `scripts/brand/generate.mjs`, Inferred) |
| SOS siren (3 s two-tone WAV, 265 KB) | [apps/mobile/assets/sounds/sos_siren.wav](../../apps/mobile/assets/sounds/sos_siren.wav) | `sos` channel sound, expo-audio loop, native `AlarmService`. Generated by `scripts/brand/gen-sos-sound.mjs` |
| Vehicle/person map icons (90 PNG @2x: 15 kinds × running/idle/off/offline/no_data/overspeed, plus walking/running "-b" frames) | `apps/mobile/assets/vehicles/*.png` | MapLibre symbol images ([vehicle-icon-images.ts](../../apps/mobile/src/features/map/vehicle-icon-images.ts)). Generated by `scripts/gen-vehicle-icons.mjs` and `gen-person-icons.mjs` from the web icon code |
| Store listing | [brand/store/play-icon-512.png](../../brand/store/play-icon-512.png), [play-feature-graphic-1024x500.png](../../brand/store/play-feature-graphic-1024x500.png), [appstore-icon-1024.png](../../brand/store/appstore-icon-1024.png) | Play / App Store. **Only one set**, and it is not clear whether it is VeeTrax or Tracker. No phone screenshots in the repo |
| Fonts | none | system fonts |

## 7. Build and release

- **No `android/` or `ios/` folders are committed.** Both apps use `expo prebuild --platform android --clean`, then `gradlew assembleRelease` (APK) or `bundleRelease` (AAB, Inferred). Because of the Windows path limit, builds run from a short-path git worktree (`C:\vt`) ([mobile README](../../apps/mobile/README.md), [tracker README](../../apps/tracker/README.md)).
- **Signing:** [tooling/expo/with-release-signing.js](../../tooling/expo/with-release-signing.js) injects a `release` signingConfig that reads `VEETRAX_SIGNING_STORE_FILE` and the password property from `~/.gradle/gradle.properties`. Aliases are `veetrax` and `veetrax-tracker`. **A release build fails if the key is missing** (no silent debug signing). Both READMEs still say "signed with the debug key", which is outdated. The keystore lives outside the repo (path referenced in a comment only).
- **EAS (mobile only):** `preview` and `production` profiles, with production `autoIncrement` and `appVersionSource: remote`. The Tracker has no EAS. The practical release path appears to be **local Gradle** (commit messages like "VeeTrax 0.6.7 (67)" bump `app.json` by hand: `git show 47924fa`).
- **Versioning:** set by hand in `app.json` (`version` and `android.versionCode`). Mobile 0.6.7/67; Tracker 1.4.3/28. The Tracker sends `X-App-Version` on every JS call ([api.ts:78](../../apps/tracker/src/lib/api.ts#L78)).
- **Store compliance work present:**
  - background-location declaration text and video script ([tracker README](../../apps/tracker/README.md));
  - prominent disclosure screen;
  - in-app account deletion (mobile) and a web delete link (Tracker);
  - optional camera features;
  - blocked unneeded permissions.

## 8. Findings

Severity: **C**ritical / **H**igh / **M**edium / **L**ow.

| # | Sev | App | Finding | Evidence | Status |
|---|---|---|---|---|---|
| M-1 | **H** | mobile | **Opening the app offline (or while the API is down) signs the user out and deletes the refresh token.** `refreshAccessToken()` returns `false` on a network error, and the bootstrap then calls `session.clear()`. A field user with poor signal loses the session and must sign in again, and the SOS alarm flow then has no session for acknowledgement. | [api.ts:117-131](../../apps/mobile/src/lib/api.ts#L117), [auth.tsx:41-44](../../apps/mobile/src/features/auth/auth.tsx#L41) | Confirmed |
| M-2 | **H** | mobile | Any `/auth/me` error (network, 5xx, timeout, after 2 retries) with no company selected calls `signOut()`, which also unregisters push. A transient outage signs out every user who opens the app. | [auth.tsx:76-81](../../apps/mobile/src/features/auth/auth.tsx#L76) | Confirmed |
| T-1 | **H** | tracker | **Silent re-activation by ANDROID_ID.** `/activate/lookup` and `/activate/restore` are unauthenticated. Restore returns a tracker token for a known `installId` (ANDROID_ID). Lookup returns the registered **e-mail and name** when the installId matches, and reveals whether a number is registered (enumeration). Severity depends on server-side checks such as rate limits or binding (Inferred; see the API analyst's report). | [control.ts:60-81](../../apps/tracker/src/lib/control.ts#L60), [activate.tsx:49-68](../../apps/tracker/src/app/activate.tsx#L49), [api.ts:134-135](../../apps/tracker/src/lib/api.ts#L134) | Inferred |
| T-2 | **H** | tracker | **Poison-batch risk:** every non-401/403 response, including a permanent 400 or 422 for a malformed point, is retried forever with backoff and never dropped. One bad point blocks all later uploads until the 50 000 cap trims it, which can take days. The README says "other 4xx drop the batch", but the code does not. | [Uploader.kt:138-141](../../apps/tracker/modules/veetrax-tracker/android/src/main/java/com/sasvata/veetrax/trackerengine/Uploader.kt#L138), [tracker README:35](../../apps/tracker/README.md#L35) | Confirmed |
| T-3 | **M** (privacy) | tracker | **Employer-"required" tracking:** the server can force tracking back on (watchdog every 15 min). Stop, Sign out and Deactivate are refused. The disclosure says the user can stop tracking ("how to stop"). Legal and Play-policy review is needed (employee consent, DPDP Act). | [Engine.kt:164-171](../../apps/tracker/modules/veetrax-tracker/android/src/main/java/com/sasvata/veetrax/trackerengine/Engine.kt#L164), [HomeMenu.tsx:18](../../apps/tracker/src/components/HomeMenu.tsx#L18), [disclosure.tsx:11-14](../../apps/tracker/src/app/disclosure.tsx#L11) | Confirmed (policy risk Inferred) |
| T-4 | **M** | tracker | The tracker token is stored in plain `SharedPreferences` (not EncryptedSharedPreferences or the Keystore), while JS uses secure-store. `allowBackup:false` lowers the risk; on a rooted phone the token can be read. | [Prefs.kt:96-98](../../apps/tracker/modules/veetrax-tracker/android/src/main/java/com/sasvata/veetrax/trackerengine/Prefs.kt#L96) | Confirmed |
| M-3 | **M** | mobile | Play policy: `USE_FULL_SCREEN_INTENT` is still declared (Play did not pre-grant it; the app handles that). A `FOREGROUND_SERVICE_MEDIA_PLAYBACK` service used for an alarm siren may be questioned by Play's FGS-type review. Starting that FGS from FCM in the background only works for **high-priority** pushes, and the server must send `priority: high`. | [veetrax-alarm manifest:3-4](../../apps/mobile/modules/veetrax-alarm/android/src/main/AndroidManifest.xml#L3), [AlarmMessagingService.kt:22](../../apps/mobile/modules/veetrax-alarm/android/src/main/java/com/sasvata/veetrax/alarm/AlarmMessagingService.kt#L22) | Inferred |
| M-4 | **M** | mobile | `AlarmService` sets `STREAM_ALARM` to maximum volume (restored in `onDestroy`). This is intrusive, and if the process is killed before `onDestroy` the user's alarm volume stays at maximum. | [AlarmService.kt:85-86](../../apps/mobile/modules/veetrax-alarm/android/src/main/java/com/sasvata/veetrax/alarm/AlarmService.kt#L85), [:166](../../apps/mobile/modules/veetrax-alarm/android/src/main/java/com/sasvata/veetrax/alarm/AlarmService.kt#L166) | Confirmed |
| M-5 | **M** | mobile | The in-app siren uses `shouldPlayInBackground: false`. If the user leaves the SOS screen via Home, the siren stops, and the native alarm was already stopped when the screen opened. | [siren.ts:21](../../apps/mobile/src/features/notifications/siren.ts#L21), [sos/[id].tsx:71](../../apps/mobile/src/app/sos/%5Bid%5D.tsx#L71) | Confirmed |
| M-6 | **M** | mobile | iOS SOS gets no Critical Alerts entitlement and no alarm when the app is closed: a short notification sound only, silenced by Focus or the silent switch. | [README.md](../../apps/mobile/README.md) | Confirmed (Partial feature) |
| M-7 | **M** | mobile | The OTP screen auto-fills `devCode` from the response. This is safe only if the server never returns `devCode` in production. | [login.tsx:61-65](../../apps/mobile/src/app/login.tsx#L61) | Inferred |
| B-1 | **M** | both | Versioning drift: mobile `eas.json` uses `appVersionSource: remote` and `autoIncrement`, while `app.json` holds a hand-edited `versionCode` 67. EAS builds and local builds will disagree on codes. | [eas.json:4](../../apps/mobile/eas.json#L4), [app.json:27](../../apps/mobile/app.json#L27) | Confirmed |
| B-2 | **M** | both | Three hosts: the API default is `gps.mintplus.co.in`, the Tracker web links use `app.veetrax.com`, and ops docs mention `us.veetrax.com`. A host change needs a rebuild because the URL is baked in at build time. | [config.ts:2](../../apps/mobile/src/lib/config.ts#L2), [HomeMenu.tsx:10](../../apps/tracker/src/components/HomeMenu.tsx#L10) | Confirmed |
| T-5 | **M** (battery) | tracker | MOVING mode uses `PRIORITY_HIGH_ACCURACY` at 10 s, plus a GPS probe every 3 min while stationary. The README estimates 3–6 %/h driving and 0.5–1 %/h parked; the probe adds GPS wake-ups all night. Acceptable for fleet use; worth exposing per-company. | [Engine.kt:46](../../apps/tracker/modules/veetrax-tracker/android/src/main/java/com/sasvata/veetrax/trackerengine/Engine.kt#L46), [Engine.kt:226-250](../../apps/tracker/modules/veetrax-tracker/android/src/main/java/com/sasvata/veetrax/trackerengine/Engine.kt#L226) | Confirmed / Inferred impact |
| T-6 | **L** | tracker | `BootReceiver` is `exported=true` and also accepts the app's own restart action. Another app could send that action to start the service, but only when tracking is already wanted. Low impact. | [app.plugin.js:59](../../apps/tracker/modules/veetrax-tracker/app.plugin.js#L59), [BootReceiver.kt:23](../../apps/tracker/modules/veetrax-tracker/android/src/main/java/com/sasvata/veetrax/trackerengine/BootReceiver.kt#L23) | Inferred |
| T-7 | **L** | tracker | Activation is India-only: `+91` is hard-coded and numbers are limited to 10 digits. | [activate.tsx:24-29](../../apps/tracker/src/app/activate.tsx#L24), [:79](../../apps/tracker/src/app/activate.tsx#L79) | Confirmed |
| T-8 | **L** | tracker | Check-in sends the photo, then the video, non-atomically. If the video fails, a retry re-uploads the photo (a duplicate selfie). `auto=1` starts recording without a tap (a REC indicator is shown). | [checkin-camera.tsx:40-53](../../apps/tracker/src/app/checkin-camera.tsx#L40), [:75-77](../../apps/tracker/src/app/checkin-camera.tsx#L75) | Confirmed |
| T-9 | **L** | tracker | The menu has both "Sign out" and "Deactivate this phone", and both call the same `deactivate()`. This is confusing UX. | [HomeMenu.tsx:52-53](../../apps/tracker/src/components/HomeMenu.tsx#L52) | Confirmed |
| T-10 | **L** | tracker | Stray `import { APP_VERSION } from './device'` after the closing `};` at the end of the file. It works (imports are hoisted) but is a code smell. | [api.ts:153](../../apps/tracker/src/lib/api.ts#L153) | Confirmed |
| T-11 | **L** | tracker | `/diagnostics` crash reports are sent unauthenticated with device model and crash text. Make sure the server rate-limits them and that the text contains no PII. | [api.ts:151-152](../../apps/tracker/src/lib/api.ts#L151) | Inferred |
| D-1 | **L** | mobile | `licences` route has no `Stack.Screen` entry, so the header title is the raw route name. | [_layout.tsx:43-75](../../apps/mobile/src/app/_layout.tsx#L43) | Confirmed |
| D-2 | **L** | mobile | Share live location is not permission-gated in the client (Vehicle details tile and route). | [vehicle/[id].tsx:143](../../apps/mobile/src/app/vehicle/%5Bid%5D.tsx#L143) | Confirmed (server enforcement unknown) |
| D-3 | **L** | both | Unused dependencies. Mobile: `@expo/ui`, `expo-font`, `expo-glass-effect`, `expo-haptics`, `expo-symbols`. Tracker: `expo-task-manager`; expo-location's own FGS config is also unused. They add binary size and permissions surface. | [mobile package.json:6-30](../../apps/mobile/package.json#L6), [tracker package.json:26](../../apps/tracker/package.json#L26) | Confirmed |
| D-4 | **L** | tracker | Gradle cache files under `modules/veetrax-tracker/android/.gradle/` are **tracked in git** despite the ignore rule (the same cleanup was done for the alarm module in `7e8654a`). | `git ls-files apps/tracker/modules/veetrax-tracker/android/.gradle` | Confirmed |
| D-5 | **L** | docs | Doc drift. The Tracker README says the jump filter "drops" fixes (code labels them with `flt` and sends them), the queue max is 20 000 (code: 50 000), and 4xx responses are dropped (code: retried). The mobile README lists only SOS/CRASH as emergencies (code: 6 types including POWER_CUT, DEVICE_TAMPER, SIM_CHANGED, TOWING). Both READMEs say release APKs are debug-signed (now refused). `HANDOFF.md` says Flutter. | [tracker README:34-51](../../apps/tracker/README.md#L34), [mobile README:85](../../apps/mobile/README.md#L85), [alerts.ts:334](../../packages/shared/src/alerts.ts#L334) | Confirmed |
| D-6 | **L** | mobile | Video and the driver-event video open the web app in an in-app browser that needs its own sign-in. There is no native video player for live streams. | [vehicle/[id].tsx:145](../../apps/mobile/src/app/vehicle/%5Bid%5D.tsx#L145), [driver-events.ts:14](../../apps/mobile/src/features/driver-events/driver-events.ts#L14) | Inferred |

**No automated tests** exist for either app (no test runner in `package.json`; only `tsc --noEmit`). Confirmed.

### Missing or partial features (summary)

- **Mobile:**
  - offline cache and session tolerance (M-1, M-2);
  - iOS critical SOS alarm;
  - native video;
  - admin masters beyond vehicles, devices and drivers;
  - biometric lock;
  - tablet layout;
  - store screenshots.
- **Tracker:**
  - iOS engine;
  - international numbers;
  - QR pairing (not implemented; the code flow is used instead);
  - a user-visible "required tracking" explanation in the disclosure;
  - a poison-batch escape (T-2);
  - EAS / CI builds.
