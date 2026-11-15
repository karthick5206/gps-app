/**
 * Customer pricing engine (doc 19 §5.2): pure, deterministic, exact. Evaluation order: coverage → base by model →
 * add-ons → discounts → tax → totals. Every line is converted from micro major units to minor units ONCE with the
 * contract rounding mode; totals are sums of the rounded lines.
 */
import { findDoubleCharges, isPerTrip, isTripCovered } from './coverage';
import { currencyExponent, isCurrency, formatMinor } from './currency';
import { allocateLargestRemainder, divCeil, divRound, formatMicro, hoursToSeconds, kmToMetres, parseDecimalMicro, percentToPpm, sumBig } from './money';
import { componentsInScope, scopesOverlap, type ScopeFacts } from './scope';
import { applyTax } from './tax';
import { daysBetweenInclusive } from './period';
import {
  PRICING_COMPONENT_KINDS,
  PRICING_ENGINE_VERSION,
  type PeriodPriceInput,
  type PriceLine,
  type PriceResult,
  type PriceStatus,
  type PricingComponentInput,
  type PricingComponentKind,
  type PricingIssue,
  type PricingPolicies,
  type RoundingMode,
  type TaxConfig,
  type TripPriceInput,
} from './types';

export type TripBaseModel = 'DISTANCE' | 'FIXED_TRIP' | 'HOURLY';

class ParamError extends Error {}

type P = Record<string, unknown>;
const raw = (p: P, k: string): unknown => p?.[k];
function str(p: P, k: string, kind: string): string {
  const v = raw(p, k);
  if (typeof v === 'string' && v.trim()) return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  throw new ParamError(`${kind}: "${k}" is required`);
}
function wrap<T>(kind: string, k: string, f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof ParamError) throw e;
    throw new ParamError(`${kind}: "${k}" is invalid (${(e as Error).message})`);
  }
}
/** Decimal major amount / rate → micro (non-negative). */
function micro(p: P, k: string, kind: string): bigint {
  const v = wrap(kind, k, () => parseDecimalMicro(str(p, k, kind)));
  if (v < 0n) throw new ParamError(`${kind}: "${k}" must not be negative`);
  return v;
}
const metres = (p: P, k: string, kind: string) => wrap(kind, k, () => kmToMetres(str(p, k, kind)));
const seconds = (p: P, k: string, kind: string) => wrap(kind, k, () => hoursToSeconds(str(p, k, kind)));
const ppm = (p: P, k: string, kind: string) => wrap(kind, k, () => percentToPpm(str(p, k, kind)));
function int(p: P, k: string, kind: string, def?: number): number {
  const v = raw(p, k);
  if ((v === undefined || v === null || v === '') && def !== undefined) return def;
  const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 1_000_000) throw new ParamError(`${kind}: "${k}" must be a whole number ≥ 0`);
  return n;
}
function hhmm(p: P, k: string, kind: string): number {
  const v = raw(p, k);
  const m = typeof v === 'string' ? /^([01]\d|2[0-3]):([0-5]\d)$/.exec(v.trim()) : null;
  if (!m) throw new ParamError(`${kind}: "${k}" must be HH:MM`);
  return Number(m[1]) * 60 + Number(m[2]);
}
interface Slab {
  uptoM: number | null;
  rate: bigint;
}
function slabs(p: P, kind: string): Slab[] {
  const v = raw(p, 'slabs');
  if (!Array.isArray(v) || !v.length) throw new ParamError(`${kind}: "slabs" must be a non-empty list`);
  const out = v.map((s, i) => {
    const o = (s ?? {}) as P;
    const upto = o.uptoKm === null || o.uptoKm === undefined || o.uptoKm === '' ? null : metres(o, 'uptoKm', kind);
    if (upto === null && i !== v.length - 1) throw new ParamError(`${kind}: only the last slab may be open-ended`);
    return { uptoM: upto, rate: micro(o, 'rate', kind) };
  });
  for (let i = 1; i < out.length; i++) {
    const prev = out[i - 1].uptoM!;
    if (out[i].uptoM !== null && out[i].uptoM! <= prev) throw new ParamError(`${kind}: slab limits must increase`);
  }
  return out;
}

