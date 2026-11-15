/**
 * Contract component editor model (doc 19 §6 "Version tabs with component cards: model presets … which prefill the
 * components"). The editor keeps every parameter as the text the person typed; `rowsToComponents` maps the rows to the
 * API's PricingComponentDto (decimal strings for money / km / hours / percent, integers for minute and stop counts),
 * `componentsToRows` maps a stored version back. Pure module: unit-tested with node --test.
 */
import { COVERAGE_KINDS, parseDecimalScaled, type CoverageKind, type PricingComponentDto, type PricingComponentKind } from '@veetracer/shared';

export type FieldType = 'money' | 'rate' | 'km' | 'hours' | 'percent' | 'int' | 'time' | 'select' | 'bool';

export interface FieldSpec {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  options?: { value: string; label: string }[];
  hint?: string;
  /** Default for a new row (text, or 'true' / 'false' for bool). */
  initial?: string;
}

export interface KindSpec {
  label: string;
  /** Help line under the card title. */
  help: string;
  fields: FieldSpec[];
  /** NIGHT / PEAK / DISCOUNT: exactly one of percent / amount. */
  either?: [string, string];
  slabs?: boolean;
  covers?: boolean;
}

const amount = (label = 'Amount'): FieldSpec => ({ key: 'amount', label, type: 'money', required: true });
const rate = (label: string): FieldSpec => ({ key: 'rate', label, type: 'rate', required: true });

