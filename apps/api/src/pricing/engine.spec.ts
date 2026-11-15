/**
 * Customer pricing engine (doc 19 §5, §8): acceptance scenarios 1–7, 11–13 and 17 at engine level, plus the money
 * invariants, rounding modes, overflow guard and contract precedence. Pure: no database.
 */
import {
  allocateFare,
  assertSameCurrency,
  divRound,
  fiscalYearLabel,
  formatDocumentNumber,
  formatMinor,
  parseDecimalMicro,
  parseMajorToMinor,
  periodBounds,
  pricePeriod,
  priceTrip,
  resolveBillableDistance,
  selectContract,
  validateComponents,
  type ContractCandidate,
  type PeriodFacts,
  type PriceResult,
  type PricingComponentInput,
  type TaxConfig,
  type TripFacts,
} from '../../../../packages/shared/src/pricing';

const NO_TAX: TaxConfig = { regime: 'NONE', rates: [] };
const GST18 = (supplier = '33', buyer = '33'): TaxConfig => ({ regime: 'IN_GST', rates: [{ taxCode: 'GST18', label: 'GST 18%', ratePpm: 180_000 }], defaultTaxCode: 'GST18', supplierStateCode: supplier, buyerStateCode: buyer });
const trip = (f: Partial<TripFacts> = {}): TripFacts => ({ serviceDate: '2026-11-20', billableDistanceM: null, ...f });
const C = (kind: PricingComponentInput['kind'], params: Record<string, unknown> = {}, extra: Partial<PricingComponentInput> = {}): PricingComponentInput => ({ kind, params, ...extra });
const T = (components: PricingComponentInput[], facts: Partial<TripFacts>, tax: TaxConfig = NO_TAX, currency = 'INR', extra: object = {}) =>
  priceTrip({ currency, roundingMode: 'HALF_UP', components, facts: trip(facts), tax, ...extra });
const period = (f: Partial<PeriodFacts>): PeriodFacts => ({ frequency: 'MONTHLY', periodStart: '2026-11-01', periodEnd: '2026-11-30', attachedDays: 30, downtimeDays: 0, suspensionDays: 0, usedDistanceM: 0, ...f });
const P = (components: PricingComponentInput[], f: Partial<PeriodFacts>, policies = {}, tax: TaxConfig = NO_TAX) =>
  pricePeriod({ currency: 'INR', roundingMode: 'HALF_UP', components, facts: period(f), tax, policies });

/** Σ lines = totals, always. */
function expectConsistent(r: PriceResult) {
  const sum = (k: 'amountMinor' | 'discountMinor' | 'taxMinor') => r.lines.reduce((s, l) => s + l[k], 0n);
  expect(r.subtotalMinor).toBe(sum('amountMinor'));
  expect(r.discountMinor).toBe(sum('discountMinor'));
  expect(r.taxMinor).toBe(sum('taxMinor'));
  expect(r.taxMinor).toBe(r.taxLines.reduce((s, t) => s + t.taxMinor, 0n));
  expect(r.totalMinor).toBe(r.subtotalMinor - r.discountMinor + r.taxMinor);
  for (const l of r.lines) expect(l.discountMinor <= l.amountMinor || l.amountMinor <= 0n).toBe(true);
}

const DISTANCE = [C('BASE_FARE', { amount: '50' }), C('PER_KM', { rate: '12.375' })];

