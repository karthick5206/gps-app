# E3 integration evidence (2026-11-11): E3 on v1.10.0, E2 security fixes first, E3 backend gaps

Branch `etms/e3` (worktree `e3-int`), from tag v1.10.0 (7d55411, production). Two commits: the merge of `etms/e3-web`
(E3 backend built on the pre-fix E2 279e26b, plus the E3 web) and the gap fixes. Isolated test instance only: fresh
`*_test` databases on the local PostgreSQL 18.6 (credentials not recorded). Production untouched. Nothing pushed.

## 1. Merge

| File | Resolution |
|---|---|
| `apps/api/prisma/schema.prisma` | `EmployeeTransportProfile` keeps E2's `notices` and gains E3's `schedules` / `bookings`. |
| `apps/api/src/etms/testing/isolation-matrix.spec.ts` | Route guard ≥ 86 at merge (E1a 16 + E2 29 + E3 41; 87 after gap 2), both controller lists checked; E2's `/:\w+/` regex and leak checks kept. |
| `isolation-matrix.ts`, `memory-store.ts` | Auto-merged (E3 entries + range / nested-create support on top of E2). |
| `packages/shared/src/i18n/hi.ts`, `ta.ts` | Regenerated as the union of v1.10.0 and `etms/e3-web` (same writer as `scripts/i18n-merge.mjs`). |

i18n counts (each of `hi` / `ta`): v1.10.0 4,168 keys, `etms/e3-web` 4,487, union **4,487**; duplicates 0, base keys
missing from E3 0, value conflicts 0 (v1.10.0 did not change either file). Strings added by the E2 security fixes and
by this work fall back to English until the next `scripts/i18n-extract.mjs` run.

Migrations, in order: `…20261114090000_etms_accounts`, `20261115090000_etms_people` (amended v1.10.0 version,
**byte-identical**: `git diff v1.10.0 -- …etms_people` empty, sha256 `045d425470af3d8a…` both), `20261116090000_etms_bookings_trips`,
`20261116090100_planned_trip_origin`. E3 composite FKs target `EmployeeTransportProfile (id, companyId)`, which the
amended E2 schema still has (`@@unique([id, companyId])`); every FK applied on the amended schema (section 3).

## 2. E2 security fixes take precedence (merge commit)

| E2 fix | What E3 had (pre-fix base) | Now |
|---|---|---|
| M2 consent | "latest TRANSPORT_PROFILE row granted" in four services; test seeds used `ADMIN_ON_BEHALF` grants (refused by the amended CHECK) | One gate `activeRoutingConsents` / shared `routingConsentEffective`: latest row a grant via WEB, PASSENGER_APP or ADMIN_RECORDED_OFFLINE (evidence enforced by the CHECK). An on-behalf "grant" never counts. Used by assignment, ADD_STOP, generator, schedules, bookings, board, candidates, draft detail, My commute. Seeds use self consent. |
| M3 no coordinates in lists | Booking list rows, CSV and board carried home points | List / CSV rows: no personal point (`pickupLabel` / `dropLabel`, `pointsHidden: LIST_VIEW`). Detail and dispatch board: personal points only while consent is active (`CONSENT_REQUIRED` otherwise), rounded to 4 decimals for branch scope; sites always. Candidates do not route to a withheld point (`NO_PICKUP`). Web uses labels and refuses to queue withheld bookings. |
| M4 export | Bookings CSV followed the read scope (partners' rows possible) | CSV only the caller's own company's bookings; labels, no coordinates. |
| M5 erasure | Bookings / stops kept copies of the home point after erasure | Erasure refused (409) while a booking is open; then booking personal points coarsened to 2 decimals (the ASSIGNED CHECK needs a point), labels / note / status reason removed, the passenger's personal planned stops renamed `[erased]` and coarsened, DRAFT change sets naming the bookings discarded, booking audit trail scrubbed (`reason`, `statusReason` added to the erased keys). |
| L9 evidence trigger | E3 DB test purged without the purge declaration | Purges run with `PURGE_EVIDENCE_WRITE`, one transaction per company, like `PurgeService`. |
| B6 DB guard | Own `veetrax_assess`-or-`_test` check | Shared `dbDescribe` (`*_test` only under `CI=true`; `DB_TEST_REQUIRED=1` fails instead of skipping). |
| M1 / R-12 | E3 creates no logins and touches no credentials | Unchanged E2 code paths. |
| QA B3 role backfill | Existing companies would not get E3 menus | Idempotent `ETMS-E3-BACKFILL` block in `etms_bookings_trips` (unchanged seeded templates only; DB-tested twice). |

Isolation matrix (E3): projection checks on booking list (no personal point), booking detail (consented pickup shown,
rounded for the dispatcher), board (no other company's queue / trips), self endpoints (only the caller's rows, no other
passenger's ids / names / address), draft detail; separate leak tests for bookings CSV, consent model (withdrawn,
forged on-behalf grant, offline consent), self view across companies (404), vehicle window (outside → hidden, inside
with a live fix → shown, after the trip + 10 min → hidden), My commute points, erasure.

## 3. Gap fixes (second commit)

1. **MeTripDto**: `plannedStart` / `plannedEnd`; `myPickupPoint` / `myDropPoint` = the caller's own booking points,
   only with their effective routing consent (`pointsHidden: CONSENT_REQUIRED` otherwise). Web: the vehicle window
   uses the trip times (start − 30 min … end + 10 min, like the server), the map shows my own pickup / drop and the
   vehicle inside the window.
2. **`GET /api/transport/dispatch/change-sets/:id`** (etms_dispatch view): a DRAFT's changes with vehicle / driver /
   passenger / trip names and "would be refused now" issues; own company, and every vehicle, trip and booking named
   must be in the caller's scope (else 404, checked in code as well as in the query); stop points per M3 (withheld
   when a passenger of the draft has no consent). Web: "Details" on saved drafts.
