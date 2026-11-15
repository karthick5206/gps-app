/**
 * Transport vendors, rate cards and the monthly vendor statement (v1.16.9, Employee transport).
 * - A vendor (cab operator) belongs to one company and serves some of its branches (empty = all). Vehicles of any type
 *   (car … bus) and drivers are mapped to a vendor. The same real operator serving another company is that company's
 *   own vendor record (tenants never share data).
 * - A rate card prices one vendor's trips for a branch (or all) and a vehicle category (or all), valid from a date.
 *   Models: TRIP, KM, SLAB, MONTHLY (per vehicle, with included km), PACKAGE (hours + km), SEAT (per employee carried);
 *   add-ons (night allowance, escort, waiting, dead km) and GST %.
 * - The statement (GET /api/transport/billing/statement) prices the month's finished trips of the vendor's vehicles
 *   from the actual GPS km and times: one line per trip and the per-vehicle totals. Nothing is estimated.
 */

export const RATE_MODELS = ['TRIP', 'KM', 'SLAB', 'MONTHLY', 'PACKAGE', 'SEAT'] as const;
export type RateModel = (typeof RATE_MODELS)[number];

export const RATE_MODEL_LABEL: Record<RateModel, string> = {
  TRIP: 'Per trip',
  KM: 'Per km',
  SLAB: 'Slab (base km + per km after)',
  MONTHLY: 'Fixed per month + extra km',
  PACKAGE: 'Package (hours + km)',
  SEAT: 'Per employee carried',
};

/** Model parameters (amounts in rupees). Unused keys are ignored. */
export interface RateParams {
  /** TRIP */
  perTrip?: number;
  /** KM: rate per km, optional minimum km per trip and a fixed base fare. */
  perKm?: number;
  minKm?: number;
  baseFare?: number;
  /** SLAB: first `baseKm` for `baseFare`, then `perKmAfter`. */
  baseKm?: number;
  perKmAfter?: number;
  /** MONTHLY (per vehicle): fee including `includedKm`, then `perExtraKm`. */
  monthlyFee?: number;
  includedKm?: number;
  perExtraKm?: number;
  /** PACKAGE (per trip): `fare` for `hours` and `km`, then per extra hour / km. */
  hours?: number;
  km?: number;
  fare?: number;
  perExtraHour?: number;
  /** SEAT */
  perSeat?: number;
}

export interface RateAddons {
  /** Added to every trip that starts inside the company night window. */
  nightAllowance?: number;
  /** Added to every night trip (escort / guard). */
  escortPerNightTrip?: number;
  /** Waiting: free minutes per trip, then per hour (trip duration beyond the planned duration). */
  waitingFreeMin?: number;
  waitingPerHour?: number;
  /** Fixed dead km added to every trip (garage ↔ first pickup), priced at the card's km rate. */
  deadKmPerTrip?: number;
}

