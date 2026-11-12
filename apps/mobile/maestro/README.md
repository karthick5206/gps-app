# Maestro flows: ETMS driver and passenger shells (E5 WP 5.5)

Black-box flows for the driver shell (`(driver)`) and the passenger shell (`(passenger)`), as doc 11 §2.1 proposes
(Maestro open-source CLI only; Maestro Cloud is paid and out of scope; tool approval O4, 2026-11-11).

**Status (2026-11-12): committed, NOT run.** The development PC has no Android SDK, no emulator, no `adb`, no Java
and no Maestro CLI. A native or EAS build is not allowed yet either (EAS / O12 approval pending). The flows target the
English UI texts of the current screens; they have not been tried against a running app, so expect some selector
fixes on the first run.

| Flow | What it covers |
|---|---|
| `driver-journey.yaml` | sign in → start duty → open today's trip → acknowledge → start (online, confirm dialog) → arrive / board / leave at each pickup → drop at the office → complete → "All actions synced" |
| `driver-offline-sync.yaml` | R6 on the device: airplane mode → arrive + board → "waiting to sync" (never confirmed) → kill + relaunch (queue survives) → back online → Sync now → "All actions synced" |
| `passenger-journey.yaml` | sign in → commute home (privacy line, no "No passenger profile") → today's trip → trip screen (estimated pickup, driver, transport desk) → bookings |
| `passenger-notifications.yaml` | Notices tab → "Your trip starts soon" (generic text) → opens the trip |
| `subflows/login.yaml` | e-mail + password sign-in, used by every flow |

## Running them (when an emulator is available)

1. Android SDK + an emulator image (API 34+), Java 17, Maestro CLI (`curl -Ls "https://get.maestro.mobile.dev" | bash`;
   free). Nothing is installed on production.
2. The app needs a **development build** (native modules such as MapLibre are not in Expo Go):
   `npx expo run:android` from `apps/mobile` builds a local debug app and starts Metro. Do not use an EAS or release
   build for these tests until the owner approves EAS / O12. Point it at a local or isolated test API
   (`EXPO_PUBLIC_API_URL`), never at production.
3. Test data (synthetic only): a driver login with one ETMS trip today (vehicle standing at the first pickup for the
   offline flow), and a passenger login seated on that trip. The quickest source is the E5 scenario runner's accounts
   (`npm run etms:e5 -w @veetracer/api -- --keep`, see `apps/api/scripts/etms-e2e/README.md`), or a dispatcher
   publishing a trip in the web app on a test instance.
4. Run:

```bash
maestro test apps/mobile/maestro \
  -e DRIVER_EMAIL=<driver>@example.test -e DRIVER_PASSWORD=<password> \
  -e PASSENGER_EMAIL=<passenger>@example.test -e PASSENGER_PASSWORD=<password>
# APP_ID defaults to com.sasvata.veetrax (the dev build); pass -e APP_ID=… for another package.
```

Notes:
- The driver flows tap stop actions only while the vehicle is standing: the in-motion lock hides them when the vehicle
  GPS reports movement. Drive the van with `npm run etms:sim-trip` or keep it parked.
- `setAirplaneMode` needs an emulator (or a device that allows it through adb).
- The screens have no `testID`s; selectors are the visible English texts. Keep the emulator language English.
- Real-device checks that an emulator cannot cover are in `docs/employee-transport/evidence/2026-11-12-e5-device-lab-checklist.md`.
