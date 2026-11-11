import type { SolverResult } from '@veetracer/shared';
import { JobError } from './job-worker';
import { mapSolverResult, planPoints, siteWindow, snapExclusions, solverProblem } from './optimize-problem';
import { optimizerHealth, solverPort } from './optimizer-port';
import { RoutingError } from '../routing/routing.errors';
import { DEPOT, greedySolve, SITE, syntheticPlan, testMatrix } from './testing/fakes';

describe('optimise problem mapping (solver contract v2)', () => {
  it('IN: [site, depot, …pickups]; site drops are not solver stops; start explicit, trip window from the drops', () => {
    const inp = syntheticPlan();
    const b = planPoints(inp);
    expect(b.points).toEqual([SITE, DEPOT, ...inp.stops.slice(0, 3).map((s) => ({ lat: s.lat, lng: s.lng }))]);
    expect(b).toMatchObject({ trip: { direction: 'IN', siteIndex: 0 }, startIndex: 1, firstStopIndex: 2 });
    expect(b.solverStops.map((s) => s.id)).toEqual(['pick-1', 'pick-2', 'pick-3']);
    expect(b.siteStops.map((s) => s.id)).toEqual(['drop-1', 'drop-2', 'drop-3']);
    const p = solverProblem(inp, b, testMatrix(5), { timeLimitS: 10 });
    expect(p.schemaVersion).toBe(2);
    expect(p.trip).toEqual({ direction: 'IN', siteIndex: 0, siteWindow: [3_000, 3_600] });
    expect(p.vehicles[0]).toEqual({ id: 'veh-a', startIndex: 1, endIndex: 1, capacity: 4, type: 'VAN' });
    expect(Object.keys(p.vehicles[0])).toContain('startIndex');
    expect(p.stops[0]).toEqual({ id: 'pick-1', locationIndex: 2, demand: 1, serviceS: 60, priority: 1, customerId: 'cust-1' });
    expect(p.options).toEqual({ timeLimitS: 10, weights: { vehicle: 7_200, distance: 0, time: 1, routeDuration: 0 } });
    // No names, refs, booking ids or coordinates in the solver payload beyond the matrix.
    expect(JSON.stringify(p)).not.toMatch(/booking-|"ref"|"lat"|"lng"|P1/);
  });

  it('passengerIds and a wheelchair need go to the solver (data the model holds); no gender, no escort field', () => {
    const inp = syntheticPlan();
    inp.stops[0].passengerIds = ['profile-1'];
    inp.stops[0].wheelchair = 1;
    inp.vehicles[1].wheelchairSpaces = 1;
    const p = solverProblem(inp, planPoints(inp), testMatrix(5), { timeLimitS: 5 });
    expect(p.stops[0]).toMatchObject({ passengerIds: ['profile-1'], wheelchair: 1 });
    expect(p.stops[1]).not.toHaveProperty('wheelchair');
    expect(p.vehicles[1]).toMatchObject({ wheelchairSpaces: 1 });
    expect(JSON.stringify(p)).not.toMatch(/gender|escort/i);
  });

  it('a route carrying more wheelchairs than the vehicle has spaces is rejected', () => {
    const inp = syntheticPlan();
    inp.stops[0].wheelchair = 1;
    const b = planPoints(inp);
    const r = greedySolve(solverProblem(inp, b, testMatrix(5), { timeLimitS: 5 }));
    expect(() => mapSolverResult(inp, b, r, null)).toThrow(/wheelchair/);
  });

  it('IN without a depot: open start (startIndex null, sent explicitly)', () => {
    const b = planPoints(syntheticPlan({ depot: null }));
    expect(b.startIndex).toBeNull();
    const p = solverProblem(syntheticPlan({ depot: null }), b, testMatrix(4), { timeLimitS: 5 });
    expect(p.vehicles[0]).toHaveProperty('startIndex', null);
  });

  it('OUT: vehicles leave the site (start = site), end at the depot or open end; maxRide and distance weights pass through', () => {
    const inp = syntheticPlan({ direction: 'OUT', maxRideS: 5_400 });
    const b = planPoints(inp);
    expect(b).toMatchObject({ startIndex: 1, endIndex: 1 });
    const open = planPoints(syntheticPlan({ direction: 'OUT', depot: null }));
    expect(open).toMatchObject({ startIndex: 0, endIndex: null });
    const p = solverProblem(inp, b, testMatrix(5), { timeLimitS: 5, objective: 'distance' });
    expect(p.trip).toMatchObject({ direction: 'OUT', maxRideS: 5_400 });
    expect(p.options.weights).toEqual({ vehicle: 50_000, distance: 1, time: 0, routeDuration: 0 });
  });

  it('generic plan (no direction): every stop is a solver stop, start = end = depot, still schema 2 without trip', () => {
    const inp = syntheticPlan({ direction: null });
    const b = planPoints(inp);
    expect(b).toMatchObject({ trip: null, startIndex: 0, endIndex: 0, firstStopIndex: 1 });
    expect(b.solverStops).toHaveLength(6);
    expect(solverProblem(inp, b, testMatrix(7), { timeLimitS: 5 }).trip).toBeUndefined();
  });

  it('refuses plans without vehicles or without any start point', () => {
    expect(() => planPoints(syntheticPlan({ vehicles: [] }))).toThrow(JobError);
    expect(() => planPoints(syntheticPlan({ direction: null, depot: null, site: null }))).toThrow(/no depot or site/);
  });

  it('site window: tightest common window; non-overlapping shifts fall back to the span; none → whole horizon', () => {
    const b = planPoints(syntheticPlan());
    expect(siteWindow(b, 86_400)).toEqual([3_000, 3_600]);
    b.siteStops[1].timeWindows = [[4_000, 4_500]];
    expect(siteWindow(b, 86_400)).toEqual([3_000, 4_500]);
    b.siteStops.forEach((s) => (s.timeWindows = null));
    expect(siteWindow(b, 86_400)).toEqual([0, 86_400]);
  });

  it('maps a result: routes + site drops at the route end, excluded stops unassigned with their reason, codes kept', () => {
    const inp = syntheticPlan({ excluded: [{ stopId: 'gone-1', reason: 'consent_withdrawn' }] });
    inp.stops = inp.stops.filter((s) => s.id !== 'pick-3');
    const b = planPoints(inp);
    const p = solverProblem(inp, b, testMatrix(4), { timeLimitS: 5 });
    const r = greedySolve({ ...p, stops: p.stops.slice(0, 1) });
    r.unassigned = [{ stopId: 'pick-2', reason: 'max_ride_unachievable', code: 'MAX_RIDE_UNACHIEVABLE' } as never];
    const { write, result } = mapSolverResult(inp, b, r, 'gh-1');
    const a = write.assignments.find((x) => x.assignmentId === 'veh-a')!;
    expect(a.visits.map((v) => [v.stopId, v.sequence])).toEqual([
      ['pick-1', 1],
      ['drop-1', 2],
    ]);
    expect(a.visits[1].etaS).toBe(3_600); // the site arrival
    expect(write.assignments.find((x) => x.assignmentId === 'veh-b')!.visits).toEqual([]);
    expect(write.unassigned).toEqual(
      expect.arrayContaining([
        { stopId: 'gone-1', reason: 'consent_withdrawn' },
        { stopId: 'pick-2', reason: 'max_ride_unachievable', code: 'MAX_RIDE_UNACHIEVABLE' },
        { stopId: 'drop-2', reason: 'max_ride_unachievable' },
        { stopId: 'drop-3', reason: 'not_scheduled_capacity_or_time' },
      ]),
    );
    expect(result.routes[0].eta).toMatchObject({ calibrated: false, liveTraffic: false, graphVersion: 'gh-1' });
  });

  it('OUT: site pickups go first on the route, at the site departure', () => {
    const inp = syntheticPlan({ direction: 'OUT' });
    const b = planPoints(inp);
    const r = greedySolve(solverProblem(inp, b, testMatrix(5), { timeLimitS: 5 }));
    const a = mapSolverResult(inp, b, r, null).write.assignments[0];
    expect(a.visits.slice(0, 3).map((v) => v.stopId)).toEqual(['drop-1', 'drop-2', 'drop-3']);
    expect(a.visits[0].etaS).toBe(a.startS);
  });

  describe('never trusts the optimiser (doc 06 §4.5)', () => {
    const setup = () => {
      const inp = syntheticPlan();
      const b = planPoints(inp);
      return { inp, b, r: greedySolve(solverProblem(inp, b, testMatrix(5), { timeLimitS: 5 })) };
    };
    it.each([
      ['a stop missing from both lists', (r: SolverResult) => r.routes[0].stops.pop(), /incomplete/],
      ['a repeated stop', (r: SolverResult) => r.routes[0].stops.push({ ...r.routes[0].stops[0] }), /repeated/],
      ['an unknown vehicle', (r: SolverResult) => (r.routes[0].vehicleId = 'veh-x'), /unknown vehicle/],
      ['a stop both routed and unassigned', (r: SolverResult) => r.unassigned.push({ stopId: 'pick-1', reason: 'no_solution_found' }), /repeated unassigned/],
      ['a visit outside its window', (_r: SolverResult) => void 0, /time window/],
      ['a site arrival outside the site window', (r: SolverResult) => (r.routes[0].endS = 9_999), /site arrival/],
    ])('%s → INVALID_INPUT, nothing stored', (name, mutate, msg) => {
      const { inp, b, r } = setup();
      if (name === 'a visit outside its window') b.solverStops[0].timeWindows = [[0, 10]];
      mutate(r);
      expect(() => mapSolverResult(inp, b, r, null)).toThrow(msg);
    });
    it('a vehicle over its seats', () => {
      const { inp, b, r } = setup();
      inp.vehicles[0].capacity = 2;
      expect(() => mapSolverResult(inp, b, r, null)).toThrow(/over capacity/);
    });
    it('INVALID_INPUT status from the service', () => {
      const { inp, b } = setup();
      expect(() => mapSolverResult(inp, b, { status: 'INVALID_INPUT', provenOptimal: false, routes: [], unassigned: [], error: 'bad' }, null)).toThrow(/rejected/);
    });
  });

  it('points the engine cannot snap become unassigned with not_on_road / outside_coverage', () => {
    const b = planPoints(syntheticPlan());
    const m = testMatrix(5);
    m.invalid = [
      { index: 2, reason: 'not_on_road' },
      { index: 4, reason: 'outside_coverage' },
      { index: 0, reason: 'unreachable_location' },
    ];
    expect([...snapExclusions(b, m)]).toEqual([
      ['pick-1', 'not_on_road'],
      ['pick-3', 'outside_coverage'],
    ]);
  });
});

