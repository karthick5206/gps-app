import { AlertTypeCode, EffectiveAlertSetting } from '@veetracer/shared';
import { RuleInput } from '../../processor/rules/evaluate';
import { RedisKeys } from '../../redis/keys';
import { ObjectTripState, prepareTrip, TripSnap } from './evaluate';
import { PlannedTripCache, PlannedTripTracker } from './tracker-engine';

const MIN = 60_000;
const T0 = Date.parse('2026-11-10T08:00:00.000Z');
const M_PER_DEG_LNG = 111_320 * Math.cos((13 * Math.PI) / 180);
const at = (east: number) => ({ lat: 13, lng: 80 + east / M_PER_DEG_LNG });

const snap = (over: Partial<TripSnap> = {}): TripSnap => ({
  id: 'trip1',
  routeName: 'Morning run',
  corridorM: 200,
  path: null,
  plannedStart: T0,
  plannedEnd: T0 + 20 * MIN,
  status: 'SCHEDULED',
  actualStart: null,
  deviationCount: 0,
  maxDeviationM: null,
  distanceKm: null,
  stops: [0, 2000, 4000].map((east, seq) => ({
    seq,
    name: `S${seq}`,
    ...at(east),
    radiusM: 100,
    plannedArrival: T0 + seq * 10 * MIN,
    plannedDeparture: T0 + seq * 10 * MIN,
    status: 'PENDING' as const,
    actualArrival: null,
    actualDeparture: null,
    delaySec: null,
  })),
  ...over,
});

const setting = (alertType: AlertTypeCode, over: Partial<EffectiveAlertSetting> = {}): EffectiveAlertSetting => ({
  alertType,
  supported: true,
  enabled: true,
  params: {},
  schedule: null,
  cooldownMin: 0,
  severity: 'WARNING',
  channels: { INFO: ['INAPP'], WARNING: ['INAPP'], CRITICAL: ['INAPP'] },
  requireAck: false,
  snoozedUntil: null,
  sources: {},
  ...over,
});

const object = { objectId: 'o1', companyId: 'c1', branchId: null, name: 'Bus 1', plateNumber: 'TN-01', deviceId: 'd1', speedLimitKph: null };
const input = (tMin: number, east: number, over: Partial<RuleInput> = {}): RuleInput => ({
  object,
  fixTime: T0 + tMin * MIN,
  ...at(east),
  speedKph: 30,
  ignition: true,
  attributes: {},
  ...over,
});

function setup(opts: { state?: ObjectTripState | null; settings?: EffectiveAlertSetting[]; trips?: TripSnap[] } = {}) {
  const pipe = { set: jest.fn(), publish: jest.fn(), xadd: jest.fn(), exec: jest.fn().mockResolvedValue([]) };
  for (const k of ['set', 'publish', 'xadd'] as const) pipe[k].mockReturnValue(pipe);
  const redis = { mget: jest.fn().mockResolvedValue([opts.state ? JSON.stringify(opts.state) : null]), pipeline: () => pipe };
  const prisma = {
    alert: { createMany: jest.fn((a: unknown) => ({ op: 'alert.createMany', a })) },
    plannedTripStop: { updateMany: jest.fn((a: unknown) => ({ op: 'stop.updateMany', a })) },
    plannedTripEvent: { createMany: jest.fn((a: unknown) => ({ op: 'event.createMany', a })), updateMany: jest.fn((a: unknown) => ({ op: 'event.updateMany', a })) },
    plannedTrip: { updateMany: jest.fn((a: unknown) => ({ op: 'trip.updateMany', a })) },
  };
  const settings = new Map((opts.settings ?? []).map((s) => [s.alertType, s]));
  const rules = { get: jest.fn().mockResolvedValue({ timezone: 'Asia/Kolkata', effective: () => settings }) };
  const trips = (opts.trips ?? [snap()]).map(prepareTrip);
  const cache = { get: jest.fn().mockResolvedValue(new Map([['o1', trips]])), invalidate: jest.fn() };
  const tracker = new PlannedTripTracker(redis as never, prisma as never, rules as never, cache as unknown as PlannedTripCache);
  return { tracker, pipe, redis, prisma, cache, rules };
}

/** Started at T0 − 5 min, left the start at T0, on the road at T0 + 1 min (500 m). */
async function startedState(): Promise<ObjectTripState> {
  const s = setup();
  const batch = await s.tracker.evaluate([input(-5, 0), input(0, 200), input(1, 500)]);
  await batch!.commit();
  const call = s.pipe.set.mock.calls.find((c) => c[0] === RedisKeys.plannedTripState('o1'))!;
  return JSON.parse(call[1] as string) as ObjectTripState;
}

