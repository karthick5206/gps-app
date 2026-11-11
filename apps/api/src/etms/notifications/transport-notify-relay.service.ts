import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { TRANSPORT_NOTIFY_TIMING as T, passengerPushAllowed, type TransportNotificationKind } from '@veetracer/shared';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisKeys } from '../../redis/keys';
import { RedisService } from '../../redis/redis.service';
import { etmsServerEnabled } from '../transport-feature.guard';
import { TransportNotificationsService, type NotifyItem } from './transport-notifications.service';

export const TRANSPORT_NOTIFY_LOCK_KEY = 'vt:etms:notify:lock';
/**
 * Security review L3: persisted high-water mark (epoch ms of TransportTripEvent.receivedAt) up to which trip events are
 * processed, and the state of the last completed pass ({ at, hwm, full }) read by System Health (relay lag).
 */
export const TRANSPORT_NOTIFY_HWM_KEY = RedisKeys.etmsNotifyHwm;
export const TRANSPORT_NOTIFY_STATE_KEY = RedisKeys.etmsNotifyState;
export interface RelayState {
  /** Epoch ms of the last completed pass. */
  at: number;
  /** High-water mark after it (epoch ms). */
  hwm: number;
  /** The pass hit the per-pass event limit (a backlog remains). */
  full: boolean;
}
const RELEASE_LOCK = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";
const MIN = 60_000;
/**
 * Trip events the relay turns into notifications, and how far back it looks at most (security review L3: from the
 * persisted high-water mark, never further back than 24 h; dedupe keys make re-reading harmless).
 */
export const RELAY_KINDS = ['PUBLISHED', 'DRIVER_CHANGED', 'PASSENGER_ADDED', 'PASSENGER_REMOVED', 'VEHICLE_CHANGED', 'STOP_ADDED', 'CANCELLED', 'REPORT_DELAY'] as const;
const CHANGE_KINDS = new Set(['PASSENGER_ADDED', 'PASSENGER_REMOVED', 'VEHICLE_CHANGED', 'STOP_ADDED']);
export const RELAY_LOOKBACK_MS = 24 * 60 * MIN;
/** A transaction may commit after a later one: events up to this much older than the mark are read again. */
export const RELAY_OVERLAP_MS = 5 * MIN;
export const RELAY_EVENTS_PER_PASS = 2000;
const OPEN = ['SCHEDULED', 'STARTED', 'IN_PROGRESS'] as const;

/** The change set an event belongs to (data.changeSetId since QA B1), else its receipt time in ms (older rows). */
function changeGroup(e: { data: unknown; receivedAt: Date }): string {
  const id = (e.data as { changeSetId?: unknown } | null)?.changeSetId;
  return typeof id === 'string' && id ? `cs:${id}` : String(e.receivedAt.getTime());
}

const TRIP_INCLUDE = {
  plannedTrip: { select: { id: true, companyId: true, driverId: true, status: true, nextStopSeq: true, etaNextStop: true, delaySec: true, plannedStart: true, stops: { select: { seq: true, plannedArrival: true } } } },
  passengers: {
    select: {
      id: true,
      status: true,
      pickupSeq: true,
      customerCompanyId: true,
      cancelReason: true,
      booking: { select: { profile: { select: { userId: true, isActive: true, companyId: true, preferences: true } } } },
    },
  },
} satisfies Prisma.TransportTripInclude;
type TripRow = Prisma.TransportTripGetPayload<{ include: typeof TRIP_INCLUDE }>;
type PaxRow = TripRow['passengers'][number];
type DriverRow = { id: string; userId: string | null; isActive: boolean; companyId: string };

/**
 * Durable producer of the operational transport notifications (05 §5.4; R1 scope), every 30 s in the API process, one
 * instance at a time (Valkey SET NX lock). Sources are rows already committed in PostgreSQL, so nothing is lost when a
 * process dies between a write and its notification; every notification has a unique dedupeKey, so re-runs never
 * duplicate:
 *  - trip events since the persisted high-water mark (at most 24 h back): dispatch change sets, cancellations, driver
 *    delay reports;
 *    driver ← TRIP_ASSIGNED (published to / reassigned to them), TRIP_UNASSIGNED (reassigned away), TRIP_CHANGED
 *    (passengers / stops / vehicle changed by a later change set), TRIP_CANCELLED; passengers ← TRIP_CANCELLED (their
 *    seat was cancelled with the trip), TRIP_DELAYED (driver REPORT_DELAY, still waiting for pickup, trip under way or
 *    pickup within 60 min; at most one per trip, passenger and 15 min);
 *  - live trip state: TRIP_STARTING_SOON (pickup planned in ≤ 30 min), VEHICLE_APPROACHING (tracker ETA to the
 *    passenger's stop ≤ 5 min, it being the next stop), TRIP_DELAYED (tracker delay ≥ 10 min, once per trip).
 * Kill switches: ETMS=off, ETMS_NOTIFY_JOB=off.
 */