describe('scenario 1: per-km trip pricing', () => {
  it('base fare + km × rate, rounded once per line', () => {
    const r = T(DISTANCE, { billableDistanceM: 25_300 });
    expect(r.status).toBe('PRICED');
    // 25.300 km × 12.375 = 313.0875 → 313.09
    expect(r.lines.map((l) => [l.component, l.amountMinor])).toEqual([['BASE_FARE', 5000n], ['PER_KM', 31309n]]);
    expect(r.totalMinor).toBe(36309n);
    expect(r.lines[1].basis).toContain('25.300 km × 12.375000/km');
    expectConsistent(r);
  });
  it('minimum billable km and minimum trip charge', () => {
    const r = T([...DISTANCE, C('MIN_BILLABLE_KM', { km: '5' }), C('MIN_TRIP_CHARGE', { amount: '150' })], { billableDistanceM: 2_000 });
    // max(5 km, 2 km) × 12.375 = 61.875 → 61.88; 50 + 61.88 = 111.88 < 150 → top-up 38.12
    expect(r.lines.map((l) => [l.component, l.amountMinor])).toEqual([['BASE_FARE', 5000n], ['PER_KM', 6188n], ['MIN_TRIP_TOP_UP', 3812n]]);
    expect(r.totalMinor).toBe(15000n);
  });
  it('slab km is marginal', () => {
    const r = T([C('SLAB_KM', { slabs: [{ uptoKm: '10', rate: '20' }, { uptoKm: null, rate: '15' }] })], { billableDistanceM: 14_500 });
    expect(r.totalMinor).toBe(20000n + 6750n); // 10 × 20 + 4.5 × 15
  });
  it('waiting, extra stops, night surcharge, tolls, seats and a discount', () => {
    const comps = [
      ...DISTANCE,
      C('WAITING', { freeMinutes: 10, incrementMinutes: 15, rate: '30' }),
      C('EXTRA_STOP', { includedStops: 2, rate: '25' }),
      C('NIGHT_SURCHARGE', { from: '22:00', to: '06:00', percent: '10' }),
      C('TOLL_PARKING_PASSTHROUGH', {}, { taxCode: 'EXEMPT' }),
      C('SEAT', { rate: '5' }),
      C('DISCOUNT', { percent: '10' }),
    ];
    const r = T(comps, { billableDistanceM: 25_300, waitingS: 31 * 60, stops: 5, startMinuteOfDay: 23 * 60 + 30, tollsMinor: 12000n, passengers: 3 }, GST18());
    const by = Object.fromEntries(r.lines.map((l) => [l.component, l]));
    expect(by.WAITING.amountMinor).toBe(6000n); // 31 − 10 = 21 min → 2 × 15 min × 30
    expect(by.EXTRA_STOP.amountMinor).toBe(7500n);
    expect(by.NIGHT_SURCHARGE.amountMinor).toBe(3631n); // 10 % of 363.09
    expect(by.TOLL_PARKING_PASSTHROUGH.amountMinor).toBe(12000n);
    expect(by.TOLL_PARKING_PASSTHROUGH.discountMinor).toBe(0n);
    expect(by.TOLL_PARKING_PASSTHROUGH.taxMinor).toBe(0n);
    expect(by.SEAT.amountMinor).toBe(1500n);
    // Discount: 10 % of the non-pass-through lines (5000 + 31309 + 6000 + 7500 + 3631 + 1500 = 54940) = 5494.
    expect(r.discountMinor).toBe(5494n);
    expectConsistent(r);
  });
  it('night band outside the start time adds nothing; bands wrap midnight', () => {
    const comps = [...DISTANCE, C('NIGHT_SURCHARGE', { from: '22:00', to: '06:00', amount: '40' })];
    expect(T(comps, { billableDistanceM: 1000, startMinuteOfDay: 12 * 60 }).lines.some((l) => l.component === 'NIGHT_SURCHARGE')).toBe(false);
    expect(T(comps, { billableDistanceM: 1000, startMinuteOfDay: 5 * 60 }).lines.find((l) => l.component === 'NIGHT_SURCHARGE')?.amountMinor).toBe(4000n);
  });
  it('cancellation: only the cancellation line, free when early enough', () => {
    const comps = [...DISTANCE, C('CANCELLATION', { amount: '100', freeBeforeMinutes: 60 })];
    const late = T(comps, { billableDistanceM: 25_000, cancelledMinutesBefore: 20 });
    expect(late.lines.map((l) => [l.component, l.amountMinor])).toEqual([['CANCELLATION', 10000n]]);
    expect(T(comps, { cancelledMinutesBefore: 90 }).totalMinor).toBe(0n);
  });
  it('estimate status when priced from planned values; override replaces the price', () => {
    expect(T(DISTANCE, { billableDistanceM: 1000 }, NO_TAX, 'INR', { estimate: true }).status).toBe('ESTIMATE');
    const o = T(DISTANCE, { billableDistanceM: 25_300 }, GST18(), 'INR', { overrideMinor: 30000n, overrideReason: 'negotiated' });
    expect(o.lines.map((l) => l.component)).toEqual(['OVERRIDE']);
    expect(o.subtotalMinor).toBe(30000n);
    expect(o.taxMinor).toBe(5400n);
    expect(o.lines[0].basis).toContain('negotiated');
  });
});

describe('scenario 2: fixed-price trip keeps the agreed price', () => {
  const fixed = [C('FIXED_TRIP', { amount: '1500' })];
  it.each([1_000, 10_000, 80_000, null])('distance %p → 1500.00', (m) => {
    const r = T(fixed, { billableDistanceM: m });
    expect(r.status).toBe('PRICED');
    expect(r.totalMinor).toBe(150000n);
  });
  it('only an INCLUDED_KM + EXCESS_KM rule changes it', () => {
    const r = T([...fixed, C('INCLUDED_KM', { km: '50' }), C('EXCESS_KM', { rate: '10' })], { billableDistanceM: 80_000 });
    expect(r.totalMinor).toBe(150000n + 30000n);
  });
});

describe('scenario 3: hourly minimum hours', () => {
  const hourly = [C('HOURLY', { rate: '500', incrementMinutes: 60 }), C('MIN_HOURS', { hours: '4' })];
  it('2.5 h actual → rounded up to 3 h → minimum 4 h', () => {
    const r = T(hourly, { actualDurationS: 9000 });
    expect(r.totalMinor).toBe(200000n);
    expect(r.lines[0].quantity).toBe('4');
  });
  it('4 h 10 min → 5 h', () => expect(T(hourly, { actualDurationS: 4 * 3600 + 600 }).totalMinor).toBe(250000n));
  it('reserved basis uses the reserved duration', () => {
    expect(T([C('HOURLY', { rate: '500', incrementMinutes: 30, basis: 'RESERVED' })], { actualDurationS: 600, reservedDurationS: 5400 }).totalMinor).toBe(75000n);
  });
  it('missing duration → needs review, never invented', () => expect(T(hourly, {}).status).toBe('NEEDS_REVIEW'));
});

