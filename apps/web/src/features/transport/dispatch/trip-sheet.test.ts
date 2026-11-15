import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { downloadTripSheetsPdf, toSheet, tripSheetsCsv } from './trip-sheet.ts';

const trip = {
  name: 'Morning login', vehicleName: 'Synthetic Van 2', plateNumber: 'TN 00 TS 0002', driverName: 'Partha', shiftName: 'Morning 09:00', plannedStart: '2026-11-16T02:30:00.000Z', direction: 'IN' as const,
  stops: [0, 1, 2, 3].map((s) => ({ seq: s, name: s === 3 ? 'Synthetic Guindy Office' : 'Home stop ' + (s + 1), plannedArrival: new Date(Date.parse('2026-11-16T02:30:00.000Z') + s * 600000).toISOString(), actualArrival: s < 2 ? new Date(Date.parse('2026-11-16T02:32:00.000Z') + s * 600000).toISOString() : null })),
  passengers: [['Priya Gowda', 0, 'BOARDED'], ['Ravi Kumar', 1, 'NO_SHOW'], ['Meena Rao', 2, 'PENDING']].map(([n, s, st], i) => ({ passenger: { id: 'p' + i, displayName: n, employeeCode: 'SYN-CHE-000' + i }, pickupSeq: s, dropSeq: 3, pickupLabel: null, dropLabel: null, seats: 1, status: st, boardedAt: st === 'BOARDED' ? '2026-11-16T02:32:00.000Z' : null })),
};
test('trip sheet rows, csv and a sample pdf', async () => {
  const clock = (iso: string) => new Date(iso).toISOString().slice(11, 16);
  const s = toSheet(trip as never, clock);
  assert.equal(s.passengers.length, 3);
  assert.equal(s.passengers[0].boarded, 'Yes');
  assert.equal(s.passengers[1].boarded, 'No-show');
  assert.equal(s.stops[0].actual, '02:32');
  assert.deepEqual(s.stops[3].drops, ['Priya Gowda', 'Ravi Kumar', 'Meena Rao']);
  assert.match(tripSheetsCsv([s], { date: '2026-11-16', direction: 'To site' }), /Synthetic Van 2 · TN 00 TS 0002/);
  if (process.env.SHEET_OUT) {
    const pdf = await downloadTripSheetsPdf([s, s], { company: 'VeeTrax ETMS Test', date: '2026-11-16', direction: 'To site (login)', printedAt: '16/11/2026 08:00' }, null);
    writeFileSync(process.env.SHEET_OUT, Buffer.from(pdf.output('arraybuffer')));
  }
});
