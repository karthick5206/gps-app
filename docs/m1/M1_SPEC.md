# VeeTracer — Milestone M1 (Foundation) technical spec

Source of truth for M1. Product requirements: `docs/VeeTracer_Design_Document_v2.0.pdf` (feature IDs in brackets).
Shared types/constants: `packages/shared/src` (import from `@veetracer/shared`). **Never redefine those types locally.**

## M1 scope
Accounts and auth, roles/permissions/data scope, master pages framework + core masters, Concox GT06 TCP gateway,
stream processor, live state + realtime, device simulator (up to 10k devices), live map on web, light/dark/system theme.
Out of scope for M1: alerts, history playback, reports, billing, mobile apps (M2+). Keep the data model forward-compatible.

## Monorepo
```
packages/shared   @veetracer/shared  (TS → CommonJS in dist; web imports the TS source via Vite alias)
apps/api          @veetracer/api     NestJS 11 + Prisma 6 + PostgreSQL 16 + Valkey (ioredis)
apps/web          @veetracer/web     React 19 + Vite 8 + Tailwind CSS 4 + shadcn-style components + MapLibre GL 5
```
All dependencies are already installed. Do not run `npm install` at the repo root for packages that are already present.
If a new package is truly required, install it with `npm install <pkg> -w <workspace>` and mention it in your report.

## Local environment
| Service | Value |
|---|---|
| PostgreSQL 16 | `postgresql://karthickramasamy@localhost:5432/veetracer` (no password, local socket user). TimescaleDB is NOT installed yet. |
| Valkey (Redis-compatible) | `redis://localhost:6379` |
| API (REST + Socket.IO) | `http://localhost:4000`, REST prefix `/api`, Socket.IO namespace `/live` |
| GT06 TCP gateway | port `5023` |
| Web dev server | `http://localhost:5173`, proxies `/api` and `/socket.io` (ws) to 4000 |

## Processes (all in apps/api)
| Process | Entry | Role |
|---|---|---|
| api | `src/main.ts` | REST, auth, masters, live snapshot, Socket.IO realtime fan-out, offline sweeper job |
| gateway | `src/gateway/main.ts` | TCP GT06 decode → `XADD vt:positions` (stream). Stateless. |
| processor | `src/processor/main.ts` | `XREADGROUP` → filter/normalise → live state (Valkey) → publish → batch insert Postgres → `XACK` |
| simulator | `src/simulator/gt06-sim.ts` | N fake GT06 devices over TCP |

Scripts in apps/api/package.json: `start:dev` (nest watch), `build`, `start`, `gateway:dev`, `processor:dev` (tsx watch),
`sim` (tsx simulator), `db:migrate` (prisma migrate dev), `db:deploy`, `db:seed`, `test` (jest), `sim:register` (register N simulator devices in the demo company).

## Data model (Prisma, apps/api/prisma/schema.prisma)
UUID ids (`@default(uuid())`), `createdAt`/`updatedAt` on every master. Tables (forward compatible with the design doc §8):
- `Partner(id, name, slug unique)` — one row "VeeTracer" (direct customers).
- `Company(id, partnerId, name, accountType BUSINESS|INDIVIDUAL, status ACTIVE|SUSPENDED, timezone default 'Asia/Kolkata', distanceUnit default 'km', retentionDays default 90, settings Json default {} (holds `thresholds: StatusThresholds`), isPlatform bool)` — the platform company "VeeTracer Platform" (isPlatform=true) hosts the Super Admin.
- `Branch(id, companyId, name, code?, address?, isActive)` unique(companyId, name).
- `User(id, companyId, name, email? unique, mobile? unique (E.164 +91…), passwordHash?, isSuperAdmin default false, managerId?, isActive, preferences Json default {"theme":"system"}, lastLoginAt?)`.
  **Exactly one Super Admin**: raw SQL in the migration `CREATE UNIQUE INDEX "one_super_admin" ON "User" ("isSuperAdmin") WHERE "isSuperAdmin";` and the service refuses to create/promote another.
