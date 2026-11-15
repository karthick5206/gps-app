import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addNewTrip, emptyDraft } from './dispatch-draft.ts';
import { escortWarnings } from './night-safety.ts';

const OFFICE = { lat: 13.0, lng: 80.2 };
const b = (id: string, lat: number, ws: string) => ({ id, name: id.toUpperCase(), pickup: { lat, lng: 80.2 }, drop: OFFICE, windowStart: ws, windowEnd: ws, seats: 1 });
const night = { on: true, from: '20:00', to: '06:00', reachedHomeMin: 20 };

test('IN trip starting at 05:00 IST warns about the first pickup; 09:00 does not; off = nothing', () => {
  // 05:00 IST = 23:30Z previous day.
  let d = addNewTrip(emptyDraft('2026-11-16', 'IN'), { objectId: 'v', label: 'Van', seats: 6 }, [b('a', 13.2, '2026-11-15T23:00:00.000Z'), b('c', 13.1, '2026-11-15T23:00:00.000Z')], { startMs: Date.parse('2026-11-15T23:30:00.000Z'), ordered: true });
  assert.deepEqual(escortWarnings(d, night, 'Asia/Kolkata'), [{ tempId: d.newTrips[0].tempId, passenger: 'A', end: 'FIRST_PICKUP', time: '05:00' }]);
  d = addNewTrip(emptyDraft('2026-11-16', 'IN'), { objectId: 'v', label: 'Van', seats: 6 }, [b('a', 13.2, '2026-11-16T03:00:00.000Z')], { startMs: Date.parse('2026-11-16T03:30:00.000Z') });
  assert.equal(escortWarnings(d, night, 'Asia/Kolkata').length, 0);
  assert.equal(escortWarnings(d, { ...night, on: false }, 'Asia/Kolkata').length, 0);
});

test('OUT trip: the last drop late at night is named', () => {
  const out = (id: string, lat: number) => ({ id, name: id.toUpperCase(), pickup: OFFICE, drop: { lat, lng: 80.2 }, windowStart: '2026-11-16T17:30:00.000Z', windowEnd: '2026-11-16T19:00:00.000Z', seats: 1 });
  // 23:00 IST start = 17:30Z; office + 2 drops, 10 min apart → last drop 23:20.
  const d = addNewTrip(emptyDraft('2026-11-16', 'OUT'), { objectId: 'v', label: 'Van', seats: 6 }, [out('near', 13.05), out('far', 13.2)], { startMs: Date.parse('2026-11-16T17:30:00.000Z'), ordered: true });
  const w = escortWarnings(d, night, 'Asia/Kolkata');
  assert.equal(w[0].passenger, 'FAR');
  assert.equal(w[0].end, 'LAST_DROP');
  assert.equal(w[0].time, '23:20');
});