describe('scenario 4: daily availability charged with zero trips', () => {
  const daily = [C('AVAILABILITY_FEE', { amount: '2000', frequency: 'DAILY' }, { covers: ['VEHICLE_TIME'] })];
  it('a day without trips is charged', () => {
    const r = P(daily, { frequency: 'DAILY', periodStart: '2026-11-02', periodEnd: '2026-11-02', attachedDays: 1, tripCount: 0 });
    expect(r.status).toBe('PRICED');
    expect(r.totalMinor).toBe(200000n);
  });
  it('unless the contract says idle periods are free', () => {
    expect(P(daily, { frequency: 'DAILY', periodStart: '2026-11-02', periodEnd: '2026-11-02', attachedDays: 1, tripCount: 0 }, { chargeWithoutTrips: false }).totalMinor).toBe(0n);
  });
  it('a daily fee over a month counts billable days (downtime and suspension excluded, replacement added back)', () => {
    expect(P(daily, { attachedDays: 30, downtimeDays: 3, suspensionDays: 2, replacementCoveredDays: 1 }).totalMinor).toBe(26n * 200000n);
  });
});

describe('scenario 5: monthly partial period proration', () => {
  const monthly = [C('AVAILABILITY_FEE', { amount: '60000', frequency: 'MONTHLY' }, { covers: ['VEHICLE_TIME', 'KM_INCLUDED'] })];
  it('attached from the 19th: 12 / 30 days', () => expect(P(monthly, { attachedDays: 12 }).totalMinor).toBe(2400000n));
  it('downtime days are not billed', () => expect(P(monthly, { attachedDays: 12, downtimeDays: 2 }).totalMinor).toBe(2000000n));
  it('full month = full fee; no proration when switched off', () => {
    expect(P(monthly, {}).totalMinor).toBe(6000000n);
    expect(P([C('AVAILABILITY_FEE', { amount: '60000', frequency: 'MONTHLY', prorate: false })], { attachedDays: 5 }).totalMinor).toBe(6000000n);
  });
  it('proration is exact and rounded once (31-day month)', () => {
    // 1000 × 10 / 31 = 322.580645… → 322.58
    expect(P([C('AVAILABILITY_FEE', { amount: '1000', frequency: 'MONTHLY' })], { periodStart: '2026-12-01', periodEnd: '2026-12-31', attachedDays: 10 }).totalMinor).toBe(32258n);
  });
  it('replacement billed under the original has no fee of its own', () => {
    const r = P(monthly, { billedUnderOriginal: true });
    expect(r.totalMinor).toBe(0n);
    expect(r.lines[0].basis).toContain('original');
  });
});

describe('scenario 6: included km and excess rate', () => {
  const comps = [C('AVAILABILITY_FEE', { amount: '60000', frequency: 'MONTHLY' }, { covers: ['VEHICLE_TIME', 'KM_INCLUDED'] }), C('INCLUDED_KM', { km: '2500' }), C('EXCESS_KM', { rate: '11.5' })];
  it('excess km beyond the included allowance', () => {
    const r = P(comps, { usedDistanceM: 2_612_345 });
    // 112.345 km × 11.5 = 1291.9675 → 1291.97
    expect(r.lines.map((l) => [l.component, l.amountMinor])).toEqual([['AVAILABILITY_FEE', 6000000n], ['EXCESS_KM', 129197n]]);
  });
  it('within the allowance: no excess line', () => expect(P(comps, { usedDistanceM: 2_400_000 }).lines).toHaveLength(1));
  it('the allowance is prorated with the fee', () => {
    // 12/30 of 2500 km = 1000 km; used 1300 → 300 × 11.5 = 3450
    const r = P(comps, { attachedDays: 12, usedDistanceM: 1_300_000 });
    expect(r.lines.find((l) => l.component === 'EXCESS_KM')?.amountMinor).toBe(345000n);
  });
  it('excess hours, overtime, holiday and minimum guarantee', () => {
    const r = P(
      [C('AVAILABILITY_FEE', { amount: '1000', frequency: 'MONTHLY' }), C('INCLUDED_HOURS', { hours: '200' }), C('EXCESS_HOUR', { rate: '100' }), C('OVERTIME', { rate: '150' }), C('HOLIDAY', { amount: '500' }), C('MIN_GUARANTEE', { amount: '5000' })],
      { usedDurationS: 210 * 3600, overtimeS: 5400, holidayDaysWorked: 2 },
    );
    const by = Object.fromEntries(r.lines.map((l) => [l.component, l.amountMinor]));
    expect(by.EXCESS_HOUR).toBe(100000n);
    expect(by.OVERTIME).toBe(22500n);
    expect(by.HOLIDAY).toBe(100000n);
    expect(r.subtotalMinor).toBe(500000n); // topped up to the guarantee
    expect(by.MIN_GUARANTEE_TOP_UP).toBe(500000n - 100000n - 100000n - 22500n - 100000n);
  });
});

