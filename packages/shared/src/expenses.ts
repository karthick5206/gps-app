/**
 * Fuel & expense log: fill-ups and other vehicle costs (with a bill photo), and from them the real km per litre and
 * cost per km of each vehicle, without a fuel sensor. Amounts are in paise.
 */

export const EXPENSE_KINDS = ['FUEL', 'SERVICE', 'REPAIR', 'TOLL', 'PARKING', 'TYRES', 'INSURANCE', 'OTHER'] as const;
export type ExpenseKind = (typeof EXPENSE_KINDS)[number];

export const EXPENSE_KIND_LABELS: Record<ExpenseKind, string> = {
  FUEL: 'Fuel',
  SERVICE: 'Service',
  REPAIR: 'Repair',
  TOLL: 'Toll',
  PARKING: 'Parking',
  TYRES: 'Tyres',
  INSURANCE: 'Insurance',
  OTHER: 'Other',
};

export interface ExpenseDto {
  id: string;
  objectId: string;
  objectName: string;
  kind: ExpenseKind;
  at: string;
  amountPaise: number;
  /** Fuel only. */
  litres: number | null;
  /** Fuel only: tank filled to full. */
  fullTank: boolean;
  /** VeeTrax odometer at that moment (km), recorded automatically. */
  odometerKm: number | null;
  vendor: string | null;
  note: string | null;
  hasPhoto: boolean;
  createdByName: string | null;
}

export interface ExpenseInput {
  objectId: string;
  kind: ExpenseKind;
  at: string;
  amountPaise: number;
  litres?: number | null;
  /** Fuel only; default true. */
  fullTank?: boolean;
  vendor?: string | null;
  note?: string | null;
}

/** Per-vehicle totals for a period. */
export interface VehicleCostDto {
  objectId: string;
  objectName: string;
  km: number;
  fuelLitres: number;
  fuelPaise: number;
  otherPaise: number;
  /** km per litre by the full-tank method (null until two full-tank fill-ups end in the period). */
  kmPerLitre: number | null;
  /** Full-tank runs (full fill-up to the next full fill-up) the km per litre is based on. */
  fullTankRuns: number;
  /** All costs per km driven (paise). */
  costPerKmPaise: number | null;
}

export interface ExpenseSummaryDto {
  from: string;
  to: string;
  vehicles: VehicleCostDto[];
  totalPaise: number;
  byKind: Record<ExpenseKind, number>;
}

/** km / L and cost per km from a period's totals. */
export function vehicleCost(km: number, fuelLitres: number, fuelPaise: number, otherPaise: number): Pick<VehicleCostDto, 'kmPerLitre' | 'costPerKmPaise'> {
  return {
    kmPerLitre: fuelLitres > 0 && km > 0 ? Math.round((km / fuelLitres) * 10) / 10 : null,
    costPerKmPaise: km > 0 ? Math.round((fuelPaise + otherPaise) / km) : null,
  };
}

/**
 * Reads amount and litres from bill text (OCR of a fuel receipt): "Amount Rs 2,500.00", "Total: 2500", "Vol 24.35 L",
 * "Qty(Ltr) 24.35", "Litres: 24.35". Returns what it found (the user checks before saving).
 */
export function parseBillText(text: string): { amount: number | null; litres: number | null } {
  const t = text.replace(/,/g, '').replace(/\s+/g, ' ');
  const num = (re: RegExp) => {
    const m = re.exec(t);
    return m ? Number(m[1]) : null;
  };
  const amount =
    num(/(?:sale|net)?\s*(?:amount|amt|total|rs\.?|inr|₹)\s*[:=]?\s*(?:rs\.?|inr|₹)?\s*(\d{2,6}(?:\.\d{1,2})?)/i) ?? num(/(?:rs\.?|₹)\s*(\d{2,6}(?:\.\d{1,2})?)/i);
  const litres = num(/(?:vol(?:ume)?|qty|quantity|litres?|liters?|ltrs?)\s*(?:\(\s*l(?:tr)?s?\s*\))?\s*[:=]?\s*(\d{1,3}(?:\.\d{1,3})?)/i) ?? num(/(\d{1,3}\.\d{1,3})\s*(?:l|ltr|ltrs|litres?)\b/i);
  return { amount: amount && amount > 0 && amount < 1_000_000 ? amount : null, litres: litres && litres > 0 && litres < 1000 ? litres : null };
}

/**
 * MILEAGE report (manual fuel entries): one row per full-tank run — from a full fill-up to the next full fill-up.
 * The litres added in that run (partial fill-ups in between plus the closing full one) are the fuel used for the GPS
 * km driven between the two fill-ups. Money in rupees.
 */
export interface MileageReportRow {
  objectId: string;
  objectName: string;
  plateNumber: string | null;
  /** Previous full fill-up (start of the run) and the full fill-up that closes it (ISO). */
  fromAt: string;
  toAt: string;
  /** Fill-ups in the run after the starting one (partial ones + the closing full one). */
  fillUps: number;
  litres: number;
  fuelCost: number;
  distanceKm: number;
  kmPerL: number | null;
  costPerKm: number | null;
}

export interface FuelFill {
  at: number;
  litres: number;
  amountPaise: number;
  fullTank: boolean;
}

export interface FullTankRun {
  from: number;
  to: number;
  litres: number;
  amountPaise: number;
  fills: number;
}

/**
 * Full-tank method: each full fill-up closes a run that started at the previous full fill-up; the litres of every
 * fill-up after the start, up to and including the closing one, are what the run used. Fill-ups before the first
 * full one, and partial ones not yet followed by a full one, have no known starting level and are left out.
 */
export function fullTankRuns(fills: readonly FuelFill[]): FullTankRun[] {
  const runs: FullTankRun[] = [];
  let start: number | null = null;
  let litres = 0;
  let amount = 0;
  let n = 0;
  for (const f of [...fills].sort((a, b) => a.at - b.at)) {
    if (start === null) {
      if (f.fullTank) start = f.at;
      continue;
    }
    litres += f.litres;
    amount += f.amountPaise;
    n += 1;
    if (f.fullTank) {
      runs.push({ from: start, to: f.at, litres, amountPaise: amount, fills: n });
      start = f.at;
      litres = amount = n = 0;
    }
  }
  return runs;
}

/** GPS km driven between two moments: trips inside count fully, trips crossing an end count by the time overlap. */
export function kmBetween(trips: readonly { start: number; end: number; km: number }[], from: number, to: number): number {
  let km = 0;
  for (const t of trips) {
    const a = Math.max(t.start, from);
    const b = Math.min(t.end, to);
    if (t.end <= t.start) {
      if (t.start >= from && t.start < to) km += t.km;
    } else if (b > a) km += (t.km * (b - a)) / (t.end - t.start);
  }
  return Math.round(km * 10) / 10;
}
