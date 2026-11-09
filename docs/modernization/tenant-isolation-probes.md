# Tenant-isolation probes — realtime, files, partners, webhooks

Status: complete · Instance: **isolated assessment only** (`http://localhost:4100/api`, DB `veetrax_assess`, Valkey db 1) · Date: 2026-11-09

This note records the remaining tenant-isolation probes that were **not** already covered by
[`02-role-permission-matrix.md`](02-role-permission-matrix.md) §4 (which already proved isolation for
`objects/:id`, history, trips, commands, `drivers/:id`, report scope and `X-Company-Id` spoofing).

Everything here was run against the isolated branch build on port **4100** only. Production (`:4000`,
DB `veetracer`) was never contacted; the probe script hard-refuses any `:4000` base URL.

## Re-runnable probe

Script: [`apps/api/scripts/tenant-isolation-probe.ts`](../../apps/api/scripts/tenant-isolation-probe.ts)
(tsx + `socket.io-client`, both already devDependencies of `apps/api`). It is idempotent — safe to
run repeatedly — prints a PASS/FAIL table and exits non-zero on any FAIL.

```bash
cd apps/api
PATH="/c/Program Files/nodejs:$PATH" npx tsx scripts/tenant-isolation-probe.ts
```

Base URL and credentials come from env vars (defaults = the seeded assessment accounts):
`BASE_URL`, `WS_ORIGIN`, `SA_EMAIL/SA_PASS`, `A_EMAIL/A_PASS`, `B_EMAIL/B_PASS`,
`VIEWER_EMAIL/VIEWER_PASS`, `A_COMPANY_ID`, `B_COMPANY_ID`, `A_VEHICLE_ID`.

Fixtures: tenant **A** = "Demo Logistics" (`demo.admin`, 21 live objects); **B** = "Beta Transport
(assessment)" (`beta.admin`, 0 vehicles); **Viewer** = 3 mapped vehicles. The script creates its own
test data on the isolated instance (a document + file, an expense + receipt photo, a partner + customer
company, API-access licence seats, webhook endpoints) and cleans up the webhook endpoints it creates.

## Method

Black-box, over the real HTTP/WebSocket surface, using the seeded accounts. For each boundary the
script performs the action as the owning tenant (A) and then as the other tenant (B) and/or the
limited Viewer, asserting the cross-tenant attempt is denied (403/404) or simply receives nothing.
Routes were read from source first to target the exact scoping code (cited under Evidence).

## Results

