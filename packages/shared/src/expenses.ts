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
  /** km per litre (null without fuel entries or distance). */
  kmPerLitre: number | null;
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

/** MILEAGE report: one row per vehicle — fuel log fill-ups against distance driven (no fuel sensor needed). Money in rupees. */
export interface MileageReportRow {
  objectId: string;
  objectName: string;
  plateNumber: string | null;
  fillUps: number;
  litres: number;
  fuelCost: number;
  otherCost: number;
  totalCost: number;
  distanceKm: number;
  kmPerL: number | null;
  costPerKm: number | null;
  pricePerL: number | null;
}