- `Role(id, companyId, name, description?, isSystem, dataScope COMPANY|ASSIGNED)` unique(companyId, name); `RolePermission(roleId, menu text, actions text[])` PK(roleId, menu).
- `UserRole(userId, roleId)`, `UserBranch(userId, branchId)`, `UserObject(userId, objectId)` — composite PKs.
- `DeviceModel(id, brand, model, protocol, capabilities text[], fields Json, commands Json, timeOffsetMinutes int default 0, filterDefaults Json default {}, isActive)` unique(brand, model).
- `Device(id, companyId? (null = platform stock), modelId, uniqueId unique, simNumber?, simOperator?, firmware?, ingestToken unique, isActive, lastSeenAt?)`.
- `TrackedObject(id, companyId, branchId?, type ObjectType, vehicleType?, name, plateNumber?, make?, model?, color?, icon?, speedLimitKph?, odometerOffsetKm float default 0, customFields Json default {}, isActive)`.
- `DeviceAssignment(id, deviceId, objectId, fromTime, toTime?)` — at most one open (toTime null) row per device and per object; enforce with partial unique indexes in raw SQL.
- `VehicleGroup(id, companyId, name, description?, isActive)` + `VehicleGroupMember(groupId, objectId)`.
- `Lookup(id, companyId? (null = system), type, code, label, sortOrder, isActive)` unique(companyId, type, code). Seed system values for types: VEHICLE_TYPE, FUEL_TYPE, LICENCE_CLASS, DOCUMENT_TYPE, GEOFENCE_CATEGORY, VEHICLE_MAKE.
- `Position(objectId?, deviceId, fixTime timestamptz, serverTime timestamptz, lat, lng (double), speedKph real, course smallint, altitude real?, satellites smallint?, valid bool, ignition bool?, flags int default 0, attributes Json)` — **PK (deviceId, fixTime)**; index (objectId, fixTime desc). Insert with `ON CONFLICT DO NOTHING` (dedupe). In the migration add, guarded: `DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name='timescaledb') THEN CREATE EXTENSION IF NOT EXISTS timescaledb; PERFORM create_hypertable('"Position"','fixTime', migrate_data => true, if_not_exists => true); END IF; END $$;`
- `RawPacket(id bigserial, uniqueId?, protocol, remoteAddress?, receivedAt, hex)` — index receivedAt; short retention later.
- `UnknownDevice(uniqueId PK, protocol, remoteAddress?, firstSeenAt, lastSeenAt, packetCount)` — devices that connect but aren't registered.
- `AuditLog(id, companyId?, userId?, action CREATE|UPDATE|DELETE|LOGIN|LOGIN_FAILED|..., entity, entityId?, changes Json?, ip?, createdAt)`.
- `Session(id, userId, refreshTokenHash, userAgent?, ip?, expiresAt, revokedAt?, createdAt)`.
- `OtpCode(id, mobile, codeHash, expiresAt, attempts default 0, consumedAt?, createdAt)`.
- `PasswordReset(id, userId, tokenHash, expiresAt, usedAt?, createdAt)`.

## Auth [AUTH-01..06]
JWT access token 15 min (`sub`=userId, `cid`=companyId, `sa`=isSuperAdmin), refresh token 30 days (random 48 bytes, stored hashed in Session, rotated on refresh). Passwords bcrypt (cost 12). Throttle auth routes.
| Method | Path | Body | Response |
|---|---|---|---|
| POST | /api/auth/login | `{email, password}` | `LoginResponse` · 401 "Invalid credentials" · 403 "Account inactive"/"Company suspended" · lockout 15 min after 5 failures |
| POST | /api/auth/otp/request | `{mobile}` | `{ok:true, devCode?}` — 6 digits, 5 min, resend ≥30 s, max 5 attempts. No SMS provider in M1: log the code; return `devCode` only when `OTP_DEV_ECHO=true` |
| POST | /api/auth/otp/verify | `{mobile, code}` | `LoginResponse` |
| POST | /api/auth/refresh | `{refreshToken}` | `AuthTokens` |
| POST | /api/auth/logout | `{refreshToken}` | `{ok:true}` |
| POST | /api/auth/password/forgot | `{email}` | `{ok:true, devLink?}` always ok (no user enumeration). Link `${WEB_URL}/reset-password?token=…`, 30 min, single use. M1 mailer = nodemailer JSON/stream transport that logs + writes the email to `var/mail/<time>.html`; `devLink` when `MAIL_DEV_ECHO=true` |
| POST | /api/auth/password/reset | `{token, password}` (≥8 chars, letter+digit) | `{ok:true}`; revokes all sessions |
| GET | /api/auth/me | — | `Me` |
| PATCH | /api/auth/me/preferences | `{theme}` | `Me` |

