/**
 * In-memory stand-in for the routing / plans API (synthetic data only), used by the unit tests and — in a dev build
 * only — by the planner when `localStorage['vt.plannerMock']` is `1` (or `engine-down`), so the screens can be
 * exercised before E4-E / E4-F land. Never bundled in production: the planner imports it behind
 * `import.meta.env.DEV`. No React, DOM or path aliases (runs under `node --test`).
 *
 * `engine-down` mode: capabilities say the engine is unreachable, optimise fails with ROUTING_UNAVAILABLE, and stored
 * plans carry `live_heuristic` ETA models — which the planner must never show (doc 17 P10 gate).
 */
import type {
  CreateRoutePlanRequest,
  EtaModel,
  PublishRoutePlanResult,
  RoutePlanAssignmentDto,
  RoutePlanStopViolation,
  RoutePlanSummaryDto,
  RoutePlanVersionDto,
  RoutingCapabilities,
  RoutingJobDto,
} from '@veetracer/shared';
import type { PlannerClient } from './planner-api';
import type { PlanEditResult, PlannerPlan, PlannerStop } from './planner-format';

export class MockApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export type MockMode = 'ok' | 'engine-down';

const ENGINE: EtaModel = { source: 'engine_free_flow', calibrated: false, liveTraffic: false, graphVersion: 'gh-test/synthetic', band: null, factor: 1, factorSource: null };
const LIVE: EtaModel = { source: 'live_heuristic', calibrated: false, liveTraffic: false, graphVersion: null, band: null, factor: 1, factorSource: null };

/** Synthetic site and passenger points (a made-up grid; no real people or addresses). */
export const FIXTURE_SITE = { id: 'poi-site-1', name: 'Synthetic Tech Park', lat: 12.9, lng: 80.2 };
export const FIXTURE_VEHICLES = [
  { objectId: 'veh-1', name: 'Van 01', plateNumber: 'TN00AA0001', seats: 4 },
  { objectId: 'veh-2', name: 'Van 02', plateNumber: 'TN00AA0002', seats: 4 },
  { objectId: 'veh-3', name: 'Car 03', plateNumber: 'TN00AA0003', seats: 3 },
];

function fixtureStops(planId: string, n: number): PlannerStop[] {
  return Array.from({ length: n }, (_, i) => {
    const hidden = i === 4; // one passenger whose routing consent is not active: no point sent
    return {
      id: `${planId}-s${i + 1}`,
      ref: `P${String(i + 1).padStart(3, '0')}`,
      name: null,
      lat: hidden ? Number.NaN : 12.95 + (i % 4) * 0.012,
      lng: hidden ? Number.NaN : 80.15 + Math.floor(i / 4) * 0.015,
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
      pointHidden: hidden || undefined,
      passengerName: `Passenger ${i + 1}`,
      pinned: false,
    };
  });
}

function summary(p: PlannerPlan): RoutePlanSummaryDto {
  return {
    id: p.id,
    name: p.name,
    planDate: p.planDate,
    status: p.status,
    direction: p.direction,
    stops: p.stops.length,
    assignments: p.assignments.length,
    unassigned: p.stops.filter((s) => !s.assignmentId).length,
    version: p.version,
    updatedAt: p.updatedAt,
  };
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'number' && Number.isNaN(x) ? '__NaN' : x)), (_k, x) => (x === '__NaN' ? Number.NaN : x)) as T;

export interface MockPlanner extends PlannerClient {
  /** Simulates another user's edit (the next edit with the old version gets PLAN_STALE). */
  bumpVersion(planId: string): void;
  setMode(mode: MockMode): void;
  plans(): PlannerPlan[];
}