3. **`ADD_STOP` change-set op** (existing, not-started ETMS trip): point taken from the booking server-side (a
   client point is refused); booking waiting, same date / direction, consent, capacity, max stops, planned between its
   neighbours, overlap re-checked when the trip grows; later stops and seats renumbered (drop before pickup for the
   seq CHECK, highest stop first for the unique index); path re-planned via RoutingService or cleared; event
   `STOP_ADDED` without coordinates; trip audit with `stopsAdded`; Idempotency-Key / expectedVersions of the change
   set. Web: a pickup > 300 m from every stop defaults to a new stop at the cheapest insertion point; the dispatcher
   can pick "New stop after …" or an existing stop; the change set carries ADD_STOP then ADD_PASSENGER with renumbered
   seqs.
4. **TRIP candidate road ETA**: RoutingService (GraphHopper) from the planned stop before the insertion point to the
   pickup, `at` = that stop's planned departure + road time (`model ROAD`, `from TRIP_STOP`); null with
   `ROUTING_UNAVAILABLE` / `NO_ROUTE` / `NO_PICKUP`. Web label "estimate · no live traffic".

## 4. Verification

| Check | Result |
|---|---|
| API `tsc --noEmit` | 0 errors |
| API `jest` (full) | 167 suites passed, 6 skipped (DB-gated); **2,952 passed**, 46 skipped (merge commit alone: 166 suites, 2,926) |
| of which isolation matrix | 1,276 (E3: 42 routes, 621 cells) |
| of which E3 dispatch specs | 51 (gaps spec 7) |
| API `nest build` | OK |
| Web `tsc -b --noEmit` / `node --test` | 0 errors / **278 passed** |
| Web build | OK; `check-no-external-maps: OK, 675 files scanned` |
| Mobile `tsc --noEmit` | 0 errors |
| DB tests, fresh `veetrax_e3int_test`, `CI=true DB_TEST_REQUIRED=1` | **26 passed**: etms-bookings-trips 11 (incl. E3 backfill, erasure, ADD_STOP on PostgreSQL with a parallel race), etms-people 6, etms-accounts 2, company-directory 1, company-settings 1, purge-financial 5 |
| Fresh `veetrax_e3int_test` drift | `prisma migrate diff --from-url … --to-schema-datamodel prisma/schema.prisma` → "No difference detected." |

### Migration v1.10.0 → HEAD on a fresh database (`veetrax_e3int_mig_test`)

1. `git archive v1.10.0 apps/api/prisma`; `prisma migrate deploy --schema <v1.10.0>/schema.prisma` → 61 migrations,
   last `20261115090000_etms_people`; drift against the v1.10.0 schema: none.
2. `prisma migrate deploy` from HEAD → "63 migrations found", applied `20261116090000_etms_bookings_trips` and
   `20261116090100_planned_trip_origin`; no checksum complaint (etms_people unchanged); `migrate status` "Database
   schema is up to date!".
3. `prisma migrate diff --from-url <db> --to-schema-datamodel prisma/schema.prisma` → "No difference detected."
   (`--exit-code` 0). EXCLUDE constraints present: `PlannedTrip_etms_vehicle_overlap_excl`, `_driver_overlap_excl`.

### btree_gist

Local role `veetracer`: not superuser, owner of the scratch databases. `btree_gist` 1.8 is a **trusted** extension on
PostgreSQL 18.6, so the migration's own `CREATE EXTENSION IF NOT EXISTS btree_gist` succeeded as the database owner
(extension owner `veetracer`); no superuser step was needed locally and nothing was pre-installed. Production: the
migration role cannot create it there, so install it once as postgres **before** `prisma migrate deploy`:
`sudo -u postgres psql -d veetracer -c 'CREATE EXTENSION IF NOT EXISTS btree_gist;'` (the statement in the migration
is then a no-op).

## 5. For the owner

- Trip detail (`/transport/trips/:id`) still shows stop coordinates of published trips even after a passenger
  withdraws consent (the stops are the trip's operational plan). Withdrawal does not yet cancel future bookings /
  seats; erasure requires cancelling them first. Decide whether withdrawal should cancel and re-plan (E4 candidate).
- Board reads with consented personal points are not ACCESS-audited (the board refetches on every live update);
  booking detail follows the E2 projection rules without an access audit either.
- New UI strings (E2 security fixes + this work) need Hindi / Tamil translations.
- The memory test store now ignores `undefined` fields on insert (as Prisma does); it had hidden a replay case.
