# 02 — Tenant, Identity, Role & Permission Matrix

Branch `feature/modernization-phase0` · 2026-11-09 · **Phase 0: no code changed.**
Detailed source analysis: Phase 1 [02-architecture-and-platform.md §4–5](../discovery/02-architecture-and-platform.md#5-authorization-model).

## 1. Entities (assignment §8: kept distinct)
| Concept | Implementation | Evidence |
|---|---|---|
| **Tenant / customer** | `Company` (accountType BUSINESS / INDIVIDUAL); every tenant table carries `companyId`. There is **no DB-level row security**, and several tables have `companyId` without an FK | Phase 1 [11 §1](../discovery/11-database.md) |
| **Branch** | `Branch`, flat under Company | schema |
| **User account** | `User` (email and/or mobile), bcrypt cost 12; 15-min access JWT + 30-day rotating hashed refresh token per `Session` | Phase 1 [02 §4](../discovery/02-architecture-and-platform.md#4-authentication) |
| **Super Admin** | a user **flag**, exactly one owner by product decision; acts in a company via the `X-Company-Id` header (or `all`) | `access/auth-context.service.ts:29`, `auth.guard.ts:25` |
| **Partner / reseller** | `Partner`, identified by its home company; owns licence pools and allocates to customers. **Not** a data-access grant by itself | Phase 1 [02 §8](../discovery/02-architecture-and-platform.md#8-module-write-ups) |
| **Device licence** | Pool-based seats per licence type, auto-assigned to devices (see [00 §6](00-current-state-inventory.md#6-annual-device-licensing--billing-as-implemented)) | `apps/api/src/licences` |

## 2. Permission model
- **38 menus × up to 6 actions** (view, create, edit, delete, export, command), from [permissions.ts](../../packages/shared/src/permissions.ts). 8 `sa_*` menus are Super-Admin-only and **cannot** be granted to tenant roles.
- **Data scope:** `ALL` (the whole company) or `ASSIGNED` (the user's branches plus individually mapped vehicles).
- **Built-in roles:** Admin, Manager, User, Viewer. Custom roles are allowed.
- **Enforcement:** global `JwtAuthGuard` → `PermissionGuard` on every controller. The web hides menus as a convenience only.

## 3. Role × capability matrix: built-in system roles (**verified**)
Read on 2026-11-09 from `GET /api/roles` on the isolated instance (fresh seed + system role sync). Production roles may have been edited since; this is the shipped default.

| Menu (actions granted) | Super Admin | Admin | Manager | User | Viewer |
|---|---|---|---|---|---|
| Data scope | all companies (switcher) | COMPANY | ASSIGNED | ASSIGNED | ASSIGNED |
| `live_map` | all | view, **command** | view | view | view |
| `reports` | all | view, export | view, export | view | — |
| `objects` (vehicles) | all | view, create, edit, delete, export | view, edit, export | view | — |
| `users` | all | view, create, edit, delete, export | **view, create, edit** | — | — |
| `roles` | all | view, create, edit, delete | — | — | — |
| `billing` | all | view, create, edit | — | — | — |
| `api` (developer keys/webhooks) | all | view, create, edit, delete | — | — | — |
| `audit_log` | all | view, export | — | — | — |
| Platform `sa_*` menus | ✔ | ✖ (not grantable) | ✖ | ✖ | ✖ |

> **Manager holds `users:create/edit`. Probed 2026-11-09 on the isolated instance:**
> - `PATCH /users/<self> {roleIds:[Admin]}` as the Chennai Manager → **403** "You cannot assign roles with company-wide scope". There *is* a **scope ceiling**: [access-rules.ts:108-120](../../apps/api/src/access/access-rules.ts#L108-L120).
> - `PATCH /users/<self> {roleIds:[User]}` → **200**. A branch-scoped user may **change their own roles** to any ASSIGNED-scope role.
> - Therefore the ceiling is on **data scope only, not on permissions**. If a tenant has a custom ASSIGNED-scope role with more menu rights (for example `live_map:command`, `billing`, `api`), any Manager can grant it to themselves or others. This refines AZ-1 below.

## 4. Tenant-isolation probes (verified 2026-11-09)
Method: on the **isolated assessment instance** (DB `veetrax_assess`, API :4100; never production), a second tenant "Beta Transport (assessment)" was created via `POST /api/admin/companies`. Its Admin then attempted to read tenant A (Demo Logistics) data by ID. Script: scratchpad `tenant-probe.sh` (to be turned into an automated e2e test, [09](09-test-strategy.md)).

| Probe (as tenant B Admin) | Result | Verdict |
|---|---|---|
| `GET /objects` (list) | 200, `items: []` | ✔ isolated |
| `GET /objects/:A-vehicle` | 404 "Object not found" | ✔ |
| `GET /objects/:A-vehicle/history` | 404 | ✔ |
| `GET /objects/:A-vehicle/trips` | 404 | ✔ |
| `GET /objects/:A-vehicle/commands` | 404 "Vehicle not found" | ✔ |
| `GET /drivers/:A-driver` | 404 "Driver not found" | ✔ |
| `POST /reports/run` TRIPS with `scope.objectIds=[A-vehicle]` | 200, `rows: []` | ✔ (foreign IDs silently filtered) |
| `GET /objects` with spoofed `X-Company-Id: <A>` | 200, `items: []` | ✔ header ignored for non-Super-Admins |
| `GET /objects` with spoofed `X-Company-Id: all` | 200, `items: []` | ✔ |
| Control: tenant A Admin `GET /objects/:A-vehicle` | 200 | ✔ |

**Not yet probed (Phase 0 follow-up, needs a socket client and file fixtures):**
- Socket.IO `/live` room isolation.
- Downloads of report files and documents by ID.
- Webhook and relay payloads.
- Background jobs (summarizer, retention) crossing companies.
- Partner users reaching non-allocated customers.

## 5. Known authorization defects (from Phase 1; not re-verified at runtime)
| ID | Defect | Severity |
|---|---|---|
| AZ-1 | **Permission (not scope) ceiling missing.** ① Anyone with `roles:create/edit` can build an Admin-equivalent role or edit built-in roles (Phase 1, code). ② Branch-scoped users with `users:edit` can assign any ASSIGNED-scope role, including **to themselves** (verified 2026-11-09); COMPANY-scope roles are correctly blocked (verified 403) | High |
| AZ-2 | API keys can exceed the creator's own scope (company-wide key from a branch-limited user; engine-stop scope without `command`) | High |
| AZ-3 | Socket.IO keeps streaming after logout or session revocation (re-checks permissions every 60 s, not the session) | High |
| AZ-4 | Partners can record offline payments that issue customer licences without platform approval | Medium |
| AZ-5 | Template test-send needs only `view` but sends real SMS/email | High |
| AZ-6 | Some Super Admin checks are hand-written inside services (works today; fragile for new routes) | Low |
| AZ-7 | No MFA; email/mobile changes are not re-verified | Medium |
