# 07 · ETMS Web UX and Dispatcher Architecture (E0)

**Author:** Agent 3 (Web UX / Dispatcher Architect) · **Date:** 2026-11-10 · **Code read:** worktree
`D:\Vibhav\gps-app-wt\etms` at `f5b151b` (v1.8.0), plus `feature/routing-engine` read with `git show` where noted.
**Scope:** web only (`apps/web`, `packages/shared`). Read-only; nothing in the code was changed.
**Labels:** **Verified** = read in source (path + symbol cited). **Proposed** = design for E1–E7, not built.

---

## 0. Summary for the Lead

| # | Finding / decision | Type |
|---|---|---|
| 1 | Navigation, routing and permissions all come from **one catalogue**: `MENUS` / `MENU_KEYS` in `packages/shared/src/permissions.ts`; `router.tsx` builds one route per menu (`PAGES: Record<MenuKey, …>`), `nav.ts` `buildNav()` groups them. Adding ETMS screens = adding menu keys + a group, no parallel nav system. | Verified |
| 2 | There is already a **per-company add-on switch** (`COMPANY_FEATURES` in `packages/shared/src/api.ts`, stored in `Company.settings.features`, exposed as `Me.company.features`) and a **build/browser UI flag** (`UI_FLAGS` in `apps/web/src/lib/flags.ts`). `buildNav()` does **not** filter by either today. The routing branch adds `MenuDef.featureFlag` + `OFF_BY_DEFAULT`. ETMS should use one combined gate (§2.4). | Verified + Proposed |
| 3 | A user belongs to **one company** (`User.companyId`); only the Super Admin can switch company (`features/shell/CompanySwitcher.tsx`). A **Provider admin who serves several corporate customers has no UI mechanism today**. The closest precedent is cross-company vehicle sharing (`VehicleShare`, `byShared` in `apps/api/src/live/live.gateway.ts`). The UX needs a "customer context" selector whose server semantics Agents 1/6 must define. | Verified gap |
| 4 | Strong reusable patterns: `MasterPage` (list + filters + bulk + CSV + history), full-screen editor dialogs (`RouteEditor`, `GeofenceEditor`), `StopList` (keyboard move up/down, fits 375 px), `PlaceSearch` (self-hosted Photon `/geocode/search`), `PoiImportDialog` (preview → pick → commit), Planned-trips list (status chips, live socket patch) and detail (plan vs actual + `HistoryMap` / `PlaybackEngine`), `alert-center` (siren, mandatory ack). | Verified |
| 5 | Live updates are a single Socket.IO `/live` connection (`features/live/realtime.ts` `Realtime.on()`); the gateway emits per company, per permission and per vehicle scope (`onPlannedTrip`, `onAlert`). **Pushes during a disconnect are lost**; clients resync on reconnect. ETMS events must follow the same pattern, and the SOS lane needs a polling fallback. | Verified |
| 6 | **Alerts are vehicle-centric** (`AlertDto.objectId`, scope check `client.allowed.has(objectId)`). An SOS raised by an *employee* phone with no vehicle does not fit the current alert path. | Verified gap |
| 7 | i18n: keys are English text, Hindi/Tamil bundles lazy-loaded (`apps/web/src/lib/i18n.ts`). **English maps only to `en-IN`** (`LANGUAGES` in `packages/shared/src/api.ts`); there is no `en-US` locale and `Company` has **no country field** (only `timezone`, `distanceUnit`). US formatting needs a country/locale setting. | Verified gap |
| 8 | No seat-capacity field on `TrackedObject` (only `type` / `vehicleType` enum incl. `CAR`, `VAN`, `BUS`). Occupancy UI depends on Agent 1 adding capacity. | Verified gap |
| 9 | Proposed IA: **new group "Employee transport"** with 11 new menu keys; **reuse** Vehicles, Drivers, Routes, Planned trips, Live map, Alerts, Reports, Alert settings / Templates, Audit log. | Proposed |

> **Validation note (E0 review):** Count mismatch: §2.2 lists 12 keys (incl. `etms_planning`). The Lead drops `etms_planning` in favour of the ported `route_plans` key placed in the `transport` group (E4), and adds `etms_self` and `etms_driver` (`02` §3.1; `05` §1). Group placement, key set and role templates are owner decision P6, not settled.

---

## 1. Verified current state

### 1.1 Navigation, routing and permissions

| Item | Evidence | Notes |
|---|---|---|
| Menu catalogue | `packages/shared/src/permissions.ts` `MENU_KEYS`, `MENUS: readonly MenuDef[]`, `MenuDef { key, label, group, path, actions, superAdminOnly?, partnerOnly? }` | 43 menus. Order of `MENUS` = order inside a group. |
| Actions | same file, `ACTIONS = ['view','create','edit','delete','export','command']` | Fixed set of six; ETMS must express its rights with these six per menu (no new action types needed, §2.3). |
| Groups | `MenuGroup = 'main' \| 'people' \| 'costs' \| 'masters' \| 'alerting' \| 'stock' \| 'admin' \| 'platform'`; labels in `apps/web/src/features/shell/nav.ts` `GROUP_LABELS`, order `GROUP_ORDER` | "main" is labelled *Tracking*, "people" *Drivers & Staff*. |
| Icons | `nav.ts` `MENU_ICONS: Record<MenuKey, LucideIcon>` | Exhaustive record: a new key fails type-check until it has an icon (good guard). |
| Nav filter | `nav.ts` `buildNav(perms, personal, reseller)` | Filters by `perms[key].includes('view')`, `PERSONAL_HIDDEN_MENUS`, `partnerOnly`. No company-feature filter. |
| Routes | `apps/web/src/app/router.tsx` `PAGES: Record<MenuKey, LazyExoticComponent>`; `MENUS.map(m => ({ path: m.path, element: <RequirePermission menu={m.key}> … }))` | Detail pages added by hand, e.g. `/planned-trips/:id` guarded with `menu="plannedTrips"`. |
| Guard | `apps/web/src/features/auth/guards.tsx` `RequirePermission({ menu, action })` → `ForbiddenPage` | Client side; server enforces with `@RequirePermission(menu, action)` (`apps/api/src/access/permission.guard.ts`). |
| Permission check | `packages/shared/src/permissions.ts` `can(perms, menu, action)`; `AuthProvider.tsx` `can` from `me.permissions` | `Me.permissions: PermissionMap`, `Me.dataScope: 'COMPANY' \| 'ASSIGNED'`. |
| Built-in roles | `SYSTEM_ROLES` (Admin, Manager, User, Viewer) | New menus reach existing companies via an SQL migration, precedent: `apps/api/prisma/migrations/20261113090000_routes_planned_trips/migration.sql` ("Built-in roles get the new routes and plannedTrips menus"). |
| Company context | `Me.company: CompanySummary { timezone, features, accountType … }`; `CompanySwitcher.tsx` "Super Admin only" | One company per user session. |
| Add-ons per company | `COMPANY_FEATURES = ['attendanceInsightsPlus']` (`packages/shared/src/api.ts`), server `apps/api/src/common/company-features.ts`, editor `features/platform/CompaniesPage.tsx` | Switched on by the Super Admin; platform company gets all. |
| UI flags | `apps/web/src/lib/flags.ts` `UI_FLAGS = ['uiRefresh']`, `VITE_UI_FLAGS`, `localStorage['vt.flags']`, `<html data-ui-refresh>` | Default ON in dev, OFF in prod builds. |
| Routing branch (not in main) | `git show feature/routing-engine:packages/shared/src/permissions.ts`: `MenuDef.featureFlag?: FeatureFlag`, menu `route_plans` (`/route-planner`, group `main`); `flags.ts` adds `routingV2` and `OFF_BY_DEFAULT` | Must be reconciled with ETMS planning screen (§2.1). |

