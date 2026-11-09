# Company deletion: retention-safe design (R-36)

Status: **Design only. Nothing here is implemented.** Branch at time of writing: `feature/s0-safety` (after commit `580dd52`).
Owner instruction: *"Legal GST invoices and payment history must not be permanently deleted through ordinary company deletion. Design a retention-safe archival or soft-delete approach and document the legal and technical implications before implementing it."*

Evidence labels: **Confirmed** = read in the code or schema at the cited line. **Inferred** = follows from the code but was not run against a database. Nothing in this document was run against any database.

The legal notes in section 2 are **not legal advice**. They list the points a Chartered Accountant or lawyer must confirm before the retention periods are fixed.

---

## 0. Summary

| Question | Answer |
|---|---|
| Is R-36 real? | **Confirmed (static).** Super Admin "Delete permanently" on a company deletes every `Invoice`, `CreditNote`, `LicenceOrder`, `LicenceSeat`, `BillingProfile` and `AuditLog` row of that company in one transaction. RESTRICT foreign keys do not stop it, because the planner deletes RESTRICT children first. It still needs an integration test on an isolated DB (section 6) before the register can say "Confirmed (executed)". |
| Same risk through a second route? | **Yes.** On `/delete-account`, the last user of an INDIVIDUAL or FAMILY account runs the same company purge, so a consumer's GST invoices are destroyed as well. This contradicts the privacy policy, which says invoices are kept "as long as tax law requires". |
| Other delete paths | `DELETE /admin/companies/:id` (plain delete) **cannot** destroy invoices: every real company has RESTRICT children, so it fails with 409. User, device and object purges, the retention job, transfers and partner management do **not** touch financial rows. |
| Invoice numbering | The counters are never decremented, so numbers are not reused. Each purge still leaves **holes** in a series that was gap-free, and changes past GST CSV exports. |
| Recommendation | Option (d), a hybrid. A company moves through **ACTIVE → SUSPENDED → ARCHIVED → PURGED_OPERATIONAL**. The purge removes operational and location data and personal data the law doesn't require. Financial records are kept, detached from the company by their existing snapshots and protected by a database guard. Financial rows may be deleted only after `retainUntil`, by a separate job that needs explicit approval. |

---

## 1. What each deletion path does today

### 1.1 Super Admin "Delete permanently" (purge): `POST /admin/purge/company/:id`

