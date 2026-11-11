# 08: Employee App (E0, Agent 4)

Status: E0 discovery, read-only on code. Baseline: worktree `D:\Vibhav\gps-app-wt\etms` = `f5b151b` = v1.8.0.
Conventions: **[V]** = Verified (evidence cited as path + symbol); **[P]** = Proposed design (no code exists).
Terms follow `00-e0-brief.md` §2 (Passenger, Booking, Transport trip, Pickup point, Corporate customer, Tenant).

---

## 0. Answer to brief question 3 (summary)

**Recommendation: host the Employee (passenger) experience in `apps/mobile` ("VeeTrax", `com.sasvata.veetrax`) as a
separate, permission-gated "Passenger shell". Do not extend `apps/tracker`. Do not create a new binary in E1–E3, but keep
it as a named fallback with explicit triggers (§2.6).**

Why, in one table:

| Criterion | `apps/mobile` | `apps/tracker` | New binary |
|---|---|---|---|
| Identity | User + JWT + `/auth/me` permissions: can carry a passenger role and server-side own-data scope [V] | Opaque token bound to a **Device**, not a person; no permissions [V] | Would reuse mobile's auth anyway |
| Location model | No location permission today; can add **foreground-only** location [V] | Built around **background** location, foreground service, boot restart, admin-forced `trackingRequired` [V] | Foreground-only |
| Play Store | No background-location declaration needed if foreground-only [P] | Background-location declaration's "core feature" is workforce tracking: wrong promise for passengers [V] | New listing, new review, new keystore |
| Push | Expo push wired end to end, incl. SOS channel [V] | None ("No Firebase, no push, no EAS project") [V] | Must set up again |
| i18n / theme / maps / API client | Shared `@veetracer/shared` i18n, MapLibre, react-query, typed API [V] | Own string tables, no maps, minimal API [V] | Copy or extract |
| Cost | Lowest: new route group + role guard + ~12 screens | High and harmful (re-architecture + privacy regression) | Highest (second store presence, CI, signing) |

---

## 1. Verified current state of both apps

### 1.1 `apps/mobile` ("VeeTrax")

| Topic | Fact | Evidence |
|---|---|---|
| Identity | Name "VeeTrax", slug `veetracer`, v0.6.9, Android `versionCode` 69, Android package and iOS bundle `com.sasvata.veetrax`, EAS project `43750026-…`, owner `karthick5206` | `apps/mobile/app.json` (`expo.*`) |
| Stack | Expo SDK 58, RN 0.88, React 19.3, expo-router (typed routes, React Compiler), TanStack Query 5, i18next, MapLibre RN 11, socket.io-client | `apps/mobile/package.json` |
| Builds | EAS profiles `preview` (internal) and `production` (store, auto-increment, remote app version); base env `EXPO_PUBLIC_SERVER_URL=https://gps.mintplus.co.in` | `apps/mobile/eas.json` |
| Store | Google Play listing constant `PLAY_STORE.veetrax`; iOS build documented (TestFlight via EAS) but no App Store link in code | `packages/shared/src/store-links.ts` `PLAY_STORE`; `apps/mobile/README.md` "iOS" |
| Navigation | Root `Stack` with `Stack.Protected guard={signedIn}` around ~35 screens and `guard={!signedIn}` around `login`. Tabs: `index` (Live map) and `vehicles` **always shown**; `alerts` and `dashboard` hidden by `href: can(...) ? undefined : null`; `more` lists items behind `can(menu)` | `src/app/_layout.tsx` `RootStack`; `src/app/(tabs)/_layout.tsx` `TabsLayout`; `src/app/(tabs)/more.tsx` `MenuItem` uses |
| Auth (client) | Email + password (`POST /auth/login`) or mobile OTP (`POST /auth/otp/request`, `/auth/otp/verify`); access token **in memory only**, refresh token and selected company in **SecureStore** (`vt.refreshToken`, `vt.companyId`); single-flight refresh on 401; sign-out unregisters push and calls `/auth/logout` | `src/app/login.tsx` `PasswordForm`, `OtpForm`; `src/lib/session.ts` `session`; `src/lib/api.ts` `refreshAccessToken`, `authorizedFetch`; `src/features/auth/auth.tsx` `AuthProvider.signOut` |
| Permissions | `GET /auth/me` → `Me { user, company, permissions: PermissionMap, dataScope }`; `can(menu, action)` = `canDo(me.permissions, …)` | `src/features/auth/auth.tsx` `meQuery`, `can`; `packages/shared/src/api.ts` `Me`; `packages/shared/src/permissions.ts` `can`, `MENU_KEYS` |
| Menu catalogue | 43 menu keys, all fleet/admin oriented; **no passenger / transport-self key**; `DataScope = 'COMPANY' \| 'ASSIGNED'` (no SELF) | `packages/shared/src/permissions.ts` `MENU_KEYS`, `DataScope` |
| Push | Expo push token registered after sign-in (`POST /auth/push-token`); Android channels `alerts` and `sos` (MAX, siren, DND bypass); full-screen SOS alarm screen; native `AlarmMessagingService` extends Expo's FCM service to ring when the app is closed | `src/features/notifications/push.ts` `registerForPush`, `ensureChannels`, `openSos`; `modules/veetrax-alarm/android/.../AlarmMessagingService.kt` |
| Location | **No `expo-location` dependency, no location permission.** "Live" data comes from server sockets | `apps/mobile/package.json` (absent); `app.json` `android.blockedPermissions` |
| Realtime | `/live` socket (company room) for vehicle positions and alerts; server refuses a socket without `live_map` or `alerts` view | `src/features/live/use-live-connection.ts`; `apps/api/src/live/live.gateway.ts` (`hasPermission(ctx,'live_map','view')`, `byCompany` rooms) |
| Maps | MapLibre; default styles are **OpenFreeMap** (`tiles.openfreemap.org`) unless `EXPO_PUBLIC_MAP_STYLE_*` set at build; `eas.json` does not set them | `src/lib/config.ts` `MAP_STYLE`; `packages/shared/src/basemap.ts` `OPENFREEMAP`; `ops/deploy/linux/maps/README.md` line 16 ("mobile apps need the same … and a new build") |
| Geocoding | Through the server only (`/geocode/reverse`, `/geocode/search`) → Photon in production | `src/features/geocoding/use-address.tsx`; `src/features/geofences/PlaceSearch.tsx` |
| i18n | i18next with shared resources; languages `en` (locale `en-IN`), `hi`, `ta`; device language fallback; preference synced from profile (`PATCH /auth/me/preferences`) | `src/lib/i18n.ts`; `packages/shared/src/api.ts` `LANGUAGES` |
| Accessibility | Reduce-motion respected, user text size / map icon size, ~85 `accessibilityLabel/Role` uses | `src/lib/motion.ts`; `src/features/display/display.ts`; grep count |
| Offline | No persisted query cache, no NetInfo; server-down banner on live map only; SOS screen rings even if the alert cannot load | `src/app/(tabs)/index.tsx` `styles.offline`; `src/app/sos/[id].tsx` comment line ~82 |
| Employee-facing today | None for a rider. `attendance*` screens are the **admin** view of staff attendance (`GET /attendance`, `PUT /attendance/correction`). Personal/family accounts are consumer features (`family.tsx`, `share/[id].tsx`) | `src/app/attendance-day.tsx`; `src/app/family.tsx`; `src/app/share/[id].tsx` |