**Company context:** the Super Admin may send header `X-Company-Id: <id>` to act inside any company (all permissions, COMPANY scope). Everyone else is locked to their own company; the header is ignored for them.

## Permissions and data scope [ORG-01..08]
- `Me.permissions` = union of the user's roles' `RolePermission` rows. Super Admin = every menu incl. `superAdminOnly` ones.
- Guard: `@RequirePermission('objects','create')` on every endpoint. `superAdminOnly` menus only for the Super Admin.
- Data scope: if any role has `COMPANY` → all company objects; else allowed objects = objects in user's branches ∪ user's mapped objects. Applies to objects, live snapshot, realtime, dashboard, devices (via their object) and branches (only assigned branches in ASSIGNED scope).
- Users with ASSIGNED scope can only create/edit users inside their own branches and can't assign roles with COMPANY scope.
- System roles from `SYSTEM_ROLES` (shared) are created for every new company; `isSystem` roles can't be deleted (permissions editable).

## Master pages API [MST-01..12]
Every list endpoint: `GET /api/<master>?q=&page=1&pageSize=25&sort=<field>&order=asc|desc&status=ACTIVE|INACTIVE&<filters>&format=json|csv` → `Paginated<Dto>` or a CSV download (current filter, all pages, max 50k rows; requires `export` action).
Every master: `GET /:id`, `POST`, `PATCH /:id`, `DELETE /:id` (409 "In use — deactivate instead" when referenced), `POST /bulk` `{ids, action:'activate'|'deactivate'|'delete'}`, `GET /:id/history` → `AuditLogDto[]`.
All writes are audited (entity, entityId, before/after diff).
| Master | Path | Menu | DTO | Extra filters / notes |
|---|---|---|---|---|
| Branches | /api/branches | branches | BranchDto | |
| Users | /api/users | users | UserDto | roleId, branchId · body `{name,email?,mobile?,password?,managerId?,roleIds[],branchIds[],objectIds[],isActive}` (email or mobile required) |
| Roles | /api/roles | roles | RoleDto | body `{name,description?,dataScope,permissions:[{menu,actions[]}]}` — validate menu/actions against `MENUS` |
| Menus | GET /api/menus | any logged-in | `MenuDef[]` | from shared |
| Objects | /api/objects | objects | TrackedObjectDto | branchId, groupId, type, vehicleType · body includes `deviceId?` — assigning closes the device's/object's previous open assignment (device swap) [DEV-02/03] |
| Devices | /api/devices | devices | DeviceDto | modelId, assigned=true/false · company admins see only their company's devices |
| Vehicle groups | /api/vehicle-groups | vehicle_groups | VehicleGroupDto | body `{name,description?,objectIds[]}` |
| Lookups | /api/lookups | lookups | LookupDto | type · system rows read-only for companies |
| Device models | /api/device-models | sa_device_models (GET also allowed for `devices` view) | DeviceModelDto | |
| Device inventory | /api/admin/devices | sa_device_inventory | DeviceDto | all companies; assign `companyId` |
| Companies | /api/admin/companies | sa_companies | CompanyDto | POST body `{name, accountType, timezone?, admin:{name,email?,mobile?,password}}` creates company + system roles + first Admin user + "Head Office" branch |
| Unknown devices | GET /api/admin/unknown-devices | sa_unknown_devices | UnknownDeviceDto | |
| Audit log | /api/audit-logs | audit_log | AuditLogDto | entity, userId, from, to |
| Company settings | GET/PATCH /api/settings | settings | `{company: CompanySummary}` | edit name, timezone, thresholds |