describe('PlannedTripTracker', () => {
  it('skips points without a fix, health-only / alarm-only points and vehicles without trips', async () => {
    const s = setup();
    expect(await s.tracker.evaluate([input(0, 0, { locationValid: false }), input(0, 0, { healthOnly: true }), input(0, 0, { alarmsOnly: true })])).toBeNull();
    s.cache.get.mockResolvedValue(new Map());
    expect(await s.tracker.evaluate([input(0, 0)])).toBeNull();
    expect(s.redis.mget).not.toHaveBeenCalled();
  });

  it('start: statements (stop before trip, guarded by open status), state SET, socket push and cache refresh on commit', async () => {
    const s = setup();
    const batch = (await s.tracker.evaluate([input(-5, 0)]))!;
    const ops = batch.statements() as unknown as { op: string; a: { where: unknown; data: Record<string, unknown> } }[];
    expect(ops.map((o) => o.op)).toEqual(['stop.updateMany', 'trip.updateMany']);
    expect(ops[0].a.where).toEqual({ tripId: 'trip1', seq: 0, trip: { status: { in: ['SCHEDULED', 'STARTED', 'IN_PROGRESS'] } } });
    expect(ops[0].a.data).toEqual({ status: 'ARRIVED', actualArrival: new Date(T0 - 5 * MIN) });
    expect(ops[1].a.where).toEqual({ id: 'trip1', status: { in: ['SCHEDULED', 'STARTED', 'IN_PROGRESS'] } });
    expect(ops[1].a.data).toMatchObject({ status: 'STARTED', nextStopSeq: 1 });

    await batch.commit();
    expect(s.pipe.set).toHaveBeenCalledWith(RedisKeys.plannedTripState('o1'), expect.any(String), 'EX', 7 * 24 * 3600);
    const pushes = s.pipe.publish.mock.calls.filter((c) => c[0] === RedisKeys.plannedTripUpdates).map((c) => JSON.parse(c[1] as string));
    expect(pushes).toEqual([
      {
        companyId: 'c1',
        objectId: 'o1',
        update: expect.objectContaining({ id: 'trip1', status: 'STARTED', nextStopSeq: 1, actualStart: null, actualEnd: null, deviationCount: 0, maxDeviationM: null, stops: expect.any(Array) }),
      },
    ]);
    expect(s.pipe.publish).toHaveBeenCalledWith(RedisKeys.rulesInvalidate, expect.stringContaining('"reason":"planned-trips"'));
    expect(s.cache.invalidate).toHaveBeenCalledWith('c1');
  });

  it('merges several fixes of a batch into one row update per trip / stop and one push per trip', async () => {
    const s = setup();
    const batch = (await s.tracker.evaluate([input(-5, 0), input(0, 200), input(1, 500)]))!;
    expect(batch.trips.size).toBe(1);
    expect(batch.trips.get('trip1')).toMatchObject({ status: 'IN_PROGRESS', actualStart: T0 });
    expect(batch.stops.get('trip1:0')).toMatchObject({ status: 'DEPARTED', actualArrival: T0 - 5 * MIN, actualDeparture: T0, delaySec: 0 });
    expect(batch.live.size).toBe(1);
    expect(batch.live.get('trip1')?.update).toMatchObject({ status: 'IN_PROGRESS', stops: expect.any(Array) });
  });

  it('raises TRIP_STOP_LATE when enabled (threshold from the setting), with the alert pipeline', async () => {
    const state = await startedState();
    const s = setup({ state, settings: [setting('TRIP_STOP_LATE', { params: { lateMin: 5 } })] });
    const batch = (await s.tracker.evaluate([input(17, 2000)]))!;
    expect(batch.alerts).toEqual([
      expect.objectContaining({ type: 'TRIP_STOP_LATE', severity: 'WARNING', object, data: expect.objectContaining({ tripId: 'trip1', routeName: 'Morning run', stopName: 'S1', delayMin: 7 }) }),
    ]);
    const ops = batch.statements() as unknown as { op: string; a: { data: { type: string }[] } }[];
    expect(ops[0].op).toBe('alert.createMany');
    expect(ops[0].a.data[0]).toMatchObject({ type: 'TRIP_STOP_LATE', companyId: 'c1', objectId: 'o1', deviceId: 'd1' });
    await batch.commit();
    expect(s.pipe.publish).toHaveBeenCalledWith(RedisKeys.alertsChannel, expect.stringContaining('"type":"TRIP_STOP_LATE"'));
    expect(s.pipe.xadd).toHaveBeenCalledWith(RedisKeys.notifyStream, 'MAXLEN', '~', expect.any(Number), '*', 'alertId', batch.alerts[0].id, 'companyId', 'c1');
    // Cooldown mark per trip stop in the saved state.
    const saved = JSON.parse(s.pipe.set.mock.calls[0][1] as string) as ObjectTripState;
    expect(saved.cd['TRIP_STOP_LATE:trip1:1']).toBe(T0 + 17 * MIN);
  });

  it('raises nothing when the alert type is disabled or not configured, but still tracks', async () => {
    const state = await startedState();
    for (const settings of [[setting('TRIP_STOP_LATE', { enabled: false })], []]) {
      const s = setup({ state, settings });
      const batch = (await s.tracker.evaluate([input(17, 2000)]))!;
      expect(batch.alerts).toEqual([]);
      expect(batch.stops.get('trip1:1')).toMatchObject({ status: 'ARRIVED' });
    }
  });

  it('honours the alert cooldown kept in the tracker state', async () => {
    const state = await startedState();
    state.cd['ROUTE_DEVIATION:trip1'] = T0;
    const s = setup({ state, settings: [setting('ROUTE_DEVIATION', { cooldownMin: 15 })] });
    const north = (m: number) => 13 + m / 111_320;
    const batch = (await s.tracker.evaluate([input(2, 800, { lat: north(400) }), input(3, 900, { lat: north(500) })]))!;
    expect(batch.eventOpens).toHaveLength(1);
    expect(batch.alerts).toEqual([]);
  });
});
