# iPhone (iOS) work for the VeeTrax apps — instructions for the Mac developer

Status: 2026-11-16. Everything below is in this monorepo (`karthick5206/gps-app`). Android is the shipping platform today;
these are the steps to bring **both apps** to iPhone with the same features. Work needs a Mac with Xcode (latest stable),
CocoaPods, Node 24 and an Apple Developer account with access to the two bundle IDs.

| App | Folder | Bundle ID | Stack | iOS state |
|---|---|---|---|---|
| **VeeTrax** (fleet users, passengers, drivers) | `apps/mobile` | `com.sasvata.veetrax` | Expo SDK (React Native), MapLibre | JS is cross-platform; needs iOS build, permissions, device testing |
| **VeeTrax Tracker** (phone as GPS tracker) | `apps/tracker` | `com.sasvata.veetrax.tracker` | Expo + **native tracking module** | Screens are cross-platform; the **tracking engine is Android-only** and needs an iOS (Swift) implementation |

`ios/` and `android/` folders are generated (`npx expo prebuild`) and are **not committed**. Put native iOS code inside the
Expo module (`apps/tracker/modules/veetrax-tracker/ios/`) and configure everything else through `app.json` / config plugins.

## 1. Set up and run

```bash
npm ci                                  # repo root (workspaces)
npm run build -w packages/shared
cd apps/mobile   && npx expo prebuild -p ios --clean && npx expo run:ios --device
cd apps/tracker  && npx expo prebuild -p ios --clean && npx expo run:ios --device
```
Test against a staging/test API, never production data. Use real iPhones for location, camera and background behaviour
(the simulator does not reflect background location or camera).

## 2. Both apps — photo features (new in v1.18)

Two features use the camera and photo library on both platforms:

| Feature | Tracker app | VeeTrax app |
|---|---|---|
| **Person photo** (profile picture shown on the map in a status-coloured ring, hover card on web) | Profile → take / choose / remove photo (`/api/tracker/v1/photo`) | Shows photos on the map, lists and vehicle detail |
| **Location photo notes** ("Add photo here": bill, receipt, visit, other — 1–5 photos, note, amount; saved with GPS position, time, address; offline queue) | Yes (`/api/tracker/v1/photo-notes`) | Yes (main API `photo_notes`) |

The JS screens use `expo-image-picker` / `expo-camera` and already work cross-platform. iOS-specific tasks:

1. **Permission texts** (App Store requires clear purpose strings). Add to both `app.json` files under `expo.ios.infoPlist`
   (or the plugin options of `expo-image-picker` / `expo-camera` / `expo-location`):
   - `NSCameraUsageDescription` — "Take a profile photo or a photo of a bill or place to save with its location."
   - `NSPhotoLibraryUsageDescription` — "Choose a photo for your profile or a photo note."
   - `NSLocationWhenInUseUsageDescription` — "Save the place where a photo note was taken and show your position."
   - Tracker only (background tracking, section 3): `NSLocationAlwaysAndWhenInUseUsageDescription` with an honest
     explanation that the company tracks this phone during work / as agreed.
2. **iPhone photo format (HEIC)**. iPhones save HEIC; the server accepts **JPEG, PNG and WebP only** (person photo ≤ 5 MB,
   photo note ≤ 10 MB per image). Always send JPEG: use `ImagePicker` with `quality: 0.8` (returns JPEG) or convert with
   `expo-image-manipulator` (`SaveFormat.JPEG`, resize long side ≤ 1920 px) before upload. Verify on a real iPhone with
   HEIC and Live Photos.
3. **Offline queue** for photo notes: confirm the queue survives app suspension and relaunch on iOS and retries with the
   same `clientId` (the server is idempotent on it).
4. **Privacy manifest**: add/extend `PrivacyInfo.xcprivacy` (Expo supports `expo.ios.privacyManifests`) declaring location,
   photos and the required-reason APIs used by the dependencies.

## 3. Tracker app — native iOS tracking engine (main task)

Android implementation to mirror: `apps/tracker/modules/veetrax-tracker/android/src/main/java/com/sasvata/veetrax/trackerengine/`
(`Engine.kt`, `TrackerService.kt`, `PointQueue.kt`, `Uploader.kt`, `JumpFilter.kt`, `Health.kt`, `Prefs.kt`, `Starter.kt`,
`WatchdogWorker.kt`, `VeetraxTrackerModule.kt`). JS contract: `apps/tracker/modules/veetrax-tracker/index.ts`
(`NativeModuleShape`). Server contract: `apps/tracker` API docs (`API.md` §3) and `apps/api/src/mobile-tracker/*`.