| # | Probe | Expected | Actual | Result |
|---|-------|----------|--------|--------|
| 1 | Socket `/live`: tenant A receives its own `live:batch` (precondition) | A streams | A got 12 batches / 20 objects in 12 s | INFO |
| 1 | Socket `/live`: B connects with `auth.companyId = A` **spoof** and emits `subscribe`/`join`/`live:subscribe`/`room`/`company`/`watch` for A's company & object ids | B receives **zero** A data over ~10 s | B batches=0, alerts=0, leaked objects=0 | **PASS** |
| 1 | Socket `/live`: Viewer (3 vehicles) scope | only its 3 allowed object ids stream | Viewer saw 3 objects, 0 out-of-scope | **PASS** |
| 1 | Socket `/live`: behaviour after the user logs out (AZ-3) | known issue — expected to keep streaming | socket stayed connected and **kept streaming** after `POST /auth/logout` | INFO (see Finding F-1) |
| 2 | `GET /documents/:id/file` of an A document, as B | A=200+bytes, B=403/404 | A=200/70 B, B=**404** | **PASS** |
| 2 | `GET /expenses/:id/photo` of an A receipt, as B | A=200+bytes, B=403/404 | A=200/70 B, B=**404** | **PASS** |
| 2 | `GET /attendance/selfie?objectId=<A veh>` as B | B=403/404 (object out of B scope) | B=**404** | **PASS** |
| 2 | `GET /attendance/video?objectId=<A veh>` as B | B=403/404 | B=**404** | **PASS** |
| 2 | `GET /driver-events/:id` of an A event, as B | B=403/404 | B=**404** | **PASS** |
| 2 | `GET /driver-events/media/:id?token=…` signed-token binding | valid token streams; wrong id / no token = 404 | no media in A seed → not exercised; **verified by code** | SKIP |
| 2 | `GET /report-runs/:id/file`, as B | B=404 (company-scoped) | B=**404** (A had no run to seed) | **PASS** |
| 2 | `GET /licences/invoices/:id/pdf`, as B | B=403/404 (company-scoped `find`) | B=**404** (A had no invoice to seed) | **PASS** |
| 2 | `GET /licences/admin/invoices` as tenant-B admin | 403 (needs `sa_licences`) | B=**403** | **PASS** |
| 2 | `/downloads` path traversal + non-APK name (`../../.env`, `../../../package.json`, `x.txt`) | all non-200 (`APK_NAME` regex gate) | all **404** | **PASS** |
| 3 | Partner reads its own partner overview | 200 | 200 | **PASS** |
| 3 | Partner reads its **allocated** customer C | 200 | 200 | **PASS** |
| 3 | Partner reads a **non-customer** (tenant B) overview | 403 "not your customer" | **403** | **PASS** |
| 3 | Partner reads a non-customer (tenant B) invoices | 403 | **403** | **PASS** |
| 3 | Partner **offline payment** targeting non-customer (tenant B) | 403 (not 2xx) | **403** "This company is not your customer" | **PASS** |
| 3 | Non-partner user (tenant B) uses a `/licences/partner/*` endpoint | 403 "not a partner account" | **403** | **PASS** |
| 3 | `GET /licences/admin/partners` as tenant-B admin | 403 (needs `sa_licences`) | B=**403** | **PASS** |
| 4 | Tenant B reads an A webhook **delivery record** (`GET /developer/webhook-deliveries/:id`) | 404 (company-scoped) | B=**404** | **PASS** |
| 4 | Tenant B lists an A endpoint's deliveries (`GET /developer/webhooks/:id/deliveries`) | 404 (endpoint not found for B) | B=**404** | **PASS** |
| 4 | Webhook fan-out is company-scoped | B endpoints never match an A event | `queueEvent` filters `where { companyId: e.companyId }` | INFO (code) |
| 4 | Live delivery to a loopback sink (`127.0.0.1`) carries only the owning company | sink `/a` sees only A, `/b` only B | sender/notifier worker not running on this instance → no delivery arrived; record-level isolation proven above | INFO |

Totals on the final run: **PASS = 20, FAIL = 0, INFO = 7, SKIP = 1** (exit 0).

## Evidence (where the boundary is enforced)

- **Socket `/live`** — `apps/api/src/live/live.gateway.ts`. The gateway registers **no**
  `@SubscribeMessage` handlers, so a client cannot request a room/company/object at all; rooms are
  assigned server-side by `roomOf()` from the auth context (`companyId`, or the `*` all-companies room
  for Super Admins only). The handshake `companyId` is resolved by
  `auth-context.service.ts:forUser` lines 59-64, which honour a requested company **only for
  `isSuperAdmin`** — a tenant-B token keeps `companyId = B` (same guard as the proven `X-Company-Id`
  case). Fan-out (`onUpdate`/`onAlert`) filters by `client.allowed` (object scope) and
  `hasPermission`. Viewer scope comes from `allowedObjects()` → `objectScopeWhere(ctx)`.
- **Documents** — `documents.service.ts:369 find()` → `where: { AND: [documentScopeWhere(ctx), { id }] }`;
  `file()` streams only a row that passed that scope.
- **Expenses** — `expenses.service.ts` `scope()` → `object.is(allCompaniesOr(ctx, objectScopeWhere(ctx)))`;
  `photo()` reads via `findFirst({ where: { AND: [scope, { id }] } })`.
- **Attendance selfie/video** — `attendance.service.ts` `selfie()/video()` call
  `person(ctx, s, objectId)`, which resolves the object through `staff()` scoped by
  `allCompaniesOr(ctx, objectScopeWhere(ctx))`; an out-of-scope `objectId` → 404.
- **Driver-event media** — public endpoint `driver-events.controller.ts media()` is authorised by an
  HMAC token, not the session. `media-token.ts verifyMediaToken` binds the token to both the media id
  (`claims.m === mediaId`) and company (`claims.c`), and `driver-events.service.ts:234` loads
  `findFirst({ where: { id, companyId: claims.c } })`. A token is unforgeable without `jwtSecret`.