### 1.2 `apps/tracker` ("VeeTrax Tracker")

| Topic | Fact | Evidence |
|---|---|---|
| Identity | "VeeTrax Tracker", v1.5.0, `versionCode` 29, `com.sasvata.veetrax.tracker`, `allowBackup:false`; **no EAS project, no Firebase, no push** | `apps/tracker/app.json`; `apps/tracker/README.md` intro |
| Purpose | Turns a phone into a GPS **Device** (model protocol `mobile`, `uniqueId` = E.164 digits) | `docs/mobile-tracker/API.md` intro; `packages/shared/src/mobile-tracker.ts` `MOBILE_TRACKER_PROTOCOL` |
| Activation | `POST /tracker/v1/activate/request` (admin must have created the Device) → 6-digit code by SMS, email, or read out by the admin → `/activate/verify` returns an opaque token (stored hashed in `MobileTrackerSession.tokenHash`); activating revokes earlier tokens; `activate/restore` by hashed Android ID after reinstall; self-service only for personal/family accounts (business users are refused) | `apps/api/src/mobile-tracker/mobile-tracker.controller.ts` `MobileTrackerController`; `mobile-tracker.service.ts` `requestCode`, `verify`, `startSession`, `restore`; `self-service.ts` `TrackerSelfService.findOwner` (BUSINESS → 403) |
| Token scope | Token resolves to a Device (`session()` → `deviceId`, company, assignments); no User, no permissions | `mobile-tracker.service.ts` `session` |
| Licence | Each phone is a `MOBILE_TRACKER` licence seat | `apps/api/prisma/schema.prisma` `enum LicenceType` |
| Location engine | Native Kotlin foreground service (`foregroundServiceType=location`, `START_STICKY`), restart on boot / update / task removal, WorkManager watchdog, OEM autostart helpers, SQLite queue (cap 50 000 rows, oldest dropped), jump filter | `modules/veetrax-tracker/android/.../TrackerService.kt`, `Engine.kt`, `BootReceiver.kt`, `WatchdogWorker.kt`, `PointQueue.kt`, `JumpFilter.kt` |
| Permissions | `ACCESS_FINE/COARSE/BACKGROUND_LOCATION`, `FOREGROUND_SERVICE_LOCATION`, `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`, `RECEIVE_BOOT_COMPLETED`, `CAMERA` | `apps/tracker/app.json` `android.permissions` |
| Admin-forced tracking | `Device.trackingRequired`: the employee **cannot** stop tracking from the phone | `schema.prisma` `Device.trackingRequired`; `src/components/HomeMenu.tsx` `confirmDeactivate` (`S.requiredBody`) |
| Consent | Prominent disclosure screen before OS dialogs (Play policy) | `src/app/disclosure.tsx`; README "Google Play: background location declaration" |
| Employee features | Attendance status, outing answers (official/personal), check-in selfie / video, SOS (hold 2 s, sent as a position with `sos:true`) | API.md "Attendance"; `src/components/AttendanceCard.tsx`; `src/components/SosButton.tsx`; `Engine.kt` `sendSos` |
| SOS dependency | SOS goes through the tracking engine and token; results `sent/queued/rejected/no_location/no_token/stopped` | `Engine.kt` `sendSos` doc comment |
| i18n | Own string tables `en`, `hi`, `ta` (not the shared i18n) | `src/lib/strings.ts`, `strings-hi.ts`, `strings-ta.ts`; `src/lib/language.ts` `LANGUAGES` |
| Platforms | Android only ("built and tested for Android only") | README "iOS" |
| Store | Play listing constant `PLAY_STORE.tracker`; background-location declaration = "Fleet / workforce tracking" | `store-links.ts`; README "Google Play" |