### 1.2 Design system

| Item | Evidence |
|---|---|
| Primitives (22) | `apps/web/src/components/ui/*`: badge, button, card, checkbox, dialog, dropdown-menu, empty-state, field, input, label, multi-select (incl. `Combobox`), popover, select, sheet, skeleton, spinner, switch, table, tabs, tooltip. Radix-based. |
| App components | `components/page-header.tsx`, `confirm-dialog.tsx`, `status-badge.tsx`, `map-tools.tsx`, `form-error.tsx`, `page-capture.tsx` |
| Tokens | `apps/web/src/index.css` `:root` (Teal default), `[data-theme='plum'\|'sky'\|'light']`, `.dark`; semantic `--success/--warning/--destructive/--info` with `-soft` / `-fg` pairs; map tokens `--map-label*`; status tokens `--status-*` injected from `STATUS_META` (`lib/status-tokens.ts`). |
| Motion | `index.css` `@media (prefers-reduced-motion: reduce)`; `MapController` takes `reducedMotion` (`features/live/map/map-controller.ts`). |
| Redesign rules | `docs/modernization/07-design-system.md` (WCAG 2.1 AA target, logo fixed, five themes, known contrast failures: light `StatusBadge`, focus ring, input borders); `docs/ui-modernization/dashboard/REPORT.md` (flag-gated presentation, "only already-fetched data, no fake data", 1440/1024/768/390 viewports, Teal + Dark, no horizontal scroll on phone, new strings need hi/ta). |
| Phone rule | `features/routes/StopList.tsx` doc comment: "Rows are cards rather than table columns so the list fits a 375 px phone"; Planned trips list switches table → cards below `lg` (`PlannedTripsPage.tsx`, `hidden lg:block` / `lg:hidden`); Live map has a phone list/map toggle (`LiveMapPage.tsx` `mobileView`). Nav on phone is a left `Sheet` (`features/shell/AppShell.tsx`). |
| Libraries | `apps/web/package.json`: React 19, react-router 7, TanStack Query 5 + Table 8, react-hook-form + zod, maplibre-gl 5, socket.io-client 4, sonner, i18next. **No drag-and-drop library, no chart library** (charts are hand-built in features), **no phone-number library on web**. |

### 1.3 Map stack and live updates

| Item | Evidence |
|---|---|
| Map | MapLibre GL; self-hosted tiles via `features/live/map/map-style.ts` `styleUrl()` / `basemap-store.ts` (Martin + Planetiler India per brief §1). |
| Live map controller | `features/live/map/map-controller.ts` `class MapController` (clustering, glide, follow, labels, reduced motion); add-on layers re-attach on style change via `layers/addon.ts` `keepAlive()` / `beneathMarkers()` (used by `alert-layer.ts`, `geofence-layer.ts`, `poi-layer.ts`). |
| History / playback | `features/history/history-map.ts` `class HistoryMap`, `playback-engine.ts` `PlaybackEngine`, `PlaybackBar.tsx`; reused by `PlannedTripDetailPage.tsx` with `trip-map.ts` (`buildPlanFeatures`, `deviationFeatures`, corridor). |
| Route editing map | `features/routes/RouteMap.tsx` (draggable `maplibregl.Marker` per stop, `PlaceSearch`), road preview `features/routes/api.ts` `usePathPreview` (GraphHopper via `routing.service.ts` `routeVia`). |
| Socket | `features/live/realtime.ts` `Realtime` (one `/live` socket per selected company; `on(event, handler)` re-attached across reconnects; snapshot reload after reconnect). |
| Server events | `apps/api/src/live/live.gateway.ts`: `live:batch` (batched, `live_map:view`), `alert` (immediate, `alerts:view`, object scope), `alerts:read`, `alerts:acked`, `plannedTrip.update` (`PLANNED_TRIP_SOCKET_EVENT`, `plannedTrips:view`, object scope), `system:health` (Super Admin). Redis pub/sub → gateway fan-out. |
| Trip live patch | `features/planned-trips/use-planned-trips.ts` `usePlannedTripLive()` / `applyLiveToCache()`: patches TanStack caches; invalidates all trip queries after reconnect ("pushes sent while disconnected are lost"). |
| Alerts UX | `features/alerts/alert-center.ts` (bell, unread, `pendingAck`, siren via `sound.ts` `playSiren`, voice, critical popup), `AlertsPage.tsx` `AckDialog`; `packages/shared/src/alerts.ts`: `SOS` type (`mandatory: true`, CRITICAL), `EMERGENCY_ALERT_TYPES`, `ACK_MANDATORY_TYPES = ['SOS','CRASH']`. |
| Routing health | Main: no routing health endpoint (`routing.controller.ts` only `POST estimate-gaps`). Routing branch: `RoutingCapabilities { engineReachable, workers, etaBands, liveTraffic:false … }`, `UNCALIBRATED_ETA_NOTICE`, `NO_LIVE_TRAFFIC_NOTICE`, `OptimizeUnassignedReason` (`git show feature/routing-engine:packages/shared/src/routing.ts`). |

> **Validation note (E0 review):** Partly wrong as a code fact. `apps/web/src/features/live/map/map-style.ts` l.34–36 falls back to **OpenFreeMap** (`packages/shared/src/basemap.ts` `OPENFREEMAP`, `tiles.openfreemap.org`) unless `VITE_MAP_STYLE_*` is set at build time; production uses self-hosted Martin only because its build env sets those variables (`ops/deploy/linux/maps/README.md`). Likewise the road preview is GraphHopper only because production sets `ROUTER_ENGINE=graphhopper`; the code default is `valhalla` (`routing.service.ts` l.22). `12` G8 now also checks the web bundle.

### 1.4 Reusable patterns (what ETMS screens should be built from)