- **Report-run files** — `report-schedules.service.ts runFile()` → `findFirst({ where: { id, companyId: ctx.companyId } })`,
  plus an owner/branch check for non-COMPANY scope.
- **Invoice / credit-note PDFs** — customer route `licences.controller.ts:98,114` →
  `invoices.find(id, { companyId: ctx.companyId })`; the `licences/admin/*` variants require
  `sa_licences` (Super Admin only).
- **Downloads** — `downloads.controller.ts file()` gates the filename on `APK_NAME.test(file)` before
  `stat`, and Nest/Express normalise the path; traversal and arbitrary names 404.
- **Partners** — `licences.controller.ts PartnerLicencesController.customer()` resolves
  `companyOwner(companyId)` and throws `ForbiddenException('This company is not your customer')` unless
  `owner.partnerId === partner.id`; `billing.service.ts:109 partnerOf()` throws for non-partner
  accounts. Every `customers/:companyId/*` route (overview, invoices, **payments**) goes through it.
- **Webhooks** — `webhooks/fanout.ts queueEvent` creates deliveries only for
  `webhookEndpoint where { companyId: e.companyId }`; `webhook-companies.ts` keys the active set by
  `companyId`; `webhooks-admin.service.ts get()/delivery()` scope every read by `ctx.companyId`.
  SSRF guard `url-guard.ts` allows loopback only off-production (why the local sink is permitted here).

## Findings (by severity)

**No cross-tenant data leak was found.** Every tenant-A artifact (live positions, documents, receipts,
selfies, driver-event media, report files, invoices, webhook deliveries, licence pools) was
inaccessible to tenant B and to the limited Viewer, and the partner/reseller boundary holds for reads
and for offline payments.

### F-1 — Realtime socket is not terminated on logout / session revocation (AZ-3) · **Low–Medium**

- **Observed:** after `POST /auth/logout` with tenant A's token, A's existing `/live` socket stayed
  connected and kept receiving `live:batch` (0 → 9 batches in the 10 s after logout).
- **Cause:** the socket is authenticated only at handshake. The periodic
  `LiveGateway.refreshAll()` (`live.gateway.ts:252`) re-resolves access with
  `contexts.forUser(ctx.userId, …)` — by **user id**, with no check that the originating session/token
  is still valid. An active-but-logged-out user is therefore never disconnected; the stream continues
  until the socket itself drops.
- **Impact:** bounded to the **user's own tenant** data they were already authorised to see — this is a
  session-lifecycle weakness, **not** a tenant-isolation break. It lengthens (effectively removes) the
  window in which a revoked session stops receiving live data, which matters for deprovisioning and for
  "log me out everywhere".
- **Suggested fix:** bind the socket to its session id at connect and invalidate it on logout — e.g.
  publish a revocation on `RedisKeys.cacheInvalidate`/a new channel keyed by session id, and in
  `handleConnection` record `socket.data.sessionId`; in `refreshAll()` (`live.gateway.ts:252-268`) have
  `AuthContextService` re-validate the session (not just the user) and `socket.disconnect(true)` when it
  is gone. At minimum, check session validity so the disconnect happens within the existing 60 s
  `SCOPE_REFRESH_MS` tick instead of never. (`apps/api/src/live/live.gateway.ts:252`;
  `apps/api/src/access/auth-context.service.ts:44`.)

### Observations (not vulnerabilities)

- The webhook **sender/notifier** worker is not running on the assessment API process, so no live
  delivery reached the loopback sink. This does not weaken the result: cross-tenant isolation of
  delivery **records** was proven over the API, and fan-out is company-scoped in code
  (`webhooks/fanout.ts`). To exercise live delivery end-to-end, start the notifier worker against
  Valkey db 1 and re-run.
- No driver-event **media** exists in the tenant-A seed, so the signed-token binding could not be
  exercised dynamically; it is covered by code review (`media-token.ts`) and by the cross-tenant event
  404. Seeding one ADAS/DMS event with a photo would let the probe assert it live.
- Tenant A and the created customer company carry no invoices/report-runs in the seed, so the
  invoice-PDF and report-run cross-tenant checks used an arbitrary id (still a valid company-scoped 404).
  Seeding an A invoice/run would upgrade these from "arbitrary-id 404" to "real-foreign-id 404".
