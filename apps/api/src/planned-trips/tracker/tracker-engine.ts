import { Logger } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  ackRequiredFor,
  AlertTypeCode,
  PLANNED_TRIP_TIMING,
  PLANNED_TRIPS_INVALIDATE_REASON,
  PlannedStopStatus,
  PlannedTripLiveUpdate,
  PlannedTripStatus,
  RoutePath,
} from '@veetracer/shared';
import type Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { NOTIFY_STREAM_MAXLEN } from '../../alerts/alert-dto';
import { CompanyRules, RulesRepository } from '../../alerts/rules-data';
import { canEmit, PendingAlert, RuleInput, RuleObject } from '../../processor/rules/evaluate';
import { pendingToDto } from '../../processor/rules/rules-engine';
import { RedisKeys } from '../../redis/keys';
import { etmsStopLabel } from '../etms-stop-label';
import {
  emptyObjectTripState,
  ObjectTripState,
  parseObjectTripState,
  PreparedTrip,
  prepareTrip,
  StopRowUpdate,
  TrackerFix,
  trackFix,
  TripEventClose,
  TripEventOpen,
  TripRowUpdate,
} from './evaluate';

const MIN = 60_000;
const STATE_TTL_SEC = 7 * 24 * 3600;
const OPEN_STATUSES: PlannedTripStatus[] = ['SCHEDULED', 'STARTED', 'IN_PROGRESS'];
const ROUTE_TIMEOUT_MS = 1500;

/** Routing engine for the ETA cap (`RoutingService.route`); null / disabled = ETA from distance and speed only. */
export interface EtaRouter {
  readonly enabled: boolean;
  route(from: { lat: number; lng: number }, to: { lat: number; lng: number }): Promise<{ s: number } | null>;
}

type TripRow = Prisma.PlannedTripGetPayload<{ include: { stops: true } }>;

const ms = (d: Date | null): number | null => (d ? d.getTime() : null);

export function toPreparedTrip(row: TripRow): PreparedTrip {
  return prepareTrip({
    id: row.id,
    routeName: row.routeName,
    corridorM: row.corridorM,
    path: Array.isArray(row.path) ? (row.path as unknown as RoutePath) : null,
    plannedStart: row.plannedStart.getTime(),
    plannedEnd: row.plannedEnd.getTime(),
    status: row.status,
    actualStart: ms(row.actualStart),
    deviationCount: row.deviationCount,
    maxDeviationM: row.maxDeviationM,
    distanceKm: row.distanceKm,
    stops: row.stops.map((s) => ({
      seq: s.seq,
      // E3 security review H1: alert messages / data (TRIP_STOP_LATE, TRIP_STOP_SKIPPED, …) never carry a passenger's
      // address label; an ETMS stop that is not a company place is "Stop n".
      name: row.origin === 'ETMS' ? etmsStopLabel(s) : s.name,
      lat: s.lat,
      lng: s.lng,
      radiusM: s.radiusM,
      plannedArrival: s.plannedArrival.getTime(),
      plannedDeparture: s.plannedDeparture.getTime(),
      status: s.status,
      actualArrival: ms(s.actualArrival),
      actualDeparture: ms(s.actualDeparture),
      delaySec: s.delaySec,
    })),
  });
}

interface CacheEntry {
  byObject: Map<string, PreparedTrip[]> | null;
  loadedAt: number;
  loading: Promise<Map<string, PreparedTrip[]>> | null;
  stale: boolean;
}

/**
 * Open trips per company, by vehicle: every STARTED / IN_PROGRESS trip plus the SCHEDULED ones whose candidate window
 * (plannedStart − 60 min … plannedEnd + 120 min) overlaps the next minutes. Invalidated by `vt:rules:invalidate` with
 * reason `planned-trips`; reloaded in the background while the previous snapshot keeps serving, and after `ttlMs`.
 */