describe('optimizer port (shared OptimizerClient → job errors)', () => {
  const failing = (code: 'OPTIMIZER_BUSY' | 'OPTIMIZER_UNAVAILABLE' | 'LIMIT_EXCEEDED') => ({
    solve: async () => {
      throw new RoutingError(code, 'x');
    },
  });
  it.each([
    ['OPTIMIZER_BUSY', 'OPTIMIZER_BUSY'],
    ['OPTIMIZER_UNAVAILABLE', 'OPTIMIZER_UNAVAILABLE'],
    ['LIMIT_EXCEEDED', 'INVALID_INPUT'],
  ] as const)('%s → %s', async (from, to) => {
    await expect(solverPort(failing(from)).solve({} as never)).rejects.toMatchObject({ code: to });
  });
  it('an aborted job does not call the optimiser', async () => {
    const solve = jest.fn();
    const ac = new AbortController();
    ac.abort(new JobError('CANCELLED', 'c'));
    await expect(solverPort({ solve }).solve({} as never, ac.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(solve).not.toHaveBeenCalled();
  });
  it('health: not configured / down / up', async () => {
    expect(await optimizerHealth({ configured: false, config: { baseUrl: '', token: '', problem: 'ETMS_ROUTING is off' }, health: async () => false })).toMatchObject({ configured: false, ok: false, error: 'ETMS_ROUTING is off' });
    expect(await optimizerHealth({ configured: true, config: { baseUrl: 'http://127.0.0.1:8090', token: 't', problem: null }, health: async () => false })).toMatchObject({ configured: true, ok: false });
    expect(await optimizerHealth({ configured: true, config: { baseUrl: 'http://127.0.0.1:8090', token: 't', problem: null }, health: async () => true })).toMatchObject({ ok: true, error: null });
  });
});