/** Parse-check one component's params (the same parsers pricing uses). */
function checkParams(c: PricingComponentInput): void {
  const p = (c.params ?? {}) as P;
  const k = c.kind;
  switch (k) {
    case 'BASE_FARE':
    case 'MIN_TRIP_CHARGE':
    case 'MIN_GUARANTEE':
    case 'HOLIDAY':
      micro(p, 'amount', k);
      return;
    case 'FIXED_TRIP':
      micro(p, 'amount', k);
      if (raw(p, 'agreedKm') !== undefined && raw(p, 'agreedKm') !== null) metres(p, 'agreedKm', k);
      return;
    case 'PER_KM':
    case 'EXCESS_KM':
    case 'EXCESS_HOUR':
    case 'OVERTIME':
    case 'SEAT':
      micro(p, 'rate', k);
      return;
    case 'SLAB_KM':
      slabs(p, k);
      return;
    case 'MIN_BILLABLE_KM':
    case 'INCLUDED_KM':
      metres(p, 'km', k);
      return;
    case 'MIN_HOURS':
    case 'INCLUDED_HOURS':
      seconds(p, 'hours', k);
      return;
    case 'HOURLY': {
      micro(p, 'rate', k);
      if (int(p, 'incrementMinutes', k, 60) === 0) throw new ParamError('HOURLY: incrementMinutes must be ≥ 1');
      const b = raw(p, 'basis');
      if (b !== undefined && b !== null && b !== 'ACTUAL' && b !== 'RESERVED') throw new ParamError('HOURLY: basis must be ACTUAL or RESERVED');
      return;
    }
    case 'WAITING':
      int(p, 'freeMinutes', k, 0);
      if (int(p, 'incrementMinutes', k, 1) === 0) throw new ParamError('WAITING: incrementMinutes must be ≥ 1');
      micro(p, 'rate', k);
      return;
    case 'EXTRA_STOP':
      int(p, 'includedStops', k, 0);
      micro(p, 'rate', k);
      return;
    case 'NIGHT_SURCHARGE':
    case 'PEAK_SURCHARGE':
      hhmm(p, 'from', k);
      hhmm(p, 'to', k);
      surchargeOf(p, k);
      return;
    case 'TOLL_PARKING_PASSTHROUGH':
      return;
    case 'AVAILABILITY_FEE': {
      micro(p, 'amount', k);
      const f = raw(p, 'frequency');
      if (f !== 'DAILY' && f !== 'WEEKLY' && f !== 'MONTHLY') throw new ParamError('AVAILABILITY_FEE: frequency must be DAILY, WEEKLY or MONTHLY');
      return;
    }
    case 'CANCELLATION':
      micro(p, 'amount', k);
      int(p, 'freeBeforeMinutes', k, 0);
      return;
    case 'DISCOUNT':
      discountOf(p);
      return;
  }
}
function surchargeOf(p: P, kind: string): { ppm: number } | { amount: bigint } {
  const hasPct = raw(p, 'percent') !== undefined && raw(p, 'percent') !== null && raw(p, 'percent') !== '';
  const hasAmt = raw(p, 'amount') !== undefined && raw(p, 'amount') !== null && raw(p, 'amount') !== '';
  if (hasPct === hasAmt) throw new ParamError(`${kind}: give either percent or amount`);
  return hasPct ? { ppm: ppm(p, 'percent', kind) } : { amount: micro(p, 'amount', kind) };
}
function discountOf(p: P): { ppm: number } | { amount: bigint } {
  const d = surchargeOf(p, 'DISCOUNT');
  if ('ppm' in d && d.ppm > 1_000_000) throw new ParamError('DISCOUNT: percent must be ≤ 100');
  return d;
}

const DISTANCE_KINDS: readonly PricingComponentKind[] = ['PER_KM', 'SLAB_KM'];
const modelOfKind = (k: PricingComponentKind): TripBaseModel | null =>
  DISTANCE_KINDS.includes(k) ? 'DISTANCE' : k === 'FIXED_TRIP' ? 'FIXED_TRIP' : k === 'HOURLY' ? 'HOURLY' : null;

/** Trip base model of (in-scope) components: FIXED_TRIP > HOURLY > DISTANCE (PER_KM / SLAB_KM / BASE_FARE only). */
export function tripBaseModel(components: readonly PricingComponentInput[]): TripBaseModel | null {
  const kinds = new Set(components.map((c) => c.kind));
  if (kinds.has('FIXED_TRIP')) return 'FIXED_TRIP';
  if (kinds.has('HOURLY')) return 'HOURLY';
  if (kinds.has('PER_KM') || kinds.has('SLAB_KM') || kinds.has('BASE_FARE')) return 'DISTANCE';
  return null;
}

/** A vehicle rate's components replace every base component of the same kind. */
export function mergeVehicleOverrides(base: readonly PricingComponentInput[], overrides: readonly PricingComponentInput[]): PricingComponentInput[] {
  const replaced = new Set(overrides.map((o) => o.kind));
  return [...base.filter((c) => !replaced.has(c.kind)), ...overrides];
}

