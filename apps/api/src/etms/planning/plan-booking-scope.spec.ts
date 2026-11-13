import { planSkipReason, windowsOverlap, type PlanScope, type PlanScopeBooking } from './plan-booking-scope';

const SITE = 'site-1';
const OTHER = 'site-2';
const H = 3_600_000;
const LOGIN = Date.parse('2026-11-20T03:30:00Z'); // 09:00 IST
const LEG = { start: LOGIN - 2 * H, end: LOGIN };

const b = (o: Partial<PlanScopeBooking> = {}): PlanScopeBooking => ({
  status: 'PENDING_ASSIGNMENT',
  journey: 'COMMUTE',
  shiftId: 'shift-a',
  pickupPoiId: null,
  dropPoiId: SITE,
  windowStart: new Date(LOGIN - H),
  windowEnd: new Date(LOGIN),
  branchId: null,
  ...o,
});
const plan = (o: Partial<PlanScope> = {}): PlanScope => ({ direction: 'IN', sitePoiId: SITE, shiftId: 'shift-a', shiftLeg: LEG, branchId: null, ...o });

describe('WP 3.9 plan booking scope', () => {
  it('plans a booking of the plan shift and site', () => {
    expect(planSkipReason(b(), plan())).toBeNull();
  });

  it('shift-less COMMUTE booking at the site: planned when its window overlaps the shift leg, else outside_shift_window', () => {
    expect(planSkipReason(b({ shiftId: null }), plan())).toBeNull();
    expect(planSkipReason(b({ shiftId: null, windowStart: new Date(LOGIN - 3 * H), windowEnd: new Date(LOGIN - 2 * H + 60_000) }), plan())).toBeNull();
    expect(planSkipReason(b({ shiftId: null, windowStart: new Date(LOGIN + H), windowEnd: new Date(LOGIN + 2 * H) }), plan())).toBe('outside_shift_window');
    // touching ends do not overlap
    expect(planSkipReason(b({ shiftId: null, windowStart: new Date(LOGIN), windowEnd: new Date(LOGIN + H) }), plan())).toBe('outside_shift_window');
  });

  it('a plan without a shift takes every COMMUTE booking at its site, with or without a shift', () => {
    const p = plan({ shiftId: null, shiftLeg: null });
    expect(planSkipReason(b({ shiftId: null, windowStart: new Date(LOGIN + 5 * H), windowEnd: new Date(LOGIN + 6 * H) }), p)).toBeNull();
    expect(planSkipReason(b({ shiftId: 'shift-b' }), p)).toBeNull();
  });

  it('other_shift, other_site (office end by direction), point_to_point, out_of_scope, needs_approval', () => {
    expect(planSkipReason(b({ shiftId: 'shift-b' }), plan())).toBe('other_shift');
    expect(planSkipReason(b({ dropPoiId: OTHER }), plan())).toBe('other_site');
    expect(planSkipReason(b({ dropPoiId: null }), plan())).toBe('other_site'); // one-time map point destination
    expect(planSkipReason(b({ pickupPoiId: SITE, dropPoiId: null }), plan({ direction: 'OUT' }))).toBeNull();
    expect(planSkipReason(b({ pickupPoiId: OTHER, dropPoiId: SITE }), plan({ direction: 'OUT' }))).toBe('other_site');
    expect(planSkipReason(b({ journey: 'POINT_TO_POINT' }), plan())).toBe('point_to_point');
    expect(planSkipReason(b({ branchId: 'br-2' }), plan({ branchId: 'br-1' }))).toBe('out_of_scope');
    expect(planSkipReason(b({ branchId: null }), plan({ branchId: 'br-1' }))).toBeNull();
    expect(planSkipReason(b({ status: 'REQUESTED' }), plan())).toBe('needs_approval');
    expect(planSkipReason(b({ status: 'WAITLISTED' }), plan())).toBe('needs_approval');
  });

  it('reports the most structural reason first', () => {
    expect(planSkipReason(b({ journey: 'POINT_TO_POINT', dropPoiId: OTHER, status: 'REQUESTED' }), plan())).toBe('point_to_point');
    expect(planSkipReason(b({ dropPoiId: OTHER, shiftId: 'shift-b', status: 'REQUESTED' }), plan())).toBe('other_site');
    expect(planSkipReason(b({ shiftId: 'shift-b', status: 'REQUESTED', branchId: 'br-2' }), plan({ branchId: 'br-1' }))).toBe('other_shift');
    expect(planSkipReason(b({ status: 'REQUESTED', branchId: 'br-2' }), plan({ branchId: 'br-1' }))).toBe('out_of_scope');
  });

  it('windowsOverlap', () => {
    expect(windowsOverlap(0, 10, { start: 5, end: 20 })).toBe(true);
    expect(windowsOverlap(0, 5, { start: 5, end: 20 })).toBe(false);
    expect(windowsOverlap(20, 30, { start: 5, end: 20 })).toBe(false);
  });
});