describe('scenario 7: hybrid, no double charge', () => {
  const feeTrips = C('AVAILABILITY_FEE', { amount: '60000', frequency: 'MONTHLY' }, { covers: ['VEHICLE_TIME', 'TRIPS'] });
  const feeTime = C('AVAILABILITY_FEE', { amount: '60000', frequency: 'MONTHLY' }, { covers: ['VEHICLE_TIME', 'KM_INCLUDED'] });
  it('a trip on the dedicated vehicle is covered (0)', () => {
    const r = T([feeTrips, C('PER_KM', { rate: '10' }, { scope: { vehicleCategory: 'BUS' } })], { onDedicatedVehicle: true, billableDistanceM: 30_000, vehicleCategory: 'SEDAN' });
    expect(r.status).toBe('COVERED');
    expect(r.totalMinor).toBe(0n);
    expect(r.lines[0].component).toBe('COVERED');
  });
  it('a fee covering vehicle time only: covered unless the contract is an explicit hybrid', () => {
    const comps = [feeTime, C('PER_KM', { rate: '10' })];
    expect(T(comps, { onDedicatedVehicle: true, billableDistanceM: 30_000 }).status).toBe('COVERED');
    const r = priceTrip({ currency: 'INR', roundingMode: 'HALF_UP', components: comps, policies: { alsoChargeTrips: true }, facts: trip({ onDedicatedVehicle: true, billableDistanceM: 30_000 }), tax: NO_TAX });
    expect(r.status).toBe('PRICED');
    expect(r.totalMinor).toBe(30000n);
  });
  it('a trip on another vehicle is priced per trip', () => expect(T([feeTrips, C('PER_KM', { rate: '10' }, { scope: { vehicleCategory: 'BUS' } })], { billableDistanceM: 30_000, vehicleCategory: 'BUS' }).totalMinor).toBe(30000n));
  it('approval validation refuses TRIPS cover + PER_KM in the same scope without alsoChargeTrips', () => {
    expect(validateComponents([feeTrips, C('PER_KM', { rate: '10' })]).map((i) => i.code)).toContain('DOUBLE_CHARGE');
    expect(validateComponents([feeTrips, C('PER_KM', { rate: '10' })], { alsoChargeTrips: true }).map((i) => i.code)).toContain('DOUBLE_CHARGE');
    expect(validateComponents([feeTime, C('PER_KM', { rate: '10' })], { alsoChargeTrips: true })).toEqual([]);
    // Disjoint scopes do not clash.
    expect(validateComponents([{ ...feeTrips, scope: { vehicleCategory: 'SEDAN' } }, C('PER_KM', { rate: '10' }, { scope: { vehicleCategory: 'BUS' } })])).toEqual([]);
  });
  it('excess km of a hybrid is billed once at period close, never per trip', () => {
    const r = priceTrip({ currency: 'INR', roundingMode: 'HALF_UP', components: [feeTime, C('FIXED_TRIP', { amount: '100' }), C('INCLUDED_KM', { km: '10' }), C('EXCESS_KM', { rate: '10' })], policies: { alsoChargeTrips: true }, facts: trip({ onDedicatedVehicle: true, billableDistanceM: 50_000 }), tax: NO_TAX });
    expect(r.totalMinor).toBe(10000n);
  });
  it('validation catches bad params and ambiguous models', () => {
    expect(validateComponents([C('PER_KM', { rate: 'abc' })]).map((i) => i.code)).toEqual(['INVALID_COMPONENT']);
    expect(validateComponents([C('PER_KM', { rate: '1' }), C('FIXED_TRIP', { amount: '1' })]).map((i) => i.code)).toEqual(['AMBIGUOUS_BASE_MODEL']);
    expect(validateComponents([C('PER_KM', { rate: '1' }), C('SLAB_KM', { slabs: [{ uptoKm: null, rate: '1' }] })]).map((i) => i.code)).toEqual(['AMBIGUOUS_BASE_MODEL']);
    expect(validateComponents([C('PER_KM', { rate: '1' }, { scope: { vehicleCategory: 'A' } }), C('FIXED_TRIP', { amount: '1' }, { scope: { vehicleCategory: 'B' } })])).toEqual([]);
    expect(validateComponents([C('DISCOUNT', { percent: '120' })]).map((i) => i.code)).toEqual(['INVALID_COMPONENT']);
  });
  it('no trip model and not covered → explicit NO_APPLICABLE_PRICING', () => {
    const r = T([feeTime], { billableDistanceM: 1000 });
    expect(r.status).toBe('NO_APPLICABLE_PRICING');
    expect(r.totalMinor).toBe(0n);
  });
});

describe('scenario 11: shared-ride individual charges', () => {
  const pax = [
    { passengerId: 'a', directDistanceM: 5_000, onboardDistanceM: 3_000 },
    { passengerId: 'b', directDistanceM: 8_000, onboardDistanceM: 5_000 },
    { passengerId: 'c', directDistanceM: 9_000, onboardDistanceM: 7_000 },
  ];
  const base = { currency: 'INR', roundingMode: 'HALF_UP' as const, preference: 'SHARED' as const, passengers: pax, coRidersOnBoard: true, vehicleTripMinor: 100001n };
  it('DISTANCE_SHARE: by passenger-km, sums exactly to the vehicle price', () => {
    const r = allocateFare({ ...base, method: 'DISTANCE_SHARE' });
    expect(r.appliedAs).toBe('SHARED');
    expect(r.shares.map((s) => s.amountMinor)).toEqual([20000n, 33334n, 46667n]);
    expect(r.shares.reduce((s, x) => s + x.amountMinor, 0n)).toBe(100001n);
  });
  it('CONTRACT_RULE uses distance-share semantics', () => expect(allocateFare({ ...base, method: 'CONTRACT_RULE' }).totalMinor).toBe(100001n));
  it('OWN_FARE: own direct distance at the shared rate', () => {
    const r = allocateFare({ ...base, method: 'OWN_FARE', baseFareMinor: 3000n, perKmRateMicro: parseDecimalMicro('10'), sharedDiscountPpm: 200_000 });
    expect(r.shares.map((s) => s.amountMinor)).toEqual([6400n, 8800n, 9600n]); // (30 + 10 × km) × 0.8
  });
  it('FIXED_PER_PASSENGER', () => expect(allocateFare({ ...base, method: 'FIXED_PER_PASSENGER', fixedPerPassengerMinor: 15000n }).totalMinor).toBe(45000n));
  it('EQUAL_SPLIT only when explicitly allowed', () => {
    const refused = allocateFare({ ...base, method: 'EQUAL_SPLIT' });
    expect(refused.issues.map((i) => i.code)).toEqual(['EQUAL_SPLIT_NOT_ALLOWED']);
    expect(refused.shares).toEqual([]);
    expect(allocateFare({ ...base, method: 'EQUAL_SPLIT', allowEqualSplit: true }).shares.map((s) => s.amountMinor)).toEqual([33334n, 33334n, 33333n]);
  });
});