/** Version validation at submit / approval: params, ambiguous models, double charges. */
export function validateComponents(components: readonly PricingComponentInput[], policies?: PricingPolicies | null): PricingIssue[] {
  const issues: PricingIssue[] = [];
  for (const c of components) {
    if (!PRICING_COMPONENT_KINDS.includes(c.kind)) {
      issues.push({ code: 'INVALID_COMPONENT', message: `Unknown component kind ${String(c.kind)}` });
      continue;
    }
    try {
      checkParams(c);
    } catch (e) {
      issues.push({ code: 'INVALID_COMPONENT', message: (e as Error).message });
    }
  }
  const based = components.filter((c) => modelOfKind(c.kind) !== null);
  outer: for (let i = 0; i < based.length; i++) {
    for (let j = i + 1; j < based.length; j++) {
      const a = based[i];
      const b = based[j];
      // Any two trip-base components (PER_KM / SLAB_KM / FIXED_TRIP / HOURLY, also two of the same kind) in one scope.
      if (scopesOverlap(a.scope, b.scope)) {
        issues.push({ code: 'AMBIGUOUS_BASE_MODEL', message: `${a.kind} and ${b.kind} apply to the same scope: one trip pricing model per scope` });
        break outer;
      }
    }
  }
  issues.push(...findDoubleCharges(components, policies));
  return issues;
}

export function assertSameCurrency(a: string, b: string): PricingIssue | null {
  return a === b ? null : { code: 'CURRENCY_MISMATCH', message: `Currency ${b} does not match the contract currency ${a}` };
}

// ───────────── Line building ─────────────

interface Ctx {
  currency: string;
  mode: RoundingMode;
  scale: bigint;
  lines: PriceLine[];
  /** Lines excluded from discounts (pass-through). */
  passthrough: Set<PriceLine>;
}
const kmText = (m: number) => `${Math.floor(m / 1000)}.${String(m % 1000).padStart(3, '0')}`;
const hText = (s: number) => {
  const h4 = divRound(BigInt(s) * 10_000n, 3600n, 'HALF_UP');
  return formatMicro(h4 * 100n, 4).replace(/\.?0+$/, '') || '0';
};
const pctText = (p: number) => formatMicro(BigInt(p) * 100n, 4).replace(/\.?0+$/, '');

/** num / den micro major units → one rounded minor line. */
function add(ctx: Ctx, l: { component: string; label: string; quantity: string; unit: string; rateMicro?: bigint; num: bigint; den?: bigint; basis: string; taxCode?: string | null }): PriceLine {
  const amountMinor = divRound(l.num, (l.den ?? 1n) * ctx.scale, ctx.mode);
  return push(ctx, { ...l, amountMinor });
}
function push(ctx: Ctx, l: { component: string; label: string; quantity: string; unit: string; rateMicro?: bigint; amountMinor: bigint; basis: string; taxCode?: string | null }): PriceLine {
  const line: PriceLine = {
    component: l.component,
    label: l.label,
    quantity: l.quantity,
    unit: l.unit,
    ...(l.rateMicro !== undefined ? { rateMicro: l.rateMicro.toString() } : {}),
    amountMinor: l.amountMinor,
    discountMinor: 0n,
    taxCode: l.taxCode ?? null,
    taxMinor: 0n,
    basis: l.basis,
  };
  ctx.lines.push(line);
  return line;
}
const labelOf = (c: PricingComponentInput, def: string) => (c.label && c.label.trim()) || def;
const r6 = (m: bigint) => formatMicro(m);

function emptyResult(status: PriceStatus, currency: string, issues: PricingIssue[], lines: PriceLine[] = []): PriceResult {
  return { status, currency, lines, subtotalMinor: sumBig(lines.map((l) => l.amountMinor)), discountMinor: 0n, taxLines: [], taxMinor: 0n, totalMinor: sumBig(lines.map((l) => l.amountMinor)), issues, engineVersion: PRICING_ENGINE_VERSION };
}

function applyDiscounts(ctx: Ctx, discounts: PricingComponentInput[]): void {
  if (!discounts.length) return;
  const eligible = ctx.lines.filter((l) => !ctx.passthrough.has(l) && l.amountMinor > 0n);
  const base = sumBig(eligible.map((l) => l.amountMinor));
  if (base <= 0n) return;
  let total = 0n;
  const basis: string[] = [];
  for (const d of discounts) {
    const v = discountOf((d.params ?? {}) as P);
    if ('ppm' in v) {
      total += divRound(base * BigInt(v.ppm), 1_000_000n, ctx.mode);
      basis.push(`${pctText(v.ppm)} %`);
    } else {
      total += divRound(v.amount, ctx.scale, ctx.mode);
      basis.push(`${r6(v.amount)} fixed`);
    }
  }
  if (total > base) total = base; // never below zero
  const parts = allocateLargestRemainder(total, eligible.map((l) => l.amountMinor));
  eligible.forEach((l, i) => {
    l.discountMinor = parts[i];
  });
}