> **Corrected in E0.5 (2026-11-11):** The Location engine row said "SQLite queue (20 000)". Re-verified at v1.8.0: `apps/tracker/modules/veetrax-tracker/android/.../trackerengine/PointQueue.kt` l.18 `const val CAP = 50_000`; rows above `CAP` are trimmed oldest-first (l.49–54). The same error in `09` §1.4 is corrected there.

### 1.3 Server-side authentication (relevant to passengers)

| Topic | Fact | Evidence |
|---|---|---|
| Tokens | JWT access token 15 min (`sub`, `cid`, `sa`, `sid`), refresh token 30 days, rotated, hashed in `Session` | `apps/api/src/auth/token.service.ts` `ACCESS_TTL_SEC`, `REFRESH_TTL_MS`; `access/auth-context.ts` `AccessTokenPayload` |
| Request context | `AuthContext { userId, companyId, permissions, dataScope, branchIds, objectIds, shares, sessionId }` | `apps/api/src/access/auth-context.ts` |
| User | `User.email @unique`, `User.mobile @unique` (**global**, not per company), `companyId` single; no employee id | `schema.prisma` `model User` |
| Seats | "User licences are no longer needed: users are free" | `apps/api/src/licences/billing.service.ts` line ~158 |
| OTP login | `requestOtp`: 503 unless an SMS provider **or Arattai** is ready (email alone is not enough); silent OK for unknown mobiles (no enumeration); 5-min TTL, 30 s resend, 5 attempts; also sends to email when configured | `apps/api/src/auth/auth.service.ts` `requestOtp`, `verifyOtp`, `OTP_UNAVAILABLE` |
| SMS providers | `console`, `smartping` (India DLT templates), `msg91` stub ("not implemented yet"); **no US provider** | `apps/api/src/notifier/sms.ts` `createSmsProvider`, `Msg91SmsProvider` |
| Push sender | `ExpoPushProvider` POSTs to `https://exp.host/--/api/v2/push/send` (Expo → FCM/APNs); `PUSH_PROVIDER=none` disables | `apps/api/src/notifier/push.ts` |
| Time-boxed sharing precedent | `LiveShare` (token hash, `expiresAt`, `revokedAt`, destination/ETA) + public endpoint `GET /public/live-share/:token` | `schema.prisma` `model LiveShare`; `apps/api/src/live-share/live-share.controller.ts` |

### 1.4 Key observations

1. Neither app serves a rider today. The only "employee" self-service is the tracker's attendance, which identifies the
   person through a tracked **Device / TrackedObject (PERSON)**, not a User.
2. `apps/mobile` already has the right foundations (`Me.permissions`, `Stack.Protected`, SecureStore, Expo push, shared
   i18n, server geocoding). Its shell, however, assumes a fleet user: Live map and Vehicles tabs are unconditional.
3. **Maps leak (pre-existing):** unless store builds were made with `EXPO_PUBLIC_MAP_STYLE_*`, the mobile app loads
   OpenFreeMap tiles from a third party, contrary to the "nothing leaves the server" rule. Must be fixed (build env)
   before any passenger build. Also `eas.json` still points at `gps.mintplus.co.in`, not `app.veetrax.com`.

   > **E0.5 Lead note (2026-11-11):** Gate G8 covers the mobile builds and also the web public share page, which
   > hard-codes OpenFreeMap (`PublicSharePage.tsx:104`) (`12` §2.1, `14` G8). The server URL for new builds is owner
   > decision O12 (README §7; default `https://app.veetrax.com`). G8 is outstanding.
4. OTP sign-in depends on India-only channels (Smartping DLT / Arattai). US passengers have no OTP channel today.

---

## 2. Brief question 3: which app hosts the Employee experience

### 2.1 Auth-model fit

- Passengers must see **their own** bookings and trips across a long-lived relationship, edit profile and preferences,
  and receive push. That is a person identity with permissions: `User` + `Session` + `Me.permissions` [V].
- The tracker identity is a **Device token** (`MobileTrackerSession`), consumes a paid `MOBILE_TRACKER` seat, and has no
  permission model [V]. Bolting bookings onto it would create a second person-identity system (violates reuse-first).