| Pattern | Evidence | ETMS reuse |
|---|---|---|
| `MasterPage<T>` | `features/masters/MasterPage.tsx`, props in `features/masters/types.ts` `MasterPageProps` (`menu`, `endpoint`, `columns`, `filters` select/text/date, `Form`, `rowActions`, `headerActions`, `aboveTable`, `fixedParams`, bulk, CSV export, column chooser, `HistorySheet`, `DetailSheet`) | Passengers, stops, shifts, bookings (list), agreements, policies, incidents (list). |
| Form dialog + fields | `features/masters/FormDialog.tsx` `useSaveMutation`, `form-fields.tsx` (`TextField`, `ComboboxField`, `SwitchField`), `form-schema.ts`, `use-options.ts` `useEntityOptions` | All simple editors. |
| Full-screen editor | `features/routes/RouteEditor.tsx` (Dialog with tabs Details / Stops / Schedules, map + list, preview, protects `data-place-search` from Esc) | Passenger editor, stop editor, route-plan editor. |
| Ordered list, keyboard | `features/routes/StopList.tsx` (move up/down buttons, delete, issues), `route-stops.ts` `moveItem`, `validateStops` | Stop order inside a trip; keyboard alternative to drag. |
| Place search | `features/geofences/PlaceSearch.tsx` → `GET /geocode/search` (Photon, self-hosted) | Home address / pickup pin. |
| Import | `features/pois/PoiImportDialog.tsx` ("preview, pick, commit") | Employee / stop bulk import. |
| Live list + detail | `features/planned-trips/PlannedTripsPage.tsx` (day pager, `STATUS_CHIPS`, live patch, table/cards), `PlannedTripDetailPage.tsx` (plan vs actual, timeline, playback), `TripDialogs.tsx` (`useTripActionDialogs`, cancel with required reason), `trip-ui.tsx` (`TripStatusBadge`, `DelayText`) | Transport trips list/detail, dispatch board trip cards. |
| Weekday schedules | `features/routes/SchedulesPanel.tsx`, `schedule-days.ts` | Recurring booking schedules, shift days. |
| Company-zone time | `features/reports/report-time.ts` `setReportTimeZone`, `reportZoneLabel`, `todayInZone` | All ETMS times. |
| Report catalogue | `features/reports/report-catalog.ts` `CatalogEntry`, `REPORT_KEYWORDS`; `PLANNED_TRIP_REPORT_TYPES` in `packages/shared/src/history.ts` | New "Employee transport" report category (§14 of the plan). |
| Dashboard kit | `features/dashboard/refresh/kit.tsx` (KPI cards with tooltip, needs-attention strip) | Transport dashboard. |

---

## 2. Proposed information architecture

### 2.1 Mapping the plan's 17 suggested menus

| # | Plan menu | Decision | Menu key | Notes |
|---|---|---|---|---|
| 1 | Transport Dashboard | **New** | `etms_dashboard` | Built with dashboard `refresh/kit.tsx`. |
| 2 | Corporate Customers / Providers | **New** | `etms_partners` | One screen, label switches by side: provider sees *Customers*, corporate sees *Providers*. |
| 3 | Employees | **New** | `etms_passengers` | Label "Employees (transport)" to avoid clash with *Staff attendance* (`attendance`). Passenger = employee transport profile (brief §2). |
| 4 | Bookings | **New** | `etms_bookings` | |
| 5 | Schedules and Shifts | **New** | `etms_schedules` | Tabs: Shifts, Recurring schedules, Holidays & exceptions. |
| 6 | Vehicles | **Reuse** `objects` | – | Add transport tab/fields (seats, transport-eligible, contract allocation) after Agent 1 decides capacity storage. |
| 7 | Drivers | **Reuse** `drivers` | – | Add transport tab (availability, contract allocation, verification). |
| 8 | Pickup and Shuttle Stops | **New** | `etms_stops` | Consider building on `Poi` (Agent 1 to decide); UI is new either way. |
| 9 | Routes and Optimization | **Split**: fixed shuttle routes **reuse** `routes`; optimisation **new** | `etms_planning` (or reuse `route_plans` from the routing branch) | One key only; see open question Q3. |
| 10 | Live Dispatch | **New** | `etms_dispatch` | §4. |
| 11 | Trips | **Reuse** `plannedTrips` if Lead/Agent 1 confirm `PlannedTrip` is the transport trip; otherwise new `etms_trips` | – | UI pattern is reused either way (list + detail). |
| 12 | Safety Policies | **New** | `etms_policies` | Separate key: corporate-owned, legal review before mandatory policies (plan §15). |
| 13 | Incidents and SOS | **New** | `etms_incidents` | SOS also surfaces in the existing bell (`alert-center`). |
| 14 | Notifications | **Reuse** `alert_settings` + `message_templates` | – | Add ETMS event types/templates there; no new notification centre. |
| 15 | Reports and Analytics | **Reuse** `reports` / `report_schedules` | – | New category "Employee transport"; types per plan §14. |
| 16 | Service Agreements / Costing | **New** | `etms_costing` (agreement terms live under `etms_partners`) | Separate key because cost data is sensitive and often hidden from dispatchers. |
| 17 | Configuration and Audit | Config **new** `etms_settings`; Audit **reuse** `audit_log` | `etms_settings` | Audit log gets an "Employee transport" entity filter. |

Also reused without a menu change: `live_map` (vehicles), `history` (playback), `alerts` (SOS/trip alerts), `users` / `roles` (role templates), `audit_log`.

### 2.2 New group and menu keys

New `MenuGroup` value **`transport`**, label **"Employee transport"**, placed after `main` in `GROUP_ORDER` (dispatchers live in it all day).

| Key | Label | Path | Actions | Icon (lucide) |
|---|---|---|---|---|
| `etms_dashboard` | Transport dashboard | `/transport` | view, export | `LayoutDashboardIcon` |
| `etms_dispatch` | Live dispatch | `/transport/dispatch` | view, edit, command | `RadioTowerIcon` |
| `etms_bookings` | Bookings | `/transport/bookings` | view, create, edit, delete, export | `TicketIcon` |
| `etms_planning` | Route planning | `/transport/planning` | view, create, edit, delete, export, command | `WaypointsIcon` |
| `etms_passengers` | Employees (transport) | `/transport/employees` | view, create, edit, delete, export | `UsersRoundIcon` |
| `etms_schedules` | Schedules & shifts | `/transport/schedules` | view, create, edit, delete, export | `CalendarRangeIcon` |
| `etms_stops` | Pickup & shuttle stops | `/transport/stops` | view, create, edit, delete, export | `MapPinnedIcon` |
| `etms_incidents` | Incidents & SOS | `/transport/incidents` | view, edit, export, command | `SirenIcon` |
| `etms_policies` | Safety policies | `/transport/policies` | view, edit | `ShieldIcon` |
| `etms_partners` | Customers / Providers & agreements | `/transport/partners` | view, create, edit, delete, export | `HandshakeIcon` |
| `etms_costing` | Rates & costing | `/transport/costing` | view, create, edit, export | `ReceiptIcon` |
| `etms_settings` | Transport settings | `/transport/settings` | view, edit | `Settings2Icon` |

Meaning of `command` (re-using the existing action, no new action type):
- `etms_dispatch:command` = publish a route version / send to drivers, cancel or suspend a running trip, manual override of a policy warning.
- `etms_planning:command` = run optimisation jobs (they cost CPU) and publish a plan.
- `etms_incidents:command` = escalate, close an SOS.

Detail routes (same permission as the menu, like `/planned-trips/:id`): `/transport/bookings/:id`, `/transport/employees/:id`, `/transport/planning/:planId`, `/transport/planning/:planId/compare`, `/transport/incidents/:id`.

### 2.3 Permission actions per role (role templates)

Templates, not new `SYSTEM_ROLES` for every company: created only when the module is switched on for a company (seeded the same way as `20261113090000_routes_planned_trips/migration.sql`). V = view, C = create, E = edit, D = delete, X = export, K = command.