describe('scenario 12: private stays private-priced', () => {
  it('a shared method is refused for PRIVATE; the vehicle trip price applies', () => {
    const r = allocateFare({ currency: 'INR', roundingMode: 'HALF_UP', preference: 'PRIVATE', method: 'DISTANCE_SHARE', passengers: [{ passengerId: 'a', directDistanceM: 5000, onboardDistanceM: 5000 }], coRidersOnBoard: false, vehicleTripMinor: 50000n });
    expect(r.issues.map((i) => i.code)).toEqual(['SHARED_FARE_NOT_ALLOWED']);
    expect(r.appliedAs).toBe('PRIVATE');
    expect(r.shares).toEqual([expect.objectContaining({ passengerId: 'a', amountMinor: 50000n })]);
  });
  it('FLEXIBLE without co-riders on board is priced private', () => {
    const r = allocateFare({ currency: 'INR', roundingMode: 'HALF_UP', preference: 'FLEXIBLE', method: 'DISTANCE_SHARE', passengers: [{ passengerId: 'a', directDistanceM: 5000, onboardDistanceM: 5000 }], coRidersOnBoard: false, vehicleTripMinor: 50000n });
    expect(r.appliedAs).toBe('PRIVATE');
    expect(r.issues).toEqual([]);
  });
});

describe('scenario 13: missing GPS → review policy', () => {
  it('REVIEW: no billable value, needs review, and the trip is not priced', () => {
    const d = resolveBillableDistance({ source: 'GPS', onMissingGps: 'REVIEW', plannedM: 10_000, gpsM: null });
    expect(d).toMatchObject({ billableM: null, gpsQuality: 'MISSING', needsReview: true });
    const r = T(DISTANCE, { billableDistanceM: d.billableM });
    expect(r.status).toBe('NEEDS_REVIEW');
    expect(r.issues.map((i) => i.code)).toEqual(['GPS_DISTANCE_REVIEW']);
    expect(r.lines).toEqual([]);
  });
  it('USE_PLANNED / USE_AGREED price on that value and say so', () => {
    const d = resolveBillableDistance({ source: 'GPS', onMissingGps: 'USE_PLANNED', plannedM: 10_000, gpsM: null });
    expect(d).toMatchObject({ billableM: 10_000, usedSource: 'PLANNED', needsReview: false });
    expect(d.basis).toContain('USE_PLANNED');
    expect(resolveBillableDistance({ source: 'GPS', onMissingGps: 'USE_AGREED', agreedM: null, gpsM: null }).needsReview).toBe(true);
  });
  it('low coverage: GPS far below or above planned, or a long offline gap', () => {
    expect(resolveBillableDistance({ source: 'GPS', onMissingGps: 'REVIEW', plannedM: 10_000, gpsM: 3_000 }).gpsQuality).toBe('LOW_COVERAGE');
    expect(resolveBillableDistance({ source: 'GPS', onMissingGps: 'REVIEW', plannedM: 10_000, gpsM: 25_000 }).gpsQuality).toBe('LOW_COVERAGE');
    expect(resolveBillableDistance({ source: 'GPS', onMissingGps: 'REVIEW', plannedM: 10_000, gpsM: 10_500, offlineGapS: 900, maxOfflineGapS: 600 }).gpsQuality).toBe('LOW_COVERAGE');
    expect(resolveBillableDistance({ source: 'GPS', onMissingGps: 'REVIEW', plannedM: 10_000, gpsM: 10_500 })).toMatchObject({ billableM: 10_500, gpsQuality: 'OK' });
  });
  it('a manual approved value wins; planned source without a value needs review', () => {
    expect(resolveBillableDistance({ source: 'GPS', onMissingGps: 'REVIEW', gpsM: null, manualM: 7_000 })).toMatchObject({ billableM: 7_000, usedSource: 'MANUAL_APPROVED' });
    expect(resolveBillableDistance({ source: 'PLANNED', onMissingGps: 'REVIEW', plannedM: null }).needsReview).toBe(true);
  });
});