export class PlannedTripCache {
  private readonly logger = new Logger('PlannedTripCache');
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    private readonly prisma: PrismaClient,
    private readonly ttlMs = 60_000,
  ) {}

  invalidate(companyId?: string | null): void {
    if (!companyId) {
      for (const e of this.entries.values()) e.stale = true;
      return;
    }
    const e = this.entries.get(companyId);
    if (e) e.stale = true;
  }

  async get(companyId: string): Promise<Map<string, PreparedTrip[]>> {
    let e = this.entries.get(companyId);
    if (!e) {
      e = { byObject: null, loadedAt: 0, loading: null, stale: true };
      this.entries.set(companyId, e);
    }
    if (e.byObject && Date.now() - e.loadedAt > this.ttlMs) e.stale = true;
    if (e.stale && !e.loading) this.reload(companyId, e);
    if (e.byObject) return e.byObject;
    return e.loading!;
  }

  private reload(companyId: string, e: CacheEntry): void {
    e.stale = false;
    e.loading = this.load(companyId)
      .then((map) => {
        e.byObject = map;
        e.loadedAt = Date.now();
        return map;
      })
      .catch((error: Error) => {
        this.logger.error(`Planned trips of ${companyId} not loaded: ${error.message}`);
        e.stale = true;
        return e.byObject ?? new Map<string, PreparedTrip[]>();
      })
      .finally(() => {
        e.loading = null;
      });
  }

  private async load(companyId: string): Promise<Map<string, PreparedTrip[]>> {
    const now = Date.now();
    // Margin over the TTL so a trip becomes a candidate before its window opens.
    const startBy = new Date(now + (PLANNED_TRIP_TIMING.candidateBeforeMin + 10) * MIN);
    const endAfter = new Date(now - PLANNED_TRIP_TIMING.incompleteAfterMin * MIN);
    const rows = await this.prisma.plannedTrip.findMany({
      where: {
        companyId,
        OR: [{ status: { in: ['STARTED', 'IN_PROGRESS'] } }, { status: 'SCHEDULED', plannedStart: { lte: startBy }, plannedEnd: { gte: endAfter } }],
      },
      include: { stops: { orderBy: { seq: 'asc' } } },
    });
    const map = new Map<string, PreparedTrip[]>();
    for (const row of rows) {
      if (row.stops.length < 2) continue;
      const list = map.get(row.objectId) ?? [];
      list.push(toPreparedTrip(row));
      map.set(row.objectId, list);
    }
    return map;
  }
}

interface CreatedAlert extends PendingAlert {
  object: RuleObject;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const date = (v: number | undefined | null) => (v === undefined ? undefined : v === null ? null : new Date(v));

/** DB data of a merged trip update (epoch ms → Date). */
function tripData(u: TripRowUpdate): Prisma.PlannedTripUpdateManyMutationInput {
  const out: Prisma.PlannedTripUpdateManyMutationInput = {};
  if (u.status !== undefined) out.status = u.status;
  if (u.actualStart !== undefined) out.actualStart = new Date(u.actualStart);
  if (u.actualEnd !== undefined) out.actualEnd = new Date(u.actualEnd);
  if (u.closedBy !== undefined) out.closedBy = u.closedBy;
  if (u.nextStopSeq !== undefined) out.nextStopSeq = u.nextStopSeq;
  if (u.etaNextStop !== undefined) out.etaNextStop = date(u.etaNextStop);
  if (u.delaySec !== undefined) out.delaySec = u.delaySec;
  if (u.deviationCount !== undefined) out.deviationCount = u.deviationCount;
  if (u.maxDeviationM !== undefined) out.maxDeviationM = u.maxDeviationM;
  if (u.distanceKm !== undefined) out.distanceKm = u.distanceKm;
  return out;
}

function stopData(u: StopRowUpdate): Prisma.PlannedTripStopUpdateManyMutationInput {
  const out: Prisma.PlannedTripStopUpdateManyMutationInput = { status: u.status as PlannedStopStatus };
  if (u.actualArrival !== undefined) out.actualArrival = new Date(u.actualArrival);
  if (u.actualDeparture !== undefined) out.actualDeparture = new Date(u.actualDeparture);
  if (u.delaySec !== undefined) out.delaySec = u.delaySec;
  return out;
}

/** One processor batch's trip changes: statements for the batch transaction, then `commit()` after it succeeded. */
export class PlannedTripBatch {
  constructor(
    private readonly redis: Redis,
    private readonly prisma: PrismaClient,
    readonly alerts: CreatedAlert[],
    readonly trips: Map<string, TripRowUpdate>,
    readonly stops: Map<string, StopRowUpdate>,
    readonly eventOpens: TripEventOpen[],
    readonly eventCloses: TripEventClose[],
    readonly live: Map<string, { companyId: string; objectId: string; update: PlannedTripLiveUpdate }>,
    readonly statusChangedCompanies: Set<string>,
    private readonly states: Map<string, string>,
    private readonly onStatusChanged: (companyId: string) => void,
  ) {}