## Live tracking pipeline [PRO-01, MAP-01..08, DATA-01..05, PERF-02..07]
### GT06 gateway (port 5023)
Frame: `78 78 | len(1) | proto(1) | content | serial(2) | crc(2) | 0D 0A` (also `79 79` with 2-byte len). `len` = proto+content+serial+crc. CRC = CRC-16/X-25 (CRC-ITU: reflected poly 0x8408, init 0xFFFF, xorout 0xFFFF) over len…serial. Handle TCP fragmentation and multiple frames per chunk; drop garbage until the next start marker.
| Proto | Meaning | Content (after proto) | Reply |
|---|---|---|---|
| 0x01 | Login | IMEI 8 bytes BCD (16 digits, leading 0) [+ type id 2 + tz 2] | `78 78 05 01 <serial> <crc> 0D 0A` |
| 0x12 / 0x22 | GPS (+LBS) | datetime 6 (YY MM DD hh mm ss, UTC) · 1 byte (hi nibble GPS info length, lo nibble satellites) · lat u32 · lng u32 (degrees = v/1800000) · speed u8 km/h · course/status u16 (bits0–9 course, bit10 north(1)/south, bit11 west(1)/east, bit12 positioned) · MCC 2 · MNC 1 · LAC 2 · CellID 3 · (0x22 only:) ACC 1 (ignition 0/1) · upload mode 1 · re-upload 1 [· mileage 4] | none |
| 0x13 | Heartbeat/status | terminal info 1 (bit1 ACC/ignition, bit2 charging, bit7 oil/electric cut) · voltage level 1 (0–6 → battery % = level×100/6) · GSM signal 1 (0–4) · alarm/lang 2 | `78 78 05 13 …` |
| 0x16 / 0x26 | Alarm | as GPS (datetime…course/status) · LBS length 1 + MCC 2 MNC 1 LAC 2 CellID 3 · terminal info 1 · voltage 1 · GSM 1 · alarm 1 (0x01 SOS, 0x02 power cut, 0x03 vibration, 0x06 overspeed) · lang 1 | `78 78 05 <proto> …` |
Unknown protocols: log + ACK nothing. Positions before login → ignore. The gateway keeps per-connection IMEI and the latest status (ignition, battery, GSM) to enrich GPS positions.
Each decoded fix → `XADD vt:positions MAXLEN ~ 2000000 * data <JSON NormalizedPosition incl. raw hex>`. Also maintain `vt:conn:<uniqueId>` = gateway id (TTL 300 s) for future commands.
Put the codec in `src/gateway/gt06/` as pure functions (`decodeFrames(buffer) → {frames, rest}`, `decodeMessage`, `encodeAck`, and **encoders used by the simulator**: `encodeLogin`, `encodeGps22`, `encodeHeartbeat`, `encodeAlarm`) with jest tests (round-trip + known hex vectors).

