import { publishWarningsFingerprint } from '@veetracer/shared';
import { publishIssues, type RuleStop } from './plan-rules';
import { canOverridePublish, meaningfulReason, publishDecisionOf } from './plans.service';

/** Owner decision 5 (publishing): the pure classification and the override rules (DB behaviour: etms-publish-gate.db-test.ts). */
let n = 0;
const stop = (o: Partial<RuleStop>): RuleStop => ({
  id: `s${++n}`,
  ref: `r${n}`,
  assignmentId: 'A',
  sequence: n,
  etaS: 600,
  serviceS: 0,
  demand: 1,
  timeWindows: null,
  stopKind: null,
  bookingId: null,
  profileId: null,
  poiId: null,
  lat: 13.06,
  lng: 80.24,
  name: null,
  ...o,
});
const route = (capacity: number | null = 4) => [{ id: 'A', vehicleLabel: 'Van 1', capacity }];
const seats = () => 1;

describe('decision 5: publish classification', () => {
  it('a site arrival after the window (08:56 vs 08:55) is HARD and overridable; IN and OUT windows alike', () => {
    const inDrop = stop({ stopKind: 'DROP', bookingId: 'b1', etaS: 5460, timeWindows: [[0, 5400]] });
    const outPickup = stop({ stopKind: 'PICKUP', bookingId: 'b2', etaS: 5460, timeWindows: [[0, 5400]] });
    const r = publishIssues(route(), [inDrop, outPickup], seats);
    expect(r.hard.map((i) => [i.stopId, i.kind, i.overridable])).toEqual([
      [inDrop.id, 'late', true],
      [outPickup.id, 'late', true],
    ]);
    expect(r.hard[0]).toMatchObject({ assignmentId: 'A', vehicleLabel: 'Van 1', etaS: 5460, window: [0, 5400] });
    expect(r.soft).toEqual([]);
    expect(r.fingerprint).toBeNull();
    // On time: nothing.
    expect(publishIssues(route(), [stop({ etaS: 5400, timeWindows: [[0, 5400]] })], seats)).toEqual({ hard: [], soft: [], fingerprint: null });
  });

  it('unreachable (no engine time) and over_capacity are HARD and not overridable; early_wait is SOFT', () => {
    const untimed = stop({ etaS: null, timeWindows: [[0, 5400]] });
    expect(publishIssues(route(), [untimed], seats).hard).toEqual([expect.objectContaining({ kind: 'unreachable', overridable: false })]);
    const full = [1, 2, 3].map((k) => stop({ stopKind: 'PICKUP', bookingId: `c${k}` }));
    expect(publishIssues(route(2), full, seats).hard).toEqual([expect.objectContaining({ kind: 'over_capacity', overridable: false })]);
    const early = stop({ etaS: 2400, timeWindows: [[3000, 5400]] });
    const r = publishIssues(route(), [early], seats);
    expect(r.hard).toEqual([]);
    expect(r.soft.map((i) => i.kind)).toEqual(['early_wait']);
    expect(r.fingerprint).toMatch(/^w1-[0-9a-f]{8}$/);
  });

  it('routes without stops and unassigned stops are not classified', () => {
    expect(publishIssues(route(), [stop({ assignmentId: null, etaS: null, timeWindows: [[0, 1]] })], seats)).toEqual({ hard: [], soft: [], fingerprint: null });
  });

  it('the warning fingerprint depends on the set (not its order) and changes with it', () => {
    const a = { stopId: 'x', kind: 'early_wait' as const };
    const b = { stopId: 'y', kind: 'max_ride_exceeded' as const };
    expect(publishWarningsFingerprint([a, b])).toBe(publishWarningsFingerprint([b, a]));
    expect(publishWarningsFingerprint([a])).not.toBe(publishWarningsFingerprint([a, b]));
    expect(publishWarningsFingerprint([a])).not.toBe(publishWarningsFingerprint([{ stopId: 'x', kind: 'max_ride_exceeded' }]));
    expect(publishWarningsFingerprint([])).toBeNull();
  });
});

describe('decision 5: override rules', () => {
  const both = { etms_planning: ['command'], etms_dispatch: ['command'] } as never;
  it('only a whole-company role holding Route planning: command and Dispatch: command may override', () => {
    expect(canOverridePublish({ dataScope: 'COMPANY', permissions: both })).toBe(true);
    expect(canOverridePublish({ dataScope: 'ASSIGNED', permissions: both })).toBe(false);
    expect(canOverridePublish({ dataScope: 'COMPANY', permissions: { etms_planning: ['command'] } as never })).toBe(false);
    expect(canOverridePublish({ dataScope: 'COMPANY', permissions: { etms_dispatch: ['command'] } as never })).toBe(false);
  });

  it('a reason needs 15+ characters and two words', () => {
    expect(meaningfulReason('Site gate opens late today')).toBe(true);
    expect(meaningfulReason('ok')).toBe(false);
    expect(meaningfulReason('aaaaaaaaaaaaaaaaaaaa')).toBe(false);
    expect(meaningfulReason('1234567890 1234567890')).toBe(false);
    expect(meaningfulReason('शिफ्ट देर से शुरू होगी आज')).toBe(true);
  });

  it('the stored decision is shown without its request hash', () => {
    expect(publishDecisionOf(null)).toBeNull();
    expect(publishDecisionOf({ weights: {} })).toBeNull();
    expect(publishDecisionOf({ publishDecision: { acknowledged: null, override: null, requestHash: 'h' } })).toEqual({ acknowledged: null, override: null });
  });
});
