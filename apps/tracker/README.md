# VeeTrax Tracker (Android phone as a GPS tracker)

Expo / React Native (SDK 58) app that turns an Android phone into a tracker for the VeeTrax platform. It
talks only to the tracker API (`docs/mobile-tracker/API.md`), base URL `${SERVER}/api/tracker/v1`.

App id (Android package and iOS bundle id): **`com.sasvata.veetrax.tracker`**. It is separate from the main
VeeTrax app (`com.sasvata.veetrax`). No Firebase, no push, no EAS project.

## How it works

1. The admin adds the phone in VeeTrax **Devices** (model *VeeTrax · Mobile tracker*, unique id = mobile
   number, e.g. `919876543210`) and assigns it to a company, vehicle or person.
2. On the phone: enter the number, get a 6-digit code by SMS (or the admin reads it from the Devices page),
   enter it. The app stores the tracker token in `expo-secure-store` **and** hands it to the native engine.
3. **Start tracking** shows a location disclosure, then asks for location (while using, then *all the
   time*) and notifications, then starts the native foreground service.
4. Tracking runs **entirely in native Kotlin** (`modules/veetrax-tracker`, a local Expo module). It does not
   need the JS runtime, so it keeps going when the app is swiped away, after a reboot and after an update.
   It stops only when the user taps **Stop** (or signs out), or the server answers REVOKED / INVALID /
   INACTIVE.
5. Server answers: `401 REVOKED` / `INVALID` → the engine stops, deletes token and queue; the app shows the
   activation screen with the reason. `403 INACTIVE` → stop, keep the token; the app re-checks `/me` hourly
   while open and lets the user start again when it works.
6. **SOS**: press and hold 2 s; the engine takes a fresh fix (≤ 15 s, else the last known one) and sends one
   point with `sos: true` at once, alone, ignoring the backoff (kept in the queue if offline).

### Native engine (`modules/veetrax-tracker/android/.../trackerengine`)

| File | Role |
|---|---|
| `TrackerService.kt` | Foreground service, `foregroundServiceType="location"`, `START_STICKY`, low-importance "Tracking" notification (tap opens the app, no Stop action). Owns the `FusedLocationProviderClient` request. `onTaskRemoved` / unexpected `onDestroy` schedule a restart alarm. |
| `Engine.kt` | Process singleton on one background `HandlerThread`: filter → queue → upload, adaptive GPS mode, SOS, status. |
| `JumpFilter.kt` | Phone-side jump / accuracy / mock / stationary filter (below). |
| `PointQueue.kt` | Native SQLite queue (WAL), keyed by fix time `t`, duplicates ignored, max 20 000 (oldest dropped). |
| `Uploader.kt` | `HttpURLConnection` POST to `/api/tracker/v1/positions`, batches of `config.batchMax`, backoff 5 s → 10 min on network / 5xx / 408 / 429; other 4xx drop the batch; applies the returned `config`. |
| `Prefs.kt` | SharedPreferences: token, server URL, config, `wanted`, stop reason, anchor fix, status. |
| `BootReceiver.kt` | `BOOT_COMPLETED`, `MY_PACKAGE_REPLACED` (+ QUICKBOOT) and our restart alarm → start the service if wanted. `LOCKED_BOOT_COMPLETED` is not used (prefs live in credential-encrypted storage). |
| `WatchdogWorker.kt` | WorkManager, every 15 min: restarts the service if it is wanted but gone. |
| `OemSettings.kt` | Opens Xiaomi / Oppo / Realme / Vivo / OnePlus / Samsung / Huawei autostart screens, falls back to App info. |
| `app.plugin.js` | Config plugin: adds the service, receiver and permissions to the app manifest. |

JS API (`modules/veetrax-tracker/index.ts`): `start(token, serverUrl, config)`, `stop()`, `isRunning()`,
`getStatus()`, `setConfig(config)`, `setCredentials()`, `sendSos()`, `flush()`, `clear()`, `resetStopReason()`,
`openAutostartSettings()`. The home screen polls `getStatus()` every 2 s only while the app is visible.

### Jump filter (on the phone, before queuing)

1. Mock (fake-GPS) fixes are dropped (counted in the status as "fake GPS").
2. Accuracy worse than **50 m** is dropped — except up to **150 m** when nothing was accepted for 2 minutes,
   so tracking never goes silent.
3. A fix whose implied speed from the last accepted fix exceeds **55 m/s (~200 km/h)** is dropped, unless
   **3 consecutive** such fixes agree with each other (then the old anchor was the wrong one: accept).
4. Standing still (reported speed < 1 m/s and within max(15 m, 2 × accuracy) of the last accepted fix):
   only one point per `stoppedIntervalSec` (default 60 s) is sent as a heartbeat.

The server still applies its own `maxAccuracyM` / mock rules on top.

### Battery and performance

- **Adaptive GPS.** *Moving*: `PRIORITY_HIGH_ACCURACY` every `intervalSec`, `minUpdateDistance = distanceM`,
  `waitForAccurateLocation`. After **2 minutes standing still** (or 2 minutes without any fix, because the
  distance filter suppresses updates when not moving) the engine switches to *stationary*:
  `PRIORITY_BALANCED_POWER_ACCURACY` (Wi-Fi / cell, GPS chip mostly off) every `stoppedIntervalSec` with batched
  delivery (`maxUpdateDelay` = 3 × interval). It switches back as soon as a fix is more than
  max(30 m, 2 × accuracy) from the last point or speed > 2 m/s. No Activity Recognition (it would need another
  permission prompt).
- **Uploads are event-driven**: after an accepted fix, coalesced to ≥ 20 s apart while moving and ≥ 60 s while
  stationary, plus backoff after failures. The network is used only when the queue is not empty. The only
  repeating timer is a 60 s idle check while the service runs.