function finish(ctx: Ctx, status: PriceStatus, issues: PricingIssue[], tax: TaxConfig): PriceResult {
  const t = applyTax(ctx.lines, tax, ctx.mode);
  const all = [...issues, ...t.issues];
  const subtotalMinor = sumBig(t.lines.map((l) => l.amountMinor));
  const discountMinor = sumBig(t.lines.map((l) => l.discountMinor));
  const taxMinor = sumBig(t.lines.map((l) => l.taxMinor));
  const failed = all.some((i) => i.code === 'TAX_PROFILE_MISSING' || i.code === 'INVALID_COMPONENT' || i.code === 'CURRENCY_MISMATCH');
  return {
    status: failed ? 'ERROR' : status,
    currency: ctx.currency,
    lines: t.lines,
    subtotalMinor,
    discountMinor,
    taxLines: t.taxLines,
    taxMinor,
    totalMinor: subtotalMinor - discountMinor + taxMinor,
    issues: all,
    engineVersion: PRICING_ENGINE_VERSION,
  };
}

function newCtx(currency: string, mode: RoundingMode): Ctx {
  return { currency, mode, scale: 10n ** BigInt(6 - currencyExponent(currency)), lines: [], passthrough: new Set() };
}

const inBand = (minute: number, from: number, to: number) => (from <= to ? minute >= from && minute < to : minute >= from || minute < to);

// ───────────── Trip ─────────────