describe('scenario 17: currency and tax', () => {
  const fixed = (amount: string, taxCode?: string) => [C('FIXED_TRIP', { amount }, taxCode ? { taxCode } : {})];
  it('INR GST intra-state: CGST + SGST, the odd paisa to CGST', () => {
    const r = T(fixed('100.03'), {}, GST18('33', '33'));
    expect(r.taxMinor).toBe(1801n); // 10003 × 18 % = 1800.54 → 1801
    expect(r.taxLines).toEqual([expect.objectContaining({ taxCode: 'GST18', taxableMinor: 10003n, taxMinor: 1801n, cgstMinor: 901n, sgstMinor: 900n, igstMinor: 0n })]);
    expect(r.totalMinor).toBe(11804n);
    expectConsistent(r);
  });
  it('INR GST inter-state: IGST', () => {
    const r = T(fixed('100.03'), {}, GST18('33', '29'));
    expect(r.taxLines[0]).toMatchObject({ igstMinor: 1801n, cgstMinor: 0n, sgstMinor: 0n });
  });
  it('USD with a configured sales tax rate', () => {
    const r = T(fixed('100'), {}, { regime: 'SIMPLE', rates: [{ taxCode: 'NYC', label: 'Sales tax 8.875%', ratePpm: 88_750 }], defaultTaxCode: 'NYC' }, 'USD');
    expect(r.taxMinor).toBe(888n); // 887.5 → 888
    expect(formatMinor(r.totalMinor, 'USD')).toBe('108.88');
  });
  it('JPY has no minor unit; KWD has three', () => {
    expect(T(fixed('1500'), {}, NO_TAX, 'JPY').totalMinor).toBe(1500n);
    expect(formatMinor(1500n, 'JPY')).toBe('1500');
    const k = T(fixed('1.2345'), {}, NO_TAX, 'KWD');
    expect(k.totalMinor).toBe(1235n);
    expect(formatMinor(k.totalMinor, 'KWD')).toBe('1.235');
    expect(parseMajorToMinor('1.234', 'KWD')).toBe(1234n);
    expect(() => parseMajorToMinor('1.2345', 'KWD')).toThrow();
    expect(() => parseMajorToMinor('10.5', 'JPY')).toThrow();
    expect(formatMinor(-5n, 'INR')).toBe('-0.05');
  });
  it('currency mismatch and unknown currencies are refused', () => {
    expect(assertSameCurrency('INR', 'USD')?.code).toBe('CURRENCY_MISMATCH');
    expect(assertSameCurrency('INR', 'INR')).toBeNull();
    expect(T(fixed('10'), {}, NO_TAX, 'XXX').status).toBe('ERROR');
  });
  it('no rate is assumed: missing configuration = TAX_PROFILE_MISSING', () => {
    const r = T(fixed('10'), {}, { regime: 'SIMPLE', rates: [], defaultTaxCode: 'VAT' });
    expect(r.status).toBe('ERROR');
    expect(r.issues.map((i) => i.code)).toContain('TAX_PROFILE_MISSING');
    expect(T(fixed('10'), {}, { ...GST18(), buyerStateCode: null }).issues.map((i) => i.code)).toContain('TAX_PROFILE_MISSING');
  });
  it('exempt lines are not taxed', () => expect(T(fixed('10', 'EXEMPT'), {}, GST18()).taxMinor).toBe(0n));
});

describe('money invariants and rounding', () => {
  it('Σ lines = totals over varied inputs', () => {
    const sets: PricingComponentInput[][] = [
      [...DISTANCE, C('DISCOUNT', { percent: '7.5' }), C('TOLL_PARKING_PASSTHROUGH', {})],
      [C('SLAB_KM', { slabs: [{ uptoKm: '3.333', rate: '17.777777' }, { uptoKm: null, rate: '9.99' }] }), C('DISCOUNT', { amount: '13.37' }), C('WAITING', { freeMinutes: 3, incrementMinutes: 7, rate: '3.33' })],
      [C('HOURLY', { rate: '333.333333', incrementMinutes: 15 }), C('SEAT', { rate: '1.11' }), C('DISCOUNT', { amount: '100000' })],
    ];
    for (const comps of sets) {
      for (const m of [1, 999, 3_333, 12_345, 99_999]) {
        for (const tax of [NO_TAX, GST18(), GST18('33', '07')]) {
          const r = T(comps, { billableDistanceM: m, actualDurationS: m, waitingS: m % 1800, passengers: m % 4, tollsMinor: BigInt(m % 500) }, tax);
          expect(['PRICED']).toContain(r.status);
          expectConsistent(r);
          expect(r.totalMinor >= 0n).toBe(true);
        }
      }
    }
  });
  it('a discount never makes the total negative', () => {
    const r = T([C('FIXED_TRIP', { amount: '10' }), C('DISCOUNT', { amount: '50' })], {});
    expect(r.subtotalMinor - r.discountMinor).toBe(0n);
  });
  it('HALF_UP vs HALF_EVEN', () => {
    expect(divRound(25n, 10n, 'HALF_UP')).toBe(3n);
    expect(divRound(25n, 10n, 'HALF_EVEN')).toBe(2n);
    expect(divRound(35n, 10n, 'HALF_EVEN')).toBe(4n);
    expect(divRound(-25n, 10n, 'HALF_UP')).toBe(-3n);
    expect(divRound(-25n, 10n, 'HALF_EVEN')).toBe(-2n);
    // 1 km × 0.125 = 0.125 → 0.13 (HALF_UP) / 0.12 (HALF_EVEN)
    const up = priceTrip({ currency: 'INR', roundingMode: 'HALF_UP', components: [C('PER_KM', { rate: '0.125' })], facts: trip({ billableDistanceM: 1000 }), tax: NO_TAX });
    const even = priceTrip({ currency: 'INR', roundingMode: 'HALF_EVEN', components: [C('PER_KM', { rate: '0.125' })], facts: trip({ billableDistanceM: 1000 }), tax: NO_TAX });
    expect([up.totalMinor, even.totalMinor]).toEqual([13n, 12n]);
  });
  it('parse overflow and junk guards', () => {
    expect(parseDecimalMicro('12.375')).toBe(12_375_000n);
    expect(() => parseDecimalMicro('1234567890123456')).toThrow(/OUT_OF_RANGE/);
    expect(() => parseDecimalMicro('1.1234567')).toThrow();
    expect(() => parseDecimalMicro('1e5')).toThrow();
    expect(() => parseDecimalMicro('')).toThrow();
    expect(T([C('PER_KM', { rate: '99999999999999999' })], { billableDistanceM: 1 }).status).toBe('ERROR');
  });
  it('periods, fiscal years and document numbers', () => {
    expect(periodBounds('WEEKLY', '2026-11-15')).toEqual({ start: '2026-11-09', end: '2026-11-15' });
    expect(periodBounds('MONTHLY', '2026-02-10')).toEqual({ start: '2026-02-01', end: '2026-02-28' });
    expect(fiscalYearLabel('2027-03-31', 4)).toBe('2026-27');
    expect(fiscalYearLabel('2027-04-01', 4)).toBe('2027-28');
    expect(fiscalYearLabel('2026-12-31', 1)).toBe('2026');
    expect(formatDocumentNumber('CI', '2026-27', 7)).toBe('CI/2026-27/0007');
    expect(formatDocumentNumber('', '2026', 12345)).toBe('2026/12345');
  });
});

