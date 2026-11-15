import { extendedPlanMetrics, type MetricsStop } from './plan-metrics';

/** Hand-computed fixture (IN plan): see each expectation for the arithmetic. */
describe('E4 WP-A compare metrics (plan-metrics.ts)', () => {
  const stop = (id: string, kind: 'PICKUP' | 'DROP', booking: string, assignmentId: string | null, seq: number | null, etaS: number | null, window: [number, number] | null = null, reason: string | null = null): MetricsStop => ({
    id,
    ref: id,
    assignmentId,
    sequence: seq,
    etaS,
    stopKind: kind,
    bookingId: booking,
    demand: kind === 'PICKUP' ? 1 : 0,
    timeWindows: window ? [window] : null,
    unassignedReason: reason,
  });
  const plan = {
    direction: 'IN' as const,
    options: { strategy: 'COMFORT', weightsSource: 'strategy', alternativeOf: 'src-1' },
    assignments: [
      { id: 'r1', vehicleLabel: 'Van 1', capacity: 4, distanceM: 10_000, durationS: 1_800 },
      { id: 'r2', vehicleLabel: 'Van 2', capacity: 4, distanceM: 5_000, durationS: 1_200 },
      { id: 'r3', vehicleLabel: 'Van 3', capacity: 6, distanceM: null, durationS: null },
    ],
    stops: [
      stop('p1', 'PICKUP', 'b1', 'r1', 1, 600),
      stop('p2', 'PICKUP', 'b2', 'r1', 2, 900),
      stop('d1', 'DROP', 'b1', 'r1', 3, 1_800, [1_500, 1_800]),
      stop('d2', 'DROP', 'b2', 'r1', 4, 1_800, [1_000, 1_700]),
      stop('p3', 'PICKUP', 'b3', 'r2', 1, 1_000),
      stop('d3', 'DROP', 'b3', 'r2', 2, 2_200, [2_000, 2_400]),
      stop('p4', 'PICKUP', 'b4', null, null, null, null, 'fleet_too_small'),
      stop('d4', 'DROP', 'b4', null, null, null, [2_000, 2_400], 'fleet_too_small'),
      stop('p5', 'PICKUP', 'b5', null, null, null),
      stop('d5', 'DROP', 'b5', null, null, null, [2_000, 2_400]),
    ],
  };
  const seats = (b: string) => (b === 'b2' ? 2 : 1);

  it('computes every metric by its definition', () => {
    expect(extendedPlanMetrics(plan, seats)).toEqual({
      vehiclesUsed: 2, // r3 carries nothing
      passengersAssigned: 4, // b1 1 + b2 2 + b3 1
      bookingsAssigned: 3,
      totalDistanceM: 15_000, // r1 + r2 (r3 unused, its null does not count)
      totalTravelS: 3_000,
      maxRideS: 1_200, // b1 1800−600, b3 2200−1000
      avgRideS: 1_100, // (1200 + 900 + 1200) / 3
      occupancy: [
        { assignmentId: 'r1', vehicleLabel: 'Van 1', passengers: 3, seats: 4, ratio: 0.75 },
        { assignmentId: 'r2', vehicleLabel: 'Van 2', passengers: 1, seats: 4, ratio: 0.25 },
      ],
      avgOccupancy: 0.5,
      deadlineCompliance: { inside: 2, total: 3, ratio: 0.667 }, // b2 arrives 1800 after its 1700 window end
      excluded: [
        { reason: 'fleet_too_small', bookings: 1 },
        { reason: 'not_optimised', bookings: 1 },
      ],
      excludedBookings: 2,
      strategy: 'COMFORT',
      alternativeOf: 'src-1',
    });
  });

  it('nulls without numbers; OUT uses the pickup at the site as the deadline end; raw weights → no strategy', () => {
    const m = extendedPlanMetrics({ direction: 'OUT', options: { strategy: 'COMFORT', weightsSource: 'weights' }, assignments: [{ id: 'r1', vehicleLabel: 'V', capacity: null, distanceM: null, durationS: 600 }], stops: [stop('s', 'PICKUP', 'b1', 'r1', 1, 100, [0, 50]), stop('h', 'DROP', 'b1', 'r1', 2, 700)] }, () => 1);
    expect(m).toMatchObject({ totalDistanceM: null, totalTravelS: 600, maxRideS: 600, avgOccupancy: null, deadlineCompliance: { inside: 0, total: 1, ratio: 0 }, strategy: null });
  });
});
