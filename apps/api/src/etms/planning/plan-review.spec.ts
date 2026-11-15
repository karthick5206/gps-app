import type { RoutePlanVersionSnapshot } from '@veetracer/shared';
import { findBusy, tripOverlaps, type BusyTrip } from '../dispatch/trip-overlap';
import { availabilityErrors, manualChanges, restorePlacements, reviewHashOf, routeSpan, snapshotRoutes } from './plan-review';

/** WP-B pure rules: review hash, manual-change diff, restore placements / conflicts, availability overlap. */

const snap = (assignments: { id: string; stopIds: string[]; objectId?: string | null; driverId?: string | null }[], unassigned: string[] = []): RoutePlanVersionSnapshot => ({
  status: 'PLANNED',
  assignments: assignments.map((a) => ({ id: a.id, vehicleLabel: a.id, objectId: a.objectId ?? null, driverId: a.driverId ?? null, stopIds: a.stopIds })),
  stops: [
    ...assignments.flatMap((a) => a.stopIds.map((s, i) => ({ id: s, ref: s, assignmentId: a.id, sequence: i + 1, etaS: 100 * i, unassignedReason: null }))),
    ...unassigned.map((s) => ({ id: s, ref: s, assignmentId: null, sequence: null, etaS: null, unassignedReason: null })),
  ],
});

const stop = (id: string, assignmentId: string | null, sequence: number | null) => ({ id, ref: id, assignmentId, sequence });

describe('reviewHashOf', () => {
  const base = { version: 4, fingerprint: null, routes: [{ id: 'a', objectId: 'v1', driverId: null, stops: [{ id: 's1', etaS: 60 }, { id: 's2', etaS: 600 }] }, { id: 'b', objectId: 'v2', driverId: 'd1', stops: [{ id: 's3', etaS: 30 }] }] };
  it('is stable and independent of the selection order', () => {
    expect(reviewHashOf(base)).toBe(reviewHashOf({ ...base, routes: [...base.routes].reverse() }));
    expect(reviewHashOf(base)).toMatch(/^r1-[0-9a-f]{32}$/);
  });
  it.each([
    ['version', { ...base, version: 5 }],
    ['vehicle', { ...base, routes: [{ ...base.routes[0], objectId: 'v9' }, base.routes[1]] }],
    ['driver', { ...base, routes: [base.routes[0], { ...base.routes[1], driverId: null }] }],
    ['stop order', { ...base, routes: [{ ...base.routes[0], stops: [...base.routes[0].stops].reverse() }, base.routes[1]] }],
    ['an ETA', { ...base, routes: [{ ...base.routes[0], stops: [{ id: 's1', etaS: 61 }, { id: 's2', etaS: 600 }] }, base.routes[1]] }],
    ['warnings', { ...base, fingerprint: 'w1-00000000' }],
    ['selection', { ...base, routes: [base.routes[0]] }],
  ])('changes with the %s', (_n, changed) => {
    expect(reviewHashOf(changed)).not.toBe(reviewHashOf(base));
  });
});

describe('manualChanges', () => {
  it('reports added / removed / reordered stops and vehicle / driver changes, only for changed routes', () => {
    const baseline = snapshotRoutes(snap([{ id: 'a', stopIds: ['1', '2', '3'], objectId: 'v1' }, { id: 'b', stopIds: ['4'], objectId: 'v2' }, { id: 'c', stopIds: ['5'] }]));
    const out = manualChanges(baseline, [
      { id: 'a', objectId: 'v1', driverId: null, stopIds: ['3', '1'] },
      { id: 'b', objectId: 'v3', driverId: 'd', stopIds: ['4', '2'] },
      { id: 'c', objectId: null, driverId: null, stopIds: ['5'] },
    ]);
    expect(out).toEqual([
      { assignmentId: 'a', addedStopIds: [], removedStopIds: ['2'], reordered: true, vehicleChanged: false, driverChanged: false },
      { assignmentId: 'b', addedStopIds: ['2'], removedStopIds: [], reordered: false, vehicleChanged: true, driverChanged: true },
    ]);
  });
});