describe('precedence (§5.7)', () => {
  const base = { status: 'ACTIVE', validFrom: '2026-01-01', validTo: null, isDefault: false, branchIds: [] as string[] };
  const q = { customerCompanyId: 'custA', branchId: 'br1', vehicleCategory: 'SEDAN', serviceDate: '2026-11-20' };
  const c = (id: string, extra: Partial<ContractCandidate>): ContractCandidate => ({ ...base, id, customerCompanyId: 'custA', ...extra });
  it('the most specific contract wins', () => {
    const cands = [c('none', {}), c('cat', { vehicleCategory: 'SEDAN' }), c('br', { branchIds: ['br1'] }), c('brcat', { branchIds: ['br1'], vehicleCategory: 'SEDAN' })];
    expect(selectContract(cands, q)).toMatchObject({ ok: true, contractId: 'brcat' });
    expect(selectContract(cands.slice(0, 3), q)).toMatchObject({ ok: true, contractId: 'br' });
    expect(selectContract(cands.slice(0, 2), q)).toMatchObject({ ok: true, contractId: 'cat' });
  });
  it('a tie is ambiguous, never "latest wins"', () => {
    const r = selectContract([c('a', { branchIds: ['br1'] }), c('b', { branchIds: ['br1', 'br2'] })], q);
    expect(r).toMatchObject({ ok: false, code: 'NO_APPLICABLE_PRICING' });
    expect(!r.ok && r.reason).toContain('ambiguous');
  });
  it('validity: validTo exclusive; inactive ignored', () => {
    expect(selectContract([c('old', { validTo: '2026-11-20' })], q).ok).toBe(false);
    expect(selectContract([c('draft', { status: 'DRAFT' })], q).ok).toBe(false);
  });
  it('never another customer\'s contract', () => {
    expect(selectContract([c('b', { customerCompanyId: 'custB' })], q)).toMatchObject({ ok: false, code: 'NO_APPLICABLE_PRICING' });
  });
  it('the company default only when it explicitly covers the customer type', () => {
    const def = (covers: ('INTERNAL' | 'EXTERNAL')[]) => c('def', { customerCompanyId: null, isDefault: true, defaultCovers: covers });
    expect(selectContract([def(['INTERNAL'])], q).ok).toBe(false);
    expect(selectContract([def(['EXTERNAL'])], q)).toMatchObject({ ok: true, contractId: 'def', viaDefault: true });
    expect(selectContract([def(['INTERNAL'])], { ...q, customerCompanyId: null })).toMatchObject({ ok: true, viaDefault: true });
    // A customer contract that exists but does not cover the branch: no silent fallback to the default.
    expect(selectContract([c('other-branch', { branchIds: ['br9'] }), def(['EXTERNAL'])], q).ok).toBe(false);
  });
});

// ───────────── Independent review regressions (QA 1, 2, 3, 4, 7, 8) ─────────────
import { splitCredit, unionDaysWithin } from '../../../../packages/shared/src/pricing';