- Users are free (no seat) [V], so a User per passenger has no licence blocker.
- OTP sign-in already exists for Users (`/auth/otp/*`) [V]; the tracker's OTP flow adds nothing a passenger needs.

### 2.2 Privacy

| Requirement (plan §4.2, §10) | Tracker app | Mobile app |
|---|---|---|
| No continuous tracking merely because of a profile | Contradicts its purpose; engine restarts on boot; `trackingRequired` lets an admin forbid stopping [V] | No location at all today [V]; add foreground-only, opt-in |
| GPS only when the employee chooses it, for a stated purpose and duration | Background "all the time" permission is requested by design [V] | `requestForegroundPermissionsAsync` per action [P] |
| Live location only in an authorised window | Server would have to discard data it already received | Collect nothing outside the action; server shows **vehicle** location to the passenger, not passenger location to anyone [P] |

Mixing riders into a workforce-tracking app also makes it hard to explain to employees (and works councils / DPDP and
US-state privacy reviews) that the transport app does not track them.

### 2.3 App-store and permission implications

- Tracker: Play's background-location declaration names "fleet / workforce tracking" as core feature [V]. Adding a
  passenger feature does not change it, but the passenger audience would inherit an app that asks for "all the time"
  location. iOS is not built [V], yet US corporate employees are largely on iPhone.
- Mobile: adding `expo-location` with `isAndroidBackgroundLocationEnabled: false` and only `NSLocationWhenInUseUsageDescription`
  needs **no** background-location declaration [P]. Data-safety form must add "approximate/precise location, optional,
  app functionality" [P].
- Mobile already ships `USE_FULL_SCREEN_INTENT` and a media-playback foreground service for the SOS alarm
  (`modules/veetrax-alarm/android/src/main/AndroidManifest.xml`) [V]. Passengers do not need the siren receiver role;
  keep it, but re-check the Play full-screen-intent declaration wording when passengers become an audience [P].
- Store listing: the app is marketed as fleet tracking ("Every vehicle, every second, one screen." in `login.tsx`).
  Listing text and screenshots need a passenger section; the in-app hero should follow the role after sign-in [P].

### 2.4 Cost (rough, for the Lead's estimates)

| Option | Main work | Relative cost |
|---|---|---|
| A. Mobile + Passenger shell | Role detection, `(passenger)` route group, ~12 screens, `expo-location` (foreground), persisted trip cache, push categories, map-style build env | **1×** |
| B. Tracker | New User-style auth inside tracker, maps (MapLibre not present), push from scratch (EAS + Firebase), shared i18n, iOS build, and then hiding the tracking engine from passengers | ~2.5–3× and a privacy regression |
| C. New binary | Everything in A plus new store listings (Play + App Store), signing keys (`tooling/expo/with-release-signing.js`), EAS project, Firebase app, CI, review cycles; shared code would need extraction into a package first | ~1.8–2× |

### 2.5 Decision

**Option A.** Shared foundations (plan §4.4) come for free; authorisation is never shared: the passenger shell trusts
only the server's answers (`Me.permissions` + own-scope endpoints).

> **Resolved in E0.5 (2026-11-11):** Option A is the approved direction: hosting the passenger and driver shells in `apps/mobile` is **D4, approved by the owner on 2026-11-11** (README §1.1, §5). The E0 review had noted that it was then only a recommendation. Nothing is implemented; the store listing / white-label question stays owner decision P6.

### 2.6 Triggers that would justify a separate binary later [P]

1. A corporate customer requires a **white-label** app or MDM-only distribution.
2. Play/App Store review objects to one app serving fleet managers and passengers.
3. App size or start-up time of the fleet app becomes a measurable problem on low-end Android phones.
4. The driver app (Agent 5) and passenger app need different release cadences that EAS channels cannot handle.

Structure option A so that this split stays cheap: put passenger code in `src/features/transport/*` and
`src/app/(passenger)/*` with no imports from fleet features except shared UI, API, auth, i18n and theme.

---

## 3. Employee role and authentication flow [P]

### 3.1 Identity mapping

| Layer | Proposal |
|---|---|
| Employee transport profile | Customer-owned record (employee id, office, shift, home pickup, accessibility needs, emergency contact). Exists **without** an app login (dispatchers can book for employees who never install the app). Model ownership: Agent 1 (`04-proposed-data-model-and-erd.md`). |
| Login identity | Optional 1:1 link `profile.userId → User.id` created at activation. The User lives in the **corporate customer's** company (tenant), holds a system role "Passenger", and has no fleet menus. |
| Lighter identity? | Rejected: a separate passenger token type would duplicate `Session`, refresh, push registration and audit. The User row is cheap (free seat). |

**Blocking issue to resolve (Agent 1 / 6):** `User.mobile` and `User.email` are **globally unique** [V]. An employee who
already has a VeeTrax personal/family account (same mobile) cannot get a second User in the employer's company. Options:
(a) per-company uniqueness (schema change, broad impact on OTP lookup); (b) allow a User to hold memberships in several
companies (larger change); (c) for E1–E3, refuse with a clear message and let the admin use a different email/mobile.
Recommend (c) now, (b) evaluated later.

