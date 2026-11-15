/**
 * Pricing reports: the API returns generic columns + rows (money = minor-unit strings in the row currency). The UI adds
 * per-unit figures the owner asked for (per trip, per km, per vehicle-day) computed exactly from those strings, and
 * hides cost / margin columns without pricing_costs:view. Pure module: unit-tested with node --test.
 */
import type { PricingReportColumn, PricingReportDto } from '@veetracer/shared';
import { visibleColumns } from './access.ts';
import { divideMinor } from './money.ts';
import { daysInclusive } from './preview.ts';

export type ReportRow = Record<string, string | number | null>;

export interface DerivedColumn extends PricingReportColumn {
  derived: true;
}

const num = (v: unknown): number => (typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : 0);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null);

/** Columns + rows to show: the server's (minus cost columns without the grant) plus derived per-unit columns. */
export function buildReportView(report: PricingReportDto, costsAllowed: boolean): { columns: PricingReportColumn[]; rows: ReportRow[] } {
  const base = visibleColumns(report.columns, costsAllowed);
  const has = (k: string) => base.some((c) => c.key === k);
  const derived: DerivedColumn[] = [];
  const add = (key: string, label: string) => derived.push({ key, label, kind: 'money', derived: true });
  if (has('revenueMinor') && has('trips')) add('revenuePerTripMinor', 'Revenue per trip');
  if (has('costMinor') && has('trips')) add('costPerTripMinor', 'Cost per trip');
  if (has('marginMinor') && has('trips')) add('marginPerTripMinor', 'Margin per trip');
  const days = daysInclusive(report.from, report.to);
  if (report.groupBy === 'vehicle' && has('revenueMinor') && days > 0) add('revenuePerVehicleDayMinor', 'Revenue per vehicle-day');
  if (report.type === 'trips' && has('totalMinor')) {
    if (has('billableKm')) add('perKmMinor', 'Per km');
    if (has('trips')) add('perTripMinor', 'Per trip');
  }
  const rows = report.rows.map((r) => {
    const out: ReportRow = { ...r };
    const trips = num(r.trips);
    for (const c of derived) {
      if (c.key === 'revenuePerTripMinor') out[c.key] = divideMinor(str(r.revenueMinor), trips);
      if (c.key === 'costPerTripMinor') out[c.key] = divideMinor(str(r.costMinor), trips);
      if (c.key === 'marginPerTripMinor') out[c.key] = divideMinor(str(r.marginMinor), trips);
      if (c.key === 'revenuePerVehicleDayMinor') out[c.key] = divideMinor(str(r.revenueMinor), days);
      if (c.key === 'perKmMinor') out[c.key] = divideMinor(str(r.totalMinor), num(r.billableKm));
      if (c.key === 'perTripMinor') out[c.key] = divideMinor(str(r.totalMinor), trips);
    }
    if (!costsAllowed) for (const k of Object.keys(out)) if (/^(cost|margin)/i.test(k)) delete out[k];
    return out;
  });
  return { columns: [...base, ...derived], rows };
}