| Menu | Corporate admin | Provider admin | Dispatcher |
|---|---|---|---|
| `etms_dashboard` | V X | V X | V |
| `etms_dispatch` | V E K | V E K | V E K |
| `etms_bookings` | V C E D X | V E X (approve/assign; scope = agreement) | V C E X |
| `etms_planning` | V C E D X K | V C E D X K | V C E X (no publish unless granted K) |
| `etms_passengers` | V C E D X | V (minimum fields only, plan §5) | V (masked home address) |
| `etms_schedules` | V C E D X | V | V E |
| `etms_stops` | V C E D X | V C E (if agreement allows) | V |
| `etms_incidents` | V E X K | V E X K (own trips) | V E K |
| `etms_policies` | V E | V | V |
| `etms_partners` | V C E (providers, agreements) | V C E (customers, agreements) | – |
| `etms_costing` | V X | V C E X | – |
| `etms_settings` | V E | V E (provider-side settings) | – |
| `objects` / `drivers` | V | V C E X | V |
| `routes` / `plannedTrips` | V C E D X | V C E D X | V E |
| `live_map`, `alerts` | V / V E | V / V E | V / V E |
| `reports` | V X | V X | V |
| `audit_log` | V X | V X | – |

The finer rules (dispatcher sees masked addresses, provider sees only agreed customers) cannot be expressed with menu actions alone; they need server-side field and row scoping (Agent 6). The UI only hides what the API does not send.

### 2.4 Module switch / feature flag (Proposed)

Three layers, all **off by default** (brief §3.4):

1. **Company add-on** `employeeTransport` added to `COMPANY_FEATURES` (`packages/shared/src/api.ts`); the Super Admin switches it on per company in `CompaniesPage.tsx` like `attendanceInsightsPlus`. Server: every ETMS controller checks it (via `company-features.ts`), returns 404 when off.
2. **Build flag** `etms` in `UI_FLAGS`, in `OFF_BY_DEFAULT` (port the mechanism from `feature/routing-engine:apps/web/src/lib/flags.ts`) so even dev builds hide it until `VITE_UI_FLAGS=etms` or `localStorage['vt.flags']='etms'`.
3. **Menu gating** in one place: extend `MenuDef` with `requires?: { companyFeature?: CompanyFeature; uiFlag?: UiFlag }` (unifying the routing branch's `featureFlag`) and apply it in `buildNav()`, `router.tsx` (don't register the route) and `HomeRedirect`. Role permissions may exist while the module is off; nothing shows.

> **Validation note (E0 review):** Lead naming decision: the company feature is **`etms`** (plus `etmsProvider` in E1b), not `employeeTransport` (`02` §3.1). The three-layer gating and 404-when-off are the recommended design, still subject to owner approval of D1–D8.

Rollback = switch the add-on off: no migration reversal, existing menus untouched.

### 2.5 Customer context (provider side, Proposed, depends on Agents 1/6)

When the signed-in company is a provider with more than one active agreement, the transport pages show a **customer selector** in the page header (not the global TopBar, which the Super Admin `CompanySwitcher` already uses): "All customers" (aggregate, read views only) or one customer. Writes (bookings, passengers, publish) require one customer selected. Selection is in the URL (`?customer=<id>`) so links and reloads keep it. It is sent as a query/header the API validates against active agreements. For a corporate-managed account the selector is hidden.

---

## 3. Screen inventory

Phases from plan §16: E1 accounts/authorization, E2 employee/driver/fleet, E3 booking & scheduling, E4 routing & optimisation, E5 driver operations & notifications, E6 safety, E7 dispatcher & analytics.

| Screen | Purpose | Primary data | Actions | Reused component | New component | Phase |
|---|---|---|---|---|---|---|
| Module switch (Platform → Companies) | Turn ETMS on per company | `Company.settings.features` | toggle | `CompaniesPage.tsx` form | – | E1 |
| Customers / Providers & agreements | Link provider ↔ customer, scope | agreements, zones, allocations | create, edit, suspend | `MasterPage`, `FormDialog` | `AgreementScopeEditor` | E1 |
| Customer context selector | Provider acts for one customer | active agreements | select | `Combobox` | `CustomerContextPicker` | E1 |
| Transport settings | Sites/locations, country, cut-offs, buffers | settings | edit | `features/admin/SettingsPage` sections | `SiteList` | E1–E3 |
| Employees (transport) list | Manage passengers | profile, site, shift, pickup type, status | create, edit, deactivate, import, export | `MasterPage`, `PoiImportDialog` pattern | `PassengerImportDialog` | E2 |
| Passenger editor | One passenger: profile, pickup, schedule, safety | profile, home pin, stop, contacts | save, geocode, pick stop | `RouteEditor` shell, `PlaceSearch`, `RouteMap` markers | `PickupPicker`, `NearestStopsList` | E2 |
| Vehicles → Transport tab | Seats, eligibility, contract | vehicle + transport attrs | edit | `ObjectsPage` form | `TransportVehicleFields` | E2 |
| Drivers → Transport tab | Availability, contract, verification | driver + transport attrs | edit | `DriversPage` form | `DriverAvailabilityGrid` | E2 |
| Pickup & shuttle stops | Designated stops, sites, gates | stop, type, served routes, capacity | create, edit, import, map edit | `MasterPage`, `RouteMap`, `PlaceSearch`, `PoiImportDialog` | `StopCoverageLayer` (passengers within walk radius) | E2 (E4 suggestions) |
| Schedules & shifts | Shifts, recurring schedules, holidays | shift, days, timezone, exceptions | create, edit, bulk assign | `SchedulesPanel`, `schedule-days.ts`, `MasterPage` | `WeekGrid`, `HolidayCalendar` | E3 |
| Bookings list | Ad-hoc + generated bookings | booking, status, shift, passenger | approve, reject, cancel, assign, export | `PlannedTripsPage` (day pager, chips), `MasterPage` filters | `BookingStatusBadge`, `CutoffChip` | E3 |
| Booking detail | Lifecycle and audit | booking events | cancel, reassign | `PlannedTripDetailPage` timeline layout | `BookingTimeline` | E3 |
| Route planning (plans list) | Optimisation jobs and plans | `RoutePlan`, jobs | new plan, run, duplicate | routing branch `RoutePlannerPage` / `PlanEditor` (if merged) | `PlanJobProgress` | E4 |
| Scenario comparison | Compare fleet mixes | scenario results | compare, choose, publish | `Table`, `Badge`, `Tabs`, map | `ScenarioMatrix`, `ScenarioMapPreview` | E4 |
| Plan editor (manual edits) | Adjust a proposal | routes, stops, passengers | move passenger, reorder, lock | `StopList`, `RouteMap` | `PlanDiffBar` (versioned edits) | E4 |
| Transport trips list / detail | Trips with passengers | trip, stops, passengers, ETA | cancel, reassign vehicle/driver, playback | `PlannedTripsPage`, `PlannedTripDetailPage`, `TripDialogs`, `HistoryMap` | `PassengerManifest` tab | E5 |
| Live dispatch board (monitor) | Read-only live view | trips, vehicles, alerts | filter, open | `MapController`, `usePlannedTripLive`, `alert-center` | `DispatchBoard`, `OccupancyBar`, `RoutingHealthChip` | E5 |
| Live dispatch board (actions) | Assign / reassign / exceptions | queue, trips, vehicles | assign, reassign, publish, cancel, escalate | same + `ConfirmDialog` | `AssignPicker`, `UnassignedQueue`, `ChangeTray` | E7 |
| Incidents & SOS console | Respond to SOS / incidents | incident, last positions, contacts | acknowledge, escalate, call, close | `alert-center`, `AckDialog`, `AlertDetailSheet`, `MiniMap` | `SosLane`, `IncidentTimeline` | E6 |
| Safety policies | Rules (escort, night, gender, max ride) | policies per customer/country | edit, enable | `MasterPage`, `SwitchField` | `PolicyRuleEditor` | E6 |
| Notifications (ETMS events) | Templates and recipients | event types, templates | edit | `AlertSettingsPage`, `TemplatesPage` | – | E5 |
| Rates & costing | Rate cards per vehicle type / km / trip | rate cards | create, edit | `MasterPage` | `RateCardEditor` | E7 |
| Transport dashboard | KPIs, needs attention | aggregates | drill-down | dashboard `refresh/kit.tsx` | `TransportKpis` | E7 |
| Reports (Employee transport category) | Plan §14 reports | report rows | run, schedule, export | `ReportsPage`, `report-catalog.ts`, `ScheduledReportsPage` | report column defs only | E7 |

