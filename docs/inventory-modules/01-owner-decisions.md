# Inventory Modules — Owner Decisions (QI-1 … QI-24)

**Purpose:** a product-owner decision document for the Device Inventory, SIM, Vehicle and Invoice modules planned in [00 Phase A plan](00-phase-a-plan-and-dependency-map.md).
**Date:** 2026-11-09. **Branch at time of writing:** `feature/s0-safety`.
**Status:** for approval. **Nothing in this file is a decided rule.** Every "Recommended default" is a proposal from engineering for the owner to approve, change or reject.

**Owner instruction followed:** "Do not invent or assume commercial rules." Where the code already does something, that is reported as *current behaviour* with a file:line reference. Where it does not, no rule is assumed: engineering builds a neutral, configurable design and the business choice stays open.

**Evidence conventions:**
- Code paths are repo-relative, cited as `path:line`. Every citation was re-read in the source on 2026-11-09.
- Step ids (B1…F6) are the PRs of the Phase A plan, [§6](00-phase-a-plan-and-dependency-map.md#6-module-dependency-map-and-implementation-order).
- "Blocks" uses three levels:
  - **Blocks build**: engineering cannot write the step correctly without the answer.
  - **Blocks go-live of step X**: the step can be built and tested now, but it must stay switched off in production until the decision is taken.
  - **Not a blocker**: implementation proceeds with a configurable setting or a neutral design.

**Compliance notes** refer to Indian GST law as engineering understands it. They are **items to confirm with the company's chartered accountant (CA), not legal advice.** Thresholds and rates change by notification; the CA must confirm the values in force.

Related open items in the [decision log](../modernization/decision-log.md): Q-05 (seat on move/transfer), Q-06 (deactivated devices and seats), Q-08 (partner-collected cash), Q-14 (currency/tax scope), Q-15 (receipts vs tax invoice). They are referenced below where they interact; they are not re-decided here.

---

## Summary table

| ID | Group | Question (short) | Recommended default (for approval) | Blocker? |
|---|---|---|---|---|
| QI-1 | 1 Inventory | Can partners hold stock / own warehouses, and who records movements? | Platform records all movements; partners get a view-only stock page later | Not a blocker (gates F4 only) |
| QI-2 | 1 Inventory | Does a delivered but unclaimed device consume a licence? | No: keep today's rule, seat starts at claim | Not a blocker |
| QI-14 | 1 Inventory | Warranty / RMA commercial terms; invoice lines for replacements? | Zero-value REPLACE movement; invoice optional and manual | Not a blocker |
| QI-15 | 1 Inventory | Scrapped / lost device: auto-deactivate? release seat? | No automatic action; manual deactivate; seat follows Q-06 | Not a blocker |
| QI-23 | 1 Inventory | Stock valuation (FIFO) or quantity only? Manufacturer master? | Capture unit cost, no accounting valuation; brand = manufacturer | Not a blocker |
| QI-3 | 2 SIM | Are SIM costs billed to customers, and how? | No default proposed: commercial decision. Build cost and optional price fields; SIM lines off until decided | Blocks go-live of SIM lines in E3, F2 cost-per-customer |
| QI-4 | 2 SIM | Which SIM ownership models (platform / partner / customer BYO)? | Support all three; BYO is tracking only | Not a blocker |
| QI-21 | 2 SIM | What SIM data and commercial invoices may tenants see? | SIM number + renewal date read-only; commercial invoices under Billing | Blocks go-live of tenant parts of C6 and E9 |
| QI-5 | 3 Numbering | Separate or shared numbering series for commercial invoices and credit notes? | Separate series per document type, FY reset in April | Blocks go-live of E4 (first live number) |
| QI-6 | 4 Issuing | Who may issue commercial invoices: Super Admin only, or partners in their own name? | Super Admin only; partner self-invoicing designed for but not built | Not a blocker for Super Admin issuing; blocks any partner issuing |
| QI-7 | 5 GST | HSN/SAC code and GST rate per line type | CA-approved table, stored as configurable defaults, editable per line | Blocks go-live of E4 |
| QI-8 | 5 GST | Commercial prices GST-inclusive or exclusive? | Exclusive by default, flag per invoice | Not a blocker (flag) |
| QI-12 | 5 GST | Do e-invoicing (IRN) and e-way bill apply? | CA to confirm turnover and dispatch values; no default possible | **Blocks go-live of E4** if e-invoicing applies |
| QI-22 | 5 GST | Currency / tax beyond INR / GST? | INR / GST only; configuration hooks | Not a blocker |
| QI-9 | 6 Overdue | Payment terms, reminders, late fees, consequences of overdue | Reminders only; no late fee, no suspension, no licence lock | Blocks go-live of E10 (job ships switched off) |
| QI-10 | 6 Refunds | Refund mechanism | Manual record (as today); Razorpay refund API later | Not a blocker |
| QI-11 | 6 Credit notes | May an issued invoice be cancelled, or only credited? | Credit note only; cancellation disabled until CA confirms a window | Not a blocker (cancel ships disabled) |
| QI-24 | 6 Overdue | Allow advances / overpayments as unallocated customer balance? | Yes, shown as credit on the statement; GST treatment per CA | Blocks go-live of E5 overpayment path |
| QI-13 | 7 Other | Licence seat on device replacement / RMA and vehicle transfer | Explicit, audited "move seat" action; never implicit | Not a blocker for B–F |
| QI-16 | 7 Other | Enforce plate-number uniqueness per company? | Warn on duplicates first, enforce after cleanup | Not a blocker |
| QI-17 | 7 Other | Vehicle categories: extend enum or add a lookup? | Body-type lookup, no enum change | Not a blocker |
| QI-18 | 7 Other | Platform staff roles (non-Super Admin) for inventory / SIM / invoices? | Keep single Super Admin now; separate design if staff exist | Not a blocker |
| QI-19 | 7 Other | Mixed invoices (device + licence on one document)? | Separate documents | Not a blocker |
| QI-20 | 7 Other | Purge vs statutory retention of financial records | Purge refuses (or retains) when financial documents exist | **Blocks go-live of E2/E4**; existing exposure today |

**Counts:** group 1: 5 · group 2: 3 · group 3: 1 · group 4: 1 · group 5: 4 · group 6: 4 · group 7: 6 (total 24).

**Phase B (Device Inventory) has no true blockers.** Steps B1–B7 can start now. B8 (backfill) needs a separate approval to *apply*, which was already stated in the Phase A plan.

---

## Group 1 — Inventory and partner warehouse policies

### QI-1 · Partner warehouses and who records movements
**Question.** Can partners (resellers) own warehouses and hold platform devices as stock? Who records stock movements: the platform only, or partners too?

**Current behaviour in the code.**
- There is no stock location of any kind. A device's only "location" is `Device.companyId`; null means platform stock (`apps/api/prisma/schema.prisma:240`).
- A partner is identified by its home company (`Partner.homeCompanyId`, `schema.prisma:61`). Partner users are the users of that company with `billing` rights (`apps/api/src/licences/billing.service.ts:109-113`).
- Parking devices in the partner's home company would consume licence seats: the hourly rebalance assigns free seats to every active device with a `companyId` (`apps/api/src/licences/pools.service.ts:87-110`), and claim / create call `SeatsService.ensureDevice` (`apps/api/src/device-claim/device-claim.service.ts:114-115`, `apps/api/src/licences/seats.service.ts:89`).

**Options.**
| Option | Customer | Finance / compliance | Partner | Engineering effort |
|---|---|---|---|---|
| A. Platform only (partners see nothing) | No change | Simplest stock accountability | Partner asks the platform for stock status | Lowest (B as planned) |
| B. Platform records; partner view-only page | No change | Platform remains accountable for counts | Sees what it holds; cannot correct errors itself | B as planned + F4 (M) |
| C. Partner full (own locations, receive, transfer, dispatch) | Possibly faster dispatch | Stock held by partners must be reconciled; ownership of goods (consignment vs sale to partner) must be defined, which changes GST treatment | Full autonomy; needs training | B + partner-scoped write APIs, isolation tests, new tenant menu (rollout to all Admins, R-I8) — L |

**Recommended default (for approval).** Option B: the platform records every movement; partners get a read-only stock view in Phase F.

**Blocks.** Not a blocker. B2 already models `StockLocation.ownerPartnerId` and `DeviceStock.holderPartnerId` (Phase A §3.2), so all three options remain possible. The answer gates only F4.

**Compliance note (confirm with CA).** If devices are handed to partners, the CA should confirm whether that is a **sale to the partner** (tax invoice at hand-over) or **consignment / stock transfer** (delivery challan, Rule 55; the platform invoices the end customer). This choice decides who invoices the customer (see QI-6).

### QI-2 · Licence on a delivered but unclaimed device
**Question.** Does a device that has been delivered to a customer, but not yet claimed, consume a licence seat?

**Current behaviour in the code.** No. A shipped device keeps `companyId = null` until the customer claims it. The claim sets `companyId`, `claimedAt`, `isActive` and calls `ensureDevice` in one transaction (`device-claim.service.ts:113-116`). Licence dates run from the paid date, not from delivery (`billing.service.ts:331`; Phase A doc and [00 §6.1](../modernization/00-current-state-inventory.md#61-model)).

**Options.**
| Option | Customer | Finance | Partner | Engineering |
|---|---|---|---|---|
| A. No: seat starts at claim (today) | Pays nothing until the unit is used | Revenue starts later; unclaimed units are visible in shipments ("Not claimed > 7 days") | Neutral | None |
| B. Yes: seat reserved at dispatch | Licence year may start before installation (complaints likely) | Earlier revenue recognition | Neutral | New seat-at-dispatch path; violates the inventory/licence isolation contract (Phase A §3.6) |

**Recommended default (for approval).** Option A, keep today's behaviour.

**Blocks.** Not a blocker. Inventory never calls seat services (Phase A rule R1).

### QI-14 · Warranty and RMA commercial terms
**Question.** When a faulty unit is replaced under warranty, who pays, and does the replacement need an invoice line?

**Current behaviour in the code.** No warranty, RMA or replacement concept exists. There is no warranty date on `Device` (`schema.prisma:238-284`). A replacement today is "add the new device, deactivate or delete the old one", with seat effects from `ensureDevice` and Q-06.

**Options.**
| Option | Customer | Finance / compliance | Partner | Engineering |
|---|---|---|---|---|
| A. Free replacement, movement only (REPLACE, zero value) | Simple | No document for the goods sent; CA must confirm whether a delivery challan is required | Partner may be asked to handle swap | Included in B5 |
| B. Free replacement with a zero-value document | Simple | Paper trail for the goods movement | — | B5 + a zero-value line in E3 |
| C. Chargeable outside warranty | Pays for out-of-warranty units | Normal tax invoice | Partner may want a margin | Needs `warrantyUntil` (already in `DeviceStock`) + E3 line |

**Recommended default (for approval).** Option A for the movement; invoicing is optional and manual (Option C available when out of warranty). Warranty length itself is a commercial term the owner sets; engineering stores `warrantyUntil` per unit without a default period.

**Blocks.** Not a blocker for B5. Invoice treatment is chosen per case in E3.

**Compliance note (confirm with CA).** Movement of goods without a sale (replacement, repair, return to supplier) may need a delivery challan (CGST Rule 55) and, above the value limit, an e-way bill.

### QI-15 · Scrapped or lost device
**Question.** When a device is marked SCRAPPED or LOST, should it be deactivated automatically, and should its licence seat be released?

**Current behaviour in the code.** No scrapped/lost status exists. A deactivated device **keeps its seat** today (`apps/api/src/masters/devices/devices.service.ts:137` only binds on re-activation; there is no release on deactivation). This is decision-log item Q-06, still open.

**Options.**
| Option | Customer | Finance | Partner | Engineering |
|---|---|---|---|---|
| A. No automatic action; Super Admin deactivates explicitly | A lost unit's seat stays in use until someone acts | No silent seat change | — | None beyond B5 |
| B. Auto-deactivate on SCRAPPED / LOST | Seat outcome depends on Q-06 | Silent licence effect from an inventory action | — | Breaks rule R2; needs licence change |

**Recommended default (for approval).** Option A. The seat consequence follows whatever is decided for Q-06.

**Blocks.** Not a blocker.

### QI-23 · Stock valuation and manufacturer master
**Question.** Do we need stock valuation (FIFO / weighted average) or only quantity tracking with a recorded unit cost? Is a manufacturer master needed beyond `DeviceModel.brand`?

**Current behaviour in the code.** No cost data exists. The manufacturer is the free-text `DeviceModel.brand` (`schema.prisma:219-236`).

**Options.**
| Option | Customer | Finance | Engineering |
|---|---|---|---|
| A. Unit cost captured, no valuation | — | Stock value = Σ unit cost (report); books stay in the accounting system | Included in B2/F1 |
| B. FIFO / average valuation in VeeTrax | — | Duplicates the accounting system; needs reconciliation | L, new ledger logic |
| C. Manufacturer master table | — | — | S, but adds a migration of brand strings |

**Recommended default (for approval).** Option A, and keep `brand` as the manufacturer.

**Blocks.** Not a blocker (`unitCostPaise` is nullable).

---

## Group 2 — SIM ownership, usage and billing

### QI-3 · Billing SIM costs to customers
**Question.** Are SIM / data costs billed to customers? If so, are they included in the licence price, charged as a separate recurring line, or passed through at cost?

**Current behaviour in the code.** SIMs are not billed. There is no SIM entity; `Device.simNumber` and `simOperator` are free text (`schema.prisma:243-244`). Licence prices are per seat type only, GST-inclusive (`schema.prisma:1546-1547`).

**Options.**
| Option | Customer | Finance / compliance | Partner | Engineering |
|---|---|---|---|---|
| A. Included in the licence price | One price, simple | SIM cost becomes a platform overhead; licence price may need review | Partner margin unchanged | None |
| B. Separate recurring charge (plan price) | Two invoices or lines per year | Separate HSN/SAC and rate (QI-7); recurring invoice schedule needed | Partner may resell | `SimPlan.pricePaise` + recurring draft generation (adds to E3) |
| C. Pass-through at cost | Transparent | Acting as pure agent vs reseller changes GST treatment (CA) | — | Same as B, with cost = price |

**Recommended default.** **None proposed** — this is a pricing decision and the instruction is not to assume one. Engineering builds `SimPlan.costPaise` (required) and `SimPlan.pricePaise` (optional, null = not billed).

**Blocks.** Go-live of SIM invoice lines in E3, and the "cost per customer" view in F2. C1–C6 proceed.

**Compliance note (confirm with CA).** Reselling telecom service and acting as a "pure agent" (CGST Rules, Rule 33) are treated differently; SIM card hardware (goods) and connectivity (service) may need different codes.

### QI-4 · SIM ownership models
**Question.** Which SIM ownership models must be supported: platform-owned, partner-owned, customer-provided (BYO)?

**Current behaviour in the code.** No ownership concept. Any tenant with `devices:edit` can type any SIM number (`apps/api/src/masters/devices/devices.dto.ts:16-17`). The tracker-reported ICCID is stored separately (`schema.prisma:246-247`).

**Options.**
| Option | Customer | Finance | Partner | Engineering |
|---|---|---|---|---|
| A. Platform only | BYO SIMs untracked | Simple | — | S |
| B. Platform + partner | — | Partner SIM costs outside platform books | Can register its SIMs | M |
| C. All three, BYO = tracking only | BYO customers keep using their SIM, visible in reconciliation | No billing for BYO | — | M (field `ownership` already in the C1 sketch) |

**Recommended default (for approval).** Option C.

**Blocks.** Not a blocker (`SimCard.ownership` is a string column with a default).

### QI-21 · Tenant visibility of SIM data and commercial invoices
**Question.** What may tenant users see: MSISDN, ICCID, plan, expiry? And where do they see commercial invoices?

**Current behaviour in the code.** Tenants already see and edit `simNumber` / `simOperator` (`devices.dto.ts:16-17`); the value also appears in live state, dashboard, reports and the public API (Phase A §1.2). Tenant Admins see licence invoices under `billing:view` (`apps/api/src/licences/licences.controller.ts:92`, `:109`).

**Options.**
| Option | Customer | Finance | Engineering |
|---|---|---|---|
| A. SIM number + renewal date read-only; invoices under Billing | Sees what affects service | — | C6 + E9 |
| B. Full SIM detail incl. ICCID, plan, cost | Transparency | Reveals platform cost if cost shown | C6 larger |
| C. Nothing new | — | — | None |

**Recommended default (for approval).** Option A. Never show `costPaise` to tenants.

**Blocks.** Go-live of the tenant-facing parts of C6 and E9 (build behind a setting, off by default). Super Admin parts proceed.

---

## Group 3 — Invoice numbering and financial years

### QI-5 · Numbering series for commercial invoices and credit notes
**Question.** Should commercial (device, SIM, installation, AMC) invoices and their credit notes use their own series, or share the licence series?

**Current behaviour in the code.**
- Licence invoices: `PREFIX/FY/seq`, prefix default `VTX` (`schema.prisma:1567`), formatted by `formatInvoiceNumber` (`packages/shared/src/licences.ts:393-395`), 4-digit zero padding.
- FY is the Indian April–March year computed in IST (`licences.ts:383-391`).
- One gap-free counter per FY, row-locked inside the issuing transaction (`apps/api/src/licences/invoice-numbering.ts:13-19`; table `InvoiceCounter(fy)` `schema.prisma:1711-1714`; unique `(fy, seq)` `schema.prisma:1704`). Numbers are taken at issue (`apps/api/src/licences/invoices.service.ts:122-124`).
- Credit notes: own counter `CreditNoteCounter` (`invoice-numbering.ts:22-28`, `schema.prisma:1763-1766`), prefix default `VTX/CN` (`schema.prisma:1569`).
- The counter is keyed **only** by FY: one global platform series.

**Options.**
| Option | Customer | Finance / compliance | Partner | Engineering |
|---|---|---|---|---|
| A. Separate series (e.g. sales `VTS/2026-27/0001`, credit notes their own prefix) | Two number styles | Each series gap-free and unique per FY; GST return lists each series | Ready for partner series later | `DocumentCounter(issuerKey, series, fy)`; licence path untouched (zero regression risk) |
| B. Shared series with licences | One sequence | Numbers spread over two tables; a bug in the new path creates gaps in the licence series (R-I6) | — | Calls existing `nextInvoiceSeq`; GST CSV merge mandatory |
| C. Separate series per document kind (device sale, service, SIM) | Several styles | More series to report | — | Same as A with more `series` values |

**Recommended default (for approval).** Option A. Prefix values themselves are chosen by the owner at go-live (settings field, no hard-coded value).

**Blocks.** Go-live of E4 (no live number may be issued until the series is approved). E1–E3 and building E4 proceed.

**Compliance note (confirm with CA).**
- CGST **Rule 46(b)** requires a consecutive serial number, unique for the financial year, **not exceeding 16 characters**, in one or multiple series. Rule 53 applies a similar requirement to credit notes. Multiple series are allowed.
- Existing exposure found while verifying (licence engine, not changed here):
  - The invoice prefix may be up to 16 characters (`apps/api/src/licences/licences.dto.ts:110`, `licence-settings.service.ts:133`), but the full number adds `/2026-27/0001` (13 characters). Only prefixes of ≤ 3 characters keep the number within 16.
  - The default credit-note prefix `VTX/CN` gives `VTX/CN/2026-27/0001` = **19 characters** (`schema.prisma:1569`, `apps/api/src/licences/credit-notes.service.ts:106`; prefix allowed up to 20, `licences.dto.ts:111`).
  - Sequence 10000+ in one FY yields 5 digits (padding does not cap), adding one more character.
  - Ask the CA whether the credit-note format must change; any change is a separate, owner-approved licence-engine task.
- FY April–March and reset of the sequence each 1 April are consistent with current practice; the CA should confirm the FY token format (`2026-27`) is acceptable.

---

## Group 4 — Invoice issuing permissions

### QI-6 · Who may issue commercial invoices
**Question.** Super Admin only, or may partners issue invoices to their customers in their own name (own GSTIN, series, bank)?

**Current behaviour in the code.**
- Licence invoices are issued only in the platform's name: the supplier block is `PlatformBillingSettings` (legal name, GSTIN, state, bank: `schema.prisma:1544-1582`); there is no partner supplier profile.
- A partner can record cash/UPI/bank/cheque collected from its customer (`licences.controller.ts:187-190`). That calls the same `recordOffline`, which issues a **platform** GST invoice immediately (`billing.service.ts:213-240`) at the price for that pool owner (`billing.service.ts:161-162`). There is no partner settlement ledger ([00 §6.2](../modernization/00-current-state-inventory.md#62-billing), "DEC"); decision-log Q-08 is open on exactly this.
- Credit notes: Super Admin only (`credit-notes.service.ts:91`).
- All platform menus are Super Admin only and cannot be granted to roles (`apps/api/src/access/access-rules.ts:52`).

**Options.**
| Option | Customer | Finance / compliance | Partner | Engineering |
|---|---|---|---|---|
| A. Super Admin only (platform is the supplier) | Invoice always from VeeTrax | One GSTIN, one set of returns | Partner cannot bill its own margin through VeeTrax | E as planned |
| B. Partners issue in their own name | Invoice from the reseller | Each partner's GSTIN, series and returns are their own responsibility; platform hosts their tax documents | Full control of pricing and margin | Partner supplier profile, `issuerKey = PARTNER:<id>` counters, partner PDF branding, partner permissions (L) |
| C. Platform issues, partner may raise drafts for approval | — | Platform remains supplier | Partner prepares, platform approves | Draft-only permission for partners (M) |

**Recommended default (for approval).** Option A now. The data model keeps `issuerKind` / `issuerPartnerId` and `DocumentCounter.issuerKey` so B or C can be added without migration.

**Blocks.** Not a blocker for Super Admin issuing. Any partner issuing (B or C) is blocked until decided, together with Q-08.

**Compliance note (confirm with CA).** If partners invoice end customers, the platform's supply is to the partner (B2B), not to the customer; the CA should confirm the document chain and whether goods move by sale or consignment (see QI-1).

---

## Group 5 — HSN/SAC and GST treatment

### QI-7 · HSN/SAC and GST rate per line type
**Question.** What HSN (goods) or SAC (services) code and GST rate apply to: device sale, SIM card, SIM/data service, installation, repair, AMC/service, other?

**Current behaviour in the code.** The licence engine is services-only with **one SAC and one rate per invoice**: `PlatformBillingSettings.sacCode` default `998314`, `gstRatePct` default 18 (`schema.prisma:1566`, `1548`), copied onto each invoice (`invoices.service.ts:151`; `Invoice.sacCode`, `gstRatePct` `schema.prisma:1683-1684`). There are no per-line codes or rates (`gstBreakdown` takes one `ratePct`, `licences.ts:306`).

**Options.**
| Option | Customer | Finance / compliance | Engineering |
|---|---|---|---|
| A. CA-approved table as configurable defaults per line kind, editable per line | Correct invoices | One place to update when rates change | E1 + settings |
| B. Fixed codes in code | — | Every change needs a release | Lower, but brittle |
| C. Free entry per line, no defaults | — | High error risk | Lowest |

**Recommended default (for approval).** Option A. Engineering ships the table **empty**; no code or rate is pre-filled for new kinds, so nothing is issued until the CA has filled it.

**Blocks.** Go-live of E4.

**Compliance note (confirm with CA).**
- Goods use **HSN**, services use **SAC**. Codes commonly seen in the trade (Phase A §4.7), *all to confirm*: GPS tracker under chapter 85 (e.g. 8526); SIM card as a smart card (chapter 85, e.g. 8523); installation / repair under SAC 9987; telecom / data under SAC 9984; whether the existing `998314` is right for the licence remains with the CA.
- Required HSN digits on invoices depend on aggregate turnover (4 or 6 digits under the current notification).
- Rule 46 invoice contents to verify on the new PDF: supplier name, address, GSTIN; serial number; date; recipient name, address, GSTIN; HSN/SAC; description; quantity and unit; total value; taxable value after discount; rate and amount of each tax; place of supply with state name for inter-state supply; delivery address if different; reverse-charge indication; signature (or digital signature).

### QI-8 · Prices inclusive or exclusive of GST
**Question.** Are commercial prices entered GST-inclusive (like licences) or exclusive?

**Current behaviour in the code.** Licence prices are GST-inclusive: the taxable value is back-calculated as `round(total / (1 + rate))`, and CGST takes the odd paisa (`licences.ts:270`, `296-303`; settings comment `schema.prisma:1546`; partner overrides also inclusive, `schema.prisma:62`). The split is CGST+SGST (intra-state), CGST+UTGST (UT without legislature) or IGST (inter-state) by supplier vs buyer state (`licences.ts:275-278`).

**Options.**
| Option | Customer | Finance | Engineering |
|---|---|---|---|
| A. Exclusive (B2B norm) | Business buyers see net + tax | Rounding stays on the tax, not the price | New `gstLineExclusive` (E1) |
| B. Inclusive (like licences) | Round consumer prices | Taxable value has odd paise | Reuse `gstLine` |
| C. Per-invoice flag, default exclusive | Either | Both supported | A + B, flag `pricesIncludeTax` |

**Recommended default (for approval).** Option C with exclusive as the default.

**Blocks.** Not a blocker (flag on the invoice).

### QI-12 · e-invoicing (IRN) and e-way bill
**Question.** Is VeeTrax's supplier entity required to generate e-invoices (IRN + QR via the Invoice Registration Portal) and e-way bills for device dispatches?

**Current behaviour in the code.** Neither exists. There is no IRN, QR or e-way bill field on `Invoice` (`schema.prisma:1667-1708`) and no portal integration anywhere in `apps/api/src/licences`.

**Options.**
| Option | Customer | Finance / compliance | Engineering |
|---|---|---|---|
| A. Not applicable (CA confirms turnover below threshold) | — | Plain tax invoices valid | None |
| B. Applicable: integrate IRP (direct or via a GSP) | B2B buyers need IRN-bearing invoices for input credit | Mandatory once applicable; invoices without IRN are not valid for B2B | New integration, credentials, failure handling, cancellation within the portal window (L); likely a **paid** GSP → owner approval |
| C. Applicable: generate IRN manually on the portal and record it | — | Valid but labour-intensive | S: store IRN / ack number / QR on the invoice |

**Recommended default.** No default: the CA must confirm applicability. Engineering adds nullable `irn`, `ackNo`, `ackAt`, `signedQr` fields so Option C is possible without migration.

**Blocks.** **Go-live of E4** if e-invoicing applies (B2B invoices would be invalid without IRN). Build proceeds.

**Compliance note (confirm with CA).** e-invoicing applies above a notified aggregate turnover threshold (most recently notified as ₹5 crore, to confirm); credit notes also need IRN once applicable; e-way bill applies to goods consignments above the notified value (commonly ₹50,000). The licence engine would be equally affected if the threshold applies.

### QI-22 · Currency and tax beyond INR / GST
**Question.** Are currencies or taxes other than INR / GST in scope (D-004, Q-14)?

**Current behaviour in the code.** India-only, hard-coded INR, GST and IST (`billing.service.ts` Razorpay currency; FY in IST `licences.ts:383-391`; [00 §6.2](../modernization/00-current-state-inventory.md#62-billing)).

**Options.** A. INR / GST only, with configuration hooks (currency code stored on documents). B. Multi-currency now (exchange rates, export invoices, LUT for zero-rated export).

**Business impact.** A keeps E at its planned size; B adds L effort and new compliance (export of services/goods) with no current customer need recorded.

**Recommended default (for approval).** Option A (consistent with D-004).

**Blocks.** Not a blocker.

---

## Group 6 — Overdue invoices, refunds and credit notes

### QI-9 · Payment terms and overdue rules
**Question.** Default due days, reminder cadence, late fee or interest, and consequences of an overdue commercial invoice.

**Current behaviour in the code.** No invoice can be overdue today: a licence invoice is issued only once paid (`Invoice.paidAt` NOT NULL, `schema.prisma:1693`; `orderId` NOT NULL, `:1673`). The only time-based consequence is the **licence** expiry: grace period default 15 days (`schema.prisma:1549`, `licences.ts:156`), after which the seat is locked (`licences.ts:196-198`). That mechanism is about licences, not unpaid invoices.

**Options.**
| Option | Customer | Finance | Partner | Engineering |
|---|---|---|---|---|
| A. Reminders only (configurable cadence) | No service impact | Collection relies on follow-up | Partner copied on reminders (optional) | E10 (S) |
| B. Reminders + late fee / interest | Extra charge | Needs terms on the invoice; interest is a separate taxable supply (CA) | — | + debit note / fee lines (M) |
| C. Reminders + suspension or licence lock | Vehicles stop tracking (safety and contract risk) | Strong lever | Partner relationship affected | Couples invoices to seats; breaks isolation contract §3.6 |

**Recommended default (for approval).** Option A, with due days and cadence as settings (no default number of days chosen by engineering; the owner sets them). **No automatic suspension or licence lock.**

**Blocks.** Go-live of E10 (the job ships switched off). `dueAt` is a nullable field; drafts and issue proceed.

### QI-10 · Refund mechanism
**Question.** Manual refund records, Razorpay refund API, or both?

**Current behaviour in the code.** Refunds are recorded, not executed: a credit note stores `refundMode` and `refundReference` (`schema.prisma:1742-1743`); modes `CASH, UPI, BANK_TRANSFER, CHEQUE, RAZORPAY_REFUND_MANUAL, NONE` (`licences.ts:52`). The Razorpay refund call is an explicit TODO (`credit-notes.service.ts:130`).

**Options.**
| Option | Customer | Finance | Engineering |
|---|---|---|---|
| A. Manual record (as today) | Refund time depends on staff | Reconcile against bank | E7 (M) |
| B. Razorpay refund API for online payments | Faster | Automatic trail; failure handling needed | + API integration, webhook for refund status (M) |
| C. Both (API when online, manual otherwise) | Best | — | A + B |

**Recommended default (for approval).** Option A first, C later. A refund always requires a reason and is audited.

**Blocks.** Not a blocker.

**Compliance note (confirm with CA).** A refund of an advance on which GST was paid may need a **refund voucher** (CGST Rule 51).

### QI-11 · Cancelling an issued invoice
**Question.** May an issued commercial invoice be cancelled (voided), and if so when? Or must every correction be a credit note?

**Current behaviour in the code.** Licence invoices cannot be cancelled; the only correction is a credit note (Super Admin, reason required, row-locked per invoice: `credit-notes.service.ts:90-99`), optionally expiring the credited seats (`credit-notes.service.ts:103`, `:183`).

**Options.**
| Option | Customer | Finance / compliance | Engineering |
|---|---|---|---|
| A. Never cancel; credit note only | Receives invoice + credit note | Cleanest audit trail; numbers never reused | E7 only |
| B. Cancel allowed if unpaid and within a short window | Cleaner for obvious errors | Must match the GST return period; IRN cancellation window if e-invoicing applies | E4 cancel action |
| C. Cancel any time before return filing | — | Risk of mismatch with GSTR-1 | E4 + return-period tracking |

**Recommended default (for approval).** Option A until the CA confirms a window; the cancel action is built but disabled. A cancelled invoice (if ever allowed) keeps its number and stays in GST exports.

**Blocks.** Not a blocker.

**Compliance note (confirm with CA).** GST law has no general "cancel an invoice" concept outside e-invoicing (IRN cancellation within the portal window); corrections are made by credit note under **section 34**, and a credit note must be declared in a return no later than the time limit in section 34(2) (currently 30 November after the end of the FY, or the annual return date if earlier, to confirm). Credit-note contents: CGST Rule 53.

### QI-24 · Advances and overpayments
**Question.** May a customer hold an unallocated balance (advance or overpayment) that is applied to later invoices?

**Current behaviour in the code.** No. A licence order's amount must equal the quote total exactly (`billing.service.ts:218-220`), so over/under payment is refused. Payments exist only as attributes of licence orders (`LicenceOrder`, `schema.prisma:1640-1663`); there is no receipt document (decision-log Q-15 open).

**Options.**
| Option | Customer | Finance / compliance | Engineering |
|---|---|---|---|
| A. Allow unallocated balance, shown on statement | Can pay in advance or round up | Needs advance accounting; GST on service advances (CA) | `Payment` + `PaymentAllocation` (E5), statement in F3 |
| B. Refuse: payment must match invoice(s) exactly | Rigid; bank transfers rarely match | Simple | Validation only |
| C. Allow, but auto-refund overpayments | — | Refund workload | A + refund flow |

**Recommended default (for approval).** Option A.

**Blocks.** Go-live of the overpayment path in E5. Allocation of exact and partial payments proceeds.

**Compliance note (confirm with CA).** For services, GST is generally due on receipt of an advance and a **receipt voucher** is required (CGST Rule 50); for goods, the current position differs. The CA should confirm whether VeeTrax needs receipt vouchers and how advances appear in GSTR-1.

---

## Group 7 — Other (licensing interaction, vehicles, platform roles, retention)

### QI-13 · Licence seat on device replacement, RMA and vehicle transfer
**Question.** When a device is replaced (RMA) or a vehicle is transferred, does the seat follow the vehicle, the device, or stay in the pool? (Restates Q-05.)

**Current behaviour in the code.** Inconsistent today:
- Super Admin Transfer moves the device's seat with the device to the new company (`apps/api/src/transfer/transfer.service.ts:153-155`).
- Admin device move releases the seat to the old company's pool and takes a free seat in the new one (`apps/api/src/masters/admin-devices/admin-devices.service.ts:79-83`).
- There is no "move seat between devices" action at all.

**Options.**
| Option | Customer | Finance | Partner | Engineering |
|---|---|---|---|---|
| A. Explicit, audited "move seat" action (no implicit effect) | Replacement keeps paid time | Every change visible in audit | — | New licence action (outside B–F, licence workstream) |
| B. Seat follows the vehicle | Natural for replacements | Implicit side effect | — | Couples inventory to seats |
| C. Seat follows the device | Replacement unit needs a new seat | Customer pays twice unless credited | — | None |

**Recommended default (for approval).** Option A. Until it exists, a REPLACE movement only records old and new IMEI.

**Blocks.** Not a blocker for B–F (B5 records the movement; D3 previews what a transfer would move without changing behaviour).

### QI-16 · Plate-number uniqueness
**Question.** Enforce one plate number per company?

**Current behaviour in the code.** `TrackedObject.plateNumber` is optional with no unique constraint (`schema.prisma:293`). Duplicates may exist.

**Options.** A. Warn now, enforce after a data check and cleanup. B. Enforce now (migration may fail on existing duplicates). C. Never enforce.

**Business impact.** B risks a failed migration and blocked edits for customers with legitimate duplicates (e.g. trailers, re-registrations); C allows data errors in reports and invoices that reference vehicles.

**Recommended default (for approval).** Option A.

**Blocks.** Not a blocker.

### QI-17 · Vehicle categories
**Question.** Extend the `VehicleType` enum or add a body-type lookup?

**Current behaviour in the code.** `enum VehicleType` (8 values, `schema.prisma:34-43`) drives default speed limits and icons (Phase A §1.3).

**Options.** A. Lookup (`VehicleProfile.bodyType`), enum unchanged. B. Extend the enum (`ALTER TYPE`, affects speed-limit defaults and icons for all tenants).

**Business impact.** A is additive and leaves alerts unchanged; B changes overspeed behaviour and is not a purely additive migration.

**Recommended default (for approval).** Option A.

**Blocks.** Not a blocker.

### QI-18 · Platform staff roles
**Question.** Will non-Super Admin platform staff (stores, accounts) operate inventory, SIM and invoices?

**Current behaviour in the code.** Exactly one Super Admin flag per user (`User.isSuperAdmin`, `schema.prisma:135`); Super Admin–only menus can never be granted to a role (`access-rules.ts:52`).

**Options.** A. Keep single Super Admin. B. Introduce platform roles (separate design: role model, audit, separation of duties such as "who issues" vs "who records payments").

**Business impact.** A means one person (or a shared login, which is undesirable) does stores and accounts work; B is a cross-cutting security change (M–L) and a prerequisite for segregation of duties on invoices.

**Recommended default (for approval).** Option A now; start a separate design if operations staff exist. New menus (`sa_sim_cards`, `sa_invoices`) are kept separate from `sa_licences` so they map cleanly to future roles.

**Blocks.** Not a blocker.

### QI-19 · Mixed invoices (device + licence)
**Question.** May one document contain both device / service lines and licence lines?

**Current behaviour in the code.** Licence invoices are created only by order fulfilment, which also creates or extends seats (`billing.service.ts:331`, `invoices.service.ts:116-124`).

**Options.** A. Separate documents (licence stays in the licence flow). B. One mixed document (commercial issue would have to trigger seat fulfilment).

**Business impact.** A: customer may receive two invoices for one sale; zero risk to seat activation. B: one document for the customer, but couples commercial invoices to seats (violates isolation §3.6), and mixes series.

**Recommended default (for approval).** Option A. A commercial line kind `LICENCE` is not offered.

**Blocks.** Not a blocker.

### QI-20 · Purge vs statutory retention
**Question.** What happens to invoices, credit notes and payments when a company, device or vehicle is purged?

**Current behaviour in the code.** The purge is catalogue-driven and deletes FK children including `Restrict` ones (`apps/api/src/purge/purge-plan.ts`, Phase A §3.1 rule 3). `Invoice.companyId` and `CreditNote.companyId` are `Restrict` FKs (`schema.prisma:1700`, `1753`), so a **company** purge would delete legal invoices (Inferred from the algorithm, not executed; Phase A R-I7).

**Options.**
| Option | Customer | Finance / compliance | Engineering |
|---|---|---|---|
| A. Purge refuses while financial documents exist | Cannot fully erase a company with invoices | Records kept | Guard in purge (S) |
| B. Purge anonymises the company but keeps financial rows (SetNull + snapshots) | Personal data reduced | Records kept; snapshots already carry buyer data | M |
| C. Keep current behaviour | — | Possible loss of statutory records | None |

**Recommended default (for approval).** Option A now, B later if privacy requests require it.

**Blocks.** **Go-live of E2/E4** (new financial tables must not be erasable). B2 already uses SetNull FKs. The existing licence exposure should be raised as a new item in the modernization risk register.

**Compliance note (confirm with CA).** CGST **section 36** requires accounts and records to be kept for 72 months from the due date of the annual return for the year concerned (longer if under proceedings).

---

## Implementation can proceed now with these neutral designs

Engineering will build the following regardless of the answers above. Each one keeps every option open; none pre-empts a decision.

**Inventory (Phase B — no blockers)**
1. Side tables only (`StockLocation`, `Supplier`, `StockReceipt`, `DeviceStock`, `StockMovement`); inventory code never writes `Device.companyId`, `isActive` or `LicenceSeat` (isolation tests). Keeps QI-2, QI-13, QI-15 open.
2. `StockLocation.ownerPartnerId` and `DeviceStock.holderPartnerId` exist but only platform screens write them. Keeps QI-1 open.
3. Nullable `unitCostPaise`, `warrantyUntil`, `serialNumber`; no valuation method, no default warranty period. Keeps QI-14, QI-23 open.
4. REPLACE / SCRAP / LOST movements record facts only; no seat or activation side effect. Keeps QI-13, QI-15 open.

**SIM (Phase C)**
5. `SimCard.ownership` (PLATFORM / PARTNER / CUSTOMER) and `SimPlan.costPaise` required, `pricePaise` nullable (null = not billed). Keeps QI-3, QI-4 open.
6. Tenant SIM display behind a setting, off by default; cost never exposed to tenants. Keeps QI-21 open.

**Vehicles (Phase D)**
7. `VehicleProfile.bodyType` lookup; duplicate-plate warning only; transfer *preview* without changing what moves. Keeps QI-13 (Q-05), QI-16, QI-17 open.

**Invoices (Phase E)**
8. **Separate configurable numbering series:** `DocumentCounter(issuerKey, series, fy)`, gap-free row lock, number assigned only at issue; prefixes are settings with **no default value** and a validation that the full formatted number stays within 16 characters. Licence `InvoiceCounter` / `CreditNoteCounter` untouched. Keeps QI-5 and QI-6 open.
9. **Per-line HSN/SAC + GST rate fields** with a configurable defaults table per line kind, shipped empty; issue is refused while any line lacks a code or rate. Keeps QI-7 open.
10. **Inclusive and exclusive tax calculation** (`gstLine` reused, `gstLineExclusive` added), per-invoice `pricesIncludeTax` flag. Keeps QI-8 open.
11. **Nullable e-invoice fields** (`irn`, `ackNo`, `ackAt`, `signedQr`) and nullable e-way bill reference on dispatch movements; no portal integration until QI-12 is answered.
12. **Payment allocation model:** `Payment` (receipt) separate from `PaymentAllocation` (many-to-many with invoices, row-locked, CHECK > 0); unallocated balance is computed, and its use is a setting. Keeps QI-24 and Q-15 open.
13. **Derived OVERDUE status** from nullable `dueAt`; reminder job built with `overdueNotifiedState` idempotency but **disabled**; no late-fee or lock code path. Keeps QI-9 open.
14. Credit notes with their own series and a manual `Refund` record; cancel action built but **disabled**; no seat-revocation code path in commercial credit notes. Keeps QI-10, QI-11 open.
15. `issuerKind` / `issuerPartnerId` on invoices and `issuerKey` on counters, with only `PLATFORM` enabled. Keeps QI-6 open.
16. Financial tables reference devices, SIMs and vehicles through SetNull FKs plus text snapshots, and a purge test proves they survive. Supports QI-20 Option A or B.
17. Super Admin–only menus `sa_sim_cards` and `sa_invoices`, separate from `sa_licences`; no new tenant menu in B–D. Keeps QI-18 open and avoids an automatic rollout to customer Admins (R-I8).

**Items to take to the chartered accountant in one sitting:** QI-7 (codes and rates), QI-8 (pricing basis), QI-11 (cancellation vs section 34 credit notes), QI-12 (IRN and e-way bill), QI-24 (advances, Rules 50/51), QI-1 / QI-6 (consignment vs sale, document chain), QI-20 (section 36 retention), and the existing licence-engine numbering-length exposure under Rules 46 and 53 (QI-5 note).
