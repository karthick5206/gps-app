# E5 device-lab checklist (WP 5.5): driver and passenger shells on real phones

**Status: NOT RUN.** Real-device testing is not possible yet: it needs a native build of `apps/mobile`, and EAS builds
(plus the O12 `eas.json` URL change) are not approved. No Android SDK, emulator or Maestro CLI exists on the
development PC either. This checklist is what the device lab runs once the owner approves a build. It complements the
Maestro flows in `apps/mobile/maestro/` (emulator, automatable) with what only a physical phone shows.

Rules for the run: synthetic accounts only (`@example.test`, synthetic names); an isolated test API, never production;
no real SMS / push to people (the test API uses `PUSH_PROVIDER=fake` or an Expo project owned by the test team, and
`SMS_PROVIDER=console`). Record per device: model, Android / iOS version, OEM skin, build id, app version, result,
screenshots (synthetic data only) or a screen recording.

## 1. Devices (owner decision O6 / doc 11 Q8 still open)

Proposed minimum for an Android-first India pilot:

| # | Class | Why |
|---|---|---|
| D1 | Low-end Android (2-3 GB RAM, Android 11-12), e.g. a Redmi / Realme entry model | Typical driver phone; aggressive battery killers (MIUI / ColorOS) |
| D2 | Mid-range Samsung (One UI, Android 14+) | Common passenger phone; Samsung battery optimisation and notification channels |
| D3 | Stock Android (Pixel or Android One, latest) | Reference behaviour |
| D4 | iPhone (iOS 17+), only if O6 says iOS is in the pilot | Push via APNs, screenshot behaviour differs (no FLAG_SECURE) |

## 2. Build under test

- [ ] Development or preview build of `apps/mobile` from the release commit, `EXPO_PUBLIC_API_URL` = the test API.
- [ ] App version and commit recorded; the same build on every device.
- [ ] Test API seeded: one driver login with today's trip (3 pickups + office), three passenger logins seated on it,
      one passenger without consent, one driver with an expired licence (start must be refused).

## 3. Driver shell

| # | Check | Expected | D1 | D2 | D3 | D4 |
|---|---|---|---|---|---|---|
| 3.1 | Sign in as driver | Driver tabs only (Today, Inbox, Sync, Account); no fleet menus | | | | |
| 3.2 | Start duty online / in airplane mode | Online: on duty. Offline: refused with "Needs a connection", nothing queued | | | | |
| 3.3 | Acknowledge offline, then online | "Waiting to sync" until the server confirms, then "Acknowledged"; never shown confirmed early | | | | |
| 3.4 | Start trip with a stale phone clock (set the clock 10 min back) | Refused (STALE_COMMAND message), trip not started | | | | |
| 3.5 | Expired-licence driver starts a trip | Refused with the licence message | | | | |
| 3.6 | In-motion lock: drive the van (or `etms:sim-trip`) while the trip screen is open | Only "Navigate" / call remain; stop actions return once the vehicle stops | | | | |
| 3.7 | Arrive / board / leave at each pickup | Counts update; passenger names visible, no phone numbers | | | | |
| 3.8 | No-show before 5 min | Button shows "No-show in m:ss"; tapping early is refused, not queued as confirmed | | | | |
| 3.9 | Offline 10 min: airplane mode, tap arrive / board / leave on two stops, kill the app, reboot the phone, reopen, go online | Queue survives kill and reboot; every action syncs once; trip state on the dispatcher board matches; no duplicate passenger notifications | | | | |
| 3.10 | Battery saver / app put to sleep by the OEM for 15 min with queued actions | Actions sync on next open; nothing lost | | | | |
| 3.11 | Arrive at the office | Drop all riders and complete. **Known defect D1:** GPS auto-completes the trip on arrival, so drops there come back LATE; record what the phone shows | | | | |
| 3.12 | Trip closed | Manifest hidden ("The trip is closed …"); cached names gone after restart | | | | |
| 3.13 | Navigation hand-off | Disabled until owner decision L6; if enabled on the test build, only coordinates leave the app | | | | |
| 3.14 | Screenshot / screen recording on the trip screen (security review M3) | Android: blocked (black / refused) on the manifest screens; iOS: record behaviour | | | | |
| 3.15 | Reassign the trip to another driver while the phone is offline, then go online | Trip disappears (REVOKED), queued events come back REJECTED NOT_ASSIGNED with a message | | | | |
| 3.16 | Sign out with queued actions | Warning; the queue is not sent under another login | | | | |

## 4. Passenger shell

| # | Check | Expected | D1 | D2 | D3 | D4 |
|---|---|---|---|---|---|---|
| 4.1 | Sign in as passenger | Commute, Bookings, Notices, Account tabs only | | | | |
| 4.2 | Consent screen (passenger without consent) | Notice text shown; grant / withdraw recorded; pickup hidden without consent | | | | |
| 4.3 | Today's trip | Own pickup, estimated pickup time, driver first name, co-riders only as a count | | | | |
| 4.4 | Vehicle on the map | Visible only inside the trip window; gone after a no-show or after drop | | | | |
| 4.5 | Push: TRIP_STARTING_SOON, VEHICLE_APPROACHING, TRIP_DELAYED, TRIP_CANCELLED | Arrive on the "trip" channel; lock screen shows generic text only (no names, plates, places); tapping opens the trip | | | | |
| 4.6 | Push preferences off | No push, but the Notices list still has the entry | | | | |
| 4.7 | Languages en / hi / ta | Every ETMS screen and notification text translated; no clipped labels on small screens | | | | |
| 4.8 | Cancel own booking inside / after the cut-off | Inside: cancelled, seat freed on the board. After: refused with the cut-off message | | | | |
| 4.9 | Font scale 1.3× and TalkBack / VoiceOver | Buttons ≥ 48 dp, labels read in a sensible order | | | | |
| 4.10 | Screenshot on the trip screen (M3) | As 3.14 | | | | |

## 5. Push / token lifecycle (D7)

- [ ] Token registered after sign-in (Account shows push on); removed on sign-out (no push after sign-out).
- [ ] Reinstall the app: the old token is cleaned up after the first failed send (DeviceNotRegistered).
- [ ] Two phones on one login: both receive; signing one out stops only that one.
- [ ] Notification channel "trip" exists with lock-screen visibility PRIVATE (Android settings → app → notifications).

## 6. Not covered here

SOS (WP 5.4) and passenger self-booking (WP 5.3) are not on `main` yet; add their rows when they land. Load (1,000
vehicles) is staging work (doc 11 §5).
