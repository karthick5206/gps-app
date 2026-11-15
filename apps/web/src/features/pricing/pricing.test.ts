import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PricingReportDto } from '@veetracer/shared';
import { canDecide, canSeeCosts, reportTypesFor, visibleColumns } from './access.ts';
import { componentToRow, newRow, rowToComponent, validateRow } from './components.ts';
import { amountError, divideMinor, formatMoney, minorToMajorString, sumMinor } from './money.ts';
import { tripFactsFromForm } from './preview.ts';
import { buildReportView } from './reports.ts';

const nbsp = (s: string) => s.replace(/ | /g, ' ');

test('formatMoney formats minor-unit strings exactly for 2-, 0- and 3-decimal currencies', () => {
  assert.equal(formatMoney('123450', 'INR', 'en-US'), '₹1,234.50');
  assert.equal(formatMoney('12345678901234567', 'INR', 'en-IN'), '₹12,34,56,78,90,12,345.67');
  assert.equal(formatMoney('0', 'INR', 'en-US'), '₹0.00');
  assert.equal(formatMoney('5', 'USD', 'en-US'), '$0.05');
  assert.equal(formatMoney('-5', 'USD', 'en-US'), '-$0.05');
  assert.equal(formatMoney('-0', 'USD', 'en-US'), '$0.00');
  assert.equal(formatMoney('1234', 'JPY', 'en-US'), '¥1,234');
  assert.equal(formatMoney('0', 'JPY', 'en-US'), '¥0');
  assert.equal(nbsp(formatMoney('1234', 'KWD', 'en-US')), 'KWD 1.234');
  assert.equal(nbsp(formatMoney('7', 'KWD', 'en-US')), 'KWD 0.007');
});

test('formatMoney never guesses: junk is a dash, unknown currency keeps the code', () => {
  assert.equal(formatMoney('12.5', 'INR'), '—');
  assert.equal(formatMoney(null, 'INR'), '—');
  assert.equal(formatMoney('1e3', 'INR'), '—');
  assert.equal(formatMoney('0', 'XXX'), '0 XXX');
});

test('minor ↔ major strings, sums and per-unit division stay exact', () => {
  assert.equal(minorToMajorString('123450', 'INR'), '1234.50');
  assert.equal(minorToMajorString('-5', 'INR'), '-0.05');
  assert.equal(minorToMajorString('1234', 'JPY'), '1234');
  assert.equal(minorToMajorString('1234', 'KWD'), '1.234');
  assert.equal(sumMinor(['900719925474099300', '1', 'x', null]), '900719925474099301');
  assert.equal(divideMinor('1000', 3), '333');
  assert.equal(divideMinor('1001', 2), '501');
  assert.equal(divideMinor('-1001', 2), '-501');
  assert.equal(divideMinor('1000', 0), null);
});

test('amountError follows the currency exponent', () => {
  assert.equal(amountError('1234.50', 'INR'), null);
  assert.notEqual(amountError('1.234', 'INR'), null);
  assert.equal(amountError('1.234', 'KWD'), null);
  assert.notEqual(amountError('1.5', 'JPY'), null);
  assert.equal(amountError('0', 'INR'), 'The amount must be more than zero');
  assert.equal(amountError('-1', 'INR'), 'The amount cannot be negative');
  assert.equal(amountError('', 'INR'), 'Required');
});

test('component rows map to the API body: decimal strings, integer minutes, booleans, covers, scope', () => {
  const waiting = { ...newRow('WAITING'), params: { freeMinutes: '10', incrementMinutes: '15', rate: '25.5' }, taxCode: 'gst18', label: ' Waiting ' };
  assert.deepEqual(rowToComponent(waiting, 3), { kind: 'WAITING', label: 'Waiting', scope: null, params: { freeMinutes: 10, incrementMinutes: 15, rate: '25.5' }, taxCode: 'GST18', sortOrder: 3 });

  const night = { ...newRow('NIGHT_SURCHARGE'), params: { from: '22:00', to: '06:00', percent: '', amount: '50' } };
  assert.deepEqual(rowToComponent(night, 0).params, { from: '22:00', to: '06:00', amount: '50' });

  const fee = { ...newRow('AVAILABILITY_FEE'), params: { amount: '45000', frequency: 'MONTHLY', prorate: 'false' }, covers: ['TRIPS', 'VEHICLE_TIME'] as ('TRIPS' | 'VEHICLE_TIME')[], vehicleCategory: 'SUV' };
  const feeDto = rowToComponent(fee, 1);
  assert.deepEqual(feeDto.params, { amount: '45000', frequency: 'MONTHLY', prorate: false });
  assert.deepEqual(feeDto.covers, ['VEHICLE_TIME', 'TRIPS']);
  assert.deepEqual(feeDto.scope, { vehicleCategory: 'SUV' });

  const slabs = { ...newRow('SLAB_KM'), slabs: [{ uptoKm: '10', rate: '20' }, { uptoKm: '40', rate: '15' }, { uptoKm: '99', rate: '12' }] };
  assert.deepEqual(rowToComponent(slabs, 0).params, { slabs: [{ uptoKm: '10', rate: '20' }, { uptoKm: '40', rate: '15' }, { uptoKm: null, rate: '12' }] });
});