> **Validation note (E0 review):** Phasing changed by D8: R1 (E3) includes a **basic** transport trip list / detail with manifest and a basic board (queue + trips + map, explicit assign actions) plus dispatcher progression and per-passenger outcomes (`12` §5 WP 3.5; README §6). Full board actions remain E7.

---

## 4. Live dispatch board (Proposed)

### 4.1 Layout

**Desktop (≥ 1280 px)**: three panes + top strip, everything visible without scrolling the page; each pane scrolls on its own.

- **Top strip:** date + shift selector (login/logout wave), customer context (provider), KPI chips (Unassigned, Trips at risk, Running, Completed, No-shows), **connection chip** (`realtime.getStatus()`: Live / Reconnecting / Offline with "last update hh:mm"), **routing-health chip**.
- **Left (≈ 22 rem): Queue.** Tabs: *Unassigned* (passengers without a seat for the selected wave), *Pending bookings* (needs approval), *Exceptions* (no-show, cancelled after cut-off, waitlisted). Grouped by site and pickup time; each row shows name (or masked label), pickup time, pickup type (door/stop), area, flags (escort required, accessibility), reason when unassigned (`OptimizeUnassignedReason` text).
- **Centre: Map.** `MapController`-based (vehicles via existing `live:batch`), add-on layers (`keepAlive`) for trip paths, unassigned passenger pins (clustered), shuttle stops, sites. Selecting a trip highlights its path and stops; selecting a passenger shows candidate trips nearby.
- **Right (≈ 26 rem): Trips & vehicles.** Trip cards sorted by risk: vehicle plate, driver, status (`TripStatusBadge`), **occupancy bar** "3 / 6 seats" (text + bar, never colour alone), next stop + ETA (`DelayText`), ETA quality badge (calibrated/uncalibrated). Expand a card → manifest (ordered stops with passengers, `StopList` look). Filter: idle vehicles, available drivers.
- **Alerts / SOS lane:** pinned at the top of the right pane; SOS becomes a full-width red banner across the top strip that cannot be hidden until acknowledged (re-uses `ACK_MANDATORY_TYPES` semantics and `playSiren`). Non-SOS trip alerts (ROUTE_DEVIATION, TRIP_STOP_LATE, …) as a collapsible list.

**Tablet (768–1279 px):** map + one side pane with a segmented control *Queue | Trips | Alerts*.

**Phone (375–390 px):** no three panes. Sticky header (shift, connection chip, routing chip), SOS banner sticky below. Bottom tab bar *Queue · Map · Trips · Alerts* (four items, fits 390 px like the dashboard tab bar fix `449014c`); cards instead of tables; actions open a bottom `Sheet`. Drag is not offered on phone; everything is explicit actions.

### 4.2 Data feeds

| Feed | Source | Status |
|---|---|---|
| Vehicle positions | `live:batch` (existing) via `liveStore` | Verified, reuse |
| Trip progress (status, next stop, ETA, delay, stop actuals) | `plannedTrip.update` (existing) if `PlannedTrip` is the transport trip | Verified, reuse |
| Trip alerts, vehicle SOS | `alert`, `alerts:acked` (existing) | Verified, reuse |
| Passenger boarding / no-show / occupancy | **new** `transport.trip.manifest` `{ tripId, stops:[{seq, boarded[], noShow[]}], occupied, capacity }` | Proposed |
| Bookings and queue changes | **new** `transport.booking.update` `{ id, status, tripId? }` (small; the client re-fetches the row) | Proposed |
| Employee SOS / incidents | **new** `transport.sos` (immediate, not batched, permission `etms_incidents:view`, scoped by customer) | Proposed (alerts today need an `objectId`) |
| Concurrent edits by another dispatcher | **new** `transport.plan.changed` `{ planId, version, byName }` | Proposed |
| Routing health | REST `GET` capabilities (routing branch `RoutingCapabilities`) polled every 60 s, or a `routing:health` event | Proposed |

All new events follow `live.gateway.ts` conventions: company room, permission check, scope check, immediate emit for safety events. Client hook `useTransportLive()` mirrors `usePlannedTripLive()`: patch TanStack caches, **invalidate everything after reconnect**. While the socket is not `connected`, the SOS lane polls `GET /transport/incidents?open=1` every 15 s (pushes during a gap are lost, verified comment in `use-planned-trips.ts`).

### 4.3 Routing-health indicator

Chip states, each with text, not only colour:
- **Routing OK** — engine reachable, workers ≥ 1.
- **Optimiser busy** — jobs queued > N; shows queue length.
- **Optimiser offline** — workers = 0: Optimise buttons disabled with reason; manual assignment still allowed.
- **Routing offline** — engine unreachable: ETAs shown as "—" (never invented, plan §17 E4 "no false ETA"); straight-line distances labelled "approx., straight line" if shown at all.
- Always available in the chip's popover: "Estimated times do not include live traffic" (`NO_LIVE_TRAFFIC_NOTICE`) and which distance bands are uncalibrated (`etaBands`).

### 4.4 Assign / reassign interactions

Primary interaction is **explicit and keyboard accessible**; drag is an optional desktop enhancement.

1. Select one or more passengers in the queue (checkbox, `Space`; `Shift+click` range).
2. **Assign…** (button or `A`) opens `AssignPicker`: candidate trips/vehicles ranked by feasibility, each with free seats, added detour (min), new ETA at the passenger and at the site, policy result (OK / warning / **blocked**, plan §17 E6 "mandatory violations block assignment"). Server computes the ranking; the client never guesses ETA.
3. Choose a trip → the change goes to a **Change tray** (pending, unpublished edits with a count badge). Each change shows its effect (seats, ETA delta). Undo per change.
4. **Publish** (`etms_dispatch:command`) sends the batch as one versioned change with an optional/required reason; drivers and passengers are notified by the backend. A conflict (`transport.plan.changed` with a newer version) shows a merge prompt instead of overwriting.

