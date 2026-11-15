import { aggregateInsights, type InsightTrip } from './transport-insights';

const at = (hhmm: string) => new Date(`2026-11-16T${hhmm}:00.000Z`);
const trip = (over: Partial<InsightTrip> = {}): InsightTrip => ({
  day: '2026-11-16',
  direction: 'IN',
  shift: 'General',
  objectId: 'van',
  vehicle: 'Van 2',
  plateNumber: 'TN 00',
  status: 'COMPLETED',
  cancelled: false,
  seatCapacity: 12,
  occupiedSeats: 3,
  km: 21.4,
  passengers: [
    { status: 'DROPPED', pickupSeq: 0 },
    { status: 'DROPPED', pickupSeq: 1 },
    { status: 'NO_SHOW', pickupSeq: 2 },
  ],
  stops: [
    { seq: 0, plannedArrival: at('03:00'), actualArrival: at('03:05') },
    { seq: 1, plannedArrival: at('03:10'), actualArrival: at('03:25') },
    { seq: 2, plannedArrival: at('03:20'), actualArrival: at('03:28') },
    { seq: 3, plannedArrival: at('03:40'), actualArrival: at('03:50') },
  ],
  ...over,
});

describe('aggregateInsights', () => {
  it('computes punctuality (pickup stops only), no-shows, seat use and km', () => {
    const r = aggregateInsights('2026-11-16', '2026-11-16', [trip(), trip({ cancelled: true, status: 'CANCELLED' })], 10, 2, 1);
    expect(r.kpis.trips).toBe(2);
    expect(r.kpis.tripsCancelled).toBe(1);
    expect(r.kpis.tripsCompleted).toBe(1);
    // Pickups at seq 0 (5 min late, on time), 1 (15 min, late), 2 (8 min, on time); seq 3 is the office drop.
    expect(r.kpis.onTimePct).toBe(66.7);
    expect(r.kpis.boarded).toBe(2);
    expect(r.kpis.noShows).toBe(1);
    expect(r.kpis.noShowPct).toBe(33.3);
    expect(r.kpis.seatUsePct).toBe(25);
    expect(r.kpis.km).toBe(21.4);
    expect(r.kpis.missedBookings).toBe(2);
    expect(r.vehicles).toEqual([expect.objectContaining({ vehicle: 'Van 2', trips: 1, km: 21.4, passengers: 3 })]);
    expect(r.shifts).toEqual([{ shift: 'General', direction: 'IN', trips: 1, passengers: 3, noShows: 1 }]);
    expect(r.days[0]).toEqual(expect.objectContaining({ day: '2026-11-16', trips: 1 }));
  });

  it('returns nulls, not zeros, when there is nothing to measure', () => {
    const r = aggregateInsights('2026-11-16', '2026-11-17', [], 0, 0, 0);
    expect(r.kpis.onTimePct).toBeNull();
    expect(r.kpis.seatUsePct).toBeNull();
    expect(r.kpis.noShowPct).toBeNull();
  });
});