/** Every kind the engine knows (packages/shared/src/pricing/types.ts PricingComponentParams). */
export const KIND_SPECS: Record<PricingComponentKind, KindSpec> = {
  BASE_FARE: { label: 'Base fare', help: 'Fixed amount added to every trip.', fields: [amount()] },
  PER_KM: { label: 'Per km', help: 'Billable km × rate.', fields: [rate('Rate per km')] },
  SLAB_KM: { label: 'Km slabs', help: 'Marginal tiers: each km is charged at the rate of the slab it falls in; the last slab is open-ended.', fields: [], slabs: true },
  MIN_TRIP_CHARGE: { label: 'Minimum trip charge', help: 'Tops the trip up to this amount.', fields: [amount('Minimum amount')] },
  MIN_BILLABLE_KM: { label: 'Minimum billable km', help: 'Trips shorter than this are billed for this many km.', fields: [{ key: 'km', label: 'Km', type: 'km', required: true }] },
  WAITING: {
    label: 'Waiting',
    help: 'Charged per started increment after the free minutes.',
    fields: [
      { key: 'freeMinutes', label: 'Free minutes', type: 'int', required: true, initial: '0' },
      { key: 'incrementMinutes', label: 'Increment (minutes)', type: 'int', required: true, initial: '15' },
      rate('Rate per increment'),
    ],
  },
  EXTRA_STOP: {
    label: 'Extra stop',
    help: 'Charged per stop beyond the included stops.',
    fields: [{ key: 'includedStops', label: 'Included stops', type: 'int', required: true, initial: '2' }, rate('Rate per extra stop')],
  },
  TOLL_PARKING_PASSTHROUGH: { label: 'Toll / parking pass-through', help: 'Actual toll and parking amounts are billed as paid (tax per the tax code; EXEMPT = no tax).', fields: [] },
  NIGHT_SURCHARGE: {
    label: 'Night surcharge',
    help: 'On the trip start time inside the band. Give either a percent or an amount.',
    fields: [
      { key: 'from', label: 'From', type: 'time', required: true, initial: '22:00' },
      { key: 'to', label: 'To', type: 'time', required: true, initial: '06:00' },
      { key: 'percent', label: 'Percent', type: 'percent' },
      { key: 'amount', label: 'Amount', type: 'money' },
    ],
    either: ['percent', 'amount'],
  },
  PEAK_SURCHARGE: {
    label: 'Peak surcharge',
    help: 'On the trip start time inside the band. Give either a percent or an amount.',
    fields: [
      { key: 'from', label: 'From', type: 'time', required: true, initial: '08:00' },
      { key: 'to', label: 'To', type: 'time', required: true, initial: '10:00' },
      { key: 'percent', label: 'Percent', type: 'percent' },
      { key: 'amount', label: 'Amount', type: 'money' },
    ],
    either: ['percent', 'amount'],
  },
  FIXED_TRIP: {
    label: 'Fixed trip price',
    help: 'One price per trip, whatever the distance.',
    fields: [amount('Trip price'), { key: 'agreedKm', label: 'Agreed km', type: 'km', hint: 'Used when the distance source is Agreed.' }],
  },
  HOURLY: {
    label: 'Hourly / shift',
    help: 'Duration × rate, rounded up to the increment.',
    fields: [
      rate('Rate per hour'),
      { key: 'incrementMinutes', label: 'Increment (minutes)', type: 'int', initial: '60' },
      {
        key: 'basis',
        label: 'Basis',
        type: 'select',
        initial: 'ACTUAL',
        options: [
          { value: 'ACTUAL', label: 'Actual duration' },
          { value: 'RESERVED', label: 'Reserved duration' },
        ],
      },
    ],
  },
  MIN_HOURS: { label: 'Minimum hours', help: 'Shorter durations are billed for this many hours.', fields: [{ key: 'hours', label: 'Hours', type: 'hours', required: true }] },
  AVAILABILITY_FEE: {
    label: 'Availability fee',
    help: 'Fee per dedicated vehicle per period (pro rata for part periods unless switched off).',
    fields: [
      amount('Fee'),
      {
        key: 'frequency',
        label: 'Per',
        type: 'select',
        required: true,
        initial: 'MONTHLY',
        options: [
          { value: 'DAILY', label: 'Day' },
          { value: 'WEEKLY', label: 'Week' },
          { value: 'MONTHLY', label: 'Month' },
        ],
      },
      { key: 'prorate', label: 'Pro rata for part periods', type: 'bool', initial: 'true' },
    ],
    covers: true,
  },
  INCLUDED_KM: { label: 'Included km', help: 'Km included in the availability fee per period.', fields: [{ key: 'km', label: 'Km', type: 'km', required: true }] },
  INCLUDED_HOURS: { label: 'Included hours', help: 'Hours included in the availability fee per period.', fields: [{ key: 'hours', label: 'Hours', type: 'hours', required: true }] },
  EXCESS_KM: { label: 'Excess km', help: 'Km above the included km × rate.', fields: [rate('Rate per km')] },
  EXCESS_HOUR: { label: 'Excess hour', help: 'Hours above the included hours × rate.', fields: [rate('Rate per hour')] },
  OVERTIME: { label: 'Overtime', help: 'Time outside the operating hours × rate.', fields: [rate('Rate per hour')] },
  HOLIDAY: { label: 'Holiday', help: 'Amount per holiday day worked.', fields: [amount('Amount per day')] },
  CANCELLATION: {
    label: 'Cancellation',
    help: 'Charged when a trip is cancelled later than the free window.',
    fields: [amount(), { key: 'freeBeforeMinutes', label: 'Free if cancelled minutes before', type: 'int', required: true, initial: '60' }],
  },
  SEAT: { label: 'Per seat', help: 'Rate per passenger.', fields: [rate('Rate per passenger')] },
  MIN_GUARANTEE: { label: 'Minimum guarantee', help: 'Tops the period up to this amount.', fields: [amount('Minimum amount')] },
  DISCOUNT: {
    label: 'Discount',
    help: 'Give either a percent or an amount.',
    fields: [
      { key: 'percent', label: 'Percent', type: 'percent' },
      { key: 'amount', label: 'Amount', type: 'money' },
    ],
    either: ['percent', 'amount'],
  },
};

/** Model presets (doc 19 §6): each prefills the components of a pricing model. */
export const MODEL_PRESETS = ['DISTANCE', 'FIXED_AVAILABILITY', 'HOURLY', 'FIXED_TRIP', 'HYBRID', 'ON_DEMAND'] as const;
export type ModelPreset = (typeof MODEL_PRESETS)[number];