export function createMockPlannerClient(opts: { mode?: MockMode; now?: () => string; seed?: boolean } = {}): MockPlanner {
  let mode: MockMode = opts.mode ?? 'ok';
  const now = opts.now ?? (() => new Date().toISOString());
  const plans = new Map<string, PlannerPlan>();
  const jobs = new Map<string, RoutingJobDto & { polls: number }>();
  const history = new Map<string, RoutePlanVersionDto[]>();
  let seq = 0;
  const nextId = (p: string) => `${p}-${++seq}`;

  const fail = (status: number, code: string, message: string): never => {
    throw new MockApiError(status, code, message);
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

  /** Recomputes synthetic engine times (7 min per leg + service) and the re-validation of every route. */
  const retime = (p: PlannerPlan): RoutePlanStopViolation[] => {
    const violations: RoutePlanStopViolation[] = [];
    for (const a of p.assignments) {
      const stops = p.stops.filter((s) => s.assignmentId === a.id).sort((x, y) => (x.sequence ?? 0) - (y.sequence ?? 0));
      let t = 0;
      stops.forEach((s, i) => {
        s.sequence = i;
        t += 420;
        s.etaS = t;
        t += s.serviceS;
      });
      const eta = mode === 'engine-down' ? LIVE : ENGINE;
      Object.assign(a, {
        startS: stops.length ? 0 : null,
        endS: stops.length ? t + 900 : null,
        durationS: stops.length ? t + 900 : null,
        adjustedDurationS: stops.length ? t + 900 : null,
        distanceM: stops.length ? stops.length * 3200 + 6000 : null,
        eta: stops.length ? eta : null,
        geometry: stops.length
          ? { type: 'LineString' as const, coordinates: [...stops.filter((s) => Number.isFinite(s.lat)).map((s) => [s.lng, s.lat] as [number, number]), [FIXTURE_SITE.lng, FIXTURE_SITE.lat] as [number, number]] }
          : null,
      });
      const load = stops.reduce((n, s) => n + s.demand, 0);
      if (a.capacity !== null && load > a.capacity) for (const s of stops) violations.push({ stopId: s.id, ref: s.ref, kind: 'over_capacity', etaS: s.etaS, window: null });
      for (const s of stops) if (a.endS !== null && s.etaS !== null && a.endS - s.etaS > 45 * 60) violations.push({ stopId: s.id, ref: s.ref, kind: 'max_ride_exceeded', etaS: s.etaS, window: null });
    }
    for (const s of p.stops) if (!s.assignmentId) s.etaS = null;
    p.violations = violations;
    return violations;
  };
  const edited = (p: PlannerPlan, type: RoutePlanVersionDto['changeType']): PlanEditResult => {
    const violations = retime(p);
    p.version += 1;
    p.updatedAt = now();
    record(p, type);
    return { plan: clone(p), violations };
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

  const create = (body: CreateRoutePlanRequest): PlannerPlan => {
    const id = nextId('plan');
    const at = now();
    const p: PlannerPlan = {
      id,
      name: body.name,
      planDate: body.planDate,
      planStartAt: body.planStartAt ?? null,
      status: 'DRAFT',
      profile: body.profile ?? 'car',
      branchId: body.branchId ?? null,
      graphVersion: null,
      depot: { lat: FIXTURE_SITE.lat, lng: FIXTURE_SITE.lng },
      direction: body.direction ?? null,
      shiftId: body.shiftId ?? null,
      sitePoiId: body.sitePoiId ?? null,
      version: 1,
      publishedAt: null,
      createdAt: at,
      updatedAt: at,
      stops: fixtureStops(id, 10),
      assignments: [],
      violations: [],
    };
    plans.set(id, p);
    record(p, 'CREATED');
    return p;
  };

  /** Round-robin seats within capacity; the hidden-point passenger cannot be routed (no point) and one is left over. */
  const solve = (p: PlannerPlan) => {
    const pinned = new Set(p.stops.filter((s) => s.pinned && s.assignmentId).map((s) => s.id));
    for (const s of p.stops) if (!pinned.has(s.id)) Object.assign(s, { assignmentId: null, sequence: null, unassignedReason: null });
    const free = new Map(p.assignments.map((a) => [a.id, (a.capacity ?? 99) - p.stops.filter((s) => pinned.has(s.id) && s.assignmentId === a.id).length]));
    let i = 0;
    for (const s of p.stops) {
      if (pinned.has(s.id)) continue;
      if (!Number.isFinite(s.lat)) {
        s.unassignedReason = 'unreachable_location';
        continue;
      }
      const n = p.assignments.length;
      const target = Array.from({ length: n }, (_, k) => p.assignments[(i + k) % n]).find((x) => (free.get(x.id) ?? 0) > 0);
      if (!target) {
        s.unassignedReason = 'not_scheduled_capacity_or_time';
        continue;
      }
      s.assignmentId = target.id;
      s.sequence = p.stops.filter((x) => x.assignmentId === target.id).length - 1;
      free.set(target.id, (free.get(target.id) ?? 0) - 1);
      i++;
    }
    p.status = 'PLANNED';
    p.graphVersion = 'gh-test/synthetic';
    retime(p);
    p.version += 1;
    p.updatedAt = now();
    record(p, 'OPTIMIZED');
  };

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
        .map(summary),
    getPlan: async (id) => clone(get(id)),
    history: async (id) => clone(history.get(id) ?? []),
    createPlan: async (body) => clone(create(body)),
    addAssignment: async (id, body) => {
      const p = get(id);
      editable(p, body.expectedVersion);
      const a: RoutePlanAssignmentDto = { id: nextId('asg'), seq: p.assignments.length, vehicleLabel: body.vehicleLabel, objectId: body.objectId, driverId: null, capacity: body.capacity, distanceM: null, durationS: null, adjustedDurationS: null, startS: null, endS: null, geometry: null, eta: null, transportTripId: null };
      p.assignments.push(a);
      p.version += 1;
      return clone(p);
    },
    optimize: async (id, body) => {
      if (mode === 'engine-down') fail(503, 'ROUTING_UNAVAILABLE', 'Routing engine unreachable');
      const p = get(id);
      editable(p, body.expectedVersion);
      if (!p.assignments.length) fail(400, 'INVALID_INPUT', 'No vehicles on the plan');
      p.status = 'OPTIMIZING';
      const job: RoutingJobDto & { polls: number } = { jobId: nextId('job'), kind: 'optimize', state: 'queued', phase: null, progress: 0, attempts: 0, maxAttempts: 3, cancelRequested: false, planId: id, createdAt: now(), startedAt: null, finishedAt: null, graphVersion: 'gh-test/synthetic', attribution: '© OpenStreetMap contributors', polls: 0 };
      jobs.set(job.jobId, job);
      p.lastJobId = job.jobId;
      const { polls: _p, ...dto } = job;
      return clone(dto);
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
          const p = get(j.planId ?? '');
          solve(p);
          Object.assign(j, { state: 'succeeded', phase: 'done', progress: 100, finishedAt: now() });
        } else {
          Object.assign(j, { state: 'running', attempts: 1, startedAt: j.startedAt ?? now(), phase: (['matrix', 'solve', 'route_legs'] as const)[j.polls - 1], progress: j.polls * 25 });
        }
      }
      const { polls: _p, ...dto } = j;
      return clone(dto);
    },
    cancelJob: async (jobId) => {
      const j = jobs.get(jobId) ?? fail(404, 'JOB_NOT_FOUND', 'Job not found');
      if (j.state === 'queued' || j.state === 'running') j.cancelRequested = true;
      const { polls: _p, ...dto } = j;
      return clone(dto);
    },
    resequence: async (id, body) => {
      const p = get(id);
      editable(p, body.expectedVersion);
      for (const r of body.assignments) {
        if (!p.assignments.some((a) => a.id === r.assignmentId)) fail(400, 'INVALID_INPUT', 'Unknown route');
        for (const s of p.stops) if (s.assignmentId === r.assignmentId && !r.stopIds.includes(s.id)) Object.assign(s, { assignmentId: null, sequence: null });
        r.stopIds.forEach((sid, i) => {
          const s = p.stops.find((x) => x.id === sid) ?? fail(400, 'INVALID_INPUT', 'Unknown stop');
          Object.assign(s, { assignmentId: r.assignmentId, sequence: i, unassignedReason: null });
        });
      }
      return edited(p, 'RESEQUENCED');
    },
    changeVehicle: async (id, aid, body) => {
      const p = get(id);
      editable(p, body.expectedVersion);
      const a = p.assignments.find((x) => x.id === aid) ?? fail(404, 'NOT_FOUND', 'Route not found');
      Object.assign(a, { objectId: body.objectId, vehicleLabel: body.vehicleLabel, capacity: body.capacity });
      return edited(p, 'EDITED');
    },
    pinStop: async (id, sid, body) => {
      const p = get(id);
      editable(p, body.expectedVersion);
      const s = p.stops.find((x) => x.id === sid) ?? fail(404, 'NOT_FOUND', 'Stop not found');
      s.pinned = body.pinned;
      return edited(p, 'EDITED');
    },
    publish: async (id, body): Promise<PublishRoutePlanResult> => {
      const p = get(id);
      editable(p, body.expectedVersion);
      if (!body.idempotencyKey) fail(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Missing key');
      const used = p.assignments.filter((a) => p.stops.some((s) => s.assignmentId === a.id));
      for (const a of used) a.transportTripId = nextId('ttrip');
      p.status = 'PUBLISHED';
      p.publishedAt = now();
      p.version += 1;
      record(p, 'PUBLISHED');
      return { planId: id, version: p.version, trips: used.map((a) => ({ assignmentId: a.id, transportTripId: a.transportTripId as string, plannedTripId: nextId('ptrip') })), changeSetId: nextId('cs') };
    },
    discard: async (id, body) => {
      const p = get(id);
      editable(p, body.expectedVersion);
      p.status = 'CANCELLED';
      p.version += 1;
      record(p, 'CANCELLED');
      return clone(p);
    },
  };
}
