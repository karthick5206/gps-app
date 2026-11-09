# 07 · Web app: screens and design system

> **Scope:** `apps/web` (React SPA), `brand/`, `docs/design/`, and the menu catalogue in `packages/shared`.
> **Method:** read-only review of the source code on 2026-11-08 (branch `main` @ `17a2e63`). The app was **not running** and we couldn't sign in, so **there are no screenshots yet**. Every layout, colour and behaviour below comes from reading the router, the layouts, the page components, the CSS tokens and the built `dist/` output. Treat the visual descriptions as reconstructions until they are checked against the running app (see the [screenshot list](#9-screenshot-shortlist)).

---

## 1. Tech stack and bootstrap

### 1.1 Stack ([package.json](../../apps/web/package.json))

| Concern | Library | Version (range in package.json) | Notes |
|---|---|---|---|
| UI runtime | react / react-dom | 19.3.0 (pinned) | `StrictMode` on |
| Build | vite + @vitejs/plugin-react | ^8.3.4 / ^6.1.2 | Uses the rolldown runtime. Dev proxy `/api` and `/socket.io` go to `API_TARGET` (default :4000) ([vite.config.ts](../../apps/web/vite.config.ts)) |
| Styling | tailwindcss + @tailwindcss/vite | ^4.3.3 | CSS-first config in [index.css](../../apps/web/src/index.css) (`@theme inline`), shadcn token convention |
| Primitives | @radix-ui/* (checkbox, dialog, dropdown-menu, label, popover, scroll-area, select, slot, switch, tabs, tooltip) | 1.x–2.x | Wrapped in [components/ui](../../apps/web/src/components/ui) (shadcn-style, owned in the repo) |
| Variants | class-variance-authority, clsx, tailwind-merge | ^0.7.1 / ^2.1.1 / ^3.7.0 | `cn()` in [lib/utils.ts](../../apps/web/src/lib/utils.ts) |
| Routing | react-router | ^7.18.4 | `createBrowserRouter` (data router) |
| Server state | @tanstack/react-query | ^5.104.4 | staleTime 30 s, no refetch on focus, no retry on 4xx ([query-client.ts](../../apps/web/src/lib/query-client.ts)) |
| Tables | @tanstack/react-table | ^8.21.3 | Used only by the generic [MasterPage](../../apps/web/src/features/masters/MasterPage.tsx). The other tables are hand-rolled |
| Forms | react-hook-form + @hookform/resolvers + zod | ^7.90 / ^5.9 / ^3.25 | |
| i18n | i18next + react-i18next | ^26.5.2 / ^17.1.0 | Keys are the English source strings |
| Maps | maplibre-gl | ^5.24.0 | OpenFreeMap vector styles |
| Realtime | socket.io-client | ^4.8.4 | `/live` namespace |
| Toasts | sonner | ^2.0.8 | top-right, `richColors`, close button |
| Icons | lucide-react | ^1.59.0 | Only icon set; custom SVG/canvas for the brand mark and map markers |
| Lazy heavy deps | jspdf ^2.5.2, html-to-image ^1.11.11, tesseract.js ^5.1.1, mpegts.js 1.8.2 | — | All loaded with dynamic `import()` on first use |

### 1.2 Bootstrap chain

| Step | File | What happens |
|---|---|---|
| 1. Pre-paint theme | [index.html:18-30](../../apps/web/index.html#L18) | Inline script reads `localStorage['vt.theme']` and sets `<html data-theme>`, the `.dark` class and `color-scheme` before first paint |
| 2. Entry | [main.tsx](../../apps/web/src/main.tsx) | Imports `lib/i18n` (side effect), calls `injectStatusTokens()` (writes `--status-*` CSS variables from `STATUS_META`) and `installStaleBuildRecovery()` (reloads once when a lazy chunk 404s after a deploy), renders `<App/>` |
| 3. Providers | [App.tsx](../../apps/web/src/app/App.tsx) | `QueryClientProvider` → `AuthProvider` → `TooltipProvider(300 ms)` → `RouterProvider` + themed `<Toaster>` |
| 4. Auth | [AuthProvider.tsx](../../apps/web/src/features/auth/AuthProvider.tsx), [session.ts](../../apps/web/src/lib/session.ts) | Access token kept in memory only. Refresh token in `localStorage['vt.refreshToken']`. On load it refreshes, then `GET /auth/me` (key includes companyId, staleTime 5 min). A session-expired handler shows a toast and signs out. Super Admin company in `vt.companyId`, sent as `X-Company-Id` |
| 5. Guards | [guards.tsx](../../apps/web/src/features/auth/guards.tsx) | `RequireAuth` (full-screen pulsing logo while restoring), `RedirectIfAuthenticated` (returns to the original page only for the same user), `RequirePermission(menu, action)` → `ForbiddenPage` |
| 6. Realtime | [realtime.ts](../../apps/web/src/features/live/realtime.ts), [AppShell.tsx:17](../../apps/web/src/features/shell/AppShell.tsx#L17) | One Socket.IO connection per selected company, opened only when the user can view `live_map`, `dashboard` or `alerts`. Events: `live:batch`, `alert`, `system:health`. Status dot in the top bar |
| 7. i18n | [lib/i18n.ts](../../apps/web/src/lib/i18n.ts) | Language from the saved choice, else the browser language, else `en`. Sets `<html lang>`. Number and date locale is en-IN / hi-IN / ta-IN |
| 8. Theme | [theme-store.ts](../../apps/web/src/features/theme/theme-store.ts) | Store outside React (the map subscribes too). It also redraws the favicon as an SVG data URL in the theme's logo colours and updates `meta[theme-color]`. The choice is saved to the profile (`PATCH /auth/me/preferences`) |
| 9. Display size | [display-store.ts](../../apps/web/src/features/display/display-store.ts) | Text scale 1 / 1.125 / 1.25 and map icon scale 1 / 1.3 / 1.6, synced to the profile |

**Themes:** there are five fixed themes ([shared/api.ts:9](../../packages/shared/src/api.ts#L9)): **Teal & Saffron** (default), **Plum & Pink**, **Sky & Cobalt**, **Light** and **Dark**. There is **no "System / follow OS" option**: older profiles that stored `system` are turned into `teal`. The approved design doc §11.2 asks for one ("Light, Dark and System").

---

## 2. Navigation

### 2.1 Shell structure ([AppShell.tsx](../../apps/web/src/features/shell/AppShell.tsx))

```
┌ TopBar (h-14, .app-header = sidebar colours) ─────────────────────────────────────────────┐
│ [☰ <lg] [Logo+Wordmark] [CompanySwitcher | company name] / [current menu]   [✨Ask] [●rt] [🔔] [文A] [Aa] [🎨] [User] │
├──────────────┬────────────────────────────────────────────────────────────────────────────┤
│ Sidebar       │ LicenceBanner · SystemHealthBanner (SA, CRITICAL) · AllCompaniesBanner (SA)  │
│ w-60 / w-16   │ <main id="main" overflow-y-auto>  <Outlet key={companyId}/>                   │
│ (lg+ only;    │                                                                              │
│ Sheet <lg)    │ AppFooter (11px: © · Privacy · Guide)                                         │
└──────────────┴────────────────────────────────────────────────────────────────────────────┘
+ LicenceRequiredDialog (global)
```

| Element | File | Behaviour |
|---|---|---|
| TopBar | [TopBar.tsx](../../apps/web/src/features/shell/TopBar.tsx) | Uses the theme's *sidebar* colours (dark teal, plum, or light for Sky/Light). The `.app-header` CSS re-points the tokens so ghost buttons stay readable ([index.css:316](../../apps/web/src/index.css#L316)). Ask button only with `live_map`, bell only with `alerts` |
| Sidebar | [Sidebar.tsx](../../apps/web/src/features/shell/Sidebar.tsx) | `bg-card` panel. Group labels are 11 px uppercase. Active item: `bg-accent`, a 3 px inset saffron bar (`--brand-accent`) and a primary-coloured icon. Collapsible to 64 px icon rail with tooltips (saved in `vt.sidebarCollapsed`). Below `lg` it becomes a left Sheet (w-72) that repeats the brand |
| Company switcher | [CompanySwitcher.tsx](../../apps/web/src/features/shell/CompanySwitcher.tsx) | **Super Admin only.** Popover with search (`GET /admin/companies?q`) and options: *All companies*, *Platform (no company)*, then each company (object count, suspended flag). Switching clears company-specific URL params and remounts the page |
| User menu | [UserMenu.tsx](../../apps/web/src/features/shell/UserMenu.tsx) | Initials avatar (`bg-navy`). Menu: Getting-started guide · Signed-in devices (SessionsDialog) · Privacy policy · Delete account · Sign out |
| Toggles | [LanguageToggle](../../apps/web/src/features/shell/LanguageToggle.tsx), [DisplayToggle](../../apps/web/src/features/shell/DisplayToggle.tsx), [ThemeToggle](../../apps/web/src/features/shell/ThemeToggle.tsx) | Radio dropdowns. The theme menu shows two-colour swatches |
| Breadcrumb | [page-header.tsx](../../apps/web/src/components/page-header.tsx) | "Group › Menu › record", built from MENUS |

Personal accounts (`accountType !== 'BUSINESS'`) also hide `branches, vehicle_groups, lookups, roles, audit_log, api, message_templates, drivers` from the sidebar ([permissions.ts](../../packages/shared/src/permissions.ts) `PERSONAL_HIDDEN_MENUS`). Their permissions don't change, so the URLs still work.

### 2.2 Route table ([router.tsx](../../apps/web/src/app/router.tsx), paths from [`MENUS`](../../packages/shared/src/permissions.ts#L66))

Role columns show the **built-in role defaults** from `SYSTEM_ROLES` (Admin = every non-SA menu; SA = Super Admin only). Custom roles can differ. ✔ = view.

| Path | Page component | Menu key (group) | Actions defined | Admin | Manager | User | Viewer | Lazy |
|---|---|---|---|---|---|---|---|---|
| `/` | `HomeRedirect` → first viewable menu | — | — | ✔ | ✔ | ✔ | ✔ | no |
| `/dashboard` | [DashboardPage](../../apps/web/src/features/dashboard/DashboardPage.tsx#L22) (`?tab=overview\|criticality\|health\|compare`) | dashboard (Tracking) | view | ✔ | ✔ | ✔ | ✔ | yes |
| `/live` | [LiveMapPage](../../apps/web/src/features/live/LiveMapPage.tsx#L78) (`?status= ?objectId= ?focus= ?geofence= ?poi=`) | live_map | view, command | ✔(+cmd) | ✔ | ✔ | ✔ | yes |
| `/history` | [HistoryPage](../../apps/web/src/features/history/HistoryPage.tsx#L273) | history | view, export | ✔ | ✔ | ✔ | ✔ | yes |
| `/alerts` | [AlertsPage](../../apps/web/src/features/alerts/AlertsPage.tsx#L120) | alerts | view, edit, export | ✔ | ✔ | ✔ | ✔ | yes |
| `/parking-mode` | [ParkingModePage](../../apps/web/src/features/parking/ParkingModePage.tsx#L184) | parking_mode | view, edit | ✔ | ✔ | ✔ | ✔ | yes |
| `/video` (`?objectId&channel&at`) | [VideoPage](../../apps/web/src/features/video/VideoPage.tsx#L13) | video | view | ✔ | ✔ | — | — | yes |
| `/dms` | [DmsPage](../../apps/web/src/features/dms/DmsPage.tsx#L25) | dms (Drivers & Staff) | view, export | ✔ | ✔ | ✔ | — | yes |
| `/driver-events` | [DriverEventsPage](../../apps/web/src/features/driver-events/DriverEventsPage.tsx#L135) | driver_events | view, edit, export | ✔ | ✔ | ✔ | — | yes |
| `/driver-scores` | [DriverScoresPage](../../apps/web/src/features/driver-scores/DriverScoresPage.tsx#L42) | driver_scores | view | ✔ | ✔ | ✔ | — | yes |
| `/attendance` | [AttendancePage](../../apps/web/src/features/attendance/AttendancePage.tsx#L1059) | attendance | view, edit, export | ✔ | ✔ | — | — | yes |
| `/expenses` | [ExpensesPage](../../apps/web/src/features/expenses/ExpensesPage.tsx#L172) | expenses (Costs & Reports) | view, create, delete | ✔ | ✔ | ✔ | — | yes |
| `/reports` | [ReportsPage](../../apps/web/src/features/reports/ReportsPage.tsx#L80) | reports | view, export | ✔ | ✔ | ✔ | — | yes |
| `/reports/schedules` | [ScheduledReportsPage](../../apps/web/src/features/reports/ScheduledReportsPage.tsx#L215) | report_schedules | CRUD-ish | ✔ | ✔ | ✔ | — | yes |
| `/masters/objects` | [ObjectsPage](../../apps/web/src/features/masters/pages/ObjectsPage.tsx#L203) | objects (Masters) | CRUD+export | ✔ | ✔ | ✔ | — | yes |
| `/masters/devices` | [DevicesPage](../../apps/web/src/features/masters/pages/DevicesPage.tsx#L27) | devices | CRUD+export | ✔ | ✔ | — | — | yes |
| `/masters/drivers` | [DriversPage](../../apps/web/src/features/masters/pages/DriversPage.tsx#L183) | drivers | CRUD+export | ✔ | ✔ | ✔ | — | yes |
| `/masters/vehicle-groups` | [VehicleGroupsPage](../../apps/web/src/features/masters/pages/VehicleGroupsPage.tsx#L71) | vehicle_groups | CRUD+export | ✔ | ✔ | ✔ | — | yes |
| `/masters/branches` | [BranchesPage](../../apps/web/src/features/masters/pages/BranchesPage.tsx#L60) | branches | CRUD+export | ✔ | ✔ | — | — | yes |
| `/masters/documents` | [DocumentsPage](../../apps/web/src/features/documents/DocumentsPage.tsx#L316) | documents | CRUD+export | ✔ | ✔ | ✔ | — | yes |
| `/masters/geofences` | [GeofencesPage](../../apps/web/src/features/geofences/GeofencesPage.tsx#L48) | geofences | CRUD+export | ✔ | ✔ | ✔ | — | yes |
| `/masters/pois` | [PoisPage](../../apps/web/src/features/pois/PoisPage.tsx#L19) | pois | CRUD+export | ✔ | ✔ | ✔ | — | yes |
| `/masters/lookups` | [LookupsPage](../../apps/web/src/features/masters/pages/LookupsPage.tsx#L83) | lookups | CRUD+export | ✔ | ✔ | — | — | yes |
| `/alerting/settings` (`?level&id`) | [AlertSettingsPage](../../apps/web/src/features/alerting/AlertSettingsPage.tsx#L81) | alert_settings (Alert Mgmt) | view, create, edit, delete | ✔ | ✔ | — | — | yes |
| `/alerting/templates` | [TemplatesPage](../../apps/web/src/features/templates/TemplatesPage.tsx#L174) | message_templates | +export | ✔ | ✔(view) | — | — | yes |
| `/admin/users` | [UsersPage](../../apps/web/src/features/admin/UsersPage.tsx#L161) | users (Administration) | CRUD+export | ✔ | ✔ | — | — | yes |
| `/admin/roles` | [RolesPage](../../apps/web/src/features/admin/RolesPage.tsx#L112) | roles | view, create, edit, delete | ✔ | — | — | — | yes |
| `/admin/settings` | [SettingsPage](../../apps/web/src/features/admin/SettingsPage.tsx#L47) | settings | view, edit | ✔ | — | — | — | yes |
| `/admin/billing` | [BillingPage](../../apps/web/src/features/billing/BillingPage.tsx#L70) | billing | view, create, edit | ✔ | — | — | — | yes |
| `/admin/developer-api` (`?tab=keys\|webhooks\|docs`) | [DeveloperApiPage](../../apps/web/src/features/developer/DeveloperApiPage.tsx#L22) | api | view, create, edit, delete | ✔ | — | — | — | yes |
| `/admin/audit-log` | [AuditLogPage](../../apps/web/src/features/admin/AuditLogPage.tsx#L33) | audit_log | view, export | ✔ | — | — | — | yes |
| `/platform/companies` | [CompaniesPage](../../apps/web/src/features/platform/CompaniesPage.tsx#L139) | sa_companies (Platform) | CRUD+export | SA | — | — | — | yes |
| `/platform/licences` | [LicencesAdminPage](../../apps/web/src/features/billing/admin/LicencesAdminPage.tsx#L91) | sa_licences | CRUD+export | SA | | | | yes |
| `/platform/device-models` | [DeviceModelsPage](../../apps/web/src/features/platform/DeviceModelsPage.tsx#L118) | sa_device_models | CRUD+export | SA | | | | yes |
| `/platform/device-inventory` | [DeviceInventoryPage](../../apps/web/src/features/platform/DeviceInventoryPage.tsx#L23) | sa_device_inventory | CRUD+export | SA | | | | yes |
| `/platform/unknown-devices` | [UnknownDevicesPage](../../apps/web/src/features/platform/UnknownDevicesPage.tsx#L25) | sa_unknown_devices | view | SA | | | | yes |
| `/platform/data-forwarding` | [DataForwardingPage](../../apps/web/src/features/platform/relay/DataForwardingPage.tsx#L52) | sa_relay | view, create, edit, delete | SA | | | | yes |
| `/platform/settings` | [PlatformSettingsPage](../../apps/web/src/features/billing/admin/PlatformSettingsPage.tsx#L9) | sa_platform_settings | view, edit | SA | | | | yes |
| `/platform/system-health` | [SystemHealthPage](../../apps/web/src/features/platform/SystemHealthPage.tsx#L613) | sa_system_health | view, edit | SA | | | | yes |
| `/claim` (`?imei&code`) | [ClaimPage](../../apps/web/src/features/claim/ClaimPage.tsx#L28) | *(not a menu)* requires `devices` | — | ✔ | ✔ | — | — | **no** (eager import wrapped in a no-op Suspense) |
| `/403` | ForbiddenPage | — | — | | | | | no |
| `*` (signed in) | NotFoundPage | — | — | | | | | no |
| *(route error)* | UnexpectedErrorPage (errorElement of AppShell only) | — | — | | | | | no |

**Public routes (no shell, all eager):**

| Path | Component | Guard | Notes |
|---|---|---|---|
| `/login` | [LoginPage](../../apps/web/src/features/auth/LoginPage.tsx#L160) | RedirectIfAuthenticated | Tabs *Password* / *OTP (mobile)*; links: Forgot password, Sign up, Guide |
| `/forgot-password` | [ForgotPasswordPage](../../apps/web/src/features/auth/ForgotPasswordPage.tsx#L18) | RedirectIfAuthenticated | Email → "Check your email" state |
| `/signup` | [SignupPage](../../apps/web/src/features/auth/SignupPage.tsx#L25) | RedirectIfAuthenticated | Personal accounts only: email code → name, mobile, state, password |
| `/reset-password` | [ResetPasswordPage](../../apps/web/src/features/auth/ResetPasswordPage.tsx#L22) | none | Token from the email link |
| `/guide` | [GuidePage](../../apps/web/src/features/guide/GuidePage.tsx#L18) | none | `GUIDE_SECTIONS` from shared, plus "email me the PDF" (`POST /guide/email`) |
| `/download` | [DownloadPage](../../apps/web/src/features/download/DownloadPage.tsx#L30) | none | Play Store first, then APK list (`GET /downloads`) |
| `/privacy` | [PrivacyPage](../../apps/web/src/features/legal/LegalPages.tsx#L79) | none | Anchors `#veetrax`, `#tracker` for store listings |
| `/delete-account` | [DeleteAccountPage](../../apps/web/src/features/legal/LegalPages.tsx#L320) | none | Static no-JS twin at [public/delete-account.html](../../apps/web/public/delete-account.html) |
| `/share/:token` | [PublicSharePage](../../apps/web/src/features/live-share/PublicSharePage.tsx#L49) | none | Live-location link. Polls every `LIVE_SHARE_POLL_SEC`. ETA to destination |

There is no separate public developer-docs route: the API reference is the *Docs* tab inside `/admin/developer-api` ([DocsTab.tsx](../../apps/web/src/features/developer/DocsTab.tsx)).

### 2.3 Secondary surfaces (dialogs, sheets, drawers)

| Surface | Opened from | File |
|---|---|---|
| Alert bell dropdown (latest 20, mute, voice, desktop notifications, critical pop-up toggle) and **critical/emergency modal** (siren repeats until acknowledged, mini-map) | TopBar | [AlertBell.tsx](../../apps/web/src/features/alerts/AlertBell.tsx#L267) |
| Ask VeeTrax (right sheet, Ctrl+K, voice input, result table → live map) | TopBar | [AskPanel.tsx](../../apps/web/src/features/ask/AskPanel.tsx) |
| Signed-in devices | User menu | [SessionsDialog.tsx](../../apps/web/src/features/shell/SessionsDialog.tsx#L39) |
| Licence banner / Licence-required dialog | Shell | [LicenceNotices.tsx](../../apps/web/src/features/billing/LicenceNotices.tsx) |
| Object drawer (tabs Overview · Device · Video · Commands · Documents, plus maintenance toggle, driver control, Share live link) | Live map | [ObjectDrawer.tsx](../../apps/web/src/features/live/ObjectDrawer.tsx#L217), [CommandsTab](../../apps/web/src/features/live/CommandsTab.tsx), [DriverControl](../../apps/web/src/features/live/DriverControl.tsx), [ShareLiveDialog](../../apps/web/src/features/live-share/ShareLiveDialog.tsx) |
| Alert detail sheet (mini-map, notification log, snapshot, actions) | Alerts page | [AlertDetailSheet.tsx](../../apps/web/src/features/alerts/AlertDetailSheet.tsx#L76) |
| Ack dialog (note for one, several or all) | Alerts page | [AlertsPage.tsx:68](../../apps/web/src/features/alerts/AlertsPage.tsx#L68) |
| Point remove/restore (SA) | History map | [PointRemoveDialog.tsx](../../apps/web/src/features/history/PointRemoveDialog.tsx) |
| Generic master: FormDialog, DetailSheet, HistorySheet (audit diff), Confirm delete | All master pages | [masters/](../../apps/web/src/features/masters) |
| Device: Raw packets sheet, Odometer dialog, Mobile tracker section, IO sensors section, Family dialog | Devices page | [RawPacketsSheet](../../apps/web/src/features/masters/RawPacketsSheet.tsx), [OdometerDialog](../../apps/web/src/features/masters/OdometerDialog.tsx), [MobileTrackerSection](../../apps/web/src/features/masters/MobileTrackerSection.tsx), [IoSensorsSection](../../apps/web/src/features/io-sensors/IoSensorsSection.tsx), [FamilyDialog](../../apps/web/src/features/family/FamilyDialog.tsx) |
| Fuel sensor settings, Compliance sheet | Objects page row menu | [FuelSettingsDialog](../../apps/web/src/features/fuel/FuelSettingsDialog.tsx), [CompliancePanel](../../apps/web/src/features/documents/CompliancePanel.tsx#L177) |
| Driver sessions sheet | Drivers page | [DriversPage.tsx:144](../../apps/web/src/features/masters/pages/DriversPage.tsx#L144) |
| Geofence editor (Shape / Details / Rules tabs, Visits), Import | Geofences | [GeofenceEditor](../../apps/web/src/features/geofences/GeofenceEditor.tsx#L103), [ImportDialog](../../apps/web/src/features/geofences/ImportDialog.tsx) |
| POI editor, POI/geofence import (KML/KMZ/GPX/GeoJSON/CSV), Export menu | POIs | [PoiEditor](../../apps/web/src/features/pois/PoiEditor.tsx), [PoiImportDialog](../../apps/web/src/features/pois/PoiImportDialog.tsx), [ExportMenu](../../apps/web/src/features/pois/ExportMenu.tsx) |
| Alert settings: Packs, Copy, Bulk enable, Send test | Alert settings | [panels.tsx](../../apps/web/src/features/alerting/panels.tsx) |
| Template editor (Dialog on desktop / Sheet on mobile), Test, Versions, Reset | Templates | [TemplateEditor](../../apps/web/src/features/templates/TemplateEditor.tsx#L115), [TemplatesPage](../../apps/web/src/features/templates/TemplatesPage.tsx) |
| Report runs sheet | Scheduled reports | [RunsSheet.tsx](../../apps/web/src/features/reports/RunsSheet.tsx) |
| Driver event detail (lightbox, review), Settings | Driver events | [DriverEventDetail](../../apps/web/src/features/driver-events/DriverEventDetail.tsx), [DriverEventSettingsDialog](../../apps/web/src/features/driver-events/DriverEventSettingsDialog.tsx) |
| Buy/renew (Razorpay, UPI QR), Customer dialog, Billing profile | Billing | [BuyDialog](../../apps/web/src/features/billing/BuyDialog.tsx#L90), [UpiPay](../../apps/web/src/features/billing/UpiPay.tsx), [BillingProfileForm](../../apps/web/src/features/billing/BillingProfileForm.tsx) |
| Admin pool dialog, Credit note | Licences admin | [AdminPoolsTab](../../apps/web/src/features/billing/admin/AdminPoolsTab.tsx), [CreditNoteDialog](../../apps/web/src/features/billing/admin/CreditNoteDialog.tsx) |
| Transfer, Purge (type-to-confirm), Share vehicle, Ship to customer, Shipments | Platform lists | [TransferDialog](../../apps/web/src/features/platform/TransferDialog.tsx), [PurgeDialog](../../apps/web/src/features/platform/PurgeDialog.tsx), [ShareVehicleDialog](../../apps/web/src/features/platform/ShareVehicleDialog.tsx), [Shipments](../../apps/web/src/features/platform/Shipments.tsx) |
| API key create (secret shown once), Webhook add/edit, Delivery log | Developer API | [CreateKeyDialog](../../apps/web/src/features/developer/CreateKeyDialog.tsx), [WebhookDialog](../../apps/web/src/features/developer/WebhookDialog.tsx), [DeliveryLog](../../apps/web/src/features/developer/DeliveryLog.tsx) |
| Relay target add/edit, secret dialog | Data forwarding | [RelayTargetDialog](../../apps/web/src/features/platform/relay/RelayTargetDialog.tsx) |
| Track a phone / Add tracker (personal, empty fleet) | Dashboard Overview | [GetStartedCard.tsx](../../apps/web/src/features/dashboard/GetStartedCard.tsx#L82) |

---

## 3. Design system

### 3.1 Colour tokens ([index.css](../../apps/web/src/index.css))

shadcn-style CSS variables are exposed to Tailwind through `@theme inline`. The default (`:root`) is **Teal & Saffron**. `[data-theme=plum|sky|light]` override the palette. The **Dark** theme is the `.dark` class.

| Token | Teal (default) | Plum | Sky | Light | Dark |
|---|---|---|---|---|---|
| `--background` | `#f5f8f7` | `#f8f5fa` | `#f3f7ff` | `#f7f7f8` | `#08121d` |
| `--foreground` | `#0f1d1b` | `#1e1225` | `#10183a` | `#17181c` | `#e3ebf2` |
| `--card` / `--popover` | `#ffffff` | `#ffffff` | `#ffffff` | `#ffffff` | `#0d1a28` / `#0f1e2e` |
| `--primary` | `#0e5e57` | `#5b1e78` | `#1f4fff` | `#0e5e57` | `#2bb3a3` (fg `#04201e`) |
| `--secondary` | `#eaf2f0` | `#f2ebf6` | `#e6eeff` | `#f0f1f3` | `#15263a` |
| `--muted` / `--muted-foreground` | `#eff4f3` / `#566966` | `#f3eef6` / `#6a5a73` | `#edf2fd` / `#55607f` | `#f2f3f5` / `#5e6370` | `#122133` / `#8b9fb3` |
| `--accent` | `#e3f1ee` | `#f1e4f7` | `#e3ecff` | `#eef0f2` | `#10303a` |
| `--border` / `--input` | `#dce6e3` / `#cbd9d5` | `#e7ddec` / `#d9cce0` | `#dce4f5` / `#ccd6ee` | `#e3e5e8` / `#d3d6db` | `#1c2e42` / `#25394f` |
| `--ring` | `#14897e` | `#a04fc4` | `#4f75ff` | `#14897e` | `#2dd4bf` |
| `--sidebar` (also header) | `#0b3b36` | `#3e1052` | `#eaf1ff` | `#ffffff` | `#06101a` |
| `--sidebar-foreground` / `-muted` | `#cfe3df` / `#8db3ad` | `#e6d5ee` / `#b293c2` | `#2a3560` / `#5f6a8f` | `#3d414b` / `#6e737f` | `#b4c4d3` / `#6c8296` |
| `--sidebar-accent` | `#14524b` | `#56236f` | `#d6e3ff` | `#f0f1f3` | `#11283c` |
| `--sidebar-primary` | `#ffb443` | `#ff9ecf` | `#1f4fff` | `#0e5e57` | `#ffb443` |
| `--brand` / `--brand-accent` | `#0e5e57` / `#ffb443` | `#5b1e78` / `#ff9ecf` | `#1f4fff` / `#ff6b4a` | `#0e5e57` / `#ffb443` | `#14897e` / `#ffb443` |
| `--navy` (avatar, tooltip bg) | `#0b3b36` | `#3e1052` | `#10183a` | `#26282e` | `#12466b` |
| `--overlay` | `rgb(8 20 32/.5)` | ← | ← | ← | `rgb(0 0 0/.6)` |

**Semantic tokens** (shared by all light themes; Dark overrides them):

| Token | Light | Dark | Soft bg / fg (light) | Soft bg / fg (dark) |
|---|---|---|---|---|
| destructive | `#dc2626` | `#ef4444` | `#fdecea` / `#a8261a` | 15 % / `#fca5a5` |
| success | `#15803d` | `#22c55e` | `#e3f4ea` / `#17683a` | 15 % / `#86efac` |
| warning | `#b45309` | `#f59e0b` | `#fdf3dc` / `#8a5300` | 15 % / `#fcd34d` |
| info | `#2563eb` | `#60a5fa` | `#e6ecf6` / `#2c4466` | 15 % / `#93c5fd` |
| neutral | — | — | `#eef1f4` / `#4a5763` | 15 % / `#cbd5e1` |
| map label / halo / marker stroke | `#0f1d2b` / `#fff` / `#fff` | `#e3ebf2` / `#08121d` / `#08121d` | | |

**Movement status colours** (single source: [`STATUS_META`](../../packages/shared/src/tracking.ts#L6), injected as `--status-*` by [status-tokens.ts](../../apps/web/src/lib/status-tokens.ts)):

| Status | Label | Light | Dark | Used for |
|---|---|---|---|---|
| RUNNING | Running ("moving") | `#16a34a` | `#22c55e` | markers, StatusDot/Badge, donuts, status cards |
| IDLE | Idle | `#d97706` | `#fbbf24` | |
| OFF | Off ("stopped") | `#dc2626` | `#f87171` | |
| OVERSPEED | Overspeeding | `#9333ea` | `#c084fc` | |
| OFFLINE | Offline | `#6b7280` | `#9ca3af` | |
| NO_DATA | No data | `#94a3b8` | `#64748b` | |

People use activity labels (Still / Walking / Running / In vehicle) mapped onto these colours (`ACTIVITY_META`).

**Alert severities** ([severity.ts](../../apps/web/src/features/alerts/severity.ts)): INFO `#2563eb` (badge `secondary` = grey), WARNING `#d97706` (badge `warning`), CRITICAL `#dc2626` (badge `destructive`). These are fixed colours, not tokens, and the same values are copied as Tailwind arbitrary classes in [AlertTypeCard.tsx:44](../../apps/web/src/features/alerting/AlertTypeCard.tsx#L44). Alert status badges: NEW `default`, ACKNOWLEDGED `muted`, RESOLVED `success`. About 57 alert types each have a lucide glyph ([alert-icons.tsx](../../apps/web/src/features/alerts/alert-icons.tsx)).

**Other colour scales:** history speed bands (<20/40/60/80/≥80 km/h, per theme) in [history-map.ts:13](../../apps/web/src/features/history/history-map.ts#L13); geofence fallback palette in [OverviewTab.tsx:111](../../apps/web/src/features/dashboard/OverviewTab.tsx#L111); medal colours (`amber-500`, `slate-400`, `orange-600`) in [DriverScoresPage.tsx:29](../../apps/web/src/features/driver-scores/DriverScoresPage.tsx#L29).

### 3.2 Typography

| Item | Value | Source |
|---|---|---|
| UI font stack | `'Inter', 'Inter Variable', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto` with `font-feature-settings: 'cv11','ss01'` | [index.css:207](../../apps/web/src/index.css#L207) |
| **Font loading** | **None.** No `@font-face`, Google Fonts link or `@fontsource` package exists, so Inter appears only if it is installed locally. Most users get Segoe UI (Windows), SF (Apple) or Roboto (Android) | finding F-07 |
| Brand font | **Manrope 700/800** ([brand/fonts](../../brand/fonts), SIL OFL). Used only when rendering PNG brand assets ([generate.mjs](../../scripts/brand/generate.mjs)). In the app the wordmark is just `font-extrabold` in the UI font ([logo.tsx:24](../../apps/web/src/components/logo.tsx#L24)) | |
| Mono | `ui-monospace, SFMono-Regular, Menlo` | IMEIs, codes, raw hex |
| Map labels | `Noto Sans Bold/Regular` (OpenFreeMap glyphs; override with `VITE_MAP_FONT`) | [map-style.ts:9](../../apps/web/src/features/live/map/map-style.ts#L9) |
| Scale in use | Page H1 `text-xl` → `sm:text-[26px]/8 font-bold`. Auth H1 `text-2xl semibold`. Dialog title `text-lg`. Card title `text-base`. Body `text-sm` (14 px). Table header `text-xs uppercase tracking-wide`. Sidebar group `text-[11px] bold uppercase`. Footer `text-[11px]`. 58 uses of `text-[10px]`/`text-[11px]` | |
| User scaling | Display toggle: 100 / 112.5 / 125 % text | [display-store.ts](../../apps/web/src/features/display/display-store.ts) |

### 3.3 Spacing, radius, shadow, borders

| Aspect | Convention |
|---|---|
| Page padding | `p-4 sm:p-6`, sections `space-y-5` / `gap-4` |
| Radius | `--radius: 0.5rem` → sm 4 px, md 6 px, lg 8 px, xl 12 px. Buttons/inputs `rounded-lg`, dialogs `rounded-xl`, badges `rounded-md`, logo tile rx 15/64 |
| Shadows | Cards and inputs `shadow-xs`. Floating map panels `shadow-md`. Dialogs/sheets `shadow-2xl`. Map popups `0 8px 24px rgb(0 0 0/.18)` |
| Borders | Global `* { border-color: var(--border) }`. 1 px everywhere |
| Focus | Global `:focus-visible { outline: none }` replaced per component by `ring-[3px] ring-ring/40` (buttons, inputs, tabs) or `ring-2` (nav) |
| Control heights | 36 px (`h-9`) default, 32 px `sm` / `icon-sm`, 40 px `lg` |

### 3.4 Components ([components/ui](../../apps/web/src/components/ui))

| Component | Variants / notes |
|---|---|
| [Button](../../apps/web/src/components/ui/button.tsx) | `default` (primary), `destructive`, `outline` (card bg), `secondary`, `ghost`, `link` × sizes `default h-9`, `sm h-8`, `lg h-10`, `icon 36`, `icon-sm 32`. Default `type="button"` |
| [Badge](../../apps/web/src/components/ui/badge.tsx) | `default` (primary/12), `secondary`, `outline`, `success`, `warning`, `destructive` (12 % tints), `muted`. Doesn't use the `*-soft/*-fg` tokens |
| [StatusBadge / StatusDot](../../apps/web/src/components/status-badge.tsx) | Status colour at 14 % as background and the raw status colour as text. Optional ping pulse (hidden with reduced motion) |
| [Card](../../apps/web/src/components/ui/card.tsx) | `rounded-lg border bg-card shadow-xs`, Header/Title/Description/Content/Footer (Footer unused) |
| [Input / Textarea](../../apps/web/src/components/ui/input.tsx) | h-9, `aria-invalid` gives a destructive border |
| [Field](../../apps/web/src/components/ui/field.tsx) | Label + required `*` + hint or `role=alert` error |
| [Select](../../apps/web/src/components/ui/select.tsx), [MultiSelect](../../apps/web/src/components/ui/multi-select.tsx) | Radix select. MultiSelect is a custom popover with search and chips |
| [Dialog](../../apps/web/src/components/ui/dialog.tsx) | Centred, `max-w-lg` default, `max-h-[100dvh-2rem]`, overlay `bg-overlay` with 2 px blur, zoom-in animation, Body scrolls, footer stacks on mobile |
| [Sheet](../../apps/web/src/components/ui/sheet.tsx) | Right (full width → `sm:max-w-md`) or left (w-72), slide animation |
| [Tabs](../../apps/web/src/components/ui/tabs.tsx) | Segmented pill (`bg-muted`, active `bg-card shadow-sm`) |
| [Table](../../apps/web/src/components/ui/table.tsx) | Header `bg-muted/50` uppercase xs, rows hover `muted/40`, selected `accent/60`, `whitespace-nowrap` cells, horizontal scroll container |
| [Tooltip](../../apps/web/src/components/ui/tooltip.tsx) | `bg-navy` xs |
| [DropdownMenu](../../apps/web/src/components/ui/dropdown-menu.tsx), [Popover](../../apps/web/src/components/ui/popover.tsx), [Switch](../../apps/web/src/components/ui/switch.tsx), [Checkbox](../../apps/web/src/components/ui/checkbox.tsx), [Label](../../apps/web/src/components/ui/label.tsx) | Standard shadcn |
| [EmptyState](../../apps/web/src/components/ui/empty-state.tsx) | 48 px round accent tile + lucide icon, title, description, optional action. Used on about 35 screens |
| [Skeleton](../../apps/web/src/components/ui/skeleton.tsx) / [Spinner](../../apps/web/src/components/ui/spinner.tsx) | `animate-pulse bg-muted` / `Loader2` spin |
| [ConfirmDialog](../../apps/web/src/components/confirm-dialog.tsx) | Cancel + confirm (destructive option), can't be closed while pending |
| [FormError](../../apps/web/src/components/form-error.tsx) | Destructive 8 % box with icon |
| [PageHeader](../../apps/web/src/components/page-header.tsx) | Breadcrumb, H1, description, actions on the right (stacks on mobile) |
| [MapTools](../../apps/web/src/components/map-tools.tsx) | Save PNG (with a caption band), full screen, marker labels toggle. Styled like the MapLibre control group |
| [PageCapture](../../apps/web/src/components/page-capture.tsx) | Dashboard → PNG/PDF (html-to-image + jsPDF, lazy) |
| [FullScreenLoader](../../apps/web/src/components/full-screen-loader.tsx) | Pulsing logo mark |

**Toasts:** sonner top-right, `richColors`, close button, follows the theme ([App.tsx](../../apps/web/src/app/App.tsx)). Bursts of alerts collapse into one summary toast ([AlertBell.tsx:53](../../apps/web/src/features/alerts/AlertBell.tsx#L53)).

**Animations** ([index.css:266](../../apps/web/src/index.css#L266)): `fade-in` 150 ms, `fade-out` 120, `zoom-in` 160 (spring), `slide-in-left/right` 220, `pop-in` 140. Theme colour transition 200 ms. Sign-in `TrackingScene` SVG (trace 9 s, ping 2 s, spin 24 s). Dashboard `CountUp` counters. Live markers glide over 1 s at 30 fps with status halos pulsing at 20 fps. Walking/running person poses. A global `prefers-reduced-motion` reset plus `useReducedMotion()` for map camera and counters.

**Loading:** route-level Suspense skeleton (h-8/h-4/h-96 blocks) in [router.tsx:66](../../apps/web/src/app/router.tsx#L66), table skeleton rows, map "Loading history…" pill, inline Spinner on buttons.

**Errors:** route `errorElement` on AppShell only ([ErrorPages.tsx](../../apps/web/src/features/errors/ErrorPages.tsx): 403 / 404 / "Something went wrong" / "VeeTrax was updated → Reload"). WebGL-unavailable fallback text on the live and history maps. Query errors are shown inline in an Overlay or as `toast.error(errorMessage(err))`.

### 3.5 Iconography

* **lucide-react** throughout. Each menu has an icon ([nav.ts](../../apps/web/src/features/shell/nav.ts)). Note `ShieldCheckIcon` is used for both *Roles & Permissions* and *Licences & Invoices*.
* **Custom SVG:** brand mark (pin + dotted trip route), drawn inline from shared geometry ([logo.tsx](../../apps/web/src/components/logo.tsx), [brand.ts](../../packages/shared/src/brand.ts)). It follows `--brand` and `--brand-accent`.
* **Canvas-drawn map markers:** top-down vehicle silhouettes for CAR, BIKE, TRUCK, BUS, SCHOOL_BUS, VAN, AUTO and OTHER (these rotate with heading); round badges for PERSON/RUNNER (animated stick figure), ASSET and PET with a separate SDF heading arrow ([vehicle-icons.ts](../../apps/web/src/features/live/map/vehicle-icons.ts)).

---

## 4. Screen-by-screen inventory

Common to every in-app screen: TopBar + Sidebar shell, `PageHeader` with breadcrumb, `p-4 sm:p-6`. **Master** screens share [MasterPage](../../apps/web/src/features/masters/MasterPage.tsx#L145):
- **Layout:** card with a toolbar (search with clear, Active/Inactive/All segmented control, Filters popover with a count badge, record count, column chooser saved in `vt.columns.<menu>`), active-filter chips, bulk bar (activate/deactivate/delete), TanStack table (sortable headers, row checkboxes, row "⋯" menu: View / Edit / History / Delete / extras) and a pager (10/25/50/100).
- **Header actions:** Export CSV (label hidden under `sm`) and Add.
- **Mobile:** same table, scrolled horizontally. There is no card/list view.

### 4.1 Tracking (live, history, alerts)

| Screen | Purpose | Layout | Major components | Actions | Navigation | Data (API) | Responsive | Visual inconsistencies | Improvement ideas |
|---|---|---|---|---|---|---|---|---|---|
| **Dashboard → Overview** | Fleet status now + today's activity | KPI tiles `grid-cols-2 xl:4`, status bar, KPIs `2/lg:3/xl:6`, 3 donuts `lg:3`, top-lists, IO cards | `OverviewTab`, `Donut`, `CountUp`, `IoCards`, `GetStartedCard` (personal & empty), `PageCapture` | Download PNG/PDF, Open live map, click donut slice → `/live?status=` | Tabs in `?tab` | `GET /dashboard/overview`, `/documents/summary`; refetch ≤10 s on `live:batch` | 2→6 columns | Hex fallback palette for geofence donut; `toLocaleString(undefined)` numbers ignore app locale | Add a time-of-last-refresh stamp; let donut legends be keyboard-focusable |
| **Dashboard → Criticality** | Vehicles needing attention (inactive, no GPS, wrong TZ, never connected) | Filter chips + table card | `CriticalityTab`, remarks | Add remark, open vehicle | → `/live?objectId` | `GET /dashboard/health`, `/dashboard/remarks`, `POST /dashboard/remarks` | `lg:` 2 columns | — | Bulk "mark in maintenance" |
| **Dashboard → Device health** | Inactivity, movement, battery | Two cards `lg:2` + table | `DeviceHealthTab` | Filter buckets | | `/dashboard/health` | | | |
| **Dashboard → Compare** | Compare vehicles over any range | Period picker card, KPI grid, 3 chart cards, ranking table | `CompareTab`, `ScopePicker` | Compare | | `POST /dashboard/compare` | `grid-cols-2 sm:flex` controls | EmptyState until run | Remember the last compare scope |
| **Live map** `/live` | Real-time positions | Full-bleed MapLibre. Floating **LivePanel** (left, 22 rem, md+), **ObjectDrawer** (right, 22 rem; bottom sheet 60 % on phones), **NeedsAttention** card (bottom-right, md+), map tools column top-right | `LivePanel` (status cards, search name/plate/IMEI, branch/group/type filters, selection, virtualised list with optional "Today's figures"), `ObjectDrawer` (Overview/Device/Video/Commands/Documents), `LiveMapOverlays` (Layers popover: geofences, POIs, alert markers; basemap picker Standard/Light/Satellite), `MapTools` | Select/follow/zoom, send command (needs `command`), assign driver, maintenance toggle, share live link, save PNG, full screen, label toggle | Deep links `?status ?objectId ?focus ?geofence ?poi` | Snapshot via `liveStore.loadSnapshot()`, socket `live:batch`, `/branches`, `/vehicle-groups`, `/live/day-stats`, `/alerts`, per-object `/devices/:id`, `/objects/:id/commands*`, `POST /objects/:id/maintenance`, `POST /drivers/assign` | `<md`: map/list toggle pill at the top centre; panel `inset-x-2 top-14`; NeedsAttention hidden | Map tool stack hidden while the list is open on phones | Phone: bottom-sheet list with snap points instead of a full-screen toggle; show a small "last update" age on the drawer header |
| **History & Playback** `/history` | Replay route, trips, stops, alerts; compare vehicles | Toolbar (vehicle combobox, compare picker, presets Today/Yesterday/… + custom range ≤ `MAX_RANGE_DAYS`) → truncation warning → map + right side panel (22 rem, desktop ≥1024 via `useMediaQuery`) or a bottom expandable panel (phones) → PlaybackBar with timeline (speed/fuel canvas) | `HistoryToolbar`, `HistorySidePanel` (Trips/Stops/Alerts/Summary tabs, CSV export), `LiveDataPanel` (time, speed, address follows), `Legend` (status / speed colour modes, All-points, compare colours), `PlaybackBar` (play/pause, 1×–16×, follow, skip stops), `Timeline`, `PointRemoveDialog` (SA) | Play, scrub, jump to trip/stop/alert, export CSV, save PNG, full screen, keyboard shortcuts | | `GET /objects/:id/history`, `/objects/:id/points`, `/point-quality/settings`, `POST /routing/estimate-gaps`, `/geocode/reverse`, CSV `/objects/:id/{trips,stops,…}` | Desktop/phone split at 1024 px; min-height 600–820 px | `MapTools` placed with magic offsets `top-[112px] right-[10px]` ([HistoryPage.tsx:656](../../apps/web/src/features/history/HistoryPage.tsx#L656)); caption dates use the browser locale | Show the keyboard shortcuts in a "?" popover; save the last vehicle and range in the URL |
| **Alerts** `/alerts` | Alert log with acknowledgement | Header + card: type tabs (most-searched types), filter row (DateRangePicker, severity, status, read/unread, vehicle), table (unread rows tinted `warning/5`), pager | `AlertsPage`, `AckDialog`, `AlertDetailSheet` (MiniMap, data, notification log, snapshot) | Ack one/selected/all with a note, export CSV, open detail, View on map / Video | → `/live?focus`, `/video?…&at` | `GET /alerts`, `/alerts/:id`, `/alerts/:id/notifications`, `/geofences/:id` | `xl:` columns hide/show; filters wrap | Rows clickable by mouse only (no keyboard) | Keyboard row activation; "acknowledge & next" in the sheet |
| **Alert bell** (TopBar) | Unread count, latest 20, sound/voice/desktop/critical pop-up toggles | Popover `min(24rem, 100vw-1rem)` | `AlertBell`, `alert-center`, `sound.ts` (WebAudio beeps/siren), `voice.ts` (speechSynthesis en-IN/hi-IN/ta-IN), `desktop-notify.ts` | Mark all read, ack, mute, open alert | → live map | `/alerts`, socket `alert` | | Critical pop-up toggle's `aria-pressed` is inverted ([AlertBell.tsx:366](../../apps/web/src/features/alerts/AlertBell.tsx#L366)) | — |
| **Critical / emergency modal** | SOS, crash, power cut, tamper, SIM change, towing | Blocking dialog with MiniMap | in `AlertBell` | Ack all, View on map, Dismiss | | | | | |
| **Parking mode** `/parking-mode` | Weekly armed windows per vehicle (spy mode) | Header, warning card "Armed now: n", table of vehicles with select-all | `ParkingModePage`, `ScheduleDialog`, `WindowEditor` (day chips, presets Every day / Mon–Fri / Weekend, overnight) | Set schedule for selected, switch off, "alarm for every alert" | | `GET/PUT /parking-mode` | `md:` columns | — | Show the next armed window on the live map marker |
| **Video** `/video` | Dashcam live + recordings | Vehicle combobox, then `VideoPanel` (Live / Recordings tabs, multi-channel grid) | `VideoPanel`, `VideoPlayer` (mpegts.js HTTP-FLV, lazy) | Start/stop live, play recordings ±2 min around an alert | `?objectId&channel&at` (also opened by the mobile app) | `/video/:id/channels`, `/recordings`, `POST /live`, `/playback`, `DELETE /video/sessions/:id` | `sm:` grid | `text-amber-400` raw colour in the player error | Show a channel-health indicator |

### 4.2 Drivers & staff

| Screen | Purpose | Layout | Major components | Actions | Data (API) | Responsive | Inconsistencies | Ideas |
|---|---|---|---|---|---|---|---|---|
| **DMS dashboard** `/dms` | Driver-monitoring and harsh-driving events per vehicle | Period filter, KPI tiles, "By event type" chart, stacked per-day columns, per-vehicle table (click → filter) | `DmsPage` (SVG charts) | Pick period/vehicle, export | `GET /dms` | `lg:` 2–3 columns | Clickable `TableRow` without keyboard ([DmsPage.tsx:136](../../apps/web/src/features/dms/DmsPage.tsx#L136)) | |
| **Driver events** `/driver-events` | Snapshot gallery of DMS/ADAS events with review | Tabs Events / Drivers. Filter bar (type, level, snapshot yes/no, review state). Card grid `sm → 2xl` | `EventCard`, `EventThumbnail`, `DriverEventDetail` (lightbox, map, prev/next, review note), `DriverEventSettingsDialog` | Review, export, settings (channels, photos per event, retention, quota) | `GET /driver-events`, `/driver-events/stats`, `/driver-events/settings` | Up to 2xl columns | — | Bulk review |
| **Driver scorecard** `/driver-scores` | Safety score leaderboard | Score-by toggle (Drivers/Vehicles), period presets, fleet average / best / needs-attention tiles, table | `DriverScoresPage` | Change scope/period | `GET /driver-scores` | `md:` 3 tiles | Medal colours are raw Tailwind palette, not tokens | Explain the score breakdown in a popover |
| **Staff attendance** `/attendance` (63 KB file) | Today's board, timesheet, employee insights, settings | Tabs Today / Timesheet / Employee / Settings. "Right now" tiles filter the list; day dialog with selfie/video, crossings, outings approval, correction | `AttendancePage` monolith | Approve outing, correct day, export Excel/PDF, schedule e-mail, settings | `GET /attendance`, `/attendance/timesheet`, `/attendance/settings`, `PUT …/correction`, `…/outing`, `…/settings` | `md/lg/xl` grids | Clickable rows without keyboard ([AttendancePage.tsx:435](../../apps/web/src/features/attendance/AttendancePage.tsx#L435)) | Split the file. Calendar view on the Employee tab exists, so add a legend |

### 4.3 Costs & reports

| Screen | Purpose | Layout | Major components | Actions | Data (API) | Responsive | Inconsistencies | Ideas |
|---|---|---|---|---|---|---|---|---|
| **Fuel & expenses** `/expenses` | Expense entries with bill photos, km/L, cost/km | Period select (This/Last month, Last 3 months), totals, per-vehicle table, entries list | `ExpensesPage`, add dialog with **"Read bill" OCR** (tesseract.js, lazy) | Add/delete expense, upload photo | `GET /expenses`, `/expenses/summary`, `POST /expenses`, upload `/expenses/:id/photo` | `md:` grids | — | Show OCR confidence; the tesseract download size (~MBs of WASM + language data) needs a progress indicator |
| **Reports** `/reports` | Run 31 report types (summary, trips, stops, idle, overspeed, geofence, fuel, AC/door, attendance…) | Card: type select, ScopePicker (branches/groups/vehicles, shared vehicles), date presets, period (Daily/Weekly/Monthly for period types), options, Run. Result: SummaryCharts + sortable `ReportTable` (sticky header, totals row), download buttons | `ReportsPage`, `ScopePicker`, `ReportOptionsFields`, `ReportTable`, `report-columns.tsx` (43 KB) | Run, download XLSX/PDF/CSV, open trip in History (new tab) | `POST /reports/run`, `/vehicle-shares/mine`, download endpoints | 17 `sm:` breakpoints; table scrolls | Number formats use the browser locale ([report-columns.tsx:91](../../apps/web/src/features/reports/report-columns.tsx#L91)) | Save report "favourites"; show row count and time taken |
| **Scheduled reports** `/reports/schedules` | Recurring e-mailed reports | MasterPage + FormDialog (type, scope, frequency Daily/Weekly/Monthly, format XLSX/PDF/CSV, RecipientChips) | `RunsSheet` | Run now, view runs | `/report-schedules` CRUD, `POST /:id/run-now`, `GET /report-runs` | Master | — | — |

### 4.4 Masters (all MasterPage unless noted)

| Screen | Columns / filters | Form (FormDialog) | Extra actions | API | Notes |
|---|---|---|---|---|---|
| **Vehicles & Objects** `/masters/objects` | Name, Plate, Type, Branch, Device, Groups, (Model, Make, Colour, Overspeed limit, Created hidden). Filters: branches, groups, object types, vehicle types | Wide: type, vehicle type, device picker, branch, groups, limits, fuel button | Compliance sheet, Fuel sensor settings | `/objects` | +Company column in All-companies view |
| **Devices** `/masters/devices` | IMEI, model, protocol, assignment… Filters: models, assignment | `DeviceForm` with Mobile tracker section, IO sensors section, Odometer | Raw packets sheet, Family dialog (personal), Odometer | `/devices`, `/devices/:id/raw`, `/odometer`, `/mobile-tracker` | |
| **Drivers** `/masters/drivers` | Name, Employee ID, Mobile, Licence (expiry chip), RFID/iButton (mono), Branch, Driving now. Filters: branches, driving now | Wide | Driver sessions sheet, Compliance | `/drivers`, `/drivers/assignments` | Hidden for personal accounts |
| **Vehicle groups** | Name, Description, Objects (3 names), Count | Name, description, MultiSelect objects | — | `/vehicle-groups` | |
| **Branches** | Name, Code, Address, Objects, Status | Name, code, address | — | `/branches` | |
| **Documents & Service** `/masters/documents` | Custom page using MasterPage per tab: *Documents* view and *Service reminders* table (TabSwitch in the header) | Document form with file upload; service form; MarkDoneDialog | Mark done, delete | `/documents`, `/service-reminders`, `/lookups` | Status chip Valid / Expiring in N days / Expired |
| **Geofences** `/masters/geofences` | MasterPage + Import button | **GeofenceEditor** (large dialog): tabs *Shape* (map with circle/polygon/rectangle tools, PlaceSearch, "place at vehicle") · *Details* · *Rules* (time windows, branch/group/vehicle scope) · *Visits* | Import GeoJSON/CSV, export KML/GeoJSON | `/geofences`, `/geofences/import`, `/geofences/:id/visits`, `/geocode/search` | 12 `sm` + 7 `md` breakpoints in the editor |
| **Points of interest** `/masters/pois` | MasterPage + Import | `PoiEditor` (details + click-to-place map with radius) | Import preview/commit (KML/KMZ/GPX/GeoJSON/CSV), Export | `/pois`, `/pois/import/preview`, `/commit` | |
| **Lookups** | Type badge, Code (mono), Label, Order, Source (System/Company), Status. Filter: types | type, code (upper-cased), label, order | — | `/lookups` | 6 lookup types |

Inconsistencies: Documents adds a page-level tab switch inside the header, unlike other masters. Geofences and POIs use large map dialogs while other masters use forms. Ideas: a mobile card list for masters; an import entry point for vehicles and drivers (CSV) to match geofences/POIs.

### 4.5 Alert management

| Screen | Purpose | Layout | Major components | Actions | Data (API) | Responsive | Ideas |
|---|---|---|---|---|---|---|---|
| **Alert settings** `/alerting/settings` | Inherited alert rules by level (Company → Branch / Group / Vehicle) | Left `LevelTree` (server search) on `lg+`, Sheet on smaller screens. Right: tabs *Alert types* (per-type `AlertTypeCard`: enabled, severity, params, require-ack, channels, SourceBadge "Inherited from…" + Reset) · *Default recipients* (`RecipientsEditor` per channel EMAIL/SMS/WhatsApp/PUSH) · *Effective* · *Snoozes* · *History* | `LevelTree`, `AlertTypeCard`, `RecipientsEditor`, `panels.tsx` | Apply pack, copy settings, bulk enable, send test, snooze | `/alert-settings*`, `/alert-packs`, `/alert-snoozes`, `/recipient-lists/*`, `/roles`, `/users` | Tree → sheet below `lg` | Search/filter alert types by name; collapse all cards |
| **Message templates** `/alerting/templates` | Email/SMS/WhatsApp/push templates per alert | MasterPage. Editor in a Dialog (desktop) or Sheet (mobile) with placeholders, sandboxed email preview (`iframe sandbox=""`), SMS GSM/segment counter | `TemplateEditor`, `TestDialog`, `VersionsSheet` | Edit, duplicate, reset to default, test send, restore a version | `/templates*` | Dialog/Sheet switch | Side-by-side preview on wide screens |

### 4.6 Administration

| Screen | Purpose | Layout / components | Actions | API | Notes / issues |
|---|---|---|---|---|---|
| **Users** `/admin/users` | Company users | MasterPage. Roles/branches/objects shown as NameList | CRUD, bulk | `/users`, `/roles` | |
| **Roles & Permissions** `/admin/roles` | Roles + data scope | MasterPage + FormDialog with `PermissionMatrix` (menus × actions; SA menus excluded) | CRUD | `/roles` | The matrix is wide, so check how it scrolls on phones |
| **Company settings** `/admin/settings` | Profile, account type, status thresholds, timezone | Two cards (`xl:` grid) | Save, reset thresholds | `GET/PATCH /settings` | |
| **Billing & Licences** `/admin/billing` | Licence pool, seats, renewals, invoices, billing profile; partner (reseller) view | Tabs *Company* / *Partner*. Inside `PoolView`: *Seats* / *Invoices* / *Billing*. `CustomersPanel` for partners | Buy/renew (Razorpay checkout, UPI QR claim), record offline payment, customer dialog | `/licences/overview`, `/licences/partner/overview`, `…/quote`, `…/checkout`, `…/verify`, `/licences/upi*` | GST breakdown (CGST/SGST/UTGST/IGST) |
| **Developer API** `/admin/developer-api` | API keys, webhooks, docs | `ApiPlanCard`, then tabs *Keys* / *Webhooks* / *Docs* (`?tab`) | Create/revoke key, add/edit/test/rotate webhook secret, redeliver | `/developer/*` | The Docs tab is English-only by design |
| **Audit log** `/admin/audit-log` | Who changed what | MasterPage, row detail uses `ChangesView` diff | Export | `/audit-log` (via MasterPage) | |

### 4.7 Platform (Super Admin)

| Screen | Purpose | Layout / components | Actions | API |
|---|---|---|---|---|
| **Companies** | Tenants | MasterPage + create form with first admin | CRUD, suspend, purge | `/admin/companies`, `/admin/purge/*` |
| **Licences & Invoices** | All pools, partners, invoices, UPI claims | Tabs *Pools* / *Partners* / *Invoices* (+credit notes) / *UPI* | Grant, partner assignment, credit note, confirm/reject UPI | `/licences/admin/*` |
| **Device models** | Model catalogue | MasterPage | CRUD | `/device-models` |
| **Device inventory** | Platform stock | MasterPage (INVENTORY_ENDPOINT) | Ship to customer (help sheet print), Shipments sheet, read info, transfer, share vehicle, purge | `/admin/devices`, `/admin/shipments`, `/admin/transfer/*`, `/admin/vehicle-shares` |
| **Unknown devices** | Devices connecting without registration | MasterPage (read-only) | Claim/register | `/admin/unknown-devices` |
| **Data forwarding** | Relay copies of device data | Master on/off card, target cards (not a table), EmptyState | Add/edit/test/pause targets, show secret | `/admin/relay-targets*` |
| **Platform settings** | Pricing and invoicing supplier details | Tabs *Pricing* / *Invoicing* (logo + UPI QR upload) | Save | `/licences/settings/*` |
| **System health** (34 KB file) | Live ops view | Issues list, Ports table, Queue cards, two `LineChart`s (throughput, queue lag), processes, DB, Valkey, host cards, Point-quality settings, Features | Test alert, edit settings | `/admin/system-health*`, `/point-quality/settings`, socket `system:health` (+ banner and toasts) |

### 4.8 Public and auth screens

| Screen | Layout | Notes / issues |
|---|---|---|
| **Login / Forgot / Signup / Reset** ([AuthLayout](../../apps/web/src/features/auth/AuthLayout.tsx)) | `lg+`: split 5:6. Left is a sidebar-coloured hero (blurred glows, animated `TrackingScene`, headline "Every vehicle, every second, one screen.", 3 highlights). Right is a centred `max-w-sm` form with a language toggle top-right and footer links. `<lg`: logo + compact scene above the form | Login tabs: Password / OTP. There's no theme toggle on the public pages, so they use the stored theme. Dev OTP code can be returned (`devCode`) |
| **Guide** | Long article, TOC of `GUIDE_SECTIONS`, email-PDF form | `GUIDE_TITLE` isn't wrapped in `t()` |
| **Download** | Play Store CTA + APK list | |
| **Privacy / Delete account** | Article layout, H2 sections in primary colour | Body prose is mostly English. Some headings are untranslated (see §7) |
| **Public live share** `/share/:token` | Full-screen map + details card (status, speed, ignition, battery, satellites, ETA "Arriving in ~n min · km", "Shared by") | Always uses `OPENFREEMAP.standard`. Ignores the `VITE_MAP_STYLE_*` overrides, dark theme and satellite ([PublicSharePage.tsx:94](../../apps/web/src/features/live-share/PublicSharePage.tsx#L94)). DOM marker with heading arrow (different look from the in-app canvas icons) |
| **Claim tracker** `/claim` (in shell) | Card: IMEI + claim code (QR fills both) → model → name → type | Not in MENUS, so the TopBar shows no breadcrumb/menu label |
| **403 / 404 / Error** | Centred icon tile, code, title, text, "Go to home" | No error boundary on public routes |

**Screen count:** 9 public + 38 menu pages + `/claim` + 3 error states = **51 routed screens**. On top of that, Dashboard has 4 tabs and there are about 45 significant dialogs/sheets (§2.3).

---

## 5. Map UI

| Topic | Implementation |
|---|---|
| Engine | MapLibre GL 5, one imperative controller per map ([map-controller.ts](../../apps/web/src/features/live/map/map-controller.ts), [history-map.ts](../../apps/web/src/features/history/history-map.ts), [geofence-draw.ts](../../apps/web/src/features/geofences/draw/geofence-draw.ts)) |
| Tiles / styles | **OpenFreeMap** public styles: `liberty` (Standard), `positron` (Light), `dark` (any map while the theme is Dark), and glyphs ([basemap.ts](../../packages/shared/src/basemap.ts)). Can be overridden with `VITE_MAP_STYLE_STANDARD/LIGHT/DARK`. **Satellite** = server-configured raster imagery + OSM road lines/names ("hybrid"), offered only when `GET /maps/config` returns imagery. Choice saved in `vt.basemap`. The design doc §5.25 plans self-hosted Planetiler + Martin tiles, which aren't in the web code |
| Theming | MapLibre controls and attribution re-skinned with tokens. Icons inverted in dark ([index.css:361](../../apps/web/src/index.css#L361)). Popups `.vt-popup` ([popup.css](../../apps/web/src/features/live/map/layers/popup.css)) |
| Markers | Canvas images `veh:<KIND>:<STATUS>:<theme>` (64 px @2x = 32 CSS px × display scale). Vehicle icons rotate with `icon-rotate: bearing` (map-aligned). Round badges get an SDF arrow offset 15 px. Status halos pulse. Duration badges ("idle 12 m") refresh every 60 s. Labels (plate/name) from zoom 13, can be toggled |
| Motion | 1 s glide interpolation (position + bearing), capped at 30 fps and 1,000 animated objects. Halo pulse ≤ 20 fps and ≤ 1,500 objects. Respects reduced motion |
| Clustering | Turns on automatically when more than **500** features (`CLUSTER_THRESHOLD`), radius 50, max zoom 14. Cluster circles in `--primary` with count. Click expands |
| Layers (live) | Geofences (zones + labels), POIs (pins with names when zoomed in), alert markers (last 24 h), all toggled in the "Layers" popover ([LiveMapOverlays.tsx](../../apps/web/src/features/live/map/layers/LiveMapOverlays.tsx)) |
| Popups | Geofence/alert/POI popups themed. Vehicle click opens the ObjectDrawer instead of a popup |
| Playback | `PLAYBACK_RATES` 1/2/4/8/16×. Track coloured by status or speed band. Progressive path drawn behind the moving marker (≈15 fps diffs). Stops/alerts markers. Estimated road gaps drawn dashed. "All points" quality view. Follow camera. Skip stops. Speed/fuel timeline canvas ([PlaybackBar](../../apps/web/src/features/history/PlaybackBar.tsx), [Timeline](../../apps/web/src/features/history/Timeline.tsx), [playback-core.ts](../../apps/web/src/features/history/playback-core.ts)) |
| Geofence drawing | Circle (drag radius; a click gives 200 m), polygon (click points; finish by double-click, Enter or clicking the first point; Backspace/Esc; drag vertices/midpoints; right-click deletes), rectangle (drag corners). Drag the inside to move. Other geofences drawn faintly. Place search and "centre at vehicle" ([geofence-draw.ts:58](../../apps/web/src/features/geofences/draw/geofence-draw.ts#L58)) |
| Mini maps | Alert detail and critical modal ([MiniMap.tsx](../../apps/web/src/features/alerts/MiniMap.tsx)), POI editor ([PoiMap.tsx](../../apps/web/src/features/pois/PoiMap.tsx)) |
| Snapshots | `MapTools` save PNG with a caption band (company, vehicle, period, totals) via [picture-header.ts](../../apps/web/src/lib/picture-header.ts) |
| Default centre | Chennai `[80.24, 13.07]` live; India `[78.9, 20.6]` z4 public share |

---

## 6. Visual asset inventory

| Asset | Type | Path | Used by |
|---|---|---|---|
| Brand mark (inline) | SVG (React), themed | [components/logo.tsx](../../apps/web/src/components/logo.tsx) + [shared/brand.ts](../../packages/shared/src/brand.ts) | TopBar, Sidebar drawer, Auth, FullScreenLoader, share page |
| Dynamic favicon | SVG data URL per theme | [theme-store.ts:26](../../apps/web/src/features/theme/theme-store.ts#L26) | Browser tab (replaces the static one at runtime) |
| favicon.svg / favicon-32.png | SVG 693 B / PNG 817 B | [apps/web/public](../../apps/web/public) | index.html |
| apple-touch-icon.png | PNG 2.6 KB | public | iOS home screen |
| icon-192 / icon-512 / icon-maskable-512 | PNG | public | [manifest.webmanifest](../../apps/web/public/manifest.webmanifest) (PWA, `standalone`, theme `#0E5E57`). No service worker, so it can't be installed offline |
| og-image.png | PNG 57 KB | public | OpenGraph |
| delete-account.html | static HTML | public | App-store account deletion URL |
| veetrax-logo(-white, -on-teal, -vertical).png, veetrax-mark(-white).svg, veetrax-mark-512.png | PNG/SVG | [brand/logo](../../brand/logo) | Marketing / tracker app ([TrackerLogo.tsx](../../apps/tracker/src/components/TrackerLogo.tsx)); not used by the web app |
| email-header-600x120 / 1200x240 | PNG | [brand/email](../../brand/email) | No code reference found (likely uploaded manually to email templates) |
| appstore-icon-1024, play-icon-512, play-feature-graphic-1024x500 | PNG | [brand/store](../../brand/store) | Store listings |
| Manrope 700/800 + OFL | TTF (~95 KB each) | [brand/fonts](../../brand/fonts) | Asset generator only |
| Generator | Node script | [scripts/brand/generate.mjs](../../scripts/brand/generate.mjs) | Writes brand/, mobile icons, web public/ |
| SOS siren WAV generator | Node script | [scripts/brand/gen-sos-sound.mjs](../../scripts/brand/gen-sos-sound.mjs) | Mobile only |
| Vehicle/person/asset/pet markers | Canvas ImageData (12 kinds × 6 statuses × 2 schemes) | [vehicle-icons.ts](../../apps/web/src/features/live/map/vehicle-icons.ts) | Live map, history |
| Heading arrow | SDF canvas | [map-style.ts](../../apps/web/src/features/live/map/map-style.ts) | Live map |
| Share-page marker | DOM div + CSS | [PublicSharePage.tsx](../../apps/web/src/features/live-share/PublicSharePage.tsx) | `/share/:token` |
| Tracking scene | Inline animated SVG | [TrackingScene.tsx](../../apps/web/src/features/auth/TrackingScene.tsx) | Auth hero |
| Alert sounds | **Synthesised WebAudio** (chime, 3 beeps, 1.6 s siren, loud parking alarm). No audio files | [sound.ts](../../apps/web/src/features/alerts/sound.ts) | Alert centre |
| Voice announcements | Browser speechSynthesis | [voice.ts](../../apps/web/src/features/alerts/voice.ts) | Alert centre |
| Icons | lucide-react | — | Everywhere |
| Illustrations / backgrounds | None (CSS blur glows on the auth hero) | — | — |
| Design document | HTML (149 KB) + Python builder | [docs/design](../../docs/design) | Product spec v2.0 ("VeeTracer" naming) |

---

## 7. Internationalisation

| Item | Value |
|---|---|
| Languages | English (source, keys = English text), **Hindi** `hi`, **Tamil** `ta` ([shared/i18n](../../packages/shared/src/i18n)) |
| Dictionaries | 2,969 entries each (`hi.ts`, `ta.ts`, 3,411 lines). Merged by `scripts/i18n-merge.mjs` |
| Extraction | [scripts/i18n-extract.mjs](../../scripts/i18n-extract.mjs) scans `t('…')`, `i18n.t('…')` and label-like props in web + mobile + shared catalogues |
| Coverage ([i18n-missing.json](../../scripts/i18n-missing.json)) | **2,713** keys found. **10 missing in hi** and **10 in ta**: the privacy-policy section headings (*What we collect, Why we use it, Who we share it with, How long we keep it, Security, Children, Consent for tracking people, Your choices and rights, Contact*) plus one bad extraction (`)} {unknownUsed.map(…)`). Coverage is about 99.6 % |
| Not covered by extraction | Long privacy and delete-account prose in [LegalPages.tsx](../../apps/web/src/features/legal/LegalPages.tsx) (e.g. the literal "Both apps"), `GUIDE_TITLE`, Developer docs (deliberately English), server-generated alert messages ("message in English only", per [voice.ts:18](../../apps/web/src/features/alerts/voice.ts#L18)) |
| Formatting | `lib/format.ts` uses the app locale (en-IN/hi-IN/ta-IN), but about 10 call sites use `toLocaleString(undefined, …)` (browser locale) ([CompareTab.tsx:42](../../apps/web/src/features/dashboard/CompareTab.tsx#L42), [OverviewTab.tsx:84](../../apps/web/src/features/dashboard/OverviewTab.tsx#L84), [report-columns.tsx:91](../../apps/web/src/features/reports/report-columns.tsx#L91), [picture-header.ts:102](../../apps/web/src/lib/picture-header.ts#L102)) |
| Bundle | Both dictionaries are bundled eagerly in the `i18n` chunk (**762 KB**), which is preloaded by the entry (F-02) |

---

## 8. Findings

Severity: **Critical** = breaks users or blocks launch quality. **High** = significant UX/perf/a11y cost. **Medium** = noticeable inconsistency. **Low** = polish or cleanup.

| # | Sev | Area | Finding | Evidence |
|---|---|---|---|---|
| F-01 | **High** | Perf | **maplibre-gl (1.03 MB) and its CSS are in the entry bundle**, even though the config comment says they are isolated in the lazily loaded live-map chunk. Every page, including `/login`, preloads them. Two causes: `PublicSharePage` is imported eagerly by the router, and `AlertBell` (always in the TopBar) → `MiniMap` → `use-basemap` imports maplibre statically | [vite.config.ts:28](../../apps/web/vite.config.ts#L28), [router.tsx:11](../../apps/web/src/app/router.tsx#L11), [PublicSharePage.tsx:3](../../apps/web/src/features/live-share/PublicSharePage.tsx#L3), [MiniMap.tsx:6](../../apps/web/src/features/alerts/MiniMap.tsx#L6); `dist/index.html` modulepreloads `maplibre-gl-*.js` |
| F-02 | **High** | Perf/i18n | Hindi and Tamil dictionaries (762 KB chunk) load for every user, including English ones. They should be loaded per language on demand | [i18n/index.ts:21](../../packages/shared/src/i18n/index.ts#L21), [lib/i18n.ts](../../apps/web/src/lib/i18n.ts) |
| F-03 | **High** | Responsive | **TopBar overflows on phones.** It always renders menu, logo, Ask, realtime dot, bell, language, display, theme and avatar: about 8 × 36 px + logo + gaps ≈ 400 px with no overflow handling, more than a 360–390 px viewport | [TopBar.tsx:58-93](../../apps/web/src/features/shell/TopBar.tsx#L58) |
| F-04 | **High** | A11y | `StatusBadge` writes the raw status colour as text on a 14 % tint. In light themes RUNNING `#16a34a`, IDLE `#d97706` and NO_DATA `#94a3b8` fall below WCAG AA 4.5:1 for 12 px text. Status is also conveyed by colour alone on map markers | [status-badge.tsx:21](../../apps/web/src/components/status-badge.tsx#L21), [tracking.ts:6](../../packages/shared/src/tracking.ts#L6) |
| F-05 | **High** | A11y | Clickable table rows can only be activated by mouse (no `tabIndex`, role or key handler). Alerts, Attendance, Admin pools and DMS rows open details only on click | [AlertsPage.tsx:413](../../apps/web/src/features/alerts/AlertsPage.tsx#L413), [AttendancePage.tsx:435](../../apps/web/src/features/attendance/AttendancePage.tsx#L435), [AdminPoolsTab.tsx:204](../../apps/web/src/features/billing/admin/AdminPoolsTab.tsx#L204), [DmsPage.tsx:136](../../apps/web/src/features/dms/DmsPage.tsx#L136), [AskPanel.tsx:243](../../apps/web/src/features/ask/AskPanel.tsx#L243) |
| F-06 | Medium | Resilience | Public routes (`/login`, `/share/:token`, `/guide`, …) have **no errorElement**. A render error shows React Router's default developer error screen, and the stale-build auto-reload doesn't run there | [router.tsx:82-99](../../apps/web/src/app/router.tsx#L82) |
| F-07 | Medium | Typography | The `Inter` font is declared but never loaded, so the typeface differs by OS. The brand font Manrope isn't used in the UI, so the in-app "VeeTrax" wordmark doesn't match the logo files | [index.css:207](../../apps/web/src/index.css#L207), [logo.tsx:24](../../apps/web/src/components/logo.tsx#L24), [brand/fonts](../../brand/fonts) |
| F-08 | Medium | Design system | There is no "System (follow OS)" theme, though the approved design doc §11.2 requires it. A stored `system` value silently becomes Teal | [shared/api.ts:20](../../packages/shared/src/api.ts#L20), [build.py:1143](../../docs/design/build.py#L1143) |
| F-09 | Medium | Consistency | Severity colours are hard-coded and duplicated: `SEVERITY_COLOR` hexes, `bg-[#…]` copies in AlertTypeCard, and INFO shown as a grey `secondary` badge while it is blue on the map. Not themed for dark | [severity.ts:6-10](../../apps/web/src/features/alerts/severity.ts#L6), [AlertTypeCard.tsx:44](../../apps/web/src/features/alerting/AlertTypeCard.tsx#L44) |
| F-10 | Medium | Consistency | Two soft-colour systems: `Badge` uses `bg-success/12 text-success`, while `--success-soft/--success-fg` tokens exist for "badges, chips and icon tiles". Raw palette classes appear in a few places (`text-amber-500`, `text-amber-400`) | [badge.tsx:13](../../apps/web/src/components/ui/badge.tsx#L13), [index.css:47](../../apps/web/src/index.css#L47), [DriverScoresPage.tsx:29](../../apps/web/src/features/driver-scores/DriverScoresPage.tsx#L29), [VideoPlayer.tsx:147](../../apps/web/src/features/video/VideoPlayer.tsx#L147) |
| F-11 | Medium | Map | The public share map ignores the configured style overrides, dark mode and satellite, and uses a different marker design from the app | [PublicSharePage.tsx:94](../../apps/web/src/features/live-share/PublicSharePage.tsx#L94) |
| F-12 | Medium | Responsive | Master tables (14 screens) and report tables only scroll horizontally on phones. There's no stacked card view, and `min-h-[560px]` forces scrolling inside short viewports | [MasterPage.tsx:384](../../apps/web/src/features/masters/MasterPage.tsx#L384), [table.tsx](../../apps/web/src/components/ui/table.tsx) |
| F-13 | Medium | Locale | Numbers and dates in dashboards, reports and captions use the browser locale instead of the chosen app language/locale (e.g. lakh grouping differs) | §7 call sites |
| F-14 | Medium | Map | History MapTools are positioned with magic offsets that assume the MapLibre control height, so they break if the control set or display scale changes | [HistoryPage.tsx:656](../../apps/web/src/features/history/HistoryPage.tsx#L656) |
| F-15 | Medium | A11y | Small text: 58 uses of `text-[10px]`/`text-[11px]` (sidebar group labels, footer, badges, kbd hints). Many icon buttons are 32 px (`icon-sm`), below the 44 px touch-target guideline on phones | grep `text-\[1[01]px\]`, [button.tsx:23](../../apps/web/src/components/ui/button.tsx#L23) |
| F-16 | Low | A11y | Critical pop-up toggle sets `aria-pressed={!state.criticalPopup}`, which is inverted relative to its sibling toggles | [AlertBell.tsx:366](../../apps/web/src/features/alerts/AlertBell.tsx#L366) |
| F-17 | Low | A11y | Global `:focus-visible { outline: none }` relies on every custom control adding its own ring. Hand-built buttons (e.g. MasterPage clear-search, filter-chip remove) have no focus style | [index.css:305](../../apps/web/src/index.css#L305), [MasterPage.tsx:412](../../apps/web/src/features/masters/MasterPage.tsx#L412) |
| F-18 | Low | Nav | `/claim` isn't in MENUS, so the TopBar shows no current-page label or breadcrumb. It's imported eagerly but wrapped in `Suspense` for no effect | [router.tsx:121-130](../../apps/web/src/app/router.tsx#L121) |
| F-19 | Low | Iconography | `ShieldCheckIcon` is used for both *Roles & Permissions* and *Licences & Invoices* | [nav.ts](../../apps/web/src/features/shell/nav.ts) |
| F-20 | Low | Perf | Lazy heavy dependencies are fine (jsPDF 341 KB + html2canvas 199 KB, mpegts 272 KB, tesseract.js WASM + traineddata downloaded at runtime), but there's no download-progress UI for the OCR's large first download | [ExpensesPage.tsx:39](../../apps/web/src/features/expenses/ExpensesPage.tsx#L39), [page-capture.tsx:34](../../apps/web/src/components/page-capture.tsx#L34) |
| F-21 | Low | Maintainability | Very large page files: AttendancePage 63 KB, report-columns 43 KB, SystemHealthPage 34 KB, HistoryPage 33 KB, alerting/panels 33 KB | sizes from `find` |
| F-22 | Low | Dead code | Exported but never imported elsewhere: `CardFooter`, `DialogTrigger/Close/Overlay`, `SheetTrigger/Close`, `PopoverAnchor`, `SelectGroup`, `DropdownMenuGroup`, `useCan`, `menuByKey`. Mostly shadcn barrel leftovers. Every source file is imported somewhere | grep across `src/` |
| F-23 | Low | Security/UX | The refresh token is kept in `localStorage` (readable by any injected script). Session list and remote sign-out exist, which helps | [session.ts:3](../../apps/web/src/lib/session.ts#L3) |
| F-24 | Low | Brand | Naming drift: product "VeeTrax" vs packages `@veetracer/*` and the design document "VeeTracer". The design doc plans self-hosted tiles, but the code uses OpenFreeMap public tiles | [package.json](../../apps/web/package.json), [basemap.ts](../../packages/shared/src/basemap.ts) |
| F-25 | Low | PWA | The manifest is `standalone` but there's no service worker or offline shell | [manifest.webmanifest](../../apps/web/public/manifest.webmanifest) |

**Strengths worth keeping:** one token source for five themes (status colours shared with mobile), consistent `PageHeader` + breadcrumb, a generic MasterPage giving 14 screens the same UX, reduced-motion support throughout, WebGL fallback text, recovery from stale builds after a deploy, careful `aria-label`s on icon buttons (only 5 icon buttons lacked an inline label and all had one nearby), and lazy loading for the truly heavy optional libraries.

---

## 9. Screenshot shortlist

Pending: capture once the app is running and an account is available. Take each one in Teal (light) and Dark, at 1440 px and 390 px.

1. `/login` (split hero; phone layout) and `/share/<token>`
2. `/dashboard` (Overview; also `?tab=criticality`, `?tab=compare`)
3. `/live` (panel + drawer open on a vehicle; Layers popover; phone map/list toggle; clustering with >500 objects)
4. `/history` (playing a trip with LiveDataPanel, legend, timeline; compare mode)
5. `/alerts` + AlertDetailSheet; TopBar bell dropdown; critical modal
6. `/reports` (after a run: charts + table)
7. `/masters/objects` (MasterPage reference, filters + bulk bar) and `/masters/geofences` editor (polygon drawing)
8. `/alerting/settings` (level tree + AlertTypeCard inheritance badges) and `/alerting/templates` editor
9. `/attendance` (Today + day dialog), `/driver-events` (card grid)
10. `/admin/billing` (PoolView + BuyDialog), `/admin/roles` PermissionMatrix
11. `/platform/system-health`, `/platform/companies` (company switcher open)
12. Error states: `/403`, unknown route, WebGL-off live map