export const PRESET_LABEL: Record<ModelPreset, string> = {
  DISTANCE: 'Distance based',
  FIXED_AVAILABILITY: 'Fixed availability',
  HOURLY: 'Hourly / shift',
  FIXED_TRIP: 'Fixed trip',
  HYBRID: 'Hybrid (availability + excess km)',
  ON_DEMAND: 'On-demand',
};

export const PRESET_KINDS: Record<ModelPreset, PricingComponentKind[]> = {
  DISTANCE: ['BASE_FARE', 'PER_KM', 'MIN_BILLABLE_KM', 'WAITING', 'NIGHT_SURCHARGE'],
  FIXED_AVAILABILITY: ['AVAILABILITY_FEE', 'OVERTIME', 'HOLIDAY'],
  HOURLY: ['HOURLY', 'MIN_HOURS', 'WAITING'],
  FIXED_TRIP: ['FIXED_TRIP', 'EXTRA_STOP', 'NIGHT_SURCHARGE'],
  HYBRID: ['AVAILABILITY_FEE', 'INCLUDED_KM', 'EXCESS_KM', 'INCLUDED_HOURS', 'EXCESS_HOUR'],
  ON_DEMAND: ['BASE_FARE', 'PER_KM', 'MIN_TRIP_CHARGE', 'WAITING', 'CANCELLATION', 'PEAK_SURCHARGE'],
};

export interface ComponentRow {
  /** Stable React key (not sent). */
  key: string;
  kind: PricingComponentKind;
  label: string;
  taxCode: string;
  /** Scope narrowing by vehicle category (the scope field the UI edits; others are kept as loaded). */
  vehicleCategory: string;
  covers: CoverageKind[];
  params: Record<string, string>;
  slabs: { uptoKm: string; rate: string }[];
  /** Scope fields the editor does not show, passed through unchanged. */
  restScope: Record<string, unknown>;
}

let seq = 0;
const nextKey = () => `c${Date.now().toString(36)}${(seq++).toString(36)}`;

export function newRow(kind: PricingComponentKind): ComponentRow {
  const spec = KIND_SPECS[kind];
  const params: Record<string, string> = {};
  for (const f of spec.fields) params[f.key] = f.initial ?? '';
  return {
    key: nextKey(),
    kind,
    label: '',
    taxCode: '',
    vehicleCategory: '',
    covers: spec.covers ? ['VEHICLE_TIME'] : [],
    params,
    slabs: spec.slabs ? [{ uptoKm: '10', rate: '' }, { uptoKm: '', rate: '' }] : [],
    restScope: {},
  };
}

export const presetRows = (preset: ModelPreset): ComponentRow[] => PRESET_KINDS[preset].map(newRow);

const str = (v: unknown): string => (v === null || v === undefined ? '' : typeof v === 'boolean' ? String(v) : String(v));

/** Stored component → editor row. */
export function componentToRow(c: PricingComponentDto): ComponentRow {
  const spec = KIND_SPECS[c.kind];
  const raw = (c.params ?? {}) as Record<string, unknown>;
  const params: Record<string, string> = {};
  for (const f of spec?.fields ?? []) params[f.key] = f.type === 'bool' && raw[f.key] === undefined ? (f.initial ?? 'false') : str(raw[f.key]);
  const slabs = Array.isArray(raw.slabs) ? (raw.slabs as { uptoKm?: unknown; rate?: unknown }[]).map((s) => ({ uptoKm: str(s.uptoKm), rate: str(s.rate) })) : [];
  const { vehicleCategory, ...restScope } = (c.scope ?? {}) as Record<string, unknown>;
  return {
    key: nextKey(),
    kind: c.kind,
    label: c.label ?? '',
    taxCode: c.taxCode ?? '',
    vehicleCategory: str(vehicleCategory),
    covers: [...(c.covers ?? [])],
    params,
    slabs,
    restScope,
  };
}

export const componentsToRows = (list: readonly PricingComponentDto[]): ComponentRow[] => [...list].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)).map(componentToRow);

