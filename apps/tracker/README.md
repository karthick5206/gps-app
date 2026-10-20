# VeeTrax Tracker (Android phone as a GPS tracker)

Expo / React Native (SDK 58) app that turns an Android phone into a tracker for the VeeTrax platform. It
talks only to the tracker API (`docs/mobile-tracker/API.md`), base URL `${SERVER}/api/tracker/v1`.

App id (Android package and iOS bundle id): **`com.sasvata.veetrax.tracker`**. It is separate from the main
VeeTrax app (`com.sasvata.veetrax`). No Firebase, no push, no EAS project.

## How it works

1. The admin adds the phone in VeeTrax **Devices** (model *VeeTrax · Mobile tracker*, unique id = mobile
   number, e.g. `919876543210`) and assigns it to a company, vehicle or person.
2. On the phone: enter the number, get a 6-digit code by SMS (or the admin reads it from the Devices page),
   enter it. The app stores the tracker token in `expo-secure-store`.
3. **Start tracking** shows a location disclosure, then asks for location (while using, then *all the
   time*) and notifications. A foreground service with a permanent notification collects fixes
   (`BestForNavigation`, interval and distance from the server config) through an `expo-task-manager` task,
   also when the app is closed.
4. Fixes go to a local SQLite queue (max 20 000 points; fixes worse than ± 500 m are dropped on the phone)
   and are uploaded oldest first in batches of `config.batchMax`, from the background task and every 30 s
   while the app is open, with exponential backoff (5 s … 10 min) when offline.
5. Server answers: `401 REVOKED` / `INVALID` → stop, sign out, show why. `403 INACTIVE` → stop, keep the
   token, check `/me` again hourly while the app is open.
6. **SOS**: press and hold 2 s; one point with `sos: true` is sent at once (queued if offline).

Code: `src/lib` (api client, SQLite queue, background task, uploader, permissions), `src/app` (screens:
`activate`, `index` = home, `disclosure`). All text is in `src/lib/strings.ts`.

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
**Allow unrestricted battery** on the home screen. On Xiaomi / Oppo / Vivo / Realme / Samsung phones also
enable *Autostart* and set battery to *No restrictions* for VeeTrax Tracker in system settings, or the
OEM may still kill the service.

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