- **WakeLock**: partial, 30 s timeout, only around each HTTP call, released in `finally`.
- All disk and network work runs on one background thread; SQLite in WAL mode with batched inserts.
- The notification channel is `IMPORTANCE_LOW` (no sound / vibration) and the notification is never updated.
- **Expected use** (rough, depends on the phone and signal): driving with GPS on all the time ≈ 3–6 % battery
  per hour (similar to a navigation app with the screen off); parked / at a desk in stationary mode ≈ 0.5–1 %
  per hour; data ≈ 1–3 MB per day of driving.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `EXPO_PUBLIC_SERVER_URL` | `https://gps.mintplus.co.in` | Server; the app calls `${SERVER}/api/tracker/v1` |

Put overrides in `apps/tracker/.env.local` (not committed). The value is baked in at build time.

## Develop

Background location needs a development build (not Expo Go):

```bash
npm install                 # at the repo root
cd apps/tracker
npx tsc --noEmit            # type check
npx expo run:android        # build, install and start Metro
```

## Android release APK (local, Windows)

Same as `apps/mobile`: the native build exceeds Windows' 260-character path limit under `OneDrive\Desktop`,
so build from a git worktree at a short path:

```bat
git worktree add --detach C:\vt HEAD     REM once; later: cd /d C:\vt & git checkout --detach <commit>
cd /d C:\vt & npm ci
cd apps\tracker
npx expo prebuild --platform android --clean
cd android
.\gradlew.bat assembleRelease
```

Output: `android/app/build/outputs/apk/release/app-release.apk` (signed with the debug key; fine for
testing, use a real upload keystore for Play). `android/` and `ios/` are generated and not committed;
change native settings in `app.json`.

After installing, on the phone: allow location **All the time**, allow notifications, and tap
**Allow unrestricted battery** on the home screen. The battery exemption matters: Android 12+ only lets the
watchdog / restart alarm start the service from the background when the app is exempt.

### Phone-maker (OEM) settings

Many Android skins kill background apps beyond what stock Android does. The home screen shows a
**Keep tracking running** card with maker-specific steps and an **Open phone settings** button that tries the
maker's autostart screen (falls back to App info):

| Maker | Setting |
|---|---|
| Xiaomi / Redmi / POCO (MIUI / HyperOS) | Security → **Autostart** ON; App info → Battery saver → **No restrictions**; lock the app in Recents |
| Oppo / Realme (ColorOS / Realme UI) | **Auto launch** / Startup manager ON; App info → Battery usage → **Allow background activity** |
| Vivo / iQOO | **Autostart** / Background startup ON; Battery → **Allow high background power usage** |
| OnePlus | App info → Battery usage → **Allow background activity**; Auto launch ON |
| Samsung (One UI) | Battery → Background usage limits → **Never sleeping apps** → add VeeTrax Tracker |
| Huawei / Honor | Battery → App launch → **Manage manually** (Auto-launch, Secondary launch, Run in background) |

See also <https://dontkillmyapp.com> for the current steps per model.

### Testing checklist (real phone)

1. Activate, Start tracking → the "VeeTrax Tracker is sharing your location" notification appears; the web
   map moves within ~30 s while driving.
2. **Swipe the app away** from Recents → notification stays, positions keep arriving.
3. **Reboot** the phone (do not open the app) → after unlocking, the notification comes back within ~1 min
   and positions resume.
4. **Update** the app (install a newer APK over it) → tracking resumes without opening the app.
5. **Airplane mode** for 10+ minutes while moving → the app shows points waiting; turn airplane mode off → the
   queue uploads (oldest first) within the backoff time (≤ 10 min, or tap Upload now) and the web history
   has no gap.
6. **Park** for 5 minutes → GPS mode shows *Stopped (battery saver)*, one heartbeat per minute on the web;
   start driving → back to *Moving* within one or two fixes.
7. **SOS** (hold 2 s) → SOS alarm on the web; in airplane mode it says "saved" and is sent later.
8. **Revoke** from the web (activate the same number on another phone) → the old phone stops at its next
   upload and shows "Tracking moved to another phone…". **Deactivate** the device on the web → the phone
   stops and shows "Tracking switched off by your administrator".
9. Tap **Stop** → notification disappears; it does not come back after a reboot.
10. Logs: `adb logcat -s VeeTraxTracker`.

## Google Play: background location declaration

Play requires a review for `ACCESS_BACKGROUND_LOCATION`. In Play Console → **App content**:

1. **Location permissions** declaration: core feature = *"Fleet / workforce tracking: the employer's VeeTrax
   account shows the live location and route history of this phone while the employee has tracking switched
   on."* Explain that background access is needed because tracking must continue with the screen off or the
   app closed, and that a permanent notification is shown while tracking.
2. **Video** (30 s or less, on a real phone): open the app → Start tracking → the in-app disclosure screen →
   system dialogs (While using → Allow all the time) → the tracking notification → the app closed while the
   position keeps updating on the VeeTrax web map.
3. **Prominent disclosure**: the app shows `disclosure.tsx` before any system permission dialog. Its text
   says location is collected *"even when the app is closed or not in use"* and why. Don't remove or move it
   after the permission request.
4. **Data safety** form: location (precise) collected and shared with the employer's account, purpose
   *App functionality*; device info (battery level). Data is encrypted in transit (HTTPS).
5. **Privacy policy URL** that covers background location collection.
6. Foreground service type **location** (`FOREGROUND_SERVICE_LOCATION`) declaration: same use case as above.

Also likely asked: `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` is allowed for apps whose core function is
continuous tracking; mention the fleet/workforce use case if Play asks.

## iOS

The config has `UIBackgroundModes: location` and the permission texts, but the app is built and tested for
Android only for now.