/** Editor row → API component (request body). Empty optional fields are left out; sortOrder = position. */
export function rowToComponent(row: ComponentRow, index: number): PricingComponentDto {
  const spec = KIND_SPECS[row.kind];
  const params: Record<string, unknown> = {};
  for (const f of spec.fields) {
    const v = (row.params[f.key] ?? '').trim();
    if (f.type === 'bool') {
      params[f.key] = v === 'true';
      continue;
    }
    if (v === '') continue;
    params[f.key] = f.type === 'int' ? Number(v) : v;
  }
  if (spec.slabs) params.slabs = row.slabs.map((s, i, all) => ({ uptoKm: i === all.length - 1 || !s.uptoKm.trim() ? null : s.uptoKm.trim(), rate: s.rate.trim() }));
  const scope: Record<string, unknown> = { ...row.restScope };
  if (row.vehicleCategory.trim()) scope.vehicleCategory = row.vehicleCategory.trim();
  const out: PricingComponentDto = {
    kind: row.kind,
    label: row.label.trim() || null,
    scope: Object.keys(scope).length ? scope : null,
    params,
    taxCode: row.taxCode.trim() ? row.taxCode.trim().toUpperCase() : null,
    sortOrder: index,
  };
  if (spec.covers) out.covers = COVERAGE_KINDS.filter((k) => row.covers.includes(k));
  return out;
}

export const rowsToComponents = (rows: readonly ComponentRow[]): PricingComponentDto[] => rows.map(rowToComponent);

function decimalOk(v: string, scale: number): boolean {
  try {
    return parseDecimalScaled(v, scale) >= 0n;
  } catch {
    return false;
  }
}

/** Field-level checks before sending (the server re-validates everything). Map of field key → English message. */
export function validateRow(row: ComponentRow): Record<string, string> {
  const spec = KIND_SPECS[row.kind];
  const errors: Record<string, string> = {};
  for (const f of spec.fields) {
    const v = (row.params[f.key] ?? '').trim();
    if (f.type === 'bool' || f.type === 'select') {
      if (f.required && !v) errors[f.key] = 'Required';
      continue;
    }
    if (!v) {
      if (f.required) errors[f.key] = 'Required';
      continue;
    }
    if (f.type === 'int' && !/^\d{1,6}$/.test(v)) errors[f.key] = 'Enter a whole number';
    else if ((f.type === 'money' || f.type === 'rate') && !decimalOk(v, 6)) errors[f.key] = 'Enter an amount (up to 6 decimals)';
    else if ((f.type === 'km' || f.type === 'percent' || f.type === 'hours') && !decimalOk(v, f.type === 'km' ? 3 : 4)) errors[f.key] = 'Enter a number';
    else if (f.type === 'time' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) errors[f.key] = 'Use HH:MM';
  }
  if (spec.either) {
    const [a, b] = spec.either;
    const hasA = !!row.params[a]?.trim();
    const hasB = !!row.params[b]?.trim();
    if (hasA === hasB) errors[a] = errors[a] ?? 'Give either a percent or an amount';
  }
  if (spec.slabs) {
    if (!row.slabs.length) errors.slabs = 'Add at least one slab';
    row.slabs.forEach((s, i) => {
      const last = i === row.slabs.length - 1;
      if (!decimalOk(s.rate.trim(), 6)) errors[`slab${i}.rate`] = 'Enter an amount (up to 6 decimals)';
      if (!last && !decimalOk(s.uptoKm.trim(), 3)) errors[`slab${i}.uptoKm`] = 'Enter a number';
    });
  }
  if (spec.covers && !row.covers.length) errors.covers = 'Choose what the fee covers';
  if (row.taxCode.trim() && !/^[A-Za-z0-9_]{1,32}$/.test(row.taxCode.trim())) errors.taxCode = 'Letters, digits and _ only';
  return errors;
}

export const COVERAGE_LABEL: Record<CoverageKind, string> = {
  VEHICLE_TIME: 'Vehicle time',
  KM_INCLUDED: 'Included km',
  HOURS_INCLUDED: 'Included hours',
  TRIPS: 'Trips (no per-trip charge)',
};