Implement `modules/veetrax-tracker/ios/` (Swift, Expo Modules API) exposing **the same JS API**:
`start(token, serverUrl, config)`, `stop(why)`, `uploadNow()`, `isRunning()`, `getStatus()` (same `TrackerStatus` fields),
`setConfig`, `setCredentials`, `initServerUrl`, `setServerUrl`, `sendSos()`, `flush()`, `resetStopReason()`, `clear()`,
`deviceInfo()`, `installId()`, `savedToken()`, `takeCrash()`. Android-only calls (`openAutostartSettings`,
`hasOemAutostart`, `manufacturer`) return `'none'` / `false` / `"Apple"` on iOS. Register the module in
`expo-module.config.json` for the `ios` platform and extend `app.plugin.js` for iOS settings.

Behaviour on iOS:
- **Location**: `CLLocationManager` with `allowsBackgroundLocationUpdates = true`, `pausesLocationUpdatesAutomatically =
  false`, `showsBackgroundLocationIndicator = true`. Moving mode: best accuracy with the configured interval/distance
  (`intervalSec`, `distanceM`); stationary mode: reduced accuracy / `startMonitoringSignificantLocationChanges` and
  region monitoring to save battery (mirror Android's "moving / stationary" switch and `stoppedIntervalSec`).
- **Background modes**: `UIBackgroundModes` = `location`, `fetch`, `processing`; `BGTaskScheduler` for queued uploads.
- **Queue + upload**: persist points locally (SQLite or file), batch up to `batchMax`, POST to
  `${serverUrl}/api/tracker/v1/positions` with `Authorization: Bearer <token>` and the same point fields as Android
  (`t, lat, lng, acc, spd, brg, alt, bat, chg, mock, sos, flt, prov, sacc, sat, mode`); delete points only after a 200;
  back off on errors; handle `401 REVOKED / INVALID` and `403 INACTIVE` exactly like Android (`stopReason`).
- **Filters**: port `JumpFilter.kt` (accuracy, jumps, mock detection — on iOS use `CLLocation.sourceInformation`
  `isSimulatedBySoftware` / `isProducedByAccessory`).
- **Token storage**: Keychain (not UserDefaults).
- **Relaunch**: iOS cannot run a permanent foreground service and cannot restart after the user force-quits the app. Use
  significant-change / region monitoring so iOS relaunches the app in the background after reboot or termination by the
  system. Document clearly that "tracking required" (administrator setting) cannot block a user from stopping it on iOS;
  report `required` honestly in `getStatus()`.
- **SOS**: `sendSos()` sends an immediate point with `sos: true` (queue if offline), same results as Android.
- **Battery / health**: report battery level/charging, last fix, last upload, queue size, failures, like `Health.kt`.

App Store review: background location needs a strong justification and an in-app explanation screen before asking for
"Always" permission; provide a demo account and video for review.

## 4. VeeTrax app on iPhone — checks

- MapLibre native (`@maplibre/maplibre-react-native`) builds and renders the self-hosted tiles
  (`https://app.veetrax.com/tiles/…`; India + USA). No external map hosts.
- Push notifications: create an APNs key in the Apple Developer account and configure it for `expo-notifications`
  (generic payloads only; details are fetched from the API).
- Passenger and driver screens (ETMS): booking with ride preference (shared/private/flexible), trip screen with "times
  may change", driver route-update acknowledgement, boarding code entry, SOS, offline sync.
- Person photos on the map and in lists; "Add photo here" for photo notes.

## 5. Acceptance checklist (per app, on a real iPhone)

- [ ] Builds with `expo prebuild` + Xcode, signed with the right bundle ID, runs on iOS 16+.
- [ ] All permission prompts show the texts above; denying a permission shows a helpful message, no crash.
- [ ] HEIC photo from the camera and the library uploads as JPEG; photo appears on the web map / photo-notes page.
- [ ] Photo note taken offline uploads once online, exactly once.
- [ ] Tracker: tracking continues with the screen locked and the app in the background for 2+ hours; points arrive on
      the web live map; stationary mode saves battery; relaunch after reboot works; SOS works offline and online;
      revoked / inactive handling matches Android.
- [ ] No coordinates, tokens or personal data in logs.

## 6. Workflow

- Branch from `main`: `feature/ios-tracker-engine`, `feature/ios-mobile`.
- Keep JS/TS changes cross-platform; run `npx tsc --noEmit` in the app folders before pushing.
- Open a pull request to `main`; releases of the server are separate from app store releases.
- Questions about API contracts: `apps/api/src/mobile-tracker/`, `apps/api/src/object-photos/`, the photo-notes module,
  and `docs/` (DEVELOPER_GUIDE.md).