  /** Order matters: stops (guarded by the trip still being open) before the trip update that may close it. */
  statements(): Prisma.PrismaPromise<unknown>[] {
    const p = this.prisma;
    const out: Prisma.PrismaPromise<unknown>[] = [];
    if (this.alerts.length) {
      out.push(
        p.alert.createMany({
          data: this.alerts.map((a) => ({
            id: a.id,
            companyId: a.object.companyId,
            objectId: a.object.objectId,
            deviceId: a.object.deviceId,
            type: a.type,
            severity: a.severity,
            message: a.message,
            lat: a.lat,
            lng: a.lng,
            data: a.data as Prisma.InputJsonObject,
            occurredAt: new Date(a.occurredAt),
            ackRequired: a.ackRequired,
          })),
        }),
      );
    }
    for (const s of this.stops.values()) {
      out.push(p.plannedTripStop.updateMany({ where: { tripId: s.tripId, seq: s.seq, trip: { status: { in: OPEN_STATUSES } } }, data: stopData(s) }));
    }
    if (this.eventOpens.length) {
      out.push(
        p.plannedTripEvent.createMany({
          data: this.eventOpens.map((e) => ({ id: e.id, tripId: e.tripId, kind: e.kind, startAt: new Date(e.startAt), lat: e.lat, lng: e.lng })),
        }),
      );
    }
    for (const e of this.eventCloses) out.push(p.plannedTripEvent.updateMany({ where: { id: e.id }, data: { endAt: new Date(e.endAt), data: e.data } }));
    for (const [id, u] of this.trips) out.push(p.plannedTrip.updateMany({ where: { id, status: { in: OPEN_STATUSES } }, data: tripData(u) }));
    return out;
  }