test('stored components round-trip through the editor row, keeping unknown scope fields', () => {
  const dto = { kind: 'HOURLY' as const, label: 'Shift', scope: { vehicleCategory: 'SEDAN', minSeats: 4 }, params: { rate: '300', incrementMinutes: 30, basis: 'RESERVED' }, taxCode: null, sortOrder: 2 };
  const back = rowToComponent(componentToRow(dto), 2);
  assert.deepEqual(back, { kind: 'HOURLY', label: 'Shift', scope: { minSeats: 4, vehicleCategory: 'SEDAN' }, params: { rate: '300', incrementMinutes: 30, basis: 'RESERVED' }, taxCode: null, sortOrder: 2 });
});

test('validateRow flags missing rates, either/or surcharges and bad slabs', () => {
  assert.deepEqual(Object.keys(validateRow(newRow('PER_KM'))), ['rate']);
  const both = { ...newRow('DISCOUNT'), params: { percent: '5', amount: '10' } };
  assert.ok(validateRow(both).percent);
  const ok = { ...newRow('DISCOUNT'), params: { percent: '5', amount: '' } };
  assert.deepEqual(validateRow(ok), {});
  const slab = { ...newRow('SLAB_KM'), slabs: [{ uptoKm: 'x', rate: '1' }, { uptoKm: '', rate: '' }] };
  assert.deepEqual(Object.keys(validateRow(slab)).sort(), ['slab0.uptoKm', 'slab1.rate']);
  assert.ok(validateRow({ ...newRow('AVAILABILITY_FEE'), params: { amount: '1', frequency: 'DAILY', prorate: 'true' }, covers: [] }).covers);
});

test('sample-calculation inputs convert to metres, seconds and minor units', () => {
  const f = tripFactsFromForm({ serviceDate: '2026-11-15', km: '25.4', actualHours: '1.5', reservedHours: '', waitingMinutes: '12', stops: '3', passengers: '', startTime: '22:30', tolls: '120.50', cancelledMinutesBefore: '', onDedicatedVehicle: false, vehicleCategory: '' }, 'INR');
  assert.deepEqual(f, { serviceDate: '2026-11-15', billableDistanceM: 25400, onDedicatedVehicle: false, actualDurationS: 5400, waitingS: 720, stops: 3, startMinuteOfDay: 1350, tollsMinor: '12050' });
  assert.throws(() => tripFactsFromForm({ serviceDate: '2026-11-15', km: '1', actualHours: '', reservedHours: '', waitingMinutes: '', stops: '', passengers: '', startTime: '', tolls: '1.5', cancelledMinutesBefore: '', onDedicatedVehicle: false, vehicleCategory: '' }, 'JPY'), /INVALID: tolls/);
});

test('cost / margin columns are visible only with pricing_costs:view', () => {
  assert.equal(canSeeCosts({ pricing_reports: ['view'] }), false);
  assert.equal(canSeeCosts({ pricing_costs: ['view'] }), true);
  assert.equal(canSeeCosts(undefined), false);
  const cols = [{ key: 'label' }, { key: 'revenueMinor' }, { key: 'costMinor' }, { key: 'marginMinor' }];
  assert.deepEqual(visibleColumns(cols, false).map((c) => c.key), ['label', 'revenueMinor']);
  assert.equal(visibleColumns(cols, true).length, 4);
  assert.deepEqual(reportTypesFor(['revenue', 'margin', 'ageing'] as const, false), ['revenue', 'ageing']);
});

test('report view adds exact per-unit columns and strips cost values without the grant', () => {
  const report: PricingReportDto = {
    type: 'revenue',
    from: '2026-11-01',
    to: '2026-11-10',
    groupBy: 'vehicle',
    columns: [
      { key: 'label', label: 'Vehicle', kind: 'text' },
      { key: 'currency', label: 'Currency', kind: 'text' },
      { key: 'trips', label: 'Trips', kind: 'number' },
      { key: 'revenueMinor', label: 'Revenue (before tax)', kind: 'money' },
      { key: 'costMinor', label: 'Operating cost', kind: 'money' },
      { key: 'marginMinor', label: 'Margin', kind: 'money' },
    ],
    rows: [{ label: 'TN 01', currency: 'INR', trips: 4, revenueMinor: '100001', costMinor: '40000', marginMinor: '60001' }],
    costVisible: true,
  };
  const withCost = buildReportView(report, true);
  assert.deepEqual(withCost.columns.map((c) => c.key).slice(-4), ['revenuePerTripMinor', 'costPerTripMinor', 'marginPerTripMinor', 'revenuePerVehicleDayMinor']);
  assert.equal(withCost.rows[0].revenuePerTripMinor, '25000');
  assert.equal(withCost.rows[0].revenuePerVehicleDayMinor, '10000');
  const without = buildReportView(report, false);
  assert.ok(without.columns.every((c) => !/^(cost|margin)/i.test(c.key)));
  assert.equal(without.rows[0].costMinor, undefined);
  assert.equal(without.rows[0].marginPerTripMinor, undefined);
});

test('maker-checker: the submitter never approves their own request', () => {
  assert.deepEqual(canDecide({ hasApprove: true, submittedById: 'u1', meId: 'u1' }), { allowed: false, ownSubmission: true });
  assert.deepEqual(canDecide({ hasApprove: true, submittedById: 'u1', meId: 'u2' }), { allowed: true, ownSubmission: false });
  assert.deepEqual(canDecide({ hasApprove: false, submittedById: 'u1', meId: 'u2' }), { allowed: false, ownSubmission: false });
});