> **Validation note (E0 review):** For R1 (E3) the assign action must not depend on the optimiser or routing: `POST /api/transport/dispatch/candidates` returns free seats only in E3; detour and ETA arrive in E4 and are `null` + `degraded` when routing is down (`05` §2.6; `02` §9). Policy results arrive in E6. The ranked `AssignPicker` described here is the E7 form; the E3 bookings list's "assign" (§6.3) uses the seats-only picker.

Other actions from a trip card menu (same pattern as `TripActionsMenu`): *Reassign vehicle*, *Reassign driver*, *Change pickup stop*, *Change vehicle type*, *Remove passenger*, *Re-optimise this trip*, *Cancel / suspend* (required reason, like `TripDialogs` cancel), *Escalate*. Reordering stops uses `StopList` move up/down buttons.

**Drag-and-drop (desktop only, optional):** drag a passenger row onto a trip card or onto a map vehicle = shortcut for steps 2–3 (still lands in the change tray, still shows feasibility). Needs either native HTML5 DnD (poor keyboard/touch support) or a new dependency such as `@dnd-kit` (has a keyboard sensor). Owner decision (Q6). Accessibility: every drag has the explicit equivalent; results are announced in an `aria-live="polite"` region ("Asha K. added to KA01AB1234, ETA 08:42, 4 of 6 seats").

Keyboard map of the board: `g q / g m / g t` focus Queue / Map / Trips; `/` search; `A` assign; `P` publish (confirm); `Esc` closes pickers. Shortcuts listed in a `?` help dialog and can be turned off.

---

## 5. Scenario comparison UI (Proposed)

Input: one booking set (site + shift wave), N scenarios (Cars only, Shared cars, Vans, Shuttle (designated stops), Mixed fleet; user can duplicate and tweak vehicle counts, walking limit, max ride time). Each runs as an optimisation job (routing branch `RoutingJob`, `OptimizeResult`); the screen shows progress per scenario and never blocks the rest.

**Matrix: rows = metrics, columns = scenarios** (on phone: one scenario card at a time with a swipe/segmented switch; metrics as a list).

| Metric | Unit / display | Rules |
|---|---|---|
| Solver result | OPTIMAL / "Best found (not proven optimal)" / No solution | from `OptimizeResult.status`, `provenOptimal` |
| Vehicles used | count by type | |
| Total distance | km / mi (`Company.distanceUnit`) | |
| Total drive time | h min | ETA label below |
| Average / max ride time per passenger | min | flagged when above policy max |
| Average / max walking distance (shuttle) | m / ft | flagged when above walk limit |
| Average occupancy | % and "seats used / seats" | |
| Empty km (estimate) | km | depot ↔ first pickup when depot known; else "—" |
| Punctuality feasibility | "n of N arrive ≥ buffer before shift" | uses predicted times; labelled as estimate |
| Unassigned passengers | count + reasons (`OptimizeUnassignedReason`) | click → list |
| Constraint warnings | count by type (capacity, time window, policy) | click → list |
| Cost estimate | currency | **only when a rate card exists** for every vehicle type in the scenario; otherwise the cell shows **"Not configured"** with a link to Rates & costing (`etms_costing`). Partial inputs → "Incomplete: no rate for Van". Never a default or sample price. |

ETA labelling:
- Every time-based cell carries an **ETA quality badge**: *Calibrated* or **"Uncalibrated"** (text from `UNCALIBRATED_ETA_NOTICE`: "free-flow road time, no correction and no live traffic") when any route in the scenario falls in an uncalibrated distance band. The column header shows the worst case.
- A footnote on the matrix always states `NO_LIVE_TRAFFIC_NOTICE`.
- Punctuality feasibility inherits the uncalibrated label ("Estimate, uncalibrated").

Presentation rules: best value per row gets a subtle "Best" marker (icon + text) only where "better" is unambiguous (fewer unassigned, fewer vehicles, less distance); **no overall score or winner** unless the customer has configured weights (open question Q8). Delta vs the selected baseline column ("−12 %"). A map preview tab shows one scenario's routes at a time. **Choose & publish** (`etms_planning:command`) creates a route plan version → trips; the matrix and inputs are stored with the version for audit.

---

## 6. Key interactions per management screen (Proposed)

### 6.1 Employees (passengers)
- List: `MasterPage` with columns name, employee ID, site, shift, pickup type (Door / Stop), stop or area, phone (masked by permission), status, last trip. Filters: site, shift, pickup type, "no pickup location", "outside service zone". Bulk: activate/deactivate, assign shift, assign stop.
- Import: CSV/XLSX template per country (India / US address columns, §7), preview with row errors (bad phone, unknown site, address not found), pick rows, commit; geocoding runs server-side against self-hosted Photon and returns confidence; low-confidence rows go to a "Needs location" filter.
- Editor (full-screen, `RouteEditor` shell) tabs: **Profile** (name, IDs, site, gender only if a policy needs it, accessibility needs), **Pickup & drop** (map with `PlaceSearch`, draggable home pin, road check: show `NOT_ON_ROAD` / `OUTSIDE_GRAPH` issues; or choose a shuttle stop from `NearestStopsList` with walking distance and time), **Schedule** (shift, days, exceptions), **Safety & contacts** (emergency contacts, escort requirement), **History** (`HistorySheet` + trips). Home address visibility follows Agent 6's rules (dispatcher sees area/landmark only).

> **Validation note (E0 review):** `NOT_ON_ROAD` / `OUTSIDE_GRAPH` do not exist in code; they are proposed (the contract names are `POINT_NOT_ON_ROAD` / `OUTSIDE_COVERAGE`, `05` §4). The road check needs `RoutingProvider.locate` (E4); in E2 the editor shows the pin and Photon result without a snap check, or calls GraphHopper `/nearest` directly if WP 2.2 adds it.

### 6.2 Pickup and shuttle stops editor
- Map-first: stops as markers, passenger homes as a density layer (counts only, no names) to see coverage; walking radius rings per stop.
- Add: click map or `PlaceSearch`; drag to adjust; fields name, type (shuttle stop / site gate / landmark), capacity, active hours, accessible, served routes (read-only list from `routes`).
- Validation: road-accessible check, duplicates within 50 m, stops with zero passengers flagged.
- E4: "Suggest stops" (clustering) shows proposals as ghost markers to accept one by one.

### 6.3 Bookings list
- Day pager + status chips copied from `PlannedTripsPage` (`STATUS_CHIPS` pattern), states from plan §9 (REQUESTED … CONFIRMED, REJECTED, CANCELLED, EXPIRED, WAITLISTED, FAILED). Columns: passenger, direction (to site / from site), shift time, pickup, source (Ad-hoc / Scheduled), status, trip, cut-off chip ("cut-off in 25 min" / "after cut-off").
- Actions: approve / reject (reason), cancel (reason), assign (opens `AssignPicker`), open trip. Bulk approve for a wave.
- Detail: timeline of events (who, when, from which app).