> **Resolved in E0.5 (2026-11-11):** **D5, approved by the owner on 2026-11-11** (README §1.1, §5), adopts this mapping: passenger = `User` + **Passenger** role + `EmployeeTransportProfile`, relationship-based access on `/api/me/transport/*`, and option (c) for E1–E3 (one login per person, `IDENTITY_IN_USE`). The Passenger role is seeded as a per-company role template only when `etms` is enabled (`12` WP 1a.2), not added to the global `SYSTEM_ROLES`, so "system role" in §3.1 / §3.3 should read "role template". The menu key is `etms_self` (Lead naming, `02` §3.1), not `transport_self`. Still open: option (b) multi-membership and dual-role users (**P3**), and the final template set (**P6**).

### 3.2 Activation (organisation-approved)

```
Corporate admin imports / creates employee transport profiles (web, Agent 3)
        │ marks "app access" → server creates inactive-login User (role Passenger, mobile and/or email)
        ▼
Invite sent (SMS DLT template / Arattai / email) with Play / App Store link (PLAY_STORE.veetrax) and company name
        ▼
Employee opens VeeTrax → "Mobile OTP" (existing /auth/otp/request + /auth/otp/verify) or email-code sign-in
        ▼
Server returns LoginResponse; Me.permissions contains only transport_self.* → app mounts the Passenger shell
        ▼
First-run: consent & privacy notice (versioned), profile confirmation, notification permission
```

- Only pre-registered Users can sign in (existing `requestOtp` returns silent OK for unknown numbers [V]); no
  self-signup for business passengers (same rule as tracker self-service refusing BUSINESS [V]).
- **Email OTP fallback** is needed for the US and for India when SMS is down: today `requestOtp` returns 503 unless SMS
  or Arattai is ready, even if email works [V]. Proposed: allow email-only delivery when the User has an email
  (Agent 6 to review enumeration and rate limits).
- SSO (Azure AD / Google Workspace / Okta via OIDC) later; maps to the same User by verified email. Out of E1–E3.
- Deactivation: HR/admin deactivates profile → `User.isActive=false` → refresh fails (`token.service.ts` `rotate`
  checks `user.isActive` [V]) and push tokens stop (tied to session [V]).

### 3.3 Token scope

- New menu key family (e.g. `transport_self` with actions `view`, `create`, `edit`) in `packages/shared/src/permissions.ts`
  and a system role "Passenger" with **only** that key. No `live_map`, `objects`, `alerts` → the `/live` socket refuses
  them [V], and every existing fleet endpoint guarded by `@RequirePermission` refuses them.
- Own-data enforcement is **server-side by identity**, not by role scope: every `/me/transport/*` endpoint resolves
  `ctx.userId → transport profile` and filters by it. Do not reuse `DataScope.ASSIGNED` (object/branch based) for this.
- A passenger never receives other passengers' names, addresses or phone numbers; co-rider count only (plan §4.2).
- Vehicle live position is returned only for the passenger's own trip and only inside the authorised window (§5.3).
- `Me` should expose a role marker the client can switch on (e.g. `permissions.transport_self` present and no fleet
  menus) so the shell is chosen without hard-coding role names.

---

## 4. Screen and workflow map [P]

### 4.1 Navigation tree (Passenger shell)

```
src/app/
├─ login.tsx                         (existing; hero text follows role after sign-in)
├─ (passenger)/                      Stack.Protected guard = signedIn && isPassenger
│  ├─ onboarding/
│  │  ├─ consent.tsx                 privacy notice + consent (versioned)
│  │  ├─ profile.tsx                 confirm name, employee id, emergency contact, language
│  │  └─ places.tsx                  confirm home pickup / office (or approved shuttle stop)
│  ├─ (tabs)/
│  │  ├─ index.tsx        "Today"    next trip card, status timeline, SOS when active
│  │  ├─ trips.tsx        "Trips"    upcoming + history
│  │  ├─ book.tsx         "Book"     ad-hoc booking (hidden if policy disallows)
│  │  ├─ commute.tsx      "Commute"  recurring schedule, pause / leave days
│  │  └─ account.tsx      "Account"  profile, places, notifications, language, privacy, sign out
│  ├─ trip/[id].tsx                  trip detail; live vehicle map in window; pickup/drop confirm
│  ├─ trip/[id]/report.tsx           delay / missed pickup / incident report
│  ├─ booking/[id].tsx               booking detail, modify / cancel
│  ├─ places/index.tsx, places/[id].tsx   saved locations (map pin / search / current location)
│  ├─ sos/active.tsx                 SOS in progress (status, call buttons)
│  ├─ notifications.tsx              in-app inbox
│  └─ privacy.tsx                    consent history, location settings, data request
└─ (tabs)/ … existing fleet shell    Stack.Protected guard = signedIn && !isPassenger
```

`Stack.Protected` is already the guard mechanism in `src/app/_layout.tsx` [V]; the change is a second guard per role.
A user holding both fleet and passenger permissions (e.g. a transport admin who also rides) gets the fleet shell with a
"My commute" entry (open question Q4).

