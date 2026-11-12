/**
 * In-memory stand-in for the plans + jobs APIs (synthetic data only), shaped like the E4-F / E4-E contracts. Used by
 * the unit tests and — in a dev build only — by the planner when `localStorage['vt.plannerMock']` is `1` (or
 * `engine-down`), so the screens can be exercised without a server. Never bundled in production: the planner imports
 * it behind `import.meta.env.DEV`. No React, DOM or path aliases (runs under `node --test`).
 *
 * `engine-down` mode: the engine is unreachable, optimise fails with ROUTING_UNAVAILABLE, edits come back `degraded`
 * with null ETAs, and stored routes carry a `live_heuristic` ETA model, which the planner must never show (P10 gate).
 */
import type {
  EtaModel,
  RoutePlanMetricsDto,
  RoutePlanPublishResult,
  RoutePlanStopViolation,
  RoutePlanSummaryDto,
  RoutePlanVersionDto,
  RoutingCapabilities,
  RoutingJobDto,
} from '@veetracer/shared';
import type { CreatePlanRequest, OptimizeJobRequest, PlannerClient } from './planner-api';
import type { PlanEditResult, PlannerAssignment, PlannerPlan, PlannerStop } from './planner-format';

export class MockApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  readonly body: unknown;
  constructor(status: number, code: string | null, message: string, body: unknown = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export type MockMode = 'ok' | 'engine-down';

const ENGINE: EtaModel = { source: 'engine_free_flow', calibrated: false, liveTraffic: false, graphVersion: 'gh-test/synthetic', band: null, factor: 1, factorSource: null };
const LIVE: EtaModel = { source: 'live_heuristic', calibrated: false, liveTraffic: false, graphVersion: null, band: null, factor: 1, factorSource: null };

/** Synthetic site and vehicles (a made-up grid; no real people or addresses). */
export const FIXTURE_SITE = { id: 'poi-site-1', name: 'Synthetic Tech Park', lat: 12.9, lng: 80.2 };
export const FIXTURE_VEHICLES = [
  { objectId: 'veh-1', name: 'Van 01', plateNumber: 'TN00AA0001', seats: 4 },
  { objectId: 'veh-2', name: 'Van 02', plateNumber: 'TN00AA0002', seats: 4 },
  { objectId: 'veh-3', name: 'Car 03', plateNumber: 'TN00AA0003', seats: 3 },
  { objectId: 'veh-9', name: 'Bus 09', plateNumber: 'TN00AA0009', seats: 12 },
];

function fixtureStops(planId: string, n: number): PlannerStop[] {
  return Array.from({ length: n }, (_, i) => {
    const hidden = i === 4; // one passenger whose routing consent is not active: the API withholds the point
    return {
      id: `${planId}-s${i + 1}`,
      ref: `P${String(i + 1).padStart(3, '0')}`,
      name: null,
      lat: hidden ? null : 12.95 + (i % 4) * 0.012,
      lng: hidden ? null : 80.15 + Math.floor(i / 4) * 0.015,
      snappedLat: null,
      snappedLng: null,
      snapDistanceM: null,
      demand: 1,
      serviceS: 60,
      timeWindows: null,
      assignmentId: null,
      sequence: null,
      etaS: null,
      unassignedReason: null,
      stopKind: 'PICKUP',
      bookingId: `bk-${planId}-${i + 1}`,
      profileId: `pp-${i + 1}`,
      poiId: null,
      customerCompanyId: null,
      personal: true,
      pointHidden: hidden ? 'CONSENT_REQUIRED' : null,
      pinned: false,
      plannedArrival: null,
      seats: 1,
      passengerName: `Passenger ${i + 1}`,
    };
  });
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export interface MockPlanner extends PlannerClient {
  /** Simulates another user's edit (the next edit with the old version gets PLAN_STALE). */
  bumpVersion(planId: string): void;
  setMode(mode: MockMode): void;
  plans(): PlannerPlan[];
}

/**
 * The mock refuses what the API refuses (so it cannot hide a contract mismatch again): a missing Idempotency-Key on
 * create / optimise / publish (400 IDEMPOTENCY_KEY_REQUIRED), unknown body fields (forbidNonWhitelisted) and missing or
 * invalid weights (OptimizeOptionsDto / P6). `optimisedStatus`: the status an optimisation leaves (PLANNED; DRAFT models
 * a server that does not set PLANNED).
 */
export function createMockPlannerClient(opts: { mode?: MockMode; now?: () => string; optimisedStatus?: 'PLANNED' | 'DRAFT' } = {}): MockPlanner {
  let mode: MockMode = opts.mode ?? 'ok';
  const now = opts.now ?? (() => new Date().toISOString());
  const plans = new Map<string, PlannerPlan>();
  const jobs = new Map<string, RoutingJobDto & { polls: number }>();
  const jobKeys = new Map<string, string>();
  const publishKeys = new Map<string, RoutePlanPublishResult>();
  const history = new Map<string, RoutePlanVersionDto[]>();
  const createKeys = new Map<string, { planId: string; hash: string }>();
  let seq = 0;
  const nextId = (p: string) => `${p}-${++seq}`;

  const fail = (status: number, code: string, message: string, body?: unknown): never => {
    throw new MockApiError(status, code, message, body);
  };
  const requireKey = (key: string | undefined) => {
    if (!key || !key.trim()) fail(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Send an Idempotency-Key header');
  };
  const only = (body: object, allowed: string[]) => {
    const extra = Object.keys(body).filter((k) => !allowed.includes(k));
    if (extra.length) fail(400, 'VALIDATION_FAILED', `property ${extra.join(', ')} should not exist`);
  };
  const validWeights = (w: unknown) => {
    const o = w as Record<string, unknown> | null | undefined;
    if (!o || typeof o !== 'object') fail(400, 'VALIDATION_FAILED', 'weights should not be null or undefined');
    const keys = ['vehicle', 'distance', 'time', 'routeDuration'];
    only(o as object, keys);
    const max: Record<string, number> = { vehicle: 1e7, distance: 1e4, time: 1e4, routeDuration: 1e4 };
    for (const k of keys) {
      const v = (o as Record<string, unknown>)[k];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > max[k]) fail(400, 'VALIDATION_FAILED', `weights.${k} must be a number 0..${max[k]}`);
    }
    const n = o as Record<string, number>;
    if (!(n.distance > 0 || n.time > 0 || n.routeDuration > 0)) fail(400, 'VALIDATION_FAILED', 'weights {vehicle, distance, time, routeDuration} are required: numbers >= 0, one of distance / time / routeDuration > 0');
  };
  const get = (id: string) => plans.get(id) ?? fail(404, 'NOT_FOUND', 'Plan not found');
  const editable = (p: PlannerPlan, expected: number) => {
    if (p.status !== 'DRAFT' && p.status !== 'PLANNED') fail(409, 'PLAN_NOT_EDITABLE', 'Plan is not editable');
    if (p.version !== expected) fail(409, 'PLAN_STALE', `Plan is at version ${p.version}`);
  };
  const record = (p: PlannerPlan, changeType: RoutePlanVersionDto['changeType']) => {
    const list = history.get(p.id) ?? [];
    list.unshift({
      version: p.version,
      changeType,
      changedById: 'user-synthetic',
      createdAt: now(),
      snapshot: {
        status: p.status,
        assignments: p.assignments.map((a) => ({ id: a.id, vehicleLabel: a.vehicleLabel, objectId: a.objectId, driverId: a.driverId, stopIds: p.stops.filter((s) => s.assignmentId === a.id).map((s) => s.id) })),
        stops: p.stops.map((s) => ({ id: s.id, ref: s.ref, assignmentId: s.assignmentId, sequence: s.sequence, etaS: s.etaS, unassignedReason: s.unassignedReason })),
      },
    });
    history.set(p.id, list);
  };
  const at = (p: PlannerPlan, s: number | null) => (s === null || !p.planStartAt ? null : new Date(Date.parse(p.planStartAt) + s * 1000).toISOString());

  /** Synthetic engine times (7 min per leg + service) and per-route checks; degraded (null times) with the engine down. */
  const retime = (p: PlannerPlan, routes?: Set<string>): RoutePlanStopViolation[] => {
    const all: RoutePlanStopViolation[] = [];
    for (const a of p.assignments) {
      const stops = p.stops.filter((s) => s.assignmentId === a.id).sort((x, y) => (x.sequence ?? 0) - (y.sequence ?? 0));
      stops.forEach((s, i) => (s.sequence = i));
      const timed = mode === 'ok' && (!routes || routes.has(a.id));
      if (timed) {
        let t = 0;
        for (const s of stops) {
          t += 420;
          s.etaS = t;
          t += s.serviceS;
        }
        Object.assign(a, {
          startS: stops.length ? 0 : null,
          endS: stops.length ? t + 900 : null,
          durationS: stops.length ? t + 900 : null,
          adjustedDurationS: stops.length ? t + 900 : null,
          distanceM: stops.length ? stops.length * 3200 + 6000 : null,
          eta: stops.length ? ENGINE : null,
          geometry: stops.length && stops.every((s) => s.lat !== null) ? { type: 'LineString' as const, coordinates: [...stops.map((s) => [s.lng as number, s.lat as number] as [number, number]), [FIXTURE_SITE.lng, FIXTURE_SITE.lat] as [number, number]] } : null,
        });
      } else if (mode === 'engine-down' && (!routes || routes.has(a.id))) {
        for (const s of stops) s.etaS = null;
        Object.assign(a, { startS: null, endS: null, durationS: null, adjustedDurationS: null, distanceM: null, eta: null, geometry: null });
      }
      for (const s of stops) s.plannedArrival = at(p, s.etaS);
      const load = stops.reduce((n, s) => n + s.seats, 0);
      const v: RoutePlanStopViolation[] = [];
      if (a.capacity !== null && load > a.capacity) for (const s of stops) v.push({ stopId: s.id, ref: s.ref, kind: 'over_capacity', etaS: s.etaS, window: null });
      for (const s of stops) if (a.endS !== null && s.etaS !== null && a.endS - s.etaS > 45 * 60) v.push({ stopId: s.id, ref: s.ref, kind: 'max_ride_exceeded', etaS: s.etaS, window: null });
      Object.assign(a, { violations: v, passengers: stops.length, seats: load });
      all.push(...v);
    }
    for (const s of p.stops) if (!s.assignmentId) Object.assign(s, { etaS: null, plannedArrival: null });
    p.violations = all;
    p.unassigned = p.stops.filter((s) => !s.assignmentId).length;
    return all;
  };
  const edited = (p: PlannerPlan, type: RoutePlanVersionDto['changeType'], routes?: Set<string>): PlanEditResult => {
    const violations = retime(p, routes);
    p.version += 1;
    p.updatedAt = now();
    record(p, type);
    return { plan: clone(p), violations, degraded: mode === 'engine-down' ? 'ENGINE_UNREACHABLE' : null };
  };

  const capabilities = (): RoutingCapabilities => ({
    enabled: true,
    engine: 'graphhopper',
    engineReachable: mode === 'ok',
    engineVersion: mode === 'ok' ? 'synthetic' : null,
    graphVersion: mode === 'ok' ? 'gh-test/synthetic' : null,
    optimizer: true,
    workers: 1,
    etaBands: { short_lt10km: 'uncalibrated', mid_10_40km: 'uncalibrated', long_gt40km: 'uncalibrated' },
    profiles: ['car'],
    limits: { routeLocations: 25, matrixLocations: 50, matrixCells: 2500, asyncMatrixLocations: 200, asyncMatrixCells: 40_000, planStops: 200, optimizeStops: 150, optimizeVehicles: 20, optimizeLocations: 200, optimizeTimeLimitS: 60, concurrentOptimizePerCompany: 2, perUserPerMinute: 60, perCompanyPerDay: 5000 },
    liveTraffic: false,
    attribution: '© OpenStreetMap contributors',
    access: { enabled: true, canView: true, canPlan: true, canEdit: true, canDelete: true, canPublish: true, scope: 'COMPANY', support: false },
  });

  const vehicle = (objectId: string) => FIXTURE_VEHICLES.find((v) => v.objectId === objectId);
  const assignment = (p: PlannerPlan, objectId: string): PlannerAssignment => {
    const v = vehicle(objectId);
    return { id: nextId('asg'), seq: p.assignments.length, vehicleLabel: v?.name ?? objectId, objectId, driverId: null, capacity: v?.seats ?? null, distanceM: null, durationS: null, adjustedDurationS: null, startS: null, endS: null, geometry: null, eta: null, transportTripId: null, locked: false, vehicleName: v?.name ?? null, plateNumber: v?.plateNumber ?? null, driverName: null, passengers: 0, seats: 0, violations: [], plannedTripId: null };
  };

  const create = (body: CreatePlanRequest): PlannerPlan => {
    const id = nextId('plan');
    const t = now();
    const p: PlannerPlan = {
      id, name: body.name, planDate: body.planDate, planStartAt: body.planStartAt ?? null, status: 'DRAFT', profile: body.profile ?? 'car', branchId: body.branchId ?? null,
      graphVersion: null, depot: { lat: FIXTURE_SITE.lat, lng: FIXTURE_SITE.lng }, direction: body.direction ?? null, shiftId: body.shiftId ?? null, sitePoiId: body.sitePoiId ?? null,
      version: 1, publishedAt: null, createdAt: t, updatedAt: t, stops: fixtureStops(id, 10), assignments: [], precise: true, editable: true, violations: [], unassigned: 10,
    };
    for (const o of body.objectIds) p.assignments.push(assignment(p, o));
    plans.set(id, p);
    record(p, 'CREATED');
    return p;
  };

  /** Round-robin within seats; pinned stops and locked routes stay; the hidden-point passenger cannot be routed. */
  const solve = (p: PlannerPlan) => {
    const locked = new Set(p.assignments.filter((a) => a.locked).map((a) => a.id));
    const keep = new Set(p.stops.filter((s) => s.assignmentId && (s.pinned || locked.has(s.assignmentId))).map((s) => s.id));
    for (const s of p.stops) if (!keep.has(s.id)) Object.assign(s, { assignmentId: null, sequence: null, unassignedReason: null });
    const open = p.assignments.filter((a) => !locked.has(a.id));
    const free = new Map(open.map((a) => [a.id, (a.capacity ?? 99) - p.stops.filter((s) => keep.has(s.id) && s.assignmentId === a.id).length]));
    let i = 0;
    for (const s of p.stops) {
      if (keep.has(s.id)) continue;
      if (s.lat === null) {
        s.unassignedReason = 'unreachable_location';
        continue;
      }
      const n = open.length;
      const target = Array.from({ length: n }, (_, k) => open[(i + k) % n]).find((x) => (free.get(x.id) ?? 0) > 0);
      if (!target) {
        s.unassignedReason = 'not_scheduled_capacity_or_time';
        continue;
      }
      s.assignmentId = target.id;
      s.sequence = p.stops.filter((x) => x.assignmentId === target.id).length - 1;
      free.set(target.id, (free.get(target.id) ?? 0) - 1);
      i++;
    }
    p.status = opts.optimisedStatus ?? 'PLANNED';
    p.graphVersion = 'gh-test/synthetic';
    retime(p);
    p.version += 1;
    p.updatedAt = now();
    record(p, 'OPTIMIZED');
  };

  const metrics = (p: PlannerPlan): RoutePlanMetricsDto => {
    const active = p.assignments.filter((a) => p.stops.some((s) => s.assignmentId === a.id));
    const cap = active.every((a) => a.capacity !== null) ? active.reduce((n, a) => n + (a.capacity ?? 0), 0) : 0;
    const seats = active.reduce((n, a) => n + a.seats, 0);
    const timed = active.every((a) => a.distanceM !== null);
    return {
      planId: p.id, name: p.name, planDate: p.planDate, status: p.status, version: p.version, routes: p.assignments.length, activeRoutes: active.length, stops: p.stops.length,
      passengers: p.stops.length, seats, unassigned: p.unassigned,
      distanceM: timed ? active.reduce((n, a) => n + (a.distanceM ?? 0), 0) : null,
      durationS: timed ? active.reduce((n, a) => n + (a.durationS ?? 0), 0) : null,
      seatUtilisation: cap ? seats / cap : null, violations: p.violations.length, graphVersion: p.graphVersion,
    };
  };

  const enqueue = (body: OptimizeJobRequest, key: string): RoutingJobDto => {
      requireKey(key);
      validWeights(body.weights);
      const replay = jobKeys.get(key);
      if (replay) return strip(jobs.get(replay)!);
      if (mode === 'engine-down') fail(503, 'ROUTING_UNAVAILABLE', 'Routing engine unreachable');
      const p = get(body.planId);
      editable(p, body.expectedVersion);
      if (!p.assignments.length) fail(400, 'INVALID_INPUT', 'No vehicles on the plan');
      p.status = 'OPTIMIZING';
      const job: RoutingJobDto & { polls: number } = { jobId: nextId('job'), kind: 'optimize', state: 'queued', phase: null, progress: 0, attempts: 0, maxAttempts: 3, cancelRequested: false, planId: p.id, createdAt: now(), startedAt: null, finishedAt: null, graphVersion: 'gh-test/synthetic', attribution: '© OpenStreetMap contributors', polls: 0 };
      jobs.set(job.jobId, job);
      jobKeys.set(key, job.jobId);
      return strip(job);
  };

  const strip = ({ polls: _p, ...dto }: RoutingJobDto & { polls: number }): RoutingJobDto => clone(dto);

  return {
    setMode: (m) => {
      mode = m;
      for (const p of plans.values()) for (const a of p.assignments) if (a.eta) a.eta = m === 'engine-down' ? LIVE : ENGINE;
    },
    plans: () => [...plans.values()].map(clone),
    bumpVersion: (id) => {
      const p = get(id);
      p.version += 1;
      record(p, 'EDITED');
    },
    capabilities: async () => capabilities(),
    listPlans: async (q) =>
      [...plans.values()]
        .filter((p) => (!q.planDate || p.planDate === q.planDate) && (!q.direction || p.direction === q.direction) && (!q.status || p.status === q.status))
        .map((p): RoutePlanSummaryDto => ({ id: p.id, name: p.name, planDate: p.planDate, status: p.status, direction: p.direction, stops: p.stops.length, assignments: p.assignments.length, unassigned: p.unassigned, version: p.version, updatedAt: p.updatedAt })),
    getPlan: async (id) => clone(get(id)),
    history: async (id) => clone(history.get(id) ?? []),
    compare: async (ids) => {
      if (ids.length < 2 || ids.length > 5) fail(400, 'INVALID_INPUT', 'Compare 2 to 5 plans');
      return { plans: ids.map((id) => metrics(get(id))) };
    },
    createPlan: async (body, key) => {
      requireKey(key);
      only(body, ['name', 'planDate', 'planStartAt', 'profile', 'branchId', 'depot', 'direction', 'shiftId', 'sitePoiId', 'objectIds']);
      if (!body.sitePoiId || !body.direction || !Array.isArray(body.objectIds) || !body.objectIds.length) fail(400, 'VALIDATION_FAILED', 'direction, sitePoiId and objectIds are required');
      const seen = createKeys.get(key);
      if (seen) {
        if (seen.hash !== JSON.stringify(body)) fail(422, 'IDEMPOTENCY_KEY_REUSED', 'Key reused with another body');
        return clone(get(seen.planId));
      }
      const p = create(body);
      createKeys.set(key, { planId: p.id, hash: JSON.stringify(body) });
      return clone(p);
    },
    optimizePlan: async (planId, body, key) => {
      only(body, ['expectedVersion', 'timeLimitS', 'objective', 'weights']);
      return enqueue({ ...body, planId }, key);
    },
    optimize: async (body, key) => {
      only(body, ['planId', 'expectedVersion', 'timeLimitS', 'objective', 'weights']);
      return enqueue(body, key);
    },
    getJob: async (jobId) => {
      const j = jobs.get(jobId) ?? fail(404, 'JOB_NOT_FOUND', 'Job not found');
      if (j.state === 'queued' || j.state === 'running') {
        j.polls += 1;
        if (j.cancelRequested) {
          Object.assign(j, { state: 'cancelled', finishedAt: now(), error: { code: 'CANCELLED', message: 'Cancelled by the user' } });
          const p = plans.get(j.planId ?? '');
          if (p) p.status = 'DRAFT';
        } else if (j.polls >= 4) {
          solve(get(j.planId ?? ''));
          Object.assign(j, { state: 'succeeded', phase: 'done', progress: 100, finishedAt: now() });
        } else {
          Object.assign(j, { state: 'running', attempts: 1, startedAt: j.startedAt ?? now(), phase: (['matrix', 'solve', 'route_legs'] as const)[j.polls - 1], progress: j.polls * 25 });
        }
      }
      return strip(j);
    },
    planJobs: async (planId) => [...jobs.values()].filter((j) => j.planId === planId && (j.state === 'queued' || j.state === 'running')).map(strip),
    cancelJob: async (jobId) => {
      const j = jobs.get(jobId) ?? fail(404, 'JOB_NOT_FOUND', 'Job not found');
      if (j.state === 'queued' || j.state === 'running') j.cancelRequested = true;
      return strip(j);
    },
    movePassenger: async (id, body) => {
      const p = get(id);
      editable(p, body.expectedVersion);
      const group = p.stops.filter((s) => s.bookingId === body.bookingId);
      if (!group.length) fail(404, 'NOT_FOUND', 'Booking not on the plan');
      const touched = new Set<string>();
      for (const s of group) {
        if (s.pinned) fail(409, 'STOP_PINNED', 'Unpin the stop first');
        if (s.assignmentId) {
          if (p.assignments.find((a) => a.id === s.assignmentId)?.locked) fail(409, 'ROUTE_LOCKED', 'Unlock the route first');
          touched.add(s.assignmentId);
        }
      }
      if (body.toAssignmentId) {
        const to = p.assignments.find((a) => a.id === body.toAssignmentId) ?? fail(404, 'NOT_FOUND', 'Route not found');
        if (to.locked) fail(409, 'ROUTE_LOCKED', 'Unlock the route first');
        touched.add(to.id);
        const end = p.stops.filter((s) => s.assignmentId === to.id).length;
        group.forEach((s, k) => Object.assign(s, { assignmentId: to.id, sequence: end + k + 0.5, unassignedReason: null }));
      } else group.forEach((s) => Object.assign(s, { assignmentId: null, sequence: null }));
      return edited(p, 'EDITED', touched);
    },
    resequence: async (id, body) => {
      const p = get(id);
      editable(p, body.expectedVersion);
      const touched = new Set<string>();
      for (const r of body.assignments) {
        const a = p.assignments.find((x) => x.id === r.assignmentId) ?? fail(400, 'INVALID_INPUT', 'Unknown route');
        if (a.locked) fail(409, 'ROUTE_LOCKED', 'Unlock the route first');
        touched.add(a.id);
        for (const s of p.stops) if (s.assignmentId === r.assignmentId && !r.stopIds.includes(s.id)) Object.assign(s, { assignmentId: null, sequence: null });
        r.stopIds.forEach((sid, i) => {
          const s = p.stops.find((x) => x.id === sid) ?? fail(400, 'INVALID_INPUT', 'Unknown stop');
          if (s.pinned && (s.assignmentId !== r.assignmentId || s.sequence !== i)) fail(409, 'STOP_PINNED', 'Unpin the stop first');
          Object.assign(s, { assignmentId: r.assignmentId, sequence: i, unassignedReason: null });
        });
      }
      return edited(p, 'RESEQUENCED', touched);
    },
    updateAssignment: async (id, aid, body) => {
      const p = get(id);
      editable(p, body.expectedVersion);
      const a = p.assignments.find((x) => x.id === aid) ?? fail(404, 'NOT_FOUND', 'Route not found');
      if (body.objectId) {
        const v = vehicle(body.objectId);
        Object.assign(a, { objectId: body.objectId, vehicleLabel: v?.name ?? body.objectId, vehicleName: v?.name ?? null, plateNumber: v?.plateNumber ?? null, capacity: v?.seats ?? null });
      }
      if (body.locked !== undefined) a.locked = body.locked;
      return edited(p, 'EDITED', new Set([a.id]));
    },
    updateStop: async (id, sid, body) => {
      const p = get(id);
      editable(p, body.expectedVersion);
      const s = p.stops.find((x) => x.id === sid) ?? fail(404, 'NOT_FOUND', 'Stop not found');
      s.pinned = body.pinned;
      return edited(p, 'EDITED', new Set());
    },
    publish: async (id, body, key) => {
      requireKey(key);
      only(body, ['expectedVersion', 'idempotencyKey', 'acknowledgedWarnings', 'override']);
      const replay = publishKeys.get(key);
      if (replay) return clone(replay);
      const p = get(id);
      editable(p, body.expectedVersion);
      if (!p.assignments.some((a) => p.stops.some((st) => st.assignmentId === a.id))) fail(409, 'PLAN_NOT_PUBLISHABLE', 'No route has passengers', { code: 'PLAN_NOT_PUBLISHABLE', routes: [] });
      const used = p.assignments.filter((a) => p.stops.some((s) => s.assignmentId === a.id));
      const untimed = used.filter((a) => a.eta === null || a.endS === null);
      if (untimed.length) fail(409, 'PLAN_NOT_PUBLISHABLE', 'Some routes have no times', { code: 'PLAN_NOT_PUBLISHABLE', routes: untimed.map((a) => ({ assignmentId: a.id, vehicleLabel: a.vehicleLabel, code: 'ROUTING_UNAVAILABLE', message: 'Route not timed' })) });
      for (const a of used) Object.assign(a, { transportTripId: nextId('ttrip'), plannedTripId: nextId('ptrip') });
      Object.assign(p, { status: 'PUBLISHED', publishedAt: now(), editable: false });
      p.version += 1;
      record(p, 'PUBLISHED');
      const r: RoutePlanPublishResult = { planId: id, version: p.version, trips: used.map((a) => ({ assignmentId: a.id, transportTripId: a.transportTripId as string, plannedTripId: a.plannedTripId })), changeSetId: nextId('cs'), warnings: [] };
      publishKeys.set(key, r);
      return clone(r);
    },
    discard: async (id, body) => {
      const p = get(id);
      editable(p, body.expectedVersion);
      Object.assign(p, { status: 'CANCELLED', editable: false });
      p.version += 1;
      record(p, 'CANCELLED');
      return clone(p);
    },
  };
}
