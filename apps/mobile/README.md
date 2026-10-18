# VeeTracer mobile app

React Native / Expo (SDK 58) app for Android and iOS, in the gps-app monorepo. It uses the same API and
`@veetracer/shared` package as the web app.

**Screens:** sign-in (password or mobile OTP), live map, vehicles, vehicle detail, history playback,
alerts (with acknowledge), dashboard, reports (view and share Excel/PDF/CSV), device commands and push alerts.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `EXPO_PUBLIC_SERVER_URL` | `https://gps.mintplus.co.in` | Server the app talks to (`/api` and the `/live` socket) |
| `EXPO_PUBLIC_MAP_STYLE_LIGHT` / `_DARK` | OpenFreeMap styles | Same basemaps as the web map |

Put overrides in `apps/mobile/.env.local` (not committed).

App ids: Android package and iOS bundle id are both `com.sasvata.veetracer` (`app.json`). Change them
**before** the first store upload; they can't change afterwards.

## Develop

The map (MapLibre) and other native modules mean the app can't run in Expo Go. Use a development build:

```bash
npm install                       # at the repo root
cd apps/mobile
npx expo run:android              # builds, installs on the emulator/phone, starts Metro
npx expo run:ios                  # on a Mac with Xcode
```

Checks: `npx tsc --noEmit` and `npx expo-doctor`.

## Android release APK (local, Windows)

The native C++ build exceeds Windows' 260-character path limit when the repo lives deep under
`OneDrive\Desktop`. A `subst` drive doesn't help, because Node resolves it back to the long path. Build from
a git worktree at a short path instead:

```bat
git worktree add --detach C:\vt HEAD     REM once; later: cd /d C:\vt & git checkout --detach <commit>
cd /d C:\vt & npm ci & npm run build:shared
cd apps\mobile
npx expo prebuild --platform android --clean
cd android
.\gradlew.bat assembleRelease
```

Output: `android/app/build/outputs/apk/release/app-release.apk`. Local release builds are signed with the
debug key, which is fine for testing. Use EAS (below) or a real keystore for Play Store uploads.

`android/` and `ios/` are generated (`expo prebuild`) and not committed. Change native settings in
`app.json` and config plugins.

## iOS (on the Mac)

1. Install Xcode, CocoaPods (`sudo gem install cocoapods`) and Node 22+.
2. Clone the repo, run `npm install` at the root, then in `apps/mobile`: `npx expo run:ios` (simulator), or
   `npx expo run:ios --device` for a connected iPhone.
3. For TestFlight / App Store: `npx eas-cli@latest build --platform ios` (needs an Apple Developer account),
   or archive `ios/VeeTracer.xcworkspace` in Xcode.

## Push alerts

The server sends the alert setting's **PUSH** channel through the Expo push service, which forwards to FCM
and APNs. Setup, once:

1. Create an Expo account and run `npx eas-cli@latest init` in `apps/mobile`. This writes
   `extra.eas.projectId` to `app.json`. The app skips push registration while it's missing.
2. **Android:** create a Firebase project and add an Android app with package `com.sasvata.veetracer`.
   Download `google-services.json` into `apps/mobile/` and set `"android": { "googleServicesFile": "./google-services.json" }`.
   In EAS, under credentials, upload the FCM V1 service-account key.
3. **iOS:** `eas credentials` creates the APNs key.
4. Server: nothing is required. Optional: `EXPO_ACCESS_TOKEN` (enhanced push security), or `PUSH_PROVIDER=none`
   to turn push off.
5. In the web app's Alert Settings, enable the **Push** channel for the alert types and severities you want.

Each phone registers after sign-in (`POST /auth/push-token`). Pushes stop when the user signs out or the
session is revoked. Tapping a notification opens the alert.

## Vehicle icons

`assets/vehicles/*.png` are rendered from the web map's icon code, so both apps match. After changing
`apps/web/src/features/live/map/vehicle-icons.ts`, regenerate them:

```bash
node apps/mobile/scripts/gen-vehicle-icons.mjs   # needs playwright resolvable (NODE_PATH)
```