### 4.2 Per-screen data and API needs

API paths are placeholders; the contract is owned by the Lead (`05-api-and-event-contracts.md`).

| Screen | Shows / does | Data needed | API (placeholder) |
|---|---|---|---|
| Consent | Purpose, what is collected, when location is used, retention, contact | Current notice version, accepted versions | `GET /me/transport/consent`, `POST /me/transport/consent {version, accepted}` |
| Profile | Name, employee id (read-only), corporate account, phone, emergency contact, accessibility needs, language, notification prefs | Transport profile | `GET/PATCH /me/transport/profile`; language via existing `PATCH /auth/me/preferences` [V] |
| Saved places | Home, office, approved shuttle stops; add by search, pin or current location (opt-in) | Places, allowed stops, policy (door-to-door allowed?) | `GET/POST/PATCH/DELETE /me/transport/places`; existing `/geocode/search`, `/geocode/reverse` [V] |
| Today | Next trip: time window, status, vehicle plate/model/colour, driver first name + masked call, ETA when reliable, OTP/boarding code if policy | Next trip instance for me | `GET /me/transport/trips?from=today&limit=1` |
| Book (ad-hoc) | Pickup (saved / pin / current), destination, date/time, one-way/round, passengers if allowed, mode, shuttle stop vs door | Policy: cut-offs, modes, max passengers | `GET /me/transport/policy`, `POST /me/transport/bookings` (idempotency key) |
| Booking detail | Status (`REQUESTED…CONFIRMED`, exceptions), estimated pickup window, modify / cancel within policy | Booking + allowed actions computed server-side | `GET /me/transport/bookings/:id`, `PATCH …`, `POST …/cancel` |
| Commute | Recurring schedule, subscribed services, request change, pause / leave days, upcoming instances | Schedule, instances, cut-off rules | `GET /me/transport/schedule`, `POST …/exceptions`, `POST …/change-requests` |
| Trip detail | Timeline (assigned → approaching → arrived → picked up → dropped), live vehicle map **only in window**, pickup / drop confirmation, report problem, share status | Trip (own stop only), window state, vehicle position | `GET /me/transport/trips/:id`, `GET /me/transport/trips/:id/vehicle` (403 outside window), `POST …/confirm {kind: pickup|drop}` |
| Report | Delay, missed pickup, breakdown, incident or concern, free text, optional photo | Categories | `POST /me/transport/trips/:id/reports` |
| SOS | Hold-to-trigger, sends trip id + one location fix if permitted, shows server acknowledgement and escalation state, call security desk / emergency number | SOS state, desk phone | `POST /me/transport/sos` (idempotency key), `GET /me/transport/sos/:id` |
| Notifications | Inbox of booking / trip / safety messages | Messages for me | `GET /me/transport/notifications` (or reuse alert storage, Agent 1) |
| History | Past trips, cancellations, no-shows | Paged own trips | `GET /me/transport/trips?before=…` |
| Privacy | Consents given, location permission status and OS shortcut, export / deletion request | Consent log | `GET /me/transport/consent/history`, `POST /me/transport/data-requests` |

### 4.3 Trip-day workflow

```
D-1 / shift roster published  → push "Your pickup tomorrow 08:10–08:20, KA01AB1234"
T-30 min                      → reminder push; Today card shows window
Driver en route (trip event)  → window opens: vehicle position visible to this passenger
Approaching (ETA ≤ N min)     → push "Cab 5 min away"
Arrived at pickup             → push; passenger may confirm boarding (or driver confirms; server reconciles)
Picked up                     → status "On board"; SOS prominent; vehicle map continues (it is now the passenger's own ride)
Dropped off                   → window closes; vehicle position no longer served; rating / report prompt
Exceptions                    → DELAYED / NO_SHOW / BREAKDOWN / CANCELLED pushes; reassignment shown
```

Client never sets trip state; it sends **events** (`confirm pickup`, `report`) and renders the server's state (plan §9).

---

## 5. Location privacy design [P]

### 5.1 When the passenger app uses GPS

| Use | Permission | Duration | Sent to server |
|---|---|---|---|
| "Use my current location" when adding a place or booking | Foreground ("while using") | One fix | Only the chosen point, after the user confirms it on the map |
| SOS | Foreground (asked at trigger if missing; SOS still sent without it) | One fresh fix, ≤ 15 s, else last known (same rule as tracker `Engine.sendSos` [V]) | Fix + accuracy + timestamp with the SOS |
| Optional "I'm at the pickup point" check | Foreground | One fix | Distance-to-stop result (prefer sending only a boolean + accuracy) |
| Continuous / background tracking | **Never requested** | — | — |

The vehicle's position comes from the existing vehicle telemetry (GPS device or driver phone), not from the passenger's phone.

### 5.2 Consent records

- Versioned notice text per language; record `{userId, noticeVersion, accepted, at, appVersion, platform}`; re-prompt on
  material change. Owner: Agent 6 (`10-security-safety-and-privacy.md`) and Agent 1 for the table.
- Separate toggles: push notifications (non-critical), sharing trip status with approved contacts; safety messages are
  mandatory per policy (plan §11).