  /** Persist tracker state, publish alerts (+ notification jobs) and `plannedTrip.update` pushes, refresh trip caches. */
  async commit(): Promise<void> {
    if (!this.states.size && !this.alerts.length && !this.live.size && !this.statusChangedCompanies.size) return;
    const pipeline = this.redis.pipeline();
    for (const [objectId, json] of this.states) pipeline.set(RedisKeys.plannedTripState(objectId), json, 'EX', STATE_TTL_SEC);
    for (const alert of this.alerts) {
      pipeline.publish(RedisKeys.alertsChannel, JSON.stringify({ companyId: alert.object.companyId, alert: pendingToDto(alert) }));
      pipeline.xadd(RedisKeys.notifyStream, 'MAXLEN', '~', NOTIFY_STREAM_MAXLEN, '*', 'alertId', alert.id, 'companyId', alert.object.companyId);
    }
    for (const msg of this.live.values()) pipeline.publish(RedisKeys.plannedTripUpdates, JSON.stringify(msg));
    for (const companyId of this.statusChangedCompanies) {
      this.onStatusChanged(companyId);
      pipeline.publish(RedisKeys.rulesInvalidate, JSON.stringify({ companyId, reason: PLANNED_TRIPS_INVALIDATE_REASON, at: Date.now() }));
    }
    const results = await pipeline.exec();
    const failed = results?.find(([error]) => error);
    if (failed?.[0]) throw failed[0];
  }
}

/**
 * Planned-trip live tracking in the processor (SPEC §4.3), next to the alert rules and on the same inputs: valid,
 * live (non-late) fixes of vehicles not in maintenance. Per-object state in `vt:ptrip:<objectId>` (MGET at batch
 * start, SET on commit); decisions in the pure `trackFix`; alerts gated by the company's Alert Settings like the rules.
 */
export class PlannedTripTracker {
  constructor(
    private readonly redis: Redis,
    private readonly prisma: PrismaClient,
    private readonly rules: RulesRepository,
    readonly cache: PlannedTripCache = new PlannedTripCache(prisma),
    private readonly router: EtaRouter | null = null,
  ) {}

  invalidate(companyId?: string | null): void {
    this.cache.invalidate(companyId);
  }

  async evaluate(inputs: RuleInput[]): Promise<PlannedTripBatch | null> {
    const usable = inputs.filter((i) => i.locationValid !== false && !i.healthOnly && !i.alarmsOnly && Number.isFinite(i.lat) && Number.isFinite(i.lng));
    if (!usable.length) return null;
    const companyIds = [...new Set(usable.map((i) => i.object.companyId))];
    const maps = await Promise.all(companyIds.map((id) => this.cache.get(id)));
    const tripsByObject = new Map<string, PreparedTrip[]>();
    companyIds.forEach((companyId, i) => {
      for (const input of usable) {
        if (input.object.companyId !== companyId) continue;
        const list = maps[i].get(input.object.objectId);
        if (list?.length) tripsByObject.set(input.object.objectId, list);
      }
    });
    const relevant = usable.filter((i) => tripsByObject.has(i.object.objectId));
    if (!relevant.length) return null;

    const objectIds = [...tripsByObject.keys()];
    const relevantCompanies = [...new Set(relevant.map((i) => i.object.companyId))];
    const [raw, rulesList] = await Promise.all([this.redis.mget(...objectIds.map(RedisKeys.plannedTripState)), Promise.all(relevantCompanies.map((id) => this.rules.get(id)))]);
    const rulesByCompany = new Map<string, CompanyRules>(relevantCompanies.map((id, i) => [id, rulesList[i]]));
    const original = new Map<string, string | null>();
    const states = new Map<string, ObjectTripState>();
    objectIds.forEach((id, i) => {
      original.set(id, raw[i]);
      states.set(id, parseObjectTripState(raw[i]) ?? emptyObjectTripState());
    });
    const routeEtas = await this.routeEtas(relevant, tripsByObject, states);

    const alerts: CreatedAlert[] = [];
    const trips = new Map<string, TripRowUpdate>();
    const stops = new Map<string, StopRowUpdate>();
    const eventOpens: TripEventOpen[] = [];
    const eventCloses: TripEventClose[] = [];
    const live = new Map<string, { companyId: string; objectId: string; update: PlannedTripLiveUpdate }>();
    const statusChangedCompanies = new Set<string>();

    for (const input of relevant) {
      const { objectId, companyId } = input.object;
      const rules = rulesByCompany.get(companyId)!;
      const settings = rules.effective(objectId);
      const fix: TrackerFix = { t: input.fixTime, lat: input.lat, lng: input.lng, speedKph: input.speedKph };
      const { state, effects } = trackFix(tripsByObject.get(objectId)!, states.get(objectId)!, fix, {
        lateMin: num(settings.get('TRIP_STOP_LATE')?.params.lateMin) ?? 10,
        deviationAlertM: num(settings.get('ROUTE_DEVIATION')?.params.minDistanceM),
        routeEta: routeEtas.get(objectId) ?? null,
        newId: randomUUID,
      });
      states.set(objectId, state);

      for (const a of effects.alerts) {
        const setting = settings.get(a.type as AlertTypeCode);
        if (!canEmit(setting, { gf: {}, cd: state.cd }, a.cooldownKey, a.at, rules.timezone)) continue;
        state.cd[a.cooldownKey] = a.at;
        alerts.push({
          id: randomUUID(),
          type: a.type,
          severity: setting.severity,
          ackRequired: ackRequiredFor(setting, a.type, setting.severity),
          message: a.message,
          occurredAt: a.at,
          lat: a.lat,
          lng: a.lng,
          geofenceId: null,
          geofenceName: null,
          data: { speedKph: Math.round(input.speedKph), ...a.data },
          object: input.object,
        });
      }
      for (const t of effects.trips) trips.set(t.id, { ...trips.get(t.id), ...t.data });
      for (const s of effects.stops) {
        const key = `${s.tripId}:${s.seq}`;
        stops.set(key, { ...stops.get(key), ...s });
      }
      eventOpens.push(...effects.eventOpens);
      eventCloses.push(...effects.eventCloses);
      for (const u of effects.live) {
        const prev = live.get(u.id)?.update;
        live.set(u.id, { companyId, objectId, update: { ...prev, ...u, ...(u.stops || prev?.stops ? { stops: u.stops ?? prev?.stops } : {}) } });
      }
      if (effects.statusChanged) statusChangedCompanies.add(companyId);
    }

    const changed = new Map<string, string>();
    for (const [id, state] of states) {
      const json = JSON.stringify(state);
      if (json !== original.get(id)) changed.set(id, json);
    }
    return new PlannedTripBatch(this.redis, this.prisma, alerts, trips, stops, eventOpens, eventCloses, live, statusChangedCompanies, changed, (companyId) =>
      this.cache.invalidate(companyId),
    );
  }

