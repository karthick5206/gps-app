# 01 — Route & Module Inventory

Branch `feature/modernization-phase0` · baseline `main@17a2e63` · 2026-11-09 · **Phase 0: no code changed.**

The route table is generated from `MENUS` in [packages/shared/src/permissions.ts:66-106](../../packages/shared/src/permissions.ts#L66-L106). Each menu route is wrapped in `RequirePermission` by [apps/web/src/app/router.tsx:100-121](../../apps/web/src/app/router.tsx#L100-L121). Backend endpoints enforce the same menu × action permissions (global guards; Phase 1 [02 §3](../discovery/02-architecture-and-platform.md#3-request-lifecycle)).

**Status labels:**
- **Verified**: rendered on the isolated assessment instance, with a screenshot in [`docs/discovery/screenshots/phase2`](../discovery/screenshots/phase2/).
- **Code-read**: implemented in source but not rendered in this assessment.
- Other labels are per [assignment §3.3](#).

## 1. Customer Portal — authenticated routes (menu-driven)
| Group | Menu key | Path | Actions | Page module | Status |
|---|---|---|---|---|---|
| Tracking | dashboard | `/dashboard` (tabs: overview, criticality, health, compare) | view | `features/dashboard` | **Verified** (all 4 tabs) |
| Tracking | live_map | `/live` | view, command | `features/live` | **Verified** |
| Tracking | history | `/history` | view, export | `features/history` | **Verified** |
| Tracking | alerts | `/alerts` | view, edit, export | `features/alerts` | Code-read |
| Tracking | parking_mode | `/parking-mode` | view, edit | `features/parking` | Code-read (escalation = stub, Phase 1 [05](../discovery/05-feature-modules-and-api.md)) |
| Tracking | video | `/video` | view | `features/video` | Code-read (needs JT1078 dashcam; single-host only) |
| Drivers & staff | dms | `/dms` | view, export | `features/dms` | **Verified** |
| Drivers & staff | driver_events | `/driver-events` | view, edit, export | `features/driver-events` | Code-read |
| Drivers & staff | driver_scores | `/driver-scores` | view | `features/driver-scores` | **Verified** |
| Drivers & staff | attendance | `/attendance` | view, edit, export | `features/attendance` | Code-read (alerts bypass Alert Settings: **Defective**, Phase 1 H14) |
| Costs & reports | expenses | `/expenses` | view, create, delete | `features/expenses` | Code-read (500-row cap, no pagination: **Partial**) |
| Costs & reports | reports | `/reports` | view, export | `features/reports` | **Verified** (7 of 31 types run; see [03](03-report-inventory.md)) |
| Costs & reports | report_schedules | `/reports/schedules` | view, create, edit, delete | `features/reports` | **Verified** (list, add dialog); options dropped (**Defective**) |
| Masters | objects | `/masters/objects` | CRUD | `features/masters` | Code-read |
| Masters | devices | `/masters/devices` | CRUD | `features/masters` | Code-read |
| Masters | drivers | `/masters/drivers` | CRUD | `features/masters` | Code-read |
| Masters | vehicle_groups | `/masters/vehicle-groups` | CRUD | `features/masters` | Code-read |
| Masters | branches | `/masters/branches` | CRUD | `features/masters` | Code-read |
| Masters | documents | `/masters/documents` | CRUD | `features/documents` | Code-read |
| Masters | geofences | `/masters/geofences` | CRUD | `features/geofences` | Code-read |
| Masters | pois | `/masters/pois` | CRUD | `features/pois` | Code-read |
| Masters | lookups | `/masters/lookups` | CRUD | `features/masters` | Code-read |
| Alerting | alert_settings | `/alerting/settings` | view, create, edit, delete | `features/alerting` | Code-read (pack create/edit UI missing: **Partial**) |
| Alerting | message_templates | `/alerting/templates` | view, create, edit, delete, export | `features/templates` | Code-read (test-send needs only view: **Defective**, Phase 1 H15) |
| Admin | users | `/admin/users` | CRUD | `features/admin` | Code-read |
| Admin | roles | `/admin/roles` | view, create, edit, delete | `features/admin` | Code-read (no permission ceiling: **Defective/security**, Phase 1 H2) |
| Admin | settings | `/admin/settings` | view, edit | `features/admin` | Code-read |
| Admin | billing | `/admin/billing` | view, create, edit | `features/billing` | Code-read (see [00 §6](00-current-state-inventory.md#6-annual-device-licensing--billing-as-implemented)) |
| Admin | api | `/admin/developer-api` | view, create, edit, delete | `features/developer` | Code-read (key scope can exceed creator: **Defective/security**, Phase 1 H3) |
| Admin | audit_log | `/admin/audit-log` | view, export | `features/admin` | Code-read |

## 2. Super Admin Portal (menus with `superAdminOnly: true`, excluded from tenant roles)
| Menu key | Path | Status |
|---|---|---|
| sa_companies | `/platform/companies` | Code-read (create company used via API in the tenant probe: works) |
| sa_licences | `/platform/licences` | Code-read; grant endpoint used successfully on the isolated instance |
| sa_device_models | `/platform/device-models` | Code-read |
| sa_device_inventory | `/platform/device-inventory` | Code-read |
| sa_unknown_devices | `/platform/unknown-devices` | Code-read |
| sa_relay | `/platform/data-forwarding` | Code-read (SSRF guard relaxed without `NODE_ENV=production`: see [05](05-technical-risk-register.md)) |
| sa_platform_settings | `/platform/settings` | Code-read |
| sa_system_health | `/platform/system-health` | Code-read |
| (company switcher) | `X-Company-Id` header, incl. `all` | Code-read; spoofing by a non-Super-Admin is ignored (**verified**, [02 §4](02-role-permission-matrix.md#4-tenant-isolation-probes-verified-2026-11-09)) |
| Platform overview dashboard | — | **Missing** (no Super Admin home with tenant/licence/payment/pipeline KPIs) |

## 3. Public and utility routes ([router.tsx:86-132](../../apps/web/src/app/router.tsx#L86-L132))
| Path | Purpose | Status |
|---|---|---|
| `/login` (password / mobile OTP), `/forgot-password`, `/reset-password` | Authentication | **Verified** (login) |
| `/signup` | Self-signup (personal accounts only) | Code-read: **Partial** (no business signup) |
| `/guide`, `/download`, `/privacy`, `/delete-account` | Help, app download, legal, account deletion | Code-read |
| `/share/:token` | Public live-share link (192-bit hashed, expiring tokens) | Code-read |
| `/claim` | Device claim | Code-read (claim by IMEI alone within 24 h: **risk**, Phase 1) |
| `/403`, `*` (404), error element | Error states | Code-read; public pages have no error boundary (Phase 1) |

## 4. API process and module map
55 NestJS module folders, run as 5 processes (api, gateway, processor, notifier, summarizer). Full map: Phase 1 [03-repository-structure.md](../discovery/03-repository-structure.md). Endpoint inventory: [04-api-and-integration-inventory.md](04-api-and-integration-inventory.md).

## 5. Mobile applications
| App | Screens | Status |
|---|---|---|
| VeeTrax customer app (`apps/mobile`, Expo 58, v0.6.7/67) | 37 (5 tabs + 32 stack routes), permission-filtered | Code-read (Phase 1 [08](../discovery/08-mobile-apps.md)); shipping on Play |
| VeeTrax Tracker (`apps/tracker`, v1.4.3/28, Android only) | 6 + menu | Code-read; iOS tracking **Missing** |