describe('review regressions', () => {
  const tax5: TaxConfig = { regime: 'IN_GST', rates: [{ taxCode: 'GST5', label: 'GST 5%', ratePpm: 50_000 }], defaultTaxCode: 'GST5', supplierStateCode: '29', buyerStateCode: '29' };
  const comps: PricingComponentInput[] = [
    { kind: 'AVAILABILITY_FEE', params: { amount: '60000', frequency: 'MONTHLY' }, covers: ['VEHICLE_TIME', 'KM_INCLUDED'] },
    { kind: 'INCLUDED_KM', params: { km: '3000' } },
    { kind: 'EXCESS_KM', params: { rate: '15' } },
    { kind: 'MIN_GUARANTEE', params: { amount: '50000' } },
  ];
  const nov = { frequency: 'MONTHLY' as const, periodStart: '2026-11-01', periodEnd: '2026-11-30', downtimeDays: 0, suspensionDays: 0, tripCount: 5 };
  const period = (f: Partial<PeriodFacts>) => pricePeriod({ currency: 'INR', roundingMode: 'HALF_UP', components: comps, tax: tax5, facts: { ...nov, attachedDays: 30, usedDistanceM: 0, ...f } as PeriodFacts });

  it('QA 1: a replacement billed under the original charges nothing itself (no excess, no minimum)', () => {
    const r = period({ attachedDays: 10, usedDistanceM: 1_500_000, billedUnderOriginal: true });
    expect(r.totalMinor).toBe(0n);
    expect(r.lines.map((l) => l.component)).toEqual(['AVAILABILITY_FEE']);
  });

  it('QA 2: the minimum guarantee is prorated with the billable days (1 day → 1/30, full downtime → 0)', () => {
    const oneDay = period({ attachedDays: 1 });
    // fee 60000 × 1/30 = 2000.00; minimum 50000 × 1/30 = 1666.67 → no top-up.
    expect(oneDay.subtotalMinor).toBe(200_000n);
    expect(oneDay.lines.some((l) => l.component === 'MIN_GUARANTEE_TOP_UP')).toBe(false);
    const down = period({ downtimeDays: 30 });
    expect(down.subtotalMinor).toBe(0n);
    // A discounted fee below the prorated minimum still tops up to the prorated minimum only.
    const low = pricePeriod({ currency: 'INR', roundingMode: 'HALF_UP', components: [{ kind: 'AVAILABILITY_FEE', params: { amount: '30000', frequency: 'MONTHLY' } }, { kind: 'MIN_GUARANTEE', params: { amount: '45000' } }], tax: tax5, facts: { ...nov, attachedDays: 15, usedDistanceM: 0 } as PeriodFacts });
    expect(low.subtotalMinor).toBe(2_250_000n); // 45000 × 15/30
  });

  it('QA 3: days without GPS data send a period with excess km to review', () => {
    const r = period({ usedDistanceM: 3_500_000, missingDistanceDays: 4 });
    expect(r.status).toBe('NEEDS_REVIEW');
    expect(r.issues.map((i) => i.code)).toContain('GPS_DISTANCE_REVIEW');
    expect(period({ usedDistanceM: 3_500_000 }).status).toBe('PRICED');
  });

  it('QA 4: the company default is never used while the customer has a suspended / gapped contract', () => {
    const q = { customerCompanyId: 'cust', branchId: null, vehicleCategory: null, serviceDate: '2026-11-20' };
    const def: ContractCandidate = { id: 'def', customerCompanyId: null, isDefault: true, branchIds: [], status: 'ACTIVE', validFrom: '2026-01-01', validTo: null, defaultCovers: ['EXTERNAL'] };
    expect(selectContract([def], q)).toMatchObject({ ok: true, contractId: 'def' });
    for (const status of ['SUSPENDED', 'NO_VERSION', 'AGREEMENT_INACTIVE']) {
      const own: ContractCandidate = { id: 'own', customerCompanyId: 'cust', isDefault: false, branchIds: [], status, validFrom: '2026-11-20', validTo: null };
      expect(selectContract([own, def], q)).toMatchObject({ ok: false, code: 'NO_APPLICABLE_PRICING' });
    }
    const expired: ContractCandidate = { id: 'old', customerCompanyId: 'cust', isDefault: false, branchIds: [], status: 'EXPIRED', validFrom: '2025-01-01', validTo: null };
    expect(selectContract([expired, def], q)).toMatchObject({ ok: true, contractId: 'def' });
  });

  it('QA 7: partial credit notes reverse exactly the invoice tax, split CGST / SGST or IGST like the invoice', () => {
    const invoice = { totalMinor: 10_501n, taxMinor: 500n, taxLines: [{ taxCode: 'GST5', label: 'GST 5%', ratePpm: 50_000, taxableMinor: 10_001n, taxMinor: 500n, cgstMinor: 250n, sgstMinor: 250n }] };
    let credited = { totalMinor: 0n, taxMinor: 0n };
    for (const amt of [3333n, 3333n, 3835n]) {
      const c = splitCredit(invoice, credited, amt);
      expect(c.subtotalMinor + c.taxMinor).toBe(amt);
      expect(c.taxLines[0].cgstMinor! + c.taxLines[0].sgstMinor!).toBe(c.taxMinor);
      credited = { totalMinor: credited.totalMinor + amt, taxMinor: credited.taxMinor + c.taxMinor };
    }
    expect(credited).toEqual({ totalMinor: 10_501n, taxMinor: 500n });
    expect(() => splitCredit(invoice, credited, 1n)).toThrow('CREDIT_EXCEEDS_INVOICE');
    const igst = splitCredit({ ...invoice, taxLines: [{ ...invoice.taxLines[0], cgstMinor: undefined, sgstMinor: undefined, igstMinor: 500n }] }, { totalMinor: 0n, taxMinor: 0n }, 10_501n);
    expect(igst.taxLines[0]).toMatchObject({ igstMinor: 500n, taxMinor: 500n });
  });

  it('QA 8: overlapping downtimes are counted once', () => {
    expect(unionDaysWithin([['2026-11-01', '2026-11-12'], ['2026-11-07', '2026-11-12']], '2026-11-01', '2026-11-30')).toBe(12);
    expect(unionDaysWithin([['2026-11-01', '2026-11-03'], ['2026-11-04', '2026-11-05'], ['2026-11-10', '2026-11-10']], '2026-11-01', '2026-11-30')).toBe(6);
    expect(unionDaysWithin([['2026-10-25', '2026-11-02']], '2026-11-01', '2026-11-30')).toBe(2);
  });
});