### 5.3 Window-limited vehicle visibility

- Server decides the window: from `DRIVER_EN_ROUTE` (or T-X minutes before the pickup window) until the passenger's
  drop-off or trip end + small grace; outside it `GET …/vehicle` returns 403 / `{visible:false}`.
- Precedent: `LiveShare.expiresAt` / `arrivedAt` ends public sharing 15 min after arrival [V]. Reuse the idea, not the
  public token (passengers are authenticated).
- **Do not** connect passengers to `/live`: that socket broadcasts per company room (`live.gateway.ts` `byCompany`) [V]
  and would expose the fleet. Use polling (10–15 s while the trip screen is open, via react-query `refetchInterval`) in
  E1–E3; a per-trip room can come later.
- Share-trip-with-contact: time-boxed link (LiveShare-style) showing vehicle + ETA, never the passenger's home address.

### 5.4 Denied or unavailable permission

| Situation | Behaviour |
|---|---|
| Location denied | Booking works with saved places / search / map pin; SOS still sends (without fix, flagged "no location") and offers call buttons |
| Location "approximate only" (Android 12+ / iOS) | Accept for place suggestion; show accuracy radius; never auto-save |
| GPS off / no fix in 15 s | Use last known fix with age, or none; tell the user |
| Notifications denied | In-app banner on Today; SMS fallback for safety-critical messages if policy says so (Agent 6) |

---

## 6. Offline / poor network, accessibility, localisation [P unless marked]

### 6.1 Offline and poor network

- Today no persisted cache and no connectivity monitor [V]. Add: NetInfo-based banner, and persist **only** today's and
  tomorrow's trip summaries (time window, vehicle plate, driver first name, desk phone) so the passenger can identify
  the cab offline. Storage: encrypted (SecureStore has small value limits; `expo-sqlite` is already used in the monorepo
  by `apps/tracker/src/lib/db.ts` [V]; encryption approach for Agent 6). Clear on sign-out.
- Mutations (book, cancel, confirm pickup, report) carry a client **idempotency key**; queued writes show "Pending",
  never "Done", until the server acknowledges (plan §4.3 rule applied to passengers).
- Booking and cancellation are **not** queued offline by default (cut-off rules make late replays dangerous); show
  "No connection, try again or call the desk".
- SOS offline: queue and retry aggressively, and immediately offer `tel:` to the security desk / local emergency
  number (112 India, 911 US) and an SMS intent pre-filled with trip id; never claim delivery without server ack.

### 6.2 Accessibility

- Every map view has a text equivalent (status timeline, "Cab is 1.2 km away, about 4 min"); plan §4.2 "accessible
  alternatives to map-only interaction".
- Reuse existing reduce-motion and text-size preferences [V]; 48 dp targets; SOS reachable by screen reader with a
  confirm step instead of hold-to-trigger when TalkBack / VoiceOver is on (hold gestures are hard with screen readers).
- Status never by colour alone; announce status changes with `AccessibilityInfo.announceForAccessibility`.
- Accessibility transport needs captured in profile (wheelchair, escort, etc.) feed dispatch, not UI only.

### 6.3 Localisation (hi / ta / en-IN / en-US)

- Today: `en` (formatted as `en-IN`), `hi`, `ta` [V]. **en-US is missing**: add a locale split (`en-IN` vs `en-US`)
  for date order, 12-hour time, distance units (km vs mi), phone display.
- `normalizeMobile` / `formatMobile` are India-first (10 digits → `91…`) [V]; US numbers must be entered in full E.164.
  The login `OtpForm` defaults to `+91` [V]; default by company country instead.
- Time zones: show trip times in the **pickup location's** time zone (overnight shifts, US DST, plan §9).
- Passenger notification templates need hi / ta / en variants (existing template system with DLT ids for India:
  `MessageTemplate`, `sms.ts` Smartping requires `dltTemplateId` [V]).

---

## 7. Push notifications

### 7.1 What exists [V]

- Client: Expo push token via `Notifications.getExpoPushTokenAsync`, registered with `POST /auth/push-token`, bound to
  the login session (`PushToken.sessionId`), removed on sign-out (`push.ts` `registerForPush`, `unregisterPush`;
  `schema.prisma` `PushToken`).
- Server: notifier sends through `ExpoPushProvider` to `https://exp.host/--/api/v2/push/send`; Expo relays to FCM
  (Android, Firebase project with `google-services.json`) and APNs (iOS); `PUSH_PROVIDER=none` turns it off
  (`apps/api/src/notifier/push.ts`; `apps/mobile/README.md` "Push alerts").
- Channels: `alerts` and `sos` (siren). Tracker app: no push.

### 7.2 Passenger additions [P]

- New Android channel `trip` (HIGH, default sound) for approaching / arrived; keep `sos` for passenger SOS updates;
  `info` (DEFAULT) for booking changes. Channel ids are fixed once created [V README], so create them before first use.
- Payload minimisation: title/body without addresses or other passengers' data (e.g. "Your cab is 5 min away"); data =
  `{tripId, kind}`; the app fetches details after opening. Respect lock-screen visibility (`PRIVATE` for trip channel).