### Processor
Consumer group `processor` on `vt:positions`, batches of up to 500, block 1000 ms. Per message:
1. Resolve device by uniqueId from an in-memory cache (TTL 30 s; also invalidated via pub/sub `vt:cache:invalidate` published by the API on device/object/assignment changes). Unknown → upsert `UnknownDevice`, ack, skip. Inactive device/object or suspended company → ack, skip.
2. Filtering per §"Data quality" (flags from `POSITION_FLAGS`): INVALID_FIX (valid=false, 0/0, satellites < 3), JUMP (implied speed vs last valid point > `MAX_PLAUSIBLE_SPEED_KPH[type]`), DRIFT (ignition false/null, speed < running threshold, distance < driftRadiusM → keep last valid coords), FUTURE (> now + 5 min), LATE (fixTime < last fixTime: store, don't touch live state).
3. Movement status from `StatusThresholds` (company settings or `DEFAULT_THRESHOLDS`): OVERSPEED if speed > limit (object `speedLimitKph` ?? `DEFAULT_SPEED_LIMIT_KPH[vehicleType]`); RUNNING if speed > runningSpeedKph; when not moving: ignition true → IDLE once stationary ≥ idleAfterSec (until then keep previous RUNNING/OVERSPEED); ignition false → OFF; ignition null → OFF. Track `statusSince` (time of last status change).
4. Live state: `SET vt:live:<objectId> <JSON LiveObject>`; `SADD vt:live:company:<companyId> <objectId>`; `PUBLISH vt:live:updates <JSON {companyId, live}>` (only when not LATE).
5. Insert positions (multi-row INSERT … ON CONFLICT DO NOTHING) and raw packets in one batch; update `Device.lastSeenAt` at most every 10 s per device. Then `XACK`. On DB error don't ack (pending entries are re-claimed with XAUTOCLAIM after 30 s).
Must sustain 1,000 msgs/s on this Mac. Log throughput every 10 s.

### Offline sweeper (api, every 30 s)
Objects whose live `serverTime` is older than `offlineAfterSec` → status OFFLINE, update live state, publish. Objects with a device but no live state → NO_DATA in snapshots.

### Live API + realtime
- `GET /api/live` (menu live_map) → `LiveObject[]` for every active object in scope (objects without live state appear with status NO_DATA and null coordinates).
- `GET /api/dashboard/summary` (menu dashboard) → `DashboardSummary`.
- Socket.IO namespace `/live`, handshake `auth: { token }` (+ optional `companyId` for the Super Admin). Server computes the socket's allowed object set (refresh every 60 s and on `vt:cache:invalidate`), subscribes once to Valkey `vt:live:updates`, buffers per socket and emits **`live:batch`** (`LiveObject[]`, latest per object) every 1000 ms when non-empty. Invalid token → `connect_error`.

### Simulator [PERF-08]
`npm run sim -- --count 20 --host 127.0.0.1 --port 5023 --interval 10 --imei-start 868120000000001`
Each device: connects, sends login (waits for ACK), then every `interval` s a 0x22 GPS packet, heartbeat every 180 s. Movement around Chennai (13.00–13.15 N, 80.18–80.30 E): drive between random waypoints at 20–70 km/h with noise, occasional overspeed bursts (85–100 km/h), stops with ignition on 1–6 min (idle) and ignition off 5–20 min, rare SOS alarm (0x26). Reconnect on disconnect; jitter start times. Print a summary every 10 s (connected, packets sent). Must run 10,000 devices from one process.
`npm run sim:register -- --count 1000` creates devices + objects (Concox GT06N model, vehicle types mixed, spread across demo branches) in the demo company for the same IMEI range.

## Seed (`npm run db:seed`, idempotent)
- Partner "VeeTracer"; platform company "VeeTracer Platform" with the **Super Admin** `admin@veetracer.local` / `Admin@12345` (mobile +919999900000).
- Device models: Concox GT06N, Concox WeTrack2, Concox AT4 (protocol GT06; capabilities ignition, sos, power_cut, engine_cut, battery, lbs), Phone (protocol PHONE).
- Lookups (system) as above.
- Demo company "Demo Logistics" (BUSINESS): branches Chennai, Coimbatore; system roles; users: `demo.admin@veetracer.local` / `Demo@12345` (Admin), `chennai.manager@veetracer.local` / `Demo@12345` (Manager, Chennai), `viewer@veetracer.local` / `Demo@12345` (Viewer, mapped to 3 objects); mobile +919999900001 for demo admin.
- 20 devices IMEI 868120000000001…020 with objects (mix of CAR/TRUCK/BUS/BIKE, plates TN-xx-XX-xxxx), split across branches; 2 vehicle groups.

## Config (apps/api/.env, with .env.example committed)
`DATABASE_URL, REDIS_URL, JWT_SECRET, API_PORT=4000, GT06_PORT=5023, WEB_URL=http://localhost:5173, OTP_DEV_ECHO=true, MAIL_DEV_ECHO=true, CORS_ORIGINS=http://localhost:5173`

## Web app [UI-01..09, MAP-01..10, ANI-08/09/13, MST-01..12]
- Tailwind CSS 4 (`@tailwindcss/vite`), shadcn/ui-style components written into `src/components/ui` (Button, Input, Label, Select, Checkbox, Switch, Dialog, DropdownMenu, Tabs, Tooltip, Popover, Badge, Card, Table, Skeleton, Sheet/Drawer, Command-less multi-select) using Radix primitives + `cva` + `cn()`.
- Design tokens as CSS variables (shadcn convention: `--background`, `--foreground`, `--card`, `--primary`, `--muted`, `--border`, …, plus `--status-running|idle|off|overspeed|offline|nodata`) in `:root` and `.dark`. Brand primary teal `#0f766e`-ish, navy accents (match the design document cover). Status colours from `STATUS_META`.
- Theme: Light / Dark / System toggle in the top bar; applies `.dark` on `<html>`; System follows `prefers-color-scheme` live; persisted to localStorage immediately and to `PATCH /api/auth/me/preferences`; initial theme applied before first paint (inline script in index.html) to avoid flashing.
- Auth: login page with tabs **Email & password** / **Mobile OTP** (shows dev code hint when returned), forgot-password and reset-password pages. Access token in memory, refresh token in localStorage; auto-refresh on 401 once, then logout. React Query for data.
- Shell: collapsible sidebar built from `MENUS` filtered by `Me.permissions`, grouped (Main / Masters / Administration / Platform); top bar with company switcher (Super Admin only → sets `X-Company-Id` and Socket.IO `companyId`), theme toggle, user menu (logout). Responsive (sidebar becomes a sheet on mobile widths).
- Dashboard: status count cards (animated count-up), devices online, link to live map.
- **Live map** (`/live`): MapLibre GL full height. Basemap: raster tiles from env `VITE_TILES_LIGHT` / `VITE_TILES_DARK` (defaults: CARTO `https://{a-d}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png` and `dark_all`, attribution "© OpenStreetMap contributors © CARTO") — swaps with theme; self-hosted tiles come in M2. Objects rendered from one GeoJSON source with WebGL layers (circle coloured by status + heading arrow symbol + plate/name label at higher zooms); clustering when > 500 points (cluster bubbles show counts). Left panel: search (name/plate/IMEI), status chips with live counts (click = filter), branch / vehicle-group / type filters, virtualised list (status dot, name, plate, speed, "Idle 12 min"-style time-in-status, last update relative time), multi-select checkboxes → "show selected only". Click marker or row → right drawer with tabs **Overview** (status + since, speed, ignition, coordinates, last fix/server time, battery, GSM, satellites, speed limit) and **Device** (IMEI, model, SIM); actions Follow / Zoom to. Follow mode keeps the camera centred smoothly. Snapshot from `GET /api/live`, then apply `live:batch` updates. **Animation**: markers glide from old to new position over ~1 s with bearing interpolation (requestAnimationFrame, update the GeoJSON source at ≤ 30 fps; only animate features in the viewport and only when < 1,000 are moving; otherwise jump). Respect `prefers-reduced-motion`. Must stay smooth with 10,000 objects.
- **Master pages**: one reusable `MasterPage` (TanStack Table, server-side pagination/sort/search/status filter, column chooser persisted in localStorage, CSV export button, bulk activate/deactivate/delete, row actions View/Edit/Delete/History, Add button) — buttons shown only if the permission allows. Implement: Vehicles & Objects (with device assignment select), Devices, Vehicle Groups (object multi-select), Branches, Lookups, Users (roles/branches/objects multi-selects), Roles (permission matrix: rows = menus, columns = actions, checkboxes only where the menu supports the action; data scope select), Audit Log (read-only), Company Settings (name, timezone, status thresholds). Platform (Super Admin): Companies (create with first admin), Device Models, Device Inventory (assign company), Unknown Devices.
- Forms: react-hook-form + zod, inline validation, toasts (sonner) for success/error, API error `message` shown.
- Quality: TypeScript strict, `npm run build` (tsc + vite build) must pass with zero errors; no console errors; keyboard accessible; works at 375 px width.

## Definition of done for M1
1. `db:migrate` + `db:seed` work on a fresh database. 2. Super Admin, demo admin, manager and viewer can log in (password and OTP); menus differ by role; viewer sees only their 3 objects. 3. Simulator with 20 devices → vehicles move on the web live map within ~2 s, colours change Running/Idle/Off/Overspeed, offline after 10 min without data. 4. Simulator with 10,000 devices (after `sim:register`) → processor keeps up (no growing backlog), map stays responsive. 5. All masters CRUD + CSV export + history work with permission checks. 6. Light/dark/system theme everywhere incl. map. 7. jest tests pass (GT06 codec, filters/status, permission/scope service).