export interface TransportVendorDto {
  id: string;
  name: string;
  gstin: string | null;
  pan: string | null;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  bankName: string | null;
  bankAccount: string | null;
  ifsc: string | null;
  upiId: string | null;
  /** Empty = every branch. */
  branchIds: string[];
  branchNames: string[];
  notes: string | null;
  isActive: boolean;
  vehicleCount: number;
  driverCount: number;
  rateCardCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface TransportVendorInput {
  name: string;
  gstin?: string | null;
  pan?: string | null;
  contactName?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  bankName?: string | null;
  bankAccount?: string | null;
  ifsc?: string | null;
  upiId?: string | null;
  branchIds?: string[];
  notes?: string | null;
  isActive?: boolean;
}

/** GET / PUT /api/transport/vendors/:id/assets — the vendor's vehicles and drivers. */
export interface TransportVendorAssetsDto {
  vehicles: { objectId: string; name: string; plateNumber: string | null; category: string | null; seats: number | null }[];
  drivers: { driverId: string; name: string; mobile: string | null }[];
}
export interface TransportVendorAssetsInput {
  objectIds: string[];
  driverIds: string[];
}

export interface TransportRateCardDto {
  id: string;
  vendorId: string;
  name: string;
  /** null = every branch. */
  branchId: string | null;
  branchName: string | null;
  /** null = every vehicle category (TransportVehicleCategory). */
  vehicleCategory: string | null;
  model: RateModel;
  params: RateParams;
  addons: RateAddons;
  gstPct: number;
  validFrom: string;
  validTo: string | null;
  isActive: boolean;
}

export interface TransportRateCardInput {
  name: string;
  branchId?: string | null;
  vehicleCategory?: string | null;
  model: RateModel;
  params: RateParams;
  addons?: RateAddons;
  gstPct?: number;
  validFrom: string;
  validTo?: string | null;
  isActive?: boolean;
}

/** Menus this release adds to the Transport admin template (new companies; existing roles get them in Roles). */
export const ETMS_VENDOR_TEMPLATE_PERMISSIONS: Record<string, Partial<Record<'etms_vendors' | 'etms_billing', ('view' | 'create' | 'edit' | 'delete' | 'export')[]>>> = {
  'Transport admin': { etms_vendors: ['view', 'create', 'edit', 'delete', 'export'], etms_billing: ['view', 'export'] },
};

// ───────────────────────────── Rate engine (pure) ─────────────────────────────

/** One finished trip as the engine needs it. */
export interface BillableTrip {
  km: number;
  /** Actual minutes, start → end (null when unknown). */
  durationMin: number | null;
  /** Planned minutes (for waiting). */
  plannedMin: number | null;
  /** Employees carried (boarded or dropped). */
  passengers: number;
  night: boolean;
}

export interface TripCharge {
  base: number;
  addons: number;
  /** What the amount is made of, e.g. "21.4 km × ₹14". */
  basis: string;
  addonText: string[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** The km rate a card uses for dead km (KM / SLAB after-rate / PACKAGE / MONTHLY extra km). */
function kmRate(model: RateModel, p: RateParams): number {
  if (model === 'KM') return num(p.perKm);
  if (model === 'SLAB') return num(p.perKmAfter);
  if (model === 'PACKAGE') return num(p.perExtraKm);
  if (model === 'MONTHLY') return num(p.perExtraKm);
  return 0;
}

/** Price one trip on a card. MONTHLY prices 0 per trip (the vehicle is charged in `monthlyCharge`). */
export function tripCharge(model: RateModel, p: RateParams, a: RateAddons, t: BillableTrip): TripCharge {
  const dead = num(a.deadKmPerTrip);
  const km = t.km + (model === 'MONTHLY' ? 0 : dead);
  let base = 0;
  let basis = '';
  switch (model) {
    case 'TRIP':
      base = num(p.perTrip);
      basis = `1 trip × ₹${num(p.perTrip)}`;
      break;
    case 'KM': {
      const billed = Math.max(km, num(p.minKm));
      base = num(p.baseFare) + billed * num(p.perKm);
      basis = `${num(p.baseFare) ? `₹${num(p.baseFare)} + ` : ''}${r2(billed)} km × ₹${num(p.perKm)}${billed > km ? ` (min ${num(p.minKm)} km)` : ''}`;
      break;
    }
    case 'SLAB': {
      const extra = Math.max(0, km - num(p.baseKm));
      base = num(p.baseFare) + extra * num(p.perKmAfter);
      basis = `first ${num(p.baseKm)} km ₹${num(p.baseFare)}${extra > 0 ? ` + ${r2(extra)} km × ₹${num(p.perKmAfter)}` : ''}`;
      break;
    }
    case 'PACKAGE': {
      const exKm = Math.max(0, km - num(p.km));
      const exH = t.durationMin === null ? 0 : Math.max(0, Math.ceil((t.durationMin - num(p.hours) * 60) / 60));
      base = num(p.fare) + exKm * num(p.perExtraKm) + exH * num(p.perExtraHour);
      basis = `package ₹${num(p.fare)} (${num(p.hours)} h / ${num(p.km)} km)${exKm > 0 ? ` + ${r2(exKm)} km × ₹${num(p.perExtraKm)}` : ''}${exH > 0 ? ` + ${exH} h × ₹${num(p.perExtraHour)}` : ''}`;
      break;
    }
    case 'SEAT':
      base = t.passengers * num(p.perSeat);
      basis = `${t.passengers} employee(s) × ₹${num(p.perSeat)}`;
      break;
    case 'MONTHLY':
      basis = 'monthly package';
      break;
  }
  const addonText: string[] = [];
  let addons = 0;
  if (t.night && num(a.nightAllowance)) {
    addons += num(a.nightAllowance);
    addonText.push(`night ₹${num(a.nightAllowance)}`);
  }
  if (t.night && num(a.escortPerNightTrip)) {
    addons += num(a.escortPerNightTrip);
    addonText.push(`escort ₹${num(a.escortPerNightTrip)}`);
  }
  if (num(a.waitingPerHour) && t.durationMin !== null && t.plannedMin !== null) {
    const waitMin = Math.max(0, t.durationMin - t.plannedMin - num(a.waitingFreeMin));
    if (waitMin > 0) {
      const w = r2((waitMin / 60) * num(a.waitingPerHour));
      addons += w;
      addonText.push(`waiting ${Math.round(waitMin)} min ₹${w}`);
    }
  }
  if (dead > 0 && kmRate(model, p) && (model === 'KM' || model === 'SLAB' || model === 'PACKAGE')) addonText.unshift(`incl. ${dead} dead km`);
  return { base: r2(base), addons: r2(addons), basis, addonText };
}

/** MONTHLY card: the vehicle's charge for the month from its total km. */
export function monthlyCharge(p: RateParams, totalKm: number): { amount: number; basis: string } {
  const extra = Math.max(0, totalKm - num(p.includedKm));
  return { amount: r2(num(p.monthlyFee) + extra * num(p.perExtraKm)), basis: `₹${num(p.monthlyFee)} incl. ${num(p.includedKm)} km${extra > 0 ? ` + ${r2(extra)} km × ₹${num(p.perExtraKm)}` : ''}` };
}

/**
 * The card for a trip: active, valid on the day, for the vehicle's branch (or all) and category (or all). The most
 * specific wins (branch + category > one of them > neither); then the latest valid-from.
 */
export function pickRateCard<C extends Pick<TransportRateCardDto, 'branchId' | 'vehicleCategory' | 'validFrom' | 'validTo' | 'isActive'>>(cards: C[], day: string, branchId: string | null, category: string | null): C | null {
  const ok = cards.filter((c) => c.isActive && c.validFrom <= day && (!c.validTo || c.validTo >= day) && (!c.branchId || c.branchId === branchId) && (!c.vehicleCategory || c.vehicleCategory === category));
  const score = (c: C) => (c.branchId ? 2 : 0) + (c.vehicleCategory ? 1 : 0);
  return ok.sort((a, b) => score(b) - score(a) || b.validFrom.localeCompare(a.validFrom))[0] ?? null;
}

// ───────────────────────────── Statement ─────────────────────────────

export interface VendorStatementLine {
  tripId: string;
  day: string;
  vehicle: string;
  plateNumber: string | null;
  driver: string | null;
  trip: string;
  direction: 'IN' | 'OUT';
  start: string | null;
  end: string | null;
  km: number;
  passengers: number;
  night: boolean;
  rateCard: string | null;
  basis: string;
  base: number;
  addons: number;
  addonText: string[];
  amount: number;
  /** Why the line has no price (no card, no GPS km …). */
  issue: string | null;
}

export interface VendorStatementVehicle {
  objectId: string;
  vehicle: string;
  plateNumber: string | null;
  trips: number;
  km: number;
  passengers: number;
  /** Trip-priced amount + monthly charge. */
  amount: number;
  monthly: { amount: number; basis: string } | null;
}

export interface VendorStatementDto {
  month: string;
  vendor: { id: string; name: string; gstin: string | null };
  branchId: string | null;
  lines: VendorStatementLine[];
  vehicles: VendorStatementVehicle[];
  totals: { trips: number; km: number; passengers: number; subtotal: number; gst: number; total: number; unpriced: number };
}