- Delivery status: Expo tickets/receipts give provider status, not user receipt; never claim delivery beyond that
  (plan §10). SMS fallback for safety-critical messages if push fails (India DLT templates exist; US has no provider).

### 7.3 Decision for the owner (D-PUSH)

The owner's rule "nothing leaves the server" is met for maps, routing and geocoding (self-hosted) [brief §1]. **Mobile
push cannot meet it**: any push to a phone necessarily goes through Google FCM (Android) or Apple APNs (iOS); today it
also goes through Expo's relay (`exp.host`). Options:

| Option | Third parties | Effort | Note |
|---|---|---|---|
| 1. Keep Expo relay (status quo) | Expo + Google + Apple | 0 | Simplest; Expo sees payload and token |
| 2. Direct FCM HTTP v1 + APNs from the notifier | Google + Apple | Medium (credentials on server, native token instead of Expo token) | Removes Expo from the path |
| 3. No push; in-app polling + SMS | SMS provider (Smartping) | Low | Poor UX; misses "cab arrived" when app closed |

Recommendation: accept Option 1 for E1–E3 with payload minimisation; record the exception explicitly; evaluate
Option 2 when iOS passengers go live. Also fix the OpenFreeMap default in mobile store builds (§1.4-3), which is a
genuine breach of the maps rule today unless builds already set `EXPO_PUBLIC_MAP_STYLE_*`.

> **Validation note (E0 review):** Existing-code fact missing here: today's notifier already sends the full alert text and the alert `data` to Expo (`apps/api/src/notifier/push.ts` l.72; `notifier.service.ts` l.421–425), and `PushToken.sessionId` is optional (`schema.prisma` l.637), with tokens without a session also targeted (`notifier.service.ts` l.417). The D7 payload rules (`02` §8.3) apply to ETMS pushes; the existing fleet-alert payloads are outside the D7 rules and should be reviewed by the owner (L4).

> **Resolved in E0.5 (2026-11-11):** The owner **approved D7 / L4 on 2026-11-11** as a limited Expo → FCM / APNs exception: generic payloads only, sensitive trip details fetched through authenticated VeeTrax APIs (README §1.1). This matches the recommendation above (Option 1 with payload minimisation; direct FCM / APNs evaluated in E8). For the existing fleet-alert pushes, **O9 (approved 2026-11-11)** keeps current behaviour during E0.5 and allows no new external sharing of passenger or driver location by default. The OpenFreeMap default in mobile builds remains outstanding as gate **G8**.

---

## 8. Open questions

| # | Question | For |
|---|---|---|
| Q1 | Accept Expo → FCM/APNs for passenger push as an explicit exception to "nothing leaves the server" (D-PUSH)? | Owner |
| Q2 | Were the current Play builds of VeeTrax made with `EXPO_PUBLIC_MAP_STYLE_*` pointing at `app.veetrax.com/tiles`? If not, they fetch OpenFreeMap tiles. And which server URL do store builds use (`eas.json` says `gps.mintplus.co.in`)? | Owner |
| Q3 | Global uniqueness of `User.mobile` / `User.email`: accept "one VeeTrax login per person" for E1–E3 (refuse duplicates), or plan multi-company membership? | Owner, Agents 1 / 6 |
| Q4 | A person who is both a fleet/transport user and a rider: fleet shell + "My commute" entry, or a shell switcher? | Owner, Agent 3 |
| Q5 | US launch timing: needs iOS build of VeeTrax, an en-US locale, and a US SMS/OTP channel (none exists) or email-OTP. Is email-OTP acceptable as the US primary? | Owner |
| Q6 | May passengers confirm their own pickup/drop, or is the driver's confirmation authoritative (with passenger confirmation as a dispute signal only)? | Owner, Agent 5 |
| Q7 | Exact live-vehicle window: from driver en-route, or fixed minutes before the pickup window? Same after pickup until drop? | Owner, Agent 6 |
| Q8 | Store listing: is the owner willing to reposition the "VeeTrax" Play/App Store listing to cover passengers, or does any corporate customer require a white-label app (trigger for a separate binary, §2.6)? | Owner |
| Q9 | Should the tracker app's existing employee self-service (attendance, SOS) ever merge into the passenger shell? Recommendation: no; keep tracker for workforce tracking only. | Owner |
| Q10 | HR/leave integration for "report non-attendance": manual in app for E1–E3, integration later? | Owner, Agent 1 |

> **Resolved in E0.5 (2026-11-11):** Q1 is answered by **L4 / D7, approved 2026-11-11** (generic payloads; details via VeeTrax APIs). Q3 is answered for E1–E3 by **D5, approved 2026-11-11** (one login per person, global unique mobile / email). Still open, with no answer chosen here (README §7): Q2 → checked under gate G8 (a build fact, not a design choice); Q3 beyond E1–E3 and Q4 → **P3**; Q5 → **O6** / **C2**; Q6 → **P5**; Q7 → **P4**; Q8 → **P6**; Q9 and Q10 are not listed in README §7 and stay with the Lead / owner.