export function priceTrip(input: TripPriceInput): PriceResult {
  const { facts } = input;
  if (!isCurrency(input.currency)) return emptyResult('ERROR', input.currency, [{ code: 'CURRENCY_MISMATCH', message: `Unknown currency ${String(input.currency)}` }]);
  const ctx = newCtx(input.currency, input.roundingMode);
  const okStatus: PriceStatus = input.estimate ? 'ESTIMATE' : 'PRICED';
  const issues: PricingIssue[] = [];
  const scopeFacts: ScopeFacts = facts;
  const comps = componentsInScope(input.components, scopeFacts);
  const bad = comps.flatMap((c) => {
    try {
      checkParams(c);
      return [];
    } catch (e) {
      return [{ code: 'INVALID_COMPONENT' as const, message: (e as Error).message }];
    }
  });
  if (bad.length) return emptyResult('ERROR', input.currency, bad);

  // Precedence 3: a negotiated trip price replaces the computed price.
  if (input.overrideMinor !== null && input.overrideMinor !== undefined) {
    if (input.overrideMinor < 0n) return emptyResult('ERROR', input.currency, [{ code: 'INVALID_COMPONENT', message: 'An override must not be negative' }]);
    push(ctx, { component: 'OVERRIDE', label: 'Negotiated trip price', quantity: '1', unit: 'trip', amountMinor: input.overrideMinor, basis: `negotiated price ${formatMinor(input.overrideMinor, input.currency)}${input.overrideReason ? `: ${input.overrideReason}` : ''}` });
    return finish(ctx, okStatus, issues, input.tax);
  }

  // 1. Coverage.
  const cov = isTripCovered(comps, input.policies, facts);
  if (cov.covered) {
    push(ctx, { component: 'COVERED', label: 'Covered by availability contract', quantity: '1', unit: 'trip', amountMinor: 0n, basis: cov.basis });
    return finish(ctx, 'COVERED', issues, input.tax);
  }
  const hasFee = comps.some((c) => c.kind === 'AVAILABILITY_FEE');
  const of = (k: PricingComponentKind) => comps.filter((c) => c.kind === k && (!hasFee || !['INCLUDED_KM', 'INCLUDED_HOURS', 'EXCESS_KM', 'EXCESS_HOUR'].includes(k) || isPerTrip(c)));
  const first = (k: PricingComponentKind) => of(k)[0];

  // Cancellation: only the cancellation line.
  if (facts.cancelledMinutesBefore !== null && facts.cancelledMinutesBefore !== undefined) {
    const c = first('CANCELLATION');
    if (!c) push(ctx, { component: 'CANCELLATION', label: 'Cancelled', quantity: '1', unit: 'trip', amountMinor: 0n, basis: 'cancelled; no cancellation charge configured' });
    else {
      const p = c.params as P;
      const free = int(p, 'freeBeforeMinutes', 'CANCELLATION', 0);
      if (facts.cancelledMinutesBefore < free) add(ctx, { component: 'CANCELLATION', label: labelOf(c, 'Cancellation charge'), quantity: '1', unit: 'trip', num: micro(p, 'amount', 'CANCELLATION'), basis: `cancelled ${facts.cancelledMinutesBefore} min before start (free until ${free} min)`, taxCode: c.taxCode });
      else push(ctx, { component: 'CANCELLATION', label: labelOf(c, 'Cancellation charge'), quantity: '0', unit: 'trip', amountMinor: 0n, basis: `cancelled ${facts.cancelledMinutesBefore} min before start: free (≥ ${free} min)`, taxCode: c.taxCode });
    }
    return finish(ctx, okStatus, issues, input.tax);
  }

  // 2. Base by model.
  const model = tripBaseModel(comps);
  if (!model) return emptyResult('NO_APPLICABLE_PRICING', input.currency, [{ code: 'NO_APPLICABLE_PRICING', message: 'The contract has no trip pricing for this trip (scope / model)' }]);
  const review = (why: string) => emptyResult('NEEDS_REVIEW', input.currency, [{ code: 'GPS_DISTANCE_REVIEW', message: why }]);
  const baseLines: PriceLine[] = [];
  const dist = facts.billableDistanceM;

  const excessKm = (): boolean => {
    const inc = first('INCLUDED_KM');
    const ex = first('EXCESS_KM');
    if (!ex) return true;
    if (dist === null || dist === undefined) return false;
    const incM = inc ? metres(inc.params as P, 'km', 'INCLUDED_KM') : 0;
    const over = Math.max(0, dist - incM);
    const rate = micro(ex.params as P, 'rate', 'EXCESS_KM');
    baseLines.push(add(ctx, { component: 'EXCESS_KM', label: labelOf(ex, 'Excess km'), quantity: kmText(over), unit: 'km', rateMicro: rate, num: rate * BigInt(over), den: 1000n, basis: `${kmText(dist)} km − ${kmText(incM)} km included = ${kmText(over)} km × ${r6(rate)}/km`, taxCode: ex.taxCode }));
    return true;
  };

  if (model === 'DISTANCE') {
    const bf = first('BASE_FARE');
    const perKm = first('PER_KM');
    const slab = first('SLAB_KM');
    if (perKm || slab) {
      if (dist === null || dist === undefined) return review('Billable distance unknown (GPS missing or low coverage): the trip needs review');
      const minKm = first('MIN_BILLABLE_KM');
      const minM = minKm ? metres(minKm.params as P, 'km', 'MIN_BILLABLE_KM') : 0;
      const m = Math.max(dist, minM);
      if (bf) baseLines.push(add(ctx, { component: 'BASE_FARE', label: labelOf(bf, 'Base fare'), quantity: '1', unit: 'trip', num: micro(bf.params as P, 'amount', 'BASE_FARE'), basis: 'base fare', taxCode: bf.taxCode }));
      const minNote = m > dist ? ` (minimum ${kmText(minM)} km applied to ${kmText(dist)} km)` : '';
      if (perKm) {
        const rate = micro(perKm.params as P, 'rate', 'PER_KM');
        baseLines.push(add(ctx, { component: 'PER_KM', label: labelOf(perKm, 'Distance'), quantity: kmText(m), unit: 'km', rateMicro: rate, num: rate * BigInt(m), den: 1000n, basis: `${kmText(m)} km × ${r6(rate)}/km${minNote}`, taxCode: perKm.taxCode }));
      } else if (slab) {
        const ss = slabs(slab.params as P, 'SLAB_KM');
        let prev = 0;
        let num = 0n;
        const parts: string[] = [];
        for (const s of ss) {
          if (m <= prev) break;
          const top = s.uptoM === null ? m : Math.min(m, s.uptoM);
          const inSlab = top - prev;
          num += s.rate * BigInt(inSlab);
          parts.push(`${kmText(inSlab)} km × ${r6(s.rate)}`);
          prev = top;
          if (s.uptoM === null) break;
        }
        if (m > prev) {
          // Beyond the last bounded slab: its rate continues.
          const last = ss[ss.length - 1];
          num += last.rate * BigInt(m - prev);
          parts.push(`${kmText(m - prev)} km × ${r6(last.rate)}`);
        }
        baseLines.push(add(ctx, { component: 'SLAB_KM', label: labelOf(slab, 'Distance (slabs)'), quantity: kmText(m), unit: 'km', num, den: 1000n, basis: `${parts.join(' + ')}${minNote}`, taxCode: slab.taxCode }));
      }
    } else if (bf) {
      baseLines.push(add(ctx, { component: 'BASE_FARE', label: labelOf(bf, 'Base fare'), quantity: '1', unit: 'trip', num: micro(bf.params as P, 'amount', 'BASE_FARE'), basis: 'base fare', taxCode: bf.taxCode }));
    }
    const minCharge = first('MIN_TRIP_CHARGE');
    if (minCharge) {
      const minMinor = divRound(micro(minCharge.params as P, 'amount', 'MIN_TRIP_CHARGE'), ctx.scale, ctx.mode);
      const charged = sumBig(baseLines.map((l) => l.amountMinor));
      if (charged < minMinor) baseLines.push(push(ctx, { component: 'MIN_TRIP_TOP_UP', label: labelOf(minCharge, 'Minimum trip charge'), quantity: '1', unit: 'trip', amountMinor: minMinor - charged, basis: `minimum trip charge ${formatMinor(minMinor, ctx.currency)} (charged ${formatMinor(charged, ctx.currency)})`, taxCode: minCharge.taxCode }));
    }
  } else if (model === 'FIXED_TRIP') {
    const f = first('FIXED_TRIP')!;
    const bf = first('BASE_FARE');
    if (bf) baseLines.push(add(ctx, { component: 'BASE_FARE', label: labelOf(bf, 'Base fare'), quantity: '1', unit: 'trip', num: micro(bf.params as P, 'amount', 'BASE_FARE'), basis: 'base fare', taxCode: bf.taxCode }));
    baseLines.push(add(ctx, { component: 'FIXED_TRIP', label: labelOf(f, 'Fixed trip price'), quantity: '1', unit: 'trip', num: micro(f.params as P, 'amount', 'FIXED_TRIP'), basis: 'agreed fixed price (distance does not change it)', taxCode: f.taxCode }));
    if (!excessKm()) return review('Excess km is configured but the billable distance is unknown: the trip needs review');
  } else {
    const h = first('HOURLY')!;
    const p = h.params as P;
    const basis = (raw(p, 'basis') as string | undefined) ?? 'ACTUAL';
    const dur = basis === 'RESERVED' ? facts.reservedDurationS : facts.actualDurationS;
    if (dur === null || dur === undefined || dur < 0) return emptyResult('NEEDS_REVIEW', input.currency, [{ code: 'MISSING_FACT', message: `Hourly pricing needs the ${basis.toLowerCase()} duration` }]);
    const inc = int(p, 'incrementMinutes', 'HOURLY', 60) * 60;
    let billed = Number(divCeil(BigInt(dur), BigInt(inc))) * inc;
    const minH = first('MIN_HOURS');
    const minS = minH ? seconds(minH.params as P, 'hours', 'MIN_HOURS') : 0;
    const minNote = billed < minS ? ` (minimum ${hText(minS)} h applied)` : '';
    billed = Math.max(billed, minS);
    const rate = micro(p, 'rate', 'HOURLY');
    const bf = first('BASE_FARE');
    if (bf) baseLines.push(add(ctx, { component: 'BASE_FARE', label: labelOf(bf, 'Base fare'), quantity: '1', unit: 'trip', num: micro(bf.params as P, 'amount', 'BASE_FARE'), basis: 'base fare', taxCode: bf.taxCode }));
    baseLines.push(add(ctx, { component: 'HOURLY', label: labelOf(h, 'Hours'), quantity: hText(billed), unit: 'h', rateMicro: rate, num: rate * BigInt(billed), den: 3600n, basis: `${hText(dur)} h ${basis.toLowerCase()} → ${hText(billed)} h billed (per ${inc / 60} min) × ${r6(rate)}/h${minNote}`, taxCode: h.taxCode }));
    if (!excessKm()) return review('Excess km is configured but the billable distance is unknown: the trip needs review');
  }
  const baseMinor = sumBig(baseLines.map((l) => l.amountMinor));

  // 3. Add-ons.
  const w = first('WAITING');
  if (w && facts.waitingS) {
    const p = w.params as P;
    const free = int(p, 'freeMinutes', 'WAITING', 0) * 60;
    const inc = int(p, 'incrementMinutes', 'WAITING', 1) * 60;
    const over = Math.max(0, facts.waitingS - free);
    if (over > 0) {
      const n = divCeil(BigInt(over), BigInt(inc));
      const rate = micro(p, 'rate', 'WAITING');
      add(ctx, { component: 'WAITING', label: labelOf(w, 'Waiting'), quantity: n.toString(), unit: `${inc / 60} min`, rateMicro: rate, num: rate * n, basis: `${Math.ceil(facts.waitingS / 60)} min waited − ${free / 60} min free → ${n} × ${inc / 60} min × ${r6(rate)}`, taxCode: w.taxCode });
    }
  }
  const es = first('EXTRA_STOP');
  if (es && facts.stops) {
    const p = es.params as P;
    const extra = Math.max(0, facts.stops - int(p, 'includedStops', 'EXTRA_STOP', 0));
    if (extra > 0) {
      const rate = micro(p, 'rate', 'EXTRA_STOP');
      add(ctx, { component: 'EXTRA_STOP', label: labelOf(es, 'Extra stops'), quantity: String(extra), unit: 'stop', rateMicro: rate, num: rate * BigInt(extra), basis: `${facts.stops} stops − ${int(p, 'includedStops', 'EXTRA_STOP', 0)} included = ${extra} × ${r6(rate)}`, taxCode: es.taxCode });
    }
  }
  for (const kind of ['NIGHT_SURCHARGE', 'PEAK_SURCHARGE'] as const) {
    const s = first(kind);
    if (!s || facts.startMinuteOfDay === null || facts.startMinuteOfDay === undefined) continue;
    const p = s.params as P;
    const from = hhmm(p, 'from', kind);
    const to = hhmm(p, 'to', kind);
    if (!inBand(facts.startMinuteOfDay, from, to)) continue;
    const v = surchargeOf(p, kind);
    const name = kind === 'NIGHT_SURCHARGE' ? 'Night surcharge' : 'Peak surcharge';
    const band = `${String(p.from)}–${String(p.to)}`;
    if ('ppm' in v) push(ctx, { component: kind, label: labelOf(s, name), quantity: pctText(v.ppm), unit: '%', amountMinor: divRound(baseMinor * BigInt(v.ppm), 1_000_000n, ctx.mode), basis: `${pctText(v.ppm)} % of base ${formatMinor(baseMinor, ctx.currency)} (start in ${band})`, taxCode: s.taxCode });
    else add(ctx, { component: kind, label: labelOf(s, name), quantity: '1', unit: 'trip', num: v.amount, basis: `fixed surcharge (start in ${band})`, taxCode: s.taxCode });
  }
  const toll = first('TOLL_PARKING_PASSTHROUGH');
  if (toll && facts.tollsMinor && facts.tollsMinor > 0n) {
    const l = push(ctx, { component: 'TOLL_PARKING_PASSTHROUGH', label: labelOf(toll, 'Tolls & parking'), quantity: '1', unit: 'actual', amountMinor: facts.tollsMinor, basis: 'actual amounts paid (pass-through)', taxCode: toll.taxCode });
    ctx.passthrough.add(l);
  }
  const seat = first('SEAT');
  if (seat && facts.passengers) {
    const rate = micro(seat.params as P, 'rate', 'SEAT');
    add(ctx, { component: 'SEAT', label: labelOf(seat, 'Passengers'), quantity: String(facts.passengers), unit: 'passenger', rateMicro: rate, num: rate * BigInt(facts.passengers), basis: `${facts.passengers} × ${r6(rate)}`, taxCode: seat.taxCode });
  }

  // 4. Discounts, 5. tax, 6. totals.
  applyDiscounts(ctx, of('DISCOUNT'));
  return finish(ctx, okStatus, issues, input.tax);
}