  /**
   * Road travel time to the next stop for trips whose ETA is due (at most once a minute per trip), from the last fix of
   * the vehicle in this batch. Only with a routing engine; a slow or failing engine just means no cap.
   */
  private async routeEtas(
    inputs: RuleInput[],
    tripsByObject: Map<string, PreparedTrip[]>,
    states: Map<string, ObjectTripState>,
  ): Promise<Map<string, { tripId: string; seq: number; sec: number }>> {
    const out = new Map<string, { tripId: string; seq: number; sec: number }>();
    if (!this.router?.enabled) return out;
    const lastFix = new Map<string, RuleInput>();
    for (const i of inputs) lastFix.set(i.object.objectId, i);
    const jobs: Promise<void>[] = [];
    for (const [objectId, input] of lastFix) {
      const ts = states.get(objectId)?.trip;
      if (!ts || (ts.status !== 'STARTED' && ts.status !== 'IN_PROGRESS')) continue;
      if (ts.eta && input.fixTime - ts.eta.t < 60_000) continue;
      const trip = tripsByObject.get(objectId)?.find((t) => t.id === ts.id);
      if (!trip) continue;
      let reached = -1;
      ts.stops.forEach((s, i) => {
        if (s.s !== 'PENDING') reached = i;
      });
      const next = trip.stops[reached + 1];
      if (!next) continue;
      const router = this.router;
      jobs.push(
        Promise.race([
          router.route({ lat: input.lat, lng: input.lng }, { lat: next.lat, lng: next.lng }).catch(() => null),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), ROUTE_TIMEOUT_MS).unref()),
        ]).then((r) => {
          if (r && Number.isFinite(r.s)) out.set(objectId, { tripId: trip.id, seq: next.seq, sec: r.s });
        }),
      );
    }
    await Promise.all(jobs);
    return out;
  }
}