describe('restorePlacements', () => {
  const ids = new Set(['a', 'b']);
  it('detects a changed stop set (conflict, nothing placed)', () => {
    const r = restorePlacements(snap([{ id: 'a', stopIds: ['1', '2'] }]), [stop('1', 'a', 0), stop('3', null, null)], ids, new Set());
    expect(r.conflict).toEqual({ removedStopIds: ['2'], addedStopIds: ['3'] });
    expect(r.placements.size).toBe(0);
  });
  it('puts back membership and order; the same order with other numbers is no change', () => {
    const r = restorePlacements(snap([{ id: 'a', stopIds: ['1', '2'] }, { id: 'b', stopIds: ['3', '4'] }]), [stop('1', 'a', 1), stop('2', 'a', 2), stop('3', 'b', 0), stop('4', null, null)], ids, new Set());
    expect(r.conflict).toBeNull();
    expect([...r.changed]).toEqual(['b']);
    expect(Object.fromEntries(r.placements)).toEqual({ '3': { assignmentId: 'b', sequence: 0 }, '4': { assignmentId: 'b', sequence: 1 } });
  });
  it('leaves fixed routes alone; a stop the version had on a fixed route becomes unassigned', () => {
    // Version: 1,2 on a; 3 on b. Now: a is fixed (published) with 1 only; 2 moved to b.
    const r = restorePlacements(snap([{ id: 'a', stopIds: ['1', '2'] }, { id: 'b', stopIds: ['3'] }]), [stop('1', 'a', 0), stop('2', 'b', 1), stop('3', 'b', 0)], ids, new Set(['a']));
    expect(Object.fromEntries(r.placements)).toEqual({ '3': { assignmentId: 'b', sequence: 0 }, '2': { assignmentId: null, sequence: null } });
    expect([...r.changed]).toEqual(['b']);
    expect(r.skippedRoutes).toEqual(['a']);
  });
});

describe('availability', () => {
  const t0 = Date.parse('2026-12-02T02:00:00Z');
  const trip = (o: Partial<BusyTrip>): BusyTrip => ({ id: 't', objectId: 'v1', driverId: null, status: 'SCHEDULED', plannedStart: new Date(t0), plannedEnd: new Date(t0 + 3_600_000), routeName: 'School run', ...o });
  it('overlap: touching ends do not count; finished trips never count', () => {
    expect(tripOverlaps(trip({}), new Date(t0 + 3_600_000), new Date(t0 + 7_200_000))).toBe(false);
    expect(tripOverlaps(trip({}), new Date(t0 + 1_000), new Date(t0 + 2_000))).toBe(true);
    expect(tripOverlaps(trip({ status: 'COMPLETED' }), new Date(t0 + 1_000), new Date(t0 + 2_000))).toBe(false);
    expect(findBusy([trip({ objectId: 'v2', driverId: 'd1' })], { objectId: 'v1', driverId: 'd1' }, new Date(t0), new Date(t0 + 60_000))?.code).toBe('DRIVER_BUSY');
  });
  it('routeSpan clamps the start to an hour before the first stop; untimed → null', () => {
    expect(routeSpan(t0, -7200, [{ etaS: 600 }, { etaS: 1800 }])).toEqual({ start: new Date(t0 + 600_000 - 3_600_000), end: new Date(t0 + 1_800_000) });
    expect(routeSpan(t0, 0, [{ etaS: 600 }, { etaS: null }])).toBeNull();
  });
  it('blocks busy and inactive vehicles / drivers per route', () => {
    const span = { start: new Date(t0 + 1_000), end: new Date(t0 + 2_000) };
    const errors = availabilityErrors(
      [
        { id: 'a', vehicleLabel: 'Van A', objectId: 'v1', driverId: null, span },
        { id: 'b', vehicleLabel: 'Van B', objectId: 'v2', driverId: 'd9', span: null },
        { id: 'c', vehicleLabel: 'Van C', objectId: 'v3', driverId: null, span },
      ],
      [trip({})],
      { vehicles: new Set(), drivers: new Set(['d9']) },
    );
    expect(errors.map((e) => [e.assignmentId, e.code])).toEqual([
      ['a', 'VEHICLE_BUSY'],
      ['b', 'DRIVER_INACTIVE'],
    ]);
    expect(errors[0].message).toContain('School run');
  });
});