Entry points:
- UI: [CompaniesPage.tsx:142](../../apps/web/src/features/platform/CompaniesPage.tsx#L142) adds `usePurgeAction('company')` to every company row ([:170](../../apps/web/src/features/platform/CompaniesPage.tsx#L170)). The dialog text says only that it "removes the item and all its history… only a database backup can bring it back" ([PurgeDialog.tsx:54](../../apps/web/src/features/platform/PurgeDialog.tsx#L54)). It does not mention invoices.
- API: [purge.controller.ts:38](../../apps/api/src/purge/purge.controller.ts#L38) calls `PurgeService.purge` ([purge.service.ts:48](../../apps/api/src/purge/purge.service.ts#L48)). There is a GET preview first ([purge.service.ts:34](../../apps/api/src/purge/purge.service.ts#L34)) that shows row counts per table.

Guards (**Confirmed**, [purge.service.ts:117-145](../../apps/api/src/purge/purge.service.ts#L117)):
- Super Admin only ([:118](../../apps/api/src/purge/purge.service.ts#L118)).
- Not the platform company ([:141](../../apps/api/src/purge/purge.service.ts#L141)), and not a company that contains a Super Admin user ([:142](../../apps/api/src/purge/purge.service.ts#L142)).
- The Super Admin must type the company name ([:50](../../apps/api/src/purge/purge.service.ts#L50)).
- **There is no check for invoices, orders, credit notes or payments.** There is also no check whether the company is a partner's home company (`Partner.homeCompanyId` is a plain column with no FK: [schema.prisma:61](../../apps/api/prisma/schema.prisma#L61)).

How the plan is built (**Confirmed**):
1. `loadCatalog` reads every foreign key and its `confdeltype` from `pg_constraint`, plus every column of every table ([purge.service.ts:164-182](../../apps/api/src/purge/purge.service.ts#L164)).
2. `planPurge` walks the graph from `Company` ([purge-plan.ts:55-88](../../apps/api/src/purge/purge-plan.ts#L55)). For every FK whose parent is the current table, it **recurses into the child unless the rule is SET NULL or SET DEFAULT**:
   ```ts
   if (fk.del === 'n' || fk.del === 'd' || path.includes(fk.child)) continue;
   walk(fk.child, ...)
   ```
   ([purge-plan.ts:74-75](../../apps/api/src/purge/purge-plan.ts#L74)). RESTRICT (`r`), NO ACTION (`a`) and CASCADE (`c`) children are therefore all scheduled for deletion before their parent. In practice RESTRICT protects nothing during a purge.
3. "Logical keys": every other table that has a `companyId` column with no FK on it is deleted too ([purge-plan.ts:33](../../apps/api/src/purge/purge-plan.ts#L33), [:77-84](../../apps/api/src/purge/purge-plan.ts#L77)). This covers Trip, Stop, Alert, Geofence, RelayTarget, MobileTrackerCode, AttendanceSettings, DailySummary and others.
4. Extra statements delete the company's devices' `RawPacket` rows by IMEI and remove its device ids from `RelayTarget.deviceIds` ([purge.service.ts:103-115](../../apps/api/src/purge/purge.service.ts#L103)).
5. Execution ([purge.service.ts:79-94](../../apps/api/src/purge/purge.service.ts#L79)): **one interactive Prisma `$transaction`** with a 30-minute timeout ([:12](../../apps/api/src/purge/purge.service.ts#L12), [:84-89](../../apps/api/src/purge/purge.service.ts#L84)). The extra statements run first, then every `DELETE`/`UPDATE … SET NULL` step in child-first order. After the commit it clears the live Valkey keys ([:90](../../apps/api/src/purge/purge.service.ts#L90)) and writes **one** audit row through `recordSystem`, outside the transaction ([:91](../../apps/api/src/purge/purge.service.ts#L91)).

Financial edges the walk follows (**Confirmed** in schema and migrations):

| Child table | FK | Rule | Evidence | Deleted by company purge? |
|---|---|---|---|---|
| `LicenceOrder` | `companyId → Company` | RESTRICT | [schema.prisma:1657](../../apps/api/prisma/schema.prisma#L1657), [migration:226](../../apps/api/prisma/migrations/20261019200000_licences_billing/migration.sql#L226) | **Yes** |
| `Invoice` | `companyId → Company` | RESTRICT | [schema.prisma:1700](../../apps/api/prisma/schema.prisma#L1700), [migration:235](../../apps/api/prisma/migrations/20261019200000_licences_billing/migration.sql#L235) | **Yes** |
| `Invoice` | `orderId → LicenceOrder` | RESTRICT | [schema.prisma:1699](../../apps/api/prisma/schema.prisma#L1699), [migration:232](../../apps/api/prisma/migrations/20261019200000_licences_billing/migration.sql#L232) | **Yes** (reached again through the order) |
| `CreditNote` | `companyId → Company`, `invoiceId → Invoice` | RESTRICT | [schema.prisma:1752-1753](../../apps/api/prisma/schema.prisma#L1752), [migration:68-71](../../apps/api/prisma/migrations/20261019210000_licence_credit_notes_api/migration.sql#L68) | **Yes** |
| `LicenceSeat` | `companyId → Company` | CASCADE | [schema.prisma:1627](../../apps/api/prisma/schema.prisma#L1627) | **Yes**, including seats a partner allocated to this customer |
| `BillingProfile` | `companyId → Company` | CASCADE | [schema.prisma:1599](../../apps/api/prisma/schema.prisma#L1599) | **Yes** |
| `AuditLog` | `companyId → Company` | RESTRICT | [schema.prisma:597](../../apps/api/prisma/schema.prisma#L597), [init migration:483](../../apps/api/prisma/migrations/20261018002831_init/migration.sql#L483) | **Yes**: the company's whole audit trail, including billing events |
| `UpiPaymentClaim` | `ownerId` (no FK, no `companyId` column) | — | [schema.prisma:1979-2002](../../apps/api/prisma/schema.prisma#L1979) | **No**, but it is left orphaned. The admin list shows owner "—" ([upi.service.ts:105-119](../../apps/api/src/licences/upi.service.ts#L105)) |
| `InvoiceCounter`, `CreditNoteCounter` | none | — | [schema.prisma:1711](../../apps/api/prisma/schema.prisma#L1711), [:1763](../../apps/api/prisma/schema.prisma#L1763) | **No**. Numbers are not reused, but the deleted numbers become holes in the series |
| Invoice and credit note PDFs on disk (`var/invoices/<fy>/…`) | — | — | [invoices.service.ts:15](../../apps/api/src/licences/invoices.service.ts#L15), [:215-224](../../apps/api/src/licences/invoices.service.ts#L215) | **No**. The purge never touches files, so the PDFs stay behind without DB rows. The same applies to Document, driver-media and attendance-selfie files, which keep personal data on disk (**Inferred**: `execute` runs only SQL and Valkey) |

Order inside the transaction (**Inferred** from the walk; the exact order depends on catalogue order): RawPacket → RelayTarget update → the deep children of Branch, User, Role, Device and TrackedObject → … → `CreditNote` → `Invoice` → `LicenceOrder` → `LicenceSeat` → `BillingProfile` → `AuditLog` → logical-`companyId` tables → `Company` last. The existing unit test locks in the current behaviour, including the deletion of `LicenceSeat` ([purge-plan.spec.ts:52](../../apps/api/src/purge/purge-plan.spec.ts#L52)). No test covers financial tables.

**R-36 verdict: Confirmed (by static analysis).** Nothing in the planner or service treats financial tables differently, and the RESTRICT rules on them are walked like any other edge. The remaining step is to run it once on an isolated DB (test T-I1 in section 6) and update the register entry to "Confirmed (executed)".

Further harm the same purge does:
- **Gap-free series broken** (**Inferred**): `nextInvoiceSeq` ([invoice-numbering.ts:13](../../apps/api/src/licences/invoice-numbering.ts#L13)) keeps counting, so the deleted `fy/seq` numbers disappear for good. The GST CSV export for an already-filed month ([invoices.service.ts:282](../../apps/api/src/licences/invoices.service.ts#L282)) would no longer match GSTR-1, including the Table 13 document summary.
- **Partner pool loss** (**Inferred**): seats with `companyId` set and `partnerId` set (allocated by a partner) are deleted rather than returned to the partner pool.
- **Device inventory loss** (**Inferred**): `Device.companyId` is RESTRICT, so physical trackers are deleted as stock records instead of being released.

### 1.2 Self-service account deletion: `POST /me/account/delete`

[purge.controller.ts:18-26](../../apps/api/src/purge/purge.controller.ts#L18) calls `deleteOwnAccount` ([purge.service.ts:61-77](../../apps/api/src/purge/purge.service.ts#L61)). It is used by the web page `/delete-account` ([LegalPages.tsx:319-334](../../apps/web/src/features/legal/LegalPages.tsx#L319)) and by the mobile app ([profile.tsx:117](../../apps/mobile/src/app/profile.tsx#L117)).
- If the caller is the **last user of an INDIVIDUAL or FAMILY account**, `kind = 'company'` ([:68-71](../../apps/api/src/purge/purge.service.ts#L68)) and the **same company purge** runs through `execute` (section 1.1). The account's invoices, credit notes, orders and audit trail are destroyed. **Confirmed.**
- Otherwise `kind = 'user'`, which removes only the login (section 1.4).
- The audit row is written with `companyId: null` ([:75](../../apps/api/src/purge/purge.service.ts#L75)).
- The privacy policy promises "Invoices: as long as tax law requires" ([LegalPages.tsx:263](../../apps/web/src/features/legal/LegalPages.tsx#L263)). The code contradicts this today. **Confirmed.**

### 1.3 Plain company delete: `DELETE /admin/companies/:id` and bulk "remove"

[companies.controller.ts:42](../../apps/api/src/masters/companies/companies.controller.ts#L42) calls [companies.service.ts:131-135](../../apps/api/src/masters/companies/companies.service.ts#L131), which runs `prisma.company.delete` with no transaction wrapper beyond Prisma's own. The bulk path ([:137-142](../../apps/api/src/masters/companies/companies.service.ts#L137)) does the same.
- Every company gets a "Head Office" branch, system roles and an Admin user at creation ([:95-107](../../apps/api/src/masters/companies/companies.service.ts#L95)). All of these are RESTRICT children, so the delete fails with P2003, which is mapped to HTTP 409 "In use… ask a Super Admin to delete it permanently" ([prisma-errors.ts:4](../../apps/api/src/common/prisma-errors.ts#L4), [:15-17](../../apps/api/src/common/prisma-errors.ts#L15)).
- **Result: this path cannot destroy financial records** (**Confirmed** from the schema; **Inferred** that it never succeeds for a real company). Its error message sends the operator to the purge, which can.

### 1.4 Other paths: none touch financial rows

| Path | Financial effect | Evidence |
|---|---|---|
| Purge `user` (Super Admin, or self-delete of a non-last or business user) | None. `LicenceSeat.userId` is SET NULL, so the seat stays in the pool. `createdById`/`decidedById` on orders, credit notes and claims have no FK, and `User` has no logical key, so the audit rows by `userId` stay. | [schema.prisma:1629](../../apps/api/prisma/schema.prisma#L1629), [purge-plan.ts:33](../../apps/api/src/purge/purge-plan.ts#L33) — **Confirmed** |
| Purge `device` / `object` | None. `LicenceSeat.deviceId` and `fuelObjectId` are SET NULL. | [schema.prisma:1630-1631](../../apps/api/prisma/schema.prisma#L1630) — **Confirmed** |
| Retention job (hourly) | None. It deletes only Position, Trip, Stop, FuelEvent, closed GeofenceVisit, NotificationLog, AlertRead, Alert, DriverEvent and media, RawPacket, UnknownDevice, expired Session/OTP/PasswordReset rows, and WebhookDelivery. | [retention.service.ts:108-138](../../apps/api/src/retention/retention.service.ts#L108), [:163-188](../../apps/api/src/retention/retention.service.ts#L163) — **Confirmed** |
| Transfers (object, device, driver) | Moves seats with their device or fuel sensor (`licenceSeat.updateMany`). No invoice, order or audit deletion. | [transfer.service.ts:83](../../apps/api/src/transfer/transfer.service.ts#L83), [:155](../../apps/api/src/transfer/transfer.service.ts#L155) — **Confirmed** |
| Partner management | There is no partner delete endpoint. `setCompanyPartner` only re-points `Company.partnerId`. | [partners.service.ts:137-142](../../apps/api/src/licences/partners.service.ts#L137) — **Confirmed** |

---

## 2. Legal and compliance implications (India). Confirm with a CA or lawyer

These are the supplier's (VeeTrax's) own records. The duty to keep them rests on the supplier, whatever the customer asks for.

| # | Topic | Working understanding (to confirm) | Design consequence |
|---|---|---|---|
| L1 | **GST record retention**: CGST Act s.35/s.36, Rules 56–58 | Accounts and records, including tax invoices, credit notes and payment vouchers, must be kept for **72 months from the due date of the annual return (GSTR-9) for the year they relate to**. The GSTR-9 due date is normally 31 December after the FY ends. If appeals, revision or investigation proceedings are pending, they must be kept until **one year after final disposal**, or for the 72-month period if that is later. Electronic records are allowed with backup and must be produced on demand (Rule 56(15)/57). | `retainUntil ≥ 31 Dec (FY end year) + 6 years` for the latest financial document. For example, FY 2026-27 → GSTR-9 due 31-Dec-2027 → keep until **31-Dec-2033**. A `legalHold` flag must be able to extend this indefinitely. |
| L2 | **Invoice content**: Rule 46 (tax invoice), s.34 and Rule 53 (credit note) | An invoice must show the supplier's name, address and GSTIN; a consecutive serial number unique per FY; date; the recipient's name, address and GSTIN (if registered); place of supply and state; SAC; taxable value; rate and amount of CGST/SGST/UTGST/IGST; and the signature. | Snapshots already hold this ([invoices.service.ts:127-178](../../apps/api/src/licences/invoices.service.ts#L127), [schema.prisma:1667-1708](../../apps/api/prisma/schema.prisma#L1667)): `supplier` JSON, `buyer` JSON (name, address, state, PIN, GSTIN, email), `lines`, tax split and `paymentMode/Reference`. **Invoice rows can outlive the Company row without losing legally required content.** Credit notes have `snapshot` JSON as well. |
| L3 | **Gap-free numbering** (Rule 46(b); GSTR-1 Table 13) | Numbers must be consecutive per FY. Missing numbers must be explained as cancelled. | No issued invoice or credit note number may ever be physically removed inside the retention window. Counters are never decremented. |
| L4 | **Income Tax**: s.44AA and Rule 6F (Income-tax Act 1961; renumbered under the Income-tax Act 2025 from 1-Apr-2026, to confirm) | Books are generally kept for **6 years from the end of the relevant assessment year**. Reassessment windows can be longer (up to 10 years in some cases). | This may exceed L1. The CA must say which period is the binding one. |
| L5 | **Companies Act 2013** s.128(5) (if VeeTrax's legal entity is a company) | Books of account are kept for **8 financial years** before the current year. | This is likely the longest period. A conservative default is **end of FY + 8 years**. |
| L6 | **DPDP Act 2023** s.8(7) and s.12 (erasure), DPDP Rules 2025 (phased commencement) | A Data Fiduciary must erase personal data when the purpose is served or consent is withdrawn, **unless retention is necessary to comply with a law in force**. The Rules also require some logs to be kept (about 1 year, to confirm) and notice before erasure for certain classes of fiduciaries. | Keep **only** what law requires: invoice and credit-note snapshots, order and payment references, claim UTRs. **Erase or anonymise the rest**: logins, phone numbers, location history, selfies, documents, contacts in recipient lists. The data principal must be told what is kept and why. The `/delete-account` page text must change. |
| L7 | **Location data** | No tax law requires tracking or location history to be kept. Possible exceptions: AIS-140 / VLTD rules for public-service vehicles (kept by the state backend, not VeeTrax, to confirm), and court or police preservation requests. | Location and operational history are **purged** at PURGED_OPERATIONAL unless a legal hold applies. |
| L8 | **Security logs**: CERT-In Directions 2022 | ICT system logs are kept for **180 days in India**. | Purge-related `AuditLog` rows (who archived or purged, when, from which IP) are kept for at least 180 days, and for the financial-retention period when they record billing events. |
| L9 | **Customer access after archival** | A registered buyer may need the invoice copy for ITC. There is no explicit duty to host it, but it is good practice to send it on request. | An open decision (O2). The design keeps the data available to Super Admin, who can always resend a PDF. |

---

## 3. Options

| Criterion | (a) Soft-delete / archive only | (b) Purge operational, retain financial detached (SetNull + snapshots) | (c) Export then hard delete everything | (d) **Hybrid**: (a) then (b), plus an approval-gated final financial purge after `retainUntil` |
|---|---|---|---|---|
| Legal fit (GST, IT) | Good: nothing is lost | Good: invoices, credit notes, orders and claims stay queryable | **Weak**: the records leave the system of record. An export file must itself meet Rule 56/57 (integrity, production on demand) and keep the series. Gaps appear in DB-based GSTR exports. | **Best** |
| Privacy fit (DPDP) | **Weak**: keeps location history and personal data indefinitely | Good: only legally required personal data remains | Good | **Best**: time-boxed archive, then minimisation |
| Engineering effort | Low (status, filters, guards) | Medium (planner exclusions, FK changes, anonymisation) | Medium (export bundle and verification) plus the same planner changes | Medium-high (a + b + job + UI) |
| Migration risk | Additive only | Includes FK rule changes (destructive class, approval needed) | Additive | Same as (b) |
| Reversibility | Full | Operational data gone; financial rows intact | None (backup only) | Full during ARCHIVED; financial rows intact after the purge |
| UI/API impact | Lists hide ARCHIVED; login blocked | Purge preview shows "kept" vs "deleted" | New export step | All of these; the purge dialog becomes a wizard |
| Licence and partner pools | Seats frozen with the company | Seats must be expired or returned before the purge | Same | Seats expire or return to the partner at archive (O3) |
| Invoice numbering | Intact | Intact | **Broken** unless the export is treated as the legal ledger | Intact |

**Rejected:** (c) on its own, because it breaks numbering integrity and turns a file into the legal ledger. (a) on its own, because it keeps location and personal data with no time limit, against DPDP minimisation.

---

## 4. Recommended design (hybrid)

### 4.1 State machine

```
            suspend                archive (2-step, reason)          purge-operational (2-step, after grace)
 ACTIVE ───────────────▶ SUSPENDED ─────────────────────▶ ARCHIVED ─────────────────────────────────▶ PURGED_OPERATIONAL
   ▲          reactivate     │  ▲      restore (SA, reason)   │                                             │
   └─────────────────────────┘  └─────────────────────────────┘                                             │
                                                                     financial purge job: only when now ≥ retainUntil,
                                                                     no legalHold, AND explicit SA approval  ▼
                                                                                              (financial rows deleted;
                                                                                               Company row may then go)
```

| State | Login and API | Visible in SA lists | Data | Exit |
|---|---|---|---|---|
| ACTIVE | yes | yes | everything | suspend |
| SUSPENDED (exists today, [schema.prisma:17-20](../../apps/api/prisma/schema.prisma#L17)) | blocked | yes | everything | reactivate / archive |
| ARCHIVED | blocked. API keys revoked, webhooks disabled, devices stop ingesting into the company | only behind an "Archived" filter | everything kept, hidden. `retentionDays` sweeps continue | restore, or purge-operational after a grace period (default 30 days, O4) |
| PURGED_OPERATIONAL | none | "Archived" filter, read-only financial tab | Company row kept as a **tombstone** (id, name, partnerId, timestamps, retention fields). Financial rows kept. Everything else removed or anonymised (matrix in 4.2). | final financial purge only (4.6) |

The self-service `/delete-account` for a personal account becomes **ARCHIVED, then automatic PURGED_OPERATIONAL** after a short grace period (for example 7 days, so a mistaken deletion can be undone, O4). For the user it behaves like a deletion. Invoices are kept.

### 4.2 Table-by-table matrix at PURGED_OPERATIONAL

Legend: **P** = purged (deleted). **R** = retained unchanged. **R-D** = retained and detached (company FK nulled or kept to the tombstone; the snapshot is the source of truth). **A** = anonymised in place. **Rel** = released or returned rather than deleted.

| Table(s) | Action | Notes |
|---|---|---|
| `Company` | **R** (tombstone) | Clear `settings` to `{}`. Keep `name` (it also appears in invoice buyer snapshots, which law requires). |
| `Invoice`, `CreditNote` | **R** | Never touched by the operational purge. They keep `companyId → tombstone`. Under Option B-alt (4.3) they get `companyId = NULL` and `formerCompanyId`. |
| `LicenceOrder` | **R** | Payment history (Razorpay ids, reference, `paidAt`, `amountPaise`, `items`). |
| `UpiPaymentClaim` | **R** | UTR and amount are payment evidence. `customerNote` is **A** (cleared) unless the claim is linked to an issued invoice. |
| `InvoiceCounter`, `CreditNoteCounter` | **R** | Never modified by any deletion path. |
| `BillingProfile` (company) | **R** until the final financial purge, or **A** if the snapshot is enough | Invoices already hold buyer snapshots, so the profile is not legally needed. Default: **delete at PURGED_OPERATIONAL** (O5). Today it is CASCADE, so the planner must handle it explicitly. |
| `LicenceSeat` (company pool) | **Rel / P** | Unexpired seats allocated by a partner (`partnerId` set) **return to the partner pool** (`companyId = NULL`) if the partner agrees (O3). Seats bought directly by the company expire at ARCHIVED and are deleted at the purge. Invoice `lines.seatIds` stay as historical ids. |
| `AuditLog` (company) | **Split** | Billing entities (`invoice`, `creditNote`, `licenceOrder`, `upiClaim`, `licence*`, `billingProfile`, `company` lifecycle) are **R-D**. Everything else is kept 180 days after the purge (CERT-In), then **P**. The `ip` and `changes` personal fields are **A** in kept rows that are not billing rows. |
| `User`, `UserRole`, `UserBranch`, `UserObject`, `Session`, `PushToken`, `PasswordReset` | **P** | Removing logins is the main privacy goal. |
| `Role`, `RolePermission`, `Branch`, `VehicleGroup*`, `Lookup` (company), `Poi`, `Geofence*`, `AlertSetting`, `RecipientList`, `AlertSnooze`, `AlertPack` (company), `MessageTemplate*` (company), `ReportSchedule`, `ReportRun`, `ParkingSchedule`, `AttendanceSettings` | **P** | Configuration. |
| `TrackedObject`, `ObjectRemark`, `Driver`, `DriverAssignment`, `Document`, `ServiceReminder`, `ServiceRecord`, `FuelConfig`, `IoSensorConfig`, `LiveShare`, `VehicleShare` | **P** | **And their files on disk** (documents), which the current purge leaves behind. |
| `Position`, `Trip`, `Stop`, `FuelEvent`, `IoSession`, `GeofenceVisit`, `Alert`, `AlertRead`, `NotificationLog`, `DailySummary`, `AttendanceDay`, `AttendanceSelfie`, `AttendanceOuting`, `Expense`, `DriverEvent`, `DriverEventMedia`, `DeviceCommand`, `RawPacket` (by IMEI) | **P** | Location and personal history, **plus media and selfie files on disk**. |
| `Device` | **Rel** | `companyId = NULL`, released to platform or partner stock, its assignments deleted. Delete the device row only for app-tracker devices (`mobile` protocol), which are not physical stock. |
| `MobileTrackerCode`, `TrackerEvent`, `MobileTrackerSession` | **P** | |
| `ApiKey`, `WebhookEndpoint`, `WebhookDelivery` | **P** | Revoked at ARCHIVED. |
| `RelayTarget` (company-scoped) | **P** | Remove the company's devices from global targets (existing step at [purge.service.ts:113](../../apps/api/src/purge/purge.service.ts#L113)). |
| Invoice and credit note PDFs (`var/invoices/…`) | **R** | Kept on disk and in the encrypted backup (S0.3). |
| `Partner.homeCompanyId` pointing at this company | **guard** | Refuse to archive a partner's home company until the partner is re-homed (O3). |

### 4.3 Schema changes

**Additive (safe, no approval beyond the normal review):**

```prisma
enum CompanyStatus { ACTIVE SUSPENDED ARCHIVED PURGED_OPERATIONAL }   // ALTER TYPE … ADD VALUE: additive

model Company {
  // …existing
  deletionRequestedAt DateTime? @db.Timestamptz(3)  // who asked (self or SA): start of grace
  deletionRequestedBy String?   @db.Uuid
  deletionReason      String?
  archivedAt          DateTime? @db.Timestamptz(3)
  archivedById        String?   @db.Uuid
  operationalPurgedAt DateTime? @db.Timestamptz(3)
  retainUntil         DateTime? @db.Timestamptz(3)  // computed at archive / purge (4.4); null = no financial rows
  legalHold           Boolean   @default(false)
  legalHoldNote       String?
}

// Optional (only with option B-alt below): survives the company row
model Invoice     { formerCompanyId String? @db.Uuid  /* + @@index */ }
model CreditNote  { formerCompanyId String? @db.Uuid }
model LicenceOrder{ formerCompanyId String? @db.Uuid }
model AuditLog    { retainUntil DateTime? @db.Timestamptz(3) }  // per-row retention for split audit handling

// Approval record for the destructive financial purge (4.6)
model RetentionApproval { id, companyId, requestedById, requestedAt, approvedById?, approvedAt?, reason, scope Json, executedAt? }
```

A DB-level guard (additive SQL in a migration, needs no data change): a `BEFORE DELETE` trigger on `Invoice`, `CreditNote`, `LicenceOrder`, `InvoiceCounter` and `CreditNoteCounter` that raises unless the session setting `vt.financial_purge_approval` equals an approved, unexecuted `RetentionApproval.id` whose company has `retainUntil < now()` and `legalHold = false`. This protects financial rows from **any** code path, including future planner bugs and ad-hoc SQL by the app role.

**Destructive class (each needs explicit owner approval):**

| Change | Why it counts as destructive | Needed? |
|---|---|---|
| **Option B-main (recommended): keep the FKs as RESTRICT.** Financial rows keep pointing at the tombstone `Company`, which is never deleted while financial rows exist. | **No FK change.** | This is the default. It avoids every destructive FK migration. |
| Option B-alt: change `Invoice/CreditNote/LicenceOrder.companyId` FKs RESTRICT → `SET NULL`, with `formerCompanyId` backfilled | Rewrites FK constraints. A wrong backfill loses the customer link. | Only if the owner wants the Company row itself to disappear before the financial retention ends. |
| Changing `BillingProfile.companyId` and `LicenceSeat.companyId` from CASCADE → RESTRICT or SET NULL | Alters delete behaviour that existing code relies on | Not required. The planner handles these tables explicitly instead. |
| Changing `AuditLog.companyId` RESTRICT → SET NULL | Constraint rewrite | Not required with the tombstone approach. |
| Removing or anonymising columns in existing rows (`UpiPaymentClaim.customerNote`, `AuditLog.ip`) | Data rewrite, irreversible | Yes, for minimisation. Done by the purge job, not by the migration. |
| Adding enum values `ARCHIVED` and `PURGED_OPERATIONAL` | Additive. Any code with exhaustive `switch`/`status: active ? 'ACTIVE' : 'SUSPENDED'` mapping ([companies.service.ts:27](../../apps/api/src/masters/companies/companies.service.ts#L27)) must be updated first | Yes (additive) |

### 4.4 Computing `retainUntil`

```
for each financial document D of the company (Invoice.issuedAt, CreditNote.issuedAt, LicenceOrder.paidAt|createdAt, UpiPaymentClaim.createdAt):
    fyEnd(D)          = 31 Mar of the Indian FY containing D
    gstr9Due(D)       = 31 Dec of the year of fyEnd(D)           // configurable; extensions by notification
    gstUntil(D)       = gstr9Due(D) + 72 months                  // CGST s.36
    booksUntil(D)     = fyEnd(D) + RETENTION_BOOKS_YEARS (default 8, Companies Act s.128) // IT/CA confirm
    until(D)          = max(gstUntil(D), booksUntil(D))
retainUntil = max(until(D)) over all D     // null if no financial documents
```
- `PlatformBillingSettings` gets configurable `gstRetentionMonths` (72) and `booksRetentionYears` (8). This is additive. The CA confirms the values (O1).
- If `legalHold = true`, `retainUntil` is treated as infinite.
- Recompute it whenever a credit note or a late order is issued against an archived company. A credit note can be issued after archival, for example for a refund.

### 4.5 Super Admin UI flow

1. **Companies → row → "Close account…"** replaces "Delete permanently" for companies.
2. **Step 1, Archive:** a reason (required, at least 10 characters) and a summary panel. The summary shows N users, devices and vehicles, the location-history range, **N invoices, N credit notes, N orders and ₹ total that will be KEPT until `retainUntil`**, unexpired seats and what happens to them (expire, or return to partner X), and any partner home-company conflict. The Super Admin types the company name. Result: ARCHIVED, logins and API keys revoked, devices released or frozen.
3. **Export bundle** (offered at archive, required before the purge): a ZIP with every invoice and credit note PDF, the orders and claims as CSV, a company data export (users, vehicles, trips summary) for the customer if requested, and `manifest.json` with SHA-256 hashes. It is written under the encrypted backup path (S0.3). The download is audited.
4. **Step 2, Purge operational data** (enabled after the grace period): the preview splits into **"Will be deleted"** and **"Kept for legal retention"** tables. The Super Admin re-types the company name and the reason, then confirms with a second factor (password re-entry or OTP). Result: PURGED_OPERATIONAL.
5. **Archived filter** on the Companies list shows state, `archivedAt`, `retainUntil`, `legalHold` toggle (Super Admin, with a reason) and a read-only **Billing** tab (invoices, credit notes, orders, resend PDF).
6. `/delete-account` page text: *"Your login, phones, trackers and all location history are deleted. Tax invoices and payment records are kept as required by GST law until <date>, then deleted."*

### 4.6 Audit

- Every transition writes an `AuditLog` row: `COMPANY_ARCHIVE`, `COMPANY_RESTORE`, `COMPANY_PURGE_OPERATIONAL`, `LEGAL_HOLD_SET/CLEAR`, `FINANCIAL_PURGE_APPROVED/EXECUTED`, `EXPORT_DOWNLOADED`. Each row has the actor, IP, reason, row counts per table, `retainUntil`, and the export manifest hash. The row is attached to the **platform company**, so it survives the purge. This fixes the current pattern where the only record lives outside the transaction ([purge.service.ts:91](../../apps/api/src/purge/purge.service.ts#L91)).
- The transition audit row is written **inside** the same transaction as the purge, so the purge and its audit commit or roll back together.
- These audit rows get `retainUntil = company.retainUntil`.

### 4.7 Scheduled jobs

- **ArchiveSweepJob** (daily): moves `deletionRequestedAt + grace` self-service requests from ARCHIVED to PURGED_OPERATIONAL. It **never** touches financial tables, and it uses the same planner with the exclusion list.
- **FinancialRetentionJob** (daily, **report-only by default**): lists companies with `retainUntil < now()` and `legalHold = false` on a Super Admin "Due for final deletion" screen. It deletes nothing by itself.
- **Final financial purge** (manual, two-person rule recommended): a Super Admin requests it (`RetentionApproval`). A **different** Super Admin, or the owner, approves it. Only then does an endpoint run, in one transaction: `SET LOCAL vt.financial_purge_approval = '<id>'`, delete `CreditNote → Invoice → LicenceOrder → UpiPaymentClaim (ownerId) → financial AuditLog → BillingProfile → Company tombstone`, and the PDFs after the commit. **Counters are never touched.** Before deleting, the job writes a per-FY "numbers retired" register (`fy`, `seq` range, retiredAt), so a later auditor can see that the gaps are the result of lawful disposal. (Whether to do this at all is O6.)

### 4.8 Changes to the existing purge endpoint

1. **`planPurge` gains a `protect` set** (`Invoice`, `CreditNote`, `LicenceOrder`, `UpiPaymentClaim`, `InvoiceCounter`, `CreditNoteCounter`, `PlatformBillingSettings`). If the walk reaches a protected table and protected rows exist, the plan **refuses**. It does not skip them silently. The exception is the company kind running in "operational" mode, where the parent `Company` is not deleted (tombstone) and the protected tables are left alone. Add `Partner` and the tombstone `Company` as stop nodes.
2. **`PurgeService.target('company')`** refuses (409, "This company has N invoices / M credit notes / K orders. Close the account instead: they must be kept until <retainUntil>") unless the company is ARCHIVED and the call is the operational purge. It also refuses for a partner's home company.
3. **`kind='user'|'device'|'object'`** stay as they are (no financial impact), with the protected-table refusal added as defence in depth.
4. **`deleteOwnAccount` personal branch** → sets `deletionRequestedAt` and ARCHIVED, revokes the sessions, and returns `scope: 'account'`. The operational purge follows after the grace period. The mobile and web contract (`{ ok, scope, deletedRows }`) keeps its shape: `deletedRows` becomes `0` and a new `purgeScheduledAt` is added (additive).
5. **`DELETE /admin/companies/:id`** and bulk remove → **archive** (or 409 with a pointer to "Close account"). Never `company.delete`.
6. **Files**: the operational purge deletes Document, driver-media and selfie files after the commit, through a file list collected inside the transaction (fixes the leftover-files gap in 1.1).
7. **Seat handling** before the walk: partner-allocated seats → `companyId = NULL`. Own seats → deleted, recorded in the audit.
8. **Device release** before the walk: physical devices → `companyId = NULL`.

---

## 5. Migration and rollback plan

| Step | Content | Kind | Rollback |
|---|---|---|---|
| M1 | Enum values `ARCHIVED` and `PURGED_OPERATIONAL`, the new Company columns, `PlatformBillingSettings` retention settings, `RetentionApproval`, `AuditLog.retainUntil` | Additive | Columns stay unused. Postgres cannot drop enum values easily, so ship M1 only once the code is ready to handle them. |
| M2 | `BEFORE DELETE` guard triggers on the financial tables and counters | Additive (behavioural) | `DROP TRIGGER` (one statement, kept in the down script) |
| M3 | Code: planner protect set, new endpoints and UI, `/delete-account` behaviour, CompaniesService.remove → archive, unit tests updated ([purge-plan.spec.ts:52](../../apps/api/src/purge/purge-plan.spec.ts#L52) currently expects `LicenceSeat` to be deleted) | Code | Redeploy the previous build. M1 and M2 are compatible with the old code, except that the M2 trigger would make the **old** company purge fail with an error. That outcome is intended. |
| M4 (optional, approval) | Option B-alt FK change to SET NULL with a `formerCompanyId` backfill | **Destructive** | Restore the constraint (data stays, because the backfill is additive). Take a verified backup first (S0.3 restore drill). |

Pre-deploy checks: a query for orphaned financial rows from past purges (`Invoice` whose `companyId` is not in `Company`, which is impossible with RESTRICT, and gaps in `Invoice(fy, seq)` versus `InvoiceCounter.lastSeq`). Any gap found means a past purge already destroyed invoices. **Report it to the owner and the CA, and recover from backup.**

## 6. Test plan (isolated DB only: `vt_test`, never the live DB)

**Unit (planner, no DB):**
- U1: a catalogue that includes the real financial FKs → `planPurge(Company)` in operational mode never contains `Invoice`, `CreditNote`, `LicenceOrder`, `UpiPaymentClaim` or the counters, and never ends with `Company`.
- U2: the full-delete mode with a protected table in the walk → throws `ProtectedRecordsError`.
- U3: `retainUntil` computation: FY boundaries (31 Mar and 1 Apr), a late credit note extends the date, `legalHold`, and the configurable months.
- U4: `deleteOwnAccount` personal → archives and does not run `execute` with company kind (update [delete-own-account.spec.ts](../../apps/api/src/purge/delete-own-account.spec.ts)).
- U5: state machine: illegal transitions are rejected (ACTIVE→PURGED_OPERATIONAL, PURGED_OPERATIONAL→ACTIVE).

**Integration (real Postgres from migrations on `vt_test`):**
- **T-I1 (reproduce R-36, run on the current code before any change):** seed a company with 2 paid orders, 2 invoices, 1 credit note, a UPI claim and audit rows → run today's purge → assert that the invoices are gone. This turns the register entry into "Confirmed (executed)".
- T-I2: the same seed on the new code → archive → purge-operational → assert that:
  - `Invoice`, `CreditNote`, `LicenceOrder` and `UpiPaymentClaim` counts are unchanged, readable through the Super Admin invoice list and PDF endpoints, and the buyer snapshot is intact;
  - `InvoiceCounter.lastSeq` is unchanged and `(fy, seq)` is contiguous;
  - users, sessions, positions, trips, alerts, documents (DB **and files**), API keys and webhooks are 0 for the company;
  - devices are released (`companyId IS NULL`) and partner seats are back in the partner pool;
  - the billing audit rows remain and the transition audit row exists.
- T-I3: purge on a non-archived company with invoices → 409, no rows changed.
- T-I4: the trigger guard: a raw `DELETE FROM "Invoice"` without approval → error. With an approved and due `RetentionApproval` → succeeds, and the counters are untouched.
- T-I5: a new invoice after another company is purged gets `lastSeq + 1` (no reuse).
- T-I6: self-service `/delete-account` for a personal account with an invoice → login fails immediately; after the grace job runs, operational data is gone and the invoice remains.
- T-I7: GST CSV for a past month is byte-identical before and after an operational purge.

## 7. Open decisions for the owner

| # | Decision | Default proposed |
|---|---|---|
| O1 | **Retention period**: the CA confirms GST (72 months from the GSTR-9 due date) against IT and the Companies Act (8 FY), and VeeTrax's legal entity type | `max(GSTR-9 due + 72 m, FY end + 8 y)` |
| O2 | Can customers (or former customers) download their invoices after archival? Through a time-limited emailed link, by request to support, or not at all? | Support resends on request. No customer login after ARCHIVED. |
| O3 | **Partner pools**: on archive, do partner-allocated unexpired seats go back to the partner (and is the partner credited)? May a partner's home company be archived? | Return to the partner pool. Block archive of a home company until the partner is re-homed. |
| O4 | Grace periods: SA archive → operational purge, and self-service → purge | 30 days / 7 days |
| O5 | Keep `BillingProfile` until the final financial purge, or delete it at the operational purge (the snapshots are enough)? | Delete at the operational purge |
| O6 | Ever run the final financial purge, or keep financial rows indefinitely (cheap, but data minimisation)? Two-person approval? | Report-only job; two-person approval; "numbers retired" register |
| O7 | Option B-main (tombstone Company, no FK change) or B-alt (SET NULL, destructive migration)? | **B-main** |
| O8 | If the pre-deploy gap check finds invoices destroyed by a past purge: restore from backup and inform the CA? | Yes, before any further purge |
| O9 | Until this ships, disable the company purge for companies that have financial rows (a one-line guard in `target('company')`) as a stop-gap? | **Recommended, now** |