@Injectable()
export class TransportNotifyRelayService {
  private readonly logger = new Logger('EtmsNotifyRelay');
  private readonly instance = randomUUID();
  private running = false;
  /** High-water mark computed by the last fromEvents, stored once its notifications are written. */
  private nextHwm: { hwm: number; full: boolean } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly notifications: TransportNotificationsService,
  ) {}

  get enabled(): boolean {
    return etmsServerEnabled() && (process.env.ETMS_NOTIFY_JOB ?? 'on').toLowerCase() !== 'off';
  }

  @Interval(30_000)
  async tick(): Promise<void> {
    if (!this.enabled || this.running) return;
    this.running = true;
    let locked = false;
    try {
      locked = (await this.redis.client.set(TRANSPORT_NOTIFY_LOCK_KEY, this.instance, 'PX', 5 * MIN, 'NX')) === 'OK';
      if (!locked) return;
      const n = await this.run(Date.now());
      if (n) this.logger.log(`Transport notifications created: ${n}`);
    } catch (error) {
      this.logger.error(`Transport notification relay failed: ${(error as Error).message}`);
    } finally {
      if (locked) await this.redis.client.eval(RELEASE_LOCK, 1, TRANSPORT_NOTIFY_LOCK_KEY, this.instance).catch(() => undefined);
      this.running = false;
    }
  }

  /** One pass (also called by tests). Returns the number of notifications created. */
  async run(now: number): Promise<number> {
    this.nextHwm = null;
    const items = [...(await this.fromEvents(now)), ...(await this.fromLiveState(now))];
    const created = (await this.notifications.notify(items)).length;
    // L3: only after the notifications are committed: a failed pass is read again next time.
    const next = this.nextHwm as { hwm: number; full: boolean } | null;
    if (next) {
      const state: RelayState = { at: now, hwm: next.hwm, full: next.full };
      await this.redis.client.set(TRANSPORT_NOTIFY_HWM_KEY, String(next.hwm)).catch(() => undefined);
      await this.redis.client.set(TRANSPORT_NOTIFY_STATE_KEY, JSON.stringify(state)).catch(() => undefined);
    }
    return created;
  }

  /** The stored high-water mark, or null (none yet, Valkey flushed or unreachable: the 24 h look-back applies). */
  private async storedHwm(): Promise<number | null> {
    const raw = await this.redis.client.get(TRANSPORT_NOTIFY_HWM_KEY).catch(() => null);
    const n = raw === null || raw === undefined ? NaN : Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  // ───────────────────────────── Trip events ─────────────────────────────

  async fromEvents(now: number): Promise<NotifyItem[]> {
    const hwm = await this.storedHwm();
    const from = Math.max(now - RELAY_LOOKBACK_MS, hwm ?? 0);
    const events = await this.prisma.transportTripEvent.findMany({
      where: { receivedAt: { gte: new Date(from) }, outcome: 'ACCEPTED', kind: { in: [...RELAY_KINDS] } },
      orderBy: { receivedAt: 'asc' },
      take: RELAY_EVENTS_PER_PASS,
      select: { id: true, tripId: true, kind: true, source: true, data: true, receivedAt: true },
    });
    // A full page continues from its last event next time; otherwise everything up to now was read (minus the overlap
    // for transactions still committing).
    const full = events.length >= RELAY_EVENTS_PER_PASS;
    this.nextHwm = { hwm: full ? events[events.length - 1]!.receivedAt.getTime() : Math.max(from, now - RELAY_OVERLAP_MS), full };
    if (!events.length) return [];
    const trips = await this.trips({ id: { in: [...new Set(events.map((e) => e.tripId))] } });
    const driverIds = new Set<string>();
    for (const t of trips.values()) if (t.plannedTrip?.driverId) driverIds.add(t.plannedTrip.driverId);
    for (const e of events) {
      const d = (e.data ?? {}) as { from?: unknown; to?: unknown; driverId?: unknown };
      for (const v of [d.from, d.to, d.driverId]) if (typeof v === 'string') driverIds.add(v);
    }
    const drivers = await this.drivers([...driverIds]);
    // When the trip's CURRENT driver got it (published / reassigned to them), and in which change set. Changes of that
    // change set and older ones are covered by their TRIP_ASSIGNED (QA B1: rows of one change set carry its id in
    // data.changeSetId; their receivedAt differs by a few ms, so receivedAt is only the fallback for older rows).
    const assignedAt = new Map<string, number>();
    const assignedIn = new Set<string>();
    for (const e of events) {
      const cur = trips.get(e.tripId)?.plannedTrip?.driverId;
      const d = (e.data ?? {}) as { to?: unknown; driverId?: unknown };
      if (cur && ((e.kind === 'PUBLISHED' && d.driverId === cur) || (e.kind === 'DRIVER_CHANGED' && d.to === cur))) {
        assignedAt.set(e.tripId, Math.max(assignedAt.get(e.tripId) ?? 0, e.receivedAt.getTime()));
        assignedIn.add(`${e.tripId}|${changeGroup(e)}`);
      }
    }
    const out: NotifyItem[] = [];
    for (const e of events) {
      const t = trips.get(e.tripId);
      if (!t?.plannedTrip) continue;
      const pt = t.plannedTrip;
      const open = (OPEN as readonly string[]).includes(pt.status) && !!t.publishedAt && !t.cancelledAt;
      const data = (e.data ?? {}) as { from?: unknown; to?: unknown; driverId?: unknown };
      const current = pt.driverId ? drivers.get(pt.driverId) : undefined;
      switch (e.kind) {
        case 'PUBLISHED': {
          if (open && current && current.id === data.driverId) out.push(...this.driverItem(t, current, 'TRIP_ASSIGNED', `asg:${e.id}`));
          break;
        }
        case 'DRIVER_CHANGED': {
          const from = typeof data.from === 'string' ? drivers.get(data.from) : undefined;
          const to = typeof data.to === 'string' ? drivers.get(data.to) : undefined;
          if (from && from.id !== pt.driverId) out.push(...this.driverItem(t, from, 'TRIP_UNASSIGNED', `unasg:${e.id}`));
          if (open && to && to.id === pt.driverId) out.push(...this.driverItem(t, to, 'TRIP_ASSIGNED', `asg:${e.id}`));
          break;
        }
        case 'CANCELLED': {
          if (current) out.push(...this.driverItem(t, current, 'TRIP_CANCELLED', `cxl:${e.id}`));
          for (const p of t.passengers) if (p.status === 'CANCELLED' && (p.cancelReason ?? '').startsWith('Trip cancelled')) out.push(...this.paxItem(p, t, 'TRIP_CANCELLED', `cxl:${e.id}`));
          break;
        }
        case 'REPORT_DELAY': {
          // Security review M2: only while the trip is under way or the pickup is near, and at most one per trip,
          // passenger and delayBucketMin window (bucket of the report's receipt, so a re-read never re-notifies).
          if (!open || e.source !== 'DRIVER_APP') break;
          const underWay = pt.status === 'STARTED' || pt.status === 'IN_PROGRESS';
          const bucket = Math.floor(e.receivedAt.getTime() / (T.delayBucketMin * MIN));
          for (const p of t.passengers) {
            if (p.status !== 'PENDING') continue;
            const pickupAt = (pt.stops.find((s) => s.seq === p.pickupSeq)?.plannedArrival ?? pt.plannedStart).getTime();
            if (!underWay && pickupAt - e.receivedAt.getTime() > T.delayReportPrePickupMin * MIN) continue;
            out.push(...this.paxItem(p, t, 'TRIP_DELAYED', `delay:${t.id}:${bucket}`));
          }
          break;
        }
        default:
          // One TRIP_CHANGED per trip and change set; none for the change set that assigned the trip to this driver.
          if (CHANGE_KINDS.has(e.kind) && open && current && e.receivedAt.getTime() > (assignedAt.get(e.tripId) ?? 0) && !assignedIn.has(`${e.tripId}|${changeGroup(e)}`)) {
            out.push(...this.driverItem(t, current, 'TRIP_CHANGED', `chg:${e.tripId}:${changeGroup(e)}`));
          }
      }
    }
    return out;
  }

  // ───────────────────────────── Live trip state ─────────────────────────────

  async fromLiveState(now: number): Promise<NotifyItem[]> {
    const out: NotifyItem[] = [];
    // TRIP_STARTING_SOON: the passenger's pickup stop is planned within the next 30 minutes, and the trip has not started
    // yet (QA B8: once under way the passenger gets VEHICLE_APPROACHING instead; closed trips get nothing).
    const soon = await this.prisma.plannedTripStop.findMany({
      where: { plannedArrival: { gte: new Date(now), lte: new Date(now + T.startingSoonMin * MIN) }, trip: { origin: 'ETMS', status: 'SCHEDULED' } },
      select: { tripId: true, seq: true },
      take: 2000,
    });
    if (soon.length) {
      const trips = await this.trips({ plannedTripId: { in: [...new Set(soon.map((s) => s.tripId))] } });
      for (const t of trips.values()) {
        if (!t.plannedTrip || !t.publishedAt || t.cancelledAt || t.plannedTrip.status !== 'SCHEDULED') continue;
        const seqs = new Set(soon.filter((s) => s.tripId === t.plannedTrip!.id).map((s) => s.seq));
        for (const p of t.passengers) if (p.status === 'PENDING' && seqs.has(p.pickupSeq)) out.push(...this.paxItem(p, t, 'TRIP_STARTING_SOON', `soon:${p.id}`));
      }
    }
    // VEHICLE_APPROACHING / TRIP_DELAYED from the v1.8 tracker's live fields (nextStopSeq, etaNextStop, delaySec).
    const running = await this.prisma.plannedTrip.findMany({
      where: {
        origin: 'ETMS',
        status: { in: ['STARTED', 'IN_PROGRESS'] },
        OR: [{ nextStopSeq: { not: null }, etaNextStop: { gte: new Date(now - 10 * MIN), lte: new Date(now + T.approachingMin * MIN) } }, { delaySec: { gte: T.delayedMin * 60 } }],
      },
      select: { id: true },
      take: 2000,
    });
    if (running.length) {
      const trips = await this.trips({ plannedTripId: { in: running.map((r) => r.id) } });
      for (const t of trips.values()) {
        const pt = t.plannedTrip;
        if (!pt || t.cancelledAt || (pt.status !== 'STARTED' && pt.status !== 'IN_PROGRESS')) continue;
        const etaMs = pt.etaNextStop?.getTime() ?? null;
        const approaching = pt.nextStopSeq !== null && etaMs !== null && etaMs <= now + T.approachingMin * MIN && etaMs >= now - 10 * MIN;
        const delayed = (pt.delaySec ?? 0) >= T.delayedMin * 60;
        for (const p of t.passengers) {
          if (p.status !== 'PENDING') continue;
          if (approaching && p.pickupSeq === pt.nextStopSeq) out.push(...this.paxItem(p, t, 'VEHICLE_APPROACHING', `appr:${p.id}`));
          if (delayed) out.push(...this.paxItem(p, t, 'TRIP_DELAYED', `delay:auto:${t.id}`));
        }
      }
    }
    return out;
  }

  // ───────────────────────────── Recipients ─────────────────────────────

  /** The driver's own login, only for an active driver of the operating company. Always pushed (operational). */
  private driverItem(t: TripRow, d: DriverRow, kind: TransportNotificationKind, key: string): NotifyItem[] {
    if (!d.userId || !d.isActive || d.companyId !== t.providerCompanyId) return [];
    return [{ companyId: d.companyId, userId: d.userId, audience: 'DRIVER', kind, tripId: t.id, dedupeKey: `${key}:${d.userId}`, push: true }];
  }

  /** The passenger's own login (active profile of the customer company). Push only if their preferences allow it. */
  private paxItem(p: PaxRow, t: TripRow, kind: TransportNotificationKind, key: string): NotifyItem[] {
    const prof = p.booking?.profile;
    if (!prof?.userId || !prof.isActive || prof.companyId !== p.customerCompanyId) return [];
    return [{ companyId: p.customerCompanyId, userId: prof.userId, audience: 'PASSENGER', kind, tripId: t.id, dedupeKey: `${key}:${prof.userId}`, push: passengerPushAllowed(prof.preferences, kind) }];
  }

  private async trips(where: Prisma.TransportTripWhereInput): Promise<Map<string, TripRow>> {
    const rows = await this.prisma.transportTrip.findMany({ where, include: TRIP_INCLUDE });
    return new Map(rows.map((r) => [r.id, r]));
  }

  private async drivers(ids: string[]): Promise<Map<string, DriverRow>> {
    if (!ids.length) return new Map();
    const rows = await this.prisma.driver.findMany({ where: { id: { in: ids } }, select: { id: true, userId: true, isActive: true, companyId: true } });
    return new Map(rows.map((r) => [r.id, r]));
  }
}