// ───────────── Availability period ─────────────

export function pricePeriod(input: PeriodPriceInput): PriceResult {
  const f = input.facts;
  if (!isCurrency(input.currency)) return emptyResult('ERROR', input.currency, [{ code: 'CURRENCY_MISMATCH', message: `Unknown currency ${String(input.currency)}` }]);
  const ctx = newCtx(input.currency, input.roundingMode);
  const comps = componentsInScope(input.components, f).filter((c) => !isPerTrip(c));
  const bad = comps.flatMap((c) => {
    try {
      checkParams(c);
      return [];
    } catch (e) {
      return [{ code: 'INVALID_COMPONENT' as const, message: (e as Error).message }];
    }
  });
  if (bad.length) return emptyResult('ERROR', input.currency, bad);
  const first = (k: PricingComponentKind) => comps.find((c) => c.kind === k);
  const fee = first('AVAILABILITY_FEE');
  if (!fee) return emptyResult('NO_APPLICABLE_PRICING', input.currency, [{ code: 'NO_APPLICABLE_PRICING', message: 'The contract has no availability fee for this vehicle' }]);
  const p = fee.params as P;
  const freq = raw(p, 'frequency') as 'DAILY' | 'WEEKLY' | 'MONTHLY';
  const prorate = raw(p, 'prorate') !== false;
  const periodDays = daysBetweenInclusive(f.periodStart, f.periodEnd);
  const billable = Math.max(0, Math.min(f.attachedDays, f.attachedDays - f.downtimeDays - f.suspensionDays + (f.replacementCoveredDays ?? 0)));
  const amount = micro(p, 'amount', 'AVAILABILITY_FEE');
  const noTrips = input.policies?.chargeWithoutTrips === false && (f.tripCount ?? 0) === 0;
  // Included allowance ratio (numerator / denominator) applied to INCLUDED_KM / INCLUDED_HOURS.
  let incNum = 1n;
  let incDen = 1n;
  const dayNote = `${f.attachedDays} attached − ${f.downtimeDays} downtime − ${f.suspensionDays} suspended${f.replacementCoveredDays ? ` + ${f.replacementCoveredDays} replacement` : ''} = ${billable} billable day(s)`;
  if (f.billedUnderOriginal) {
    push(ctx, { component: 'AVAILABILITY_FEE', label: labelOf(fee, 'Availability fee'), quantity: '0', unit: 'period', amountMinor: 0n, basis: 'replacement vehicle: billed under the original vehicle', taxCode: fee.taxCode });
    incNum = 0n;
  } else if (noTrips) {
    push(ctx, { component: 'AVAILABILITY_FEE', label: labelOf(fee, 'Availability fee'), quantity: '0', unit: 'period', amountMinor: 0n, basis: 'no trips in the period and the contract does not charge idle periods', taxCode: fee.taxCode });
    incNum = 0n;
  } else if (freq === 'DAILY') {
    add(ctx, { component: 'AVAILABILITY_FEE', label: labelOf(fee, 'Availability fee (daily)'), quantity: String(billable), unit: 'day', rateMicro: amount, num: amount * BigInt(billable), basis: `${dayNote} × ${r6(amount)}/day`, taxCode: fee.taxCode });
    incNum = BigInt(billable);
  } else if (!prorate || billable >= periodDays) {
    const full = !prorate ? f.attachedDays > 0 : true;
    add(ctx, { component: 'AVAILABILITY_FEE', label: labelOf(fee, `Availability fee (${freq.toLowerCase()})`), quantity: full ? '1' : '0', unit: 'period', rateMicro: amount, num: full ? amount : 0n, basis: !prorate ? `full ${freq.toLowerCase()} fee (no proration)` : `full period: ${dayNote}`, taxCode: fee.taxCode });
    incNum = full ? 1n : 0n;
  } else {
    add(ctx, { component: 'AVAILABILITY_FEE', label: labelOf(fee, `Availability fee (${freq.toLowerCase()})`), quantity: `${billable}/${periodDays}`, unit: 'period', rateMicro: amount, num: amount * BigInt(billable), den: BigInt(periodDays), basis: `${r6(amount)} × ${billable}/${periodDays} days (${dayNote})`, taxCode: fee.taxCode });
    incNum = BigInt(billable);
    incDen = BigInt(periodDays);
  }

  const incKm = first('INCLUDED_KM');
  const exKm = first('EXCESS_KM');
  if (exKm) {
    const incM = incKm ? Number((BigInt(metres(incKm.params as P, 'km', 'INCLUDED_KM')) * incNum) / incDen) : 0;
    const over = Math.max(0, f.usedDistanceM - incM);
    if (over > 0) {
      const rate = micro(exKm.params as P, 'rate', 'EXCESS_KM');
      add(ctx, { component: 'EXCESS_KM', label: labelOf(exKm, 'Excess km'), quantity: kmText(over), unit: 'km', rateMicro: rate, num: rate * BigInt(over), den: 1000n, basis: `${kmText(f.usedDistanceM)} km used − ${kmText(incM)} km included = ${kmText(over)} km × ${r6(rate)}/km`, taxCode: exKm.taxCode });
    }
  }
  const incH = first('INCLUDED_HOURS');
  const exH = first('EXCESS_HOUR');
  if (exH && f.usedDurationS) {
    const incS = incH ? Number((BigInt(seconds(incH.params as P, 'hours', 'INCLUDED_HOURS')) * incNum) / incDen) : 0;
    const over = Math.max(0, f.usedDurationS - incS);
    if (over > 0) {
      const rate = micro(exH.params as P, 'rate', 'EXCESS_HOUR');
      add(ctx, { component: 'EXCESS_HOUR', label: labelOf(exH, 'Excess hours'), quantity: hText(over), unit: 'h', rateMicro: rate, num: rate * BigInt(over), den: 3600n, basis: `${hText(f.usedDurationS)} h used − ${hText(incS)} h included = ${hText(over)} h × ${r6(rate)}/h`, taxCode: exH.taxCode });
    }
  }
  const ot = first('OVERTIME');
  if (ot && f.overtimeS) {
    const rate = micro(ot.params as P, 'rate', 'OVERTIME');
    add(ctx, { component: 'OVERTIME', label: labelOf(ot, 'Overtime'), quantity: hText(f.overtimeS), unit: 'h', rateMicro: rate, num: rate * BigInt(f.overtimeS), den: 3600n, basis: `${hText(f.overtimeS)} h outside operating hours × ${r6(rate)}/h`, taxCode: ot.taxCode });
  }
  const hol = first('HOLIDAY');
  if (hol && f.holidayDaysWorked) {
    const a = micro(hol.params as P, 'amount', 'HOLIDAY');
    add(ctx, { component: 'HOLIDAY', label: labelOf(hol, 'Holiday duty'), quantity: String(f.holidayDaysWorked), unit: 'day', rateMicro: a, num: a * BigInt(f.holidayDaysWorked), basis: `${f.holidayDaysWorked} holiday day(s) worked × ${r6(a)}`, taxCode: hol.taxCode });
  }
  const mg = first('MIN_GUARANTEE');
  if (mg && !f.billedUnderOriginal && !noTrips) {
    const minMinor = divRound(micro(mg.params as P, 'amount', 'MIN_GUARANTEE'), ctx.scale, ctx.mode);
    const charged = sumBig(ctx.lines.map((l) => l.amountMinor));
    if (charged < minMinor) push(ctx, { component: 'MIN_GUARANTEE_TOP_UP', label: labelOf(mg, 'Minimum guarantee'), quantity: '1', unit: 'period', amountMinor: minMinor - charged, basis: `minimum guarantee ${formatMinor(minMinor, ctx.currency)} (charged ${formatMinor(charged, ctx.currency)})`, taxCode: mg.taxCode });
  }
  applyDiscounts(ctx, comps.filter((c) => c.kind === 'DISCOUNT'));
  return finish(ctx, 'PRICED', [], input.tax);
}