### 6.4 Schedules and shifts
- **Shifts** tab: `MasterPage` (name, site, start, end, overnight flag, days via `schedule-days.ts`, timezone = site's).
- **Recurring schedules**: per passenger or per team; `WeekGrid` (rows = passengers, columns = days, cell = shift chip; keyboard navigable grid, `aria-rowindex/colindex`); bulk apply a shift to a selection.
- **Holidays & exceptions**: calendar per site/country; an exception preview shows how many bookings will not be generated. Overnight shifts and US DST days display both local times explicitly ("01:30 PDT → 01:30 PST").

### 6.5 Incidents and SOS console
- Two lanes: **Open SOS** (always on top, ack mandatory) and **Incidents** (breakdown, delay, harassment report, accident, deviation escalations).
- SOS card: who raised it (employee / driver / device), trip, vehicle, time since raised (ticking), last known position + accuracy + age, nearest site, contacts with `tel:` buttons, **Acknowledge** (required note, `AckDialog` pattern), **Escalate** (to configured chain), **Close** (outcome + note). Response time is recorded and later reported.
- Map: live position of the vehicle (if any) and the phone's last position; trail of the last 10 minutes via `HistoryMap`.
- Bell integration: SOS also enters `alert-center` (siren, critical popup) so a dispatcher on any page sees it. Access to an incident's location history is audited (Agent 6).

---

## 7. Accessibility, responsiveness, i18n and formatting (Proposed, on Verified foundations)

### 7.1 Accessibility (WCAG 2.1 AA, per `docs/modernization/07-design-system.md`)
- Status never by colour alone: badges carry text + icon; occupancy shows "3 / 6"; ETA quality is a text badge.
- Avoid the documented failing pairs (light `StatusBadge`, `Badge` success/warning) for dispatch statuses; use the `-soft` / `-fg` token pairs that pass.
- Focus: visible focus on cards and map list items; every map action has a list equivalent (the map is never the only way).
- Live regions: SOS `role="alert"` (assertive, once); assignment/publish results `aria-live="polite"`; ticking timers are not announced every second.
- Motion: respect `prefers-reduced-motion` (existing `index.css` and `MapController.reducedMotion`); no pulsing except SOS, which also has text.
- Touch targets ≥ 44 px on phone; dialogs and sheets trap focus (Radix).

### 7.2 Responsiveness
- Verify each screen at 1440 / 1024 / 768 / 390 and 375 px, Teal + Dark (dashboard REPORT standard); no horizontal page scroll; tables become cards below `lg` (Planned trips pattern); editors become full-screen sheets.
- Dispatch board on phone is a monitoring + exception tool; heavy planning (scenario matrix editing) is desktop-first but readable on phone.

### 7.3 Languages
- All strings through `t()` with English text keys; Hindi and Tamil added to `packages/shared/src/i18n/hi.ts` / `ta.ts`; `node scripts/i18n-extract.mjs` must report 0 missing ETMS keys before release (dashboard redesign shipped English-only strings, REPORT "Open items").
- US English: same English keys; only formatting differs (below). Plurals via i18next counts ("{{count}} seats").
- Hindi/Tamil glyph widths: avoid fixed-width chips; test the board in `ta` (longest labels).

### 7.4 India / US formatting
Today `currentLocale()` (`apps/web/src/lib/i18n.ts`) returns `en-IN` / `hi-IN` / `ta-IN` and `formatDateTime` / `formatNumber` (`lib/format.ts`) use it; times in reports use the company zone (`report-time.ts`). Proposed:

| Item | India | US | Mechanism |
|---|---|---|---|
| Locale | `en-IN`, `hi-IN`, `ta-IN` | `en-US` | new company (or site) **country** setting → formatting locale, separate from UI language |
| Time zone | `Asia/Kolkata` (single) | per **site** (ET/CT/MT/PT…), DST | site timezone on every time shown on the board; show zone abbreviation when the user's and site's zones differ (`reportZoneLabel` pattern) |
| Clock | 12 h "8:30 am" (en-IN default) | 12 h "8:30 AM" | `Intl.DateTimeFormat(locale, { timeStyle:'short', timeZone })`; optional 24 h preference |
| Dates | 10 Nov 2026 | Nov 10, 2026 | `Intl` |
| Numbers | 1,23,456 | 123,456 | `Intl.NumberFormat` (already locale-driven) |
| Distance | km | mi | existing `Company.distanceUnit` |
| Currency | ₹ INR, GST | $ USD, sales tax | from rate card currency; never inferred |
| Phone | store E.164 (`+919876543210`); show `+91 98765 43210`; validate 10-digit mobile starting 6–9 | store `+15551234567`; show `(555) 123-4567` | shared validator in `packages/shared` (library choice is Q9); note `mobile-tracker.ts` stores E.164 digits without `+` today |
| Address fields | Line 1 (house/building), Line 2 (street/area), Landmark, Locality, City, State, PIN (6 digits) | Street, Apt/Suite, City, State (2-letter), ZIP (5 or 9) | country-driven form layout; single-line display order per country |
| Week start | Monday | Sunday | schedule grids |

---

## 8. Low-fidelity wireframes

### 8.1 Live dispatch board, desktop (1440 px)

```
+--------------------------------------------------------------------------------------------------------------+
| Live dispatch   [Tue 10 Nov v] [Login wave 08:00 v] [Customer: Acme Tech v]   (*) Live 08:12   [Routing OK v]  |
| Unassigned 7 | At risk 2 | Running 14 | Done 3 | No-show 1                                                    |
|!! SOS  Priya R. on KA01AB1234 (Trip T-0815)  raised 0:42 ago   [Acknowledge] [Open]  -- cannot be dismissed --|
+------------------------+--------------------------------------------------+-----------------------------------+
| QUEUE                  |                                                  | ALERTS (2)              [v]       |
| [Unassigned 7][Pending | <MapLibre map>                                   |  ! Late at stop 3  T-0807  +9 min |
|  3][Exceptions 1]      |   o  passenger pins (clustered)                  |  ! Deviation       T-0811         |
| Search [__________]    |   []  vehicles (live)                            +-----------------------------------+
| -- Whitefield 07:10 -- |   --- selected trip path                         | TRIPS & VEHICLES  [At risk first v]|
| [x] Asha K.  Door  ESC |   (S) shuttle stops   (#) site                   | T-0807 KA01AB1234  Ravi  RUNNING  |
|     07:10  Outside zone|                                                  |  Seats [####--] 4/6  Next: Stop 3 |
| [ ] Vikram S. Stop 12  |                                                  |  ETA 07:52 (+9 min) Uncalibrated  |
|     07:15              |                                                  |  [Assign here] [...]              |
| [ ] Meena L. Door      |                                                  | T-0811 KA05MN4455  Arun  RUNNING  |
|     07:20  cap_exceeded|                                                  |  Seats [######] 6/6  Next: Site   |
|                        |                                                  | Idle: KA03ZZ0001 (Van, 7 seats)   |
| [Assign selected (1)]  |                                                  |                                   |
+------------------------+--------------------------------------------------+-----------------------------------+
| Change tray: 2 pending  (Asha K. -> T-0807, ETA 07:31, 5/6) (Stop order T-0807)   [Undo] [Review & publish]   |
+--------------------------------------------------------------------------------------------------------------+
```

### 8.2 Live dispatch board, phone (390 px)

```
+------------------------------------+
| Dispatch  08:00 v   (*)Live  [OK]  |
|!! SOS Priya R. 0:42   [Ack] [Open] |
+------------------------------------+
| Unassigned (7)        [Select]     |
| +--------------------------------+ |
| | Asha K.        07:10  Door ESC | |
| | Outside zone       [Assign >]  | |
| +--------------------------------+ |
| | Vikram S.      07:15  Stop 12  | |
| |                    [Assign >]  | |
| +--------------------------------+ |
|                                    |
| 2 pending changes   [Publish]      |
+------------------------------------+
| [Queue] [ Map ] [Trips] [Alerts 2] |
+------------------------------------+
  Assign > opens bottom sheet:
  | Assign Asha K.                   |
  | T-0807  +6 min  5/6  OK      ( ) |
  | T-0809  +14 min 3/4  Warning ( ) |
  | KA03ZZ0001 idle  1/7 New trip( ) |
  |           [Cancel] [Add to tray] |
```

### 8.3 Passenger editor (desktop; phone = tabs stacked full-screen)

```
+--------------------------------------------------------------------------------------------+
| Employee: Asha Kumar (EMP-1042)                                     [Cancel] [Save]         |
| [Profile] [Pickup & drop] [Schedule] [Safety & contacts] [History]                          |
+------------------------------------------+-------------------------------------------------+
| Pickup type  (o) Door to door ( ) Stop   |  Search address [ 12th Main, Indiranagar___ ]   |
|                                          |  +-------------------------------------------+  |
| Address (India)                          |  |            <map>                          |  |
| Line 1    [No. 45, 2nd Floor        ]    |  |        (H) home pin (draggable)           |  |
| Line 2    [12th Main, HAL 2nd Stage ]    |  |   (S)12  (S)14   walking rings            |  |
| Landmark  [Near Metro station       ]    |  +-------------------------------------------+  |
| City [Bengaluru] State [Karnataka v]     |  ! Pin is 120 m from the nearest road: move it   |
| PIN  [560038]                            |  Nearest stops                                  |
| Phone [+91 98765 43210]                  |   Stop 12 Indiranagar Metro  350 m  5 min walk  |
| Site [Whitefield Campus v]               |   Stop 14 CMH Road           600 m  8 min walk  |
| Return drop  [x] same as pickup          |   [Use Stop 12 instead]                         |
+------------------------------------------+-------------------------------------------------+
```

### 8.4 Scenario comparison

```
+--------------------------------------------------------------------------------------------------+
| Compare scenarios  Whitefield, Login 08:00, 186 passengers      Baseline: [Shared cars v]        |
| Estimated times do not include live traffic.                                                    |
+----------------------+--------------+--------------+--------------+--------------+--------------+
| Metric               | Cars         | Shared cars  | Vans         | Shuttle      | Mixed        |
+----------------------+--------------+--------------+--------------+--------------+--------------+
| Solver               | Best found*  | Best found*  | Optimal      | Best found*  | Running 62 % |
| Vehicles             | 62 cars      | 41 cars      | 18 vans      | 6 buses      | ...          |
| Distance             | 1,940 km     | 1,312 km     | 905 km Best  | 610 km Best  |              |
| Avg / max ride       | 34 / 58 min  | 41 / 66 min  | 47 / 79 min! | 52 / 71 min  |              |
| ETA quality          | Calibrated   | Uncalibrated | Uncalibrated | Uncalibrated |              |
| Avg walk             | -            | -            | -            | 380 m        |              |
| Avg occupancy        | 3.0/4 (75 %) | 4.5/6 (76 %) | 10.3/12      | 31/40 (78 %) |              |
| Punctuality (est.)   | 186/186      | 183/186      | 179/186      | 181/186      |              |
| Unassigned           | 0            | 0            | 2 (time win.)| 5 (walk lim.)|              |
| Warnings             | 0            | 1            | 4            | 2            |              |
| Cost estimate        | Not configured -> set rates   (no rate card for Car, Van, Bus)                        |
+----------------------+--------------+--------------+--------------+--------------+--------------+
| * Best found within the time limit, not proven optimal.   ! above policy max ride time (75 min)  |
| [Map preview: Vans v]                                  [Duplicate & edit] [Choose & publish...] |
+--------------------------------------------------------------------------------------------------+
```

---

## 9. Open questions (for the owner / Lead)

| # | Question | Why it matters | Proposed default |
|---|---|---|---|
| Q1 | Is a transport provider and a corporate customer each a `Company` (linked by a service agreement), or are customers records inside the provider's company? | Decides whether the customer context selector (§2.5) switches data scope across companies (like `VehicleShare`) or filters within one. | Each is a `Company`; agreement grants scoped cross-company access (Agents 1/6). |
| Q2 | Is the transport trip the v1.8.0 `PlannedTrip` (extended with passengers) or a new entity? | Decides reuse of `plannedTrips` menu, list/detail pages and `plannedTrip.update`. | Reuse `PlannedTrip` + manifest (pending Agent 1 evidence). |
| Q3 | Does ETMS planning use the routing branch's `route_plans` menu / `RoutePlannerPage`, or a new `etms_planning`? | Avoid two planning screens and two menu keys. | One key: rename/adopt `route_plans` when the routing branch merges; ETMS adds the scenario view. |
| Q4 | Approve the new group "Employee transport" placed second in the sidebar, and the 11 new menu keys (§2.2)? | Sidebar length for companies with the module on. | Yes; hidden entirely when the add-on is off. |
| Q5 | Role templates (Corporate admin / Provider admin / Dispatcher) created only for companies with the module, not added to `SYSTEM_ROLES` globally? | Existing customers must be unaffected (plan §17 E1). | Yes, templates seeded on enable. |
| Q6 | Allow a drag-and-drop dependency (e.g. `@dnd-kit`) for desktop assign, or explicit actions only? | New dependency vs ergonomics; explicit actions are required anyway for accessibility. | Explicit actions in E7; drag later if dispatchers ask. |
| Q7 | Add a **country** (and site-level timezone) setting to drive `en-US` formatting, phone and address forms? | No country field and no `en-US` locale exist today. | Company country + per-site timezone. |
| Q8 | May the scenario comparison show an overall "recommended" scenario, and with which weights? | Avoid implying a cost/quality judgement without inputs. | No overall winner until weights are configured. |
| Q9 | Phone validation library on web/shared (e.g. `libphonenumber-js`) or a small India/US validator? | Bundle size vs correctness. | Small shared India/US validator first. |
| Q10 | What may a Dispatcher and a Provider admin see of an employee's home address and phone? | Masking in lists, editor and map (plan §5 "minimum necessary"). | Area/landmark + masked phone with click-to-call through the platform; full address only for corporate admin. |
| Q11 | Employee SOS (no vehicle): new incident event and console, or extend `AlertDto` to allow no `objectId`? | Current alert scoping is per vehicle. | Separate incident model and `transport.sos` event; mirrored into the bell. |
| Q12 | Seat capacity: a field on `TrackedObject` or a transport-attributes table? | Occupancy bars, scenario metrics and assignment checks depend on it. | Agent 1 decides; UI reads one `capacity` value. |

---

**File:** `D:\Vibhav\gps-app-wt\etms\docs\employee-transport\07-web-dispatcher-ux.md` (not committed).
