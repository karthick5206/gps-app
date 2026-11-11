import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { ROUTING_CONSENT_PURPOSE, TRANSPORT_E3_LIMITS, currentConsents, type GeoPoint, type TransportDirection, type TransportScheduleOverride } from '@veetracer/shared';
import { randomUUID } from 'node:crypto';
import { companyFeatures } from '../../common/company-features';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { latestConsents } from '../people/people.service';
import { etmsServerEnabled } from '../transport-feature.guard';
import { cutoffMinutes, dateOnly, dayKeyOf, validPoint } from './e3-common';
import { legWindow, scheduleOccurrences, type LegWindow, type ShiftTiming } from './service-dates';

export const BOOKING_GENERATOR_LOCK_KEY = 'vt:etms:bookings:generator:lock';
const RELEASE_LOCK = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;
const H = 3_600_000;

/** statusReason values the generator / schedule commands write, so they can tell their own cancellations apart. */
export const SKIPPED_REASON = 'Skipped (schedule exception)';
export const SCHEDULE_CHANGED_REASON = 'Schedule changed';
export const SCHEDULE_ARCHIVED_REASON = 'Schedule archived';
export const EXPIRED_REASON = 'Window passed without a seat';

/** Statuses the generator / schedule edits may still rewrite (not seated yet). */
export const UNSEATED_STATUSES = ['REQUESTED', 'PENDING_ASSIGNMENT', 'WAITLISTED'] as const;

export interface PickupInfo {
  consent: boolean;
  /** Default stop (preferred, like E2 pickupOf) or home point; null when neither exists. */
  home: GeoPoint | null;
}

interface ScheduleForGen {
  id: string;
  companyId: string;
  profileId: string;
  shiftId: string;
  direction: TransportDirection;
  days: number[];
  pickupMode: 'HOME' | 'STOP';
  validFrom: Date;
  validTo: Date | null;
  stopPoi: { id: string; name: string; lat: number; lng: number } | null;
  shift: ShiftTiming & { id: string; sitePoi: { id: string; name: string; lat: number; lng: number } | null };
}

/** Pickup / drop of one leg (pure): IN = home or stop → site, OUT = site → home or stop. No point without consent. */
export function legPoints(s: Pick<ScheduleForGen, 'direction' | 'pickupMode' | 'stopPoi' | 'shift'>, info: PickupInfo | undefined, override?: GeoPoint | null): { pickup: GeoPoint | null; drop: GeoPoint | null } {
  const site = s.shift.sitePoi ? { lat: s.shift.sitePoi.lat, lng: s.shift.sitePoi.lng, label: s.shift.sitePoi.name, poiId: s.shift.sitePoi.id } : null;
  let passenger: GeoPoint | null = null;
  if (info?.consent) {
    if (override && validPoint(override)) passenger = { lat: override.lat, lng: override.lng, label: override.label ?? null, poiId: override.poiId ?? null };
    else if (s.pickupMode === 'STOP') passenger = s.stopPoi ? { lat: s.stopPoi.lat, lng: s.stopPoi.lng, label: s.stopPoi.name, poiId: s.stopPoi.id } : null;
    else passenger = info.home;
  }
  return s.direction === 'IN' ? { pickup: passenger, drop: site } : { pickup: site, drop: passenger };
}

/** Override JSON of an exception, defensively parsed. */
export function overrideOf(json: Prisma.JsonValue | null | undefined): TransportScheduleOverride | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;
  const o = json as Record<string, unknown>;
  const out: TransportScheduleOverride = {};
  if (typeof o.timeMin === 'number' && Number.isInteger(o.timeMin) && o.timeMin >= 0 && o.timeMin < 1440) out.timeMin = o.timeMin;
  const p = o.pickup as Record<string, unknown> | undefined;
  if (p && validPoint(p as { lat?: unknown; lng?: unknown })) out.pickup = { lat: p.lat as number, lng: p.lng as number, label: typeof p.label === 'string' ? p.label : null, poiId: null };
  return out;
}

/** Booking columns of one generated leg (pure). */
export function bookingData(s: ScheduleForGen, serviceDate: string, window: LegWindow, points: { pickup: GeoPoint | null; drop: GeoPoint | null }, cutoffMin: number): Prisma.TransportBookingCreateManyInput {
  return {
    id: randomUUID(),
    customerCompanyId: s.companyId,
    profileId: s.profileId,
    scheduleId: s.id,
    shiftId: s.shiftId,
    source: 'SCHEDULE',
    serviceDate: dateOnly(serviceDate),
    direction: s.direction,
    timeZone: s.shift.timeZone,
    pickupLabel: points.pickup?.label ?? null,
    pickupLat: points.pickup?.lat ?? null,
    pickupLng: points.pickup?.lng ?? null,
    pickupPoiId: points.pickup?.poiId ?? null,
    dropLabel: points.drop?.label ?? null,
    dropLat: points.drop?.lat ?? null,
    dropLng: points.drop?.lng ?? null,
    dropPoiId: points.drop?.poiId ?? null,
    windowStart: new Date(window.start),
    windowEnd: new Date(window.end),
    status: 'PENDING_ASSIGNMENT',
    cutoffAt: new Date(window.start - cutoffMin * 60_000),
  };
}

export interface GenerateResult {
  created: number;
  skippedByException: number;
}

/**
 * Booking generator + expiry sweep (12 WP 3.2, 05 §2.5): every 15 minutes in the API process, one instance at a time
 * (Valkey SET NX lock, like the planned-trip generator). Kill switches: ETMS=off, ETMS_BOOKING_JOB=off.
 *  1. Generate: for every active schedule (active shift and passenger, company ACTIVE with the `etms` add-on) the
 *     legs whose window starts in the next 72 h, in the shift's time zone (overnight, DST). Idempotent: unique
 *     (scheduleId, serviceDate, direction) + `INSERT … ON CONFLICT DO NOTHING` (createMany skipDuplicates), which also
 *     skips a leg when the passenger already has another active booking that day (partial unique index).
 *     Pickup points need an active TRANSPORT_PROFILE consent; without it the booking is created "needs location".
 *  2. Expire: REQUESTED / PENDING_ASSIGNMENT / WAITLISTED bookings whose window ended → EXPIRED.
 */
@Injectable()
export class BookingGeneratorService {
  private readonly logger = new Logger('EtmsBookingGenerator');
  private readonly instance = randomUUID();
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  get enabled(): boolean {
    return etmsServerEnabled() && (process.env.ETMS_BOOKING_JOB ?? 'on').toLowerCase() !== 'off';
  }

  @Interval(TRANSPORT_E3_LIMITS.generatorTickMin * 60_000)
  async tick(): Promise<void> {
    if (!this.enabled || this.running) return;
    this.running = true;
    let locked = false;
    try {
      locked = (await this.redis.client.set(BOOKING_GENERATOR_LOCK_KEY, this.instance, 'PX', 10 * 60_000, 'NX')) === 'OK';
      if (!locked) return;
      const now = Date.now();
      const g = await this.generate(now);
      const expired = await this.expire(now);
      if (g.created || expired) this.logger.log(`Bookings generated ${g.created}, expired ${expired}`);
    } catch (error) {
      this.logger.error(`Booking generator failed: ${(error as Error).message}`);
    } finally {
      if (locked) await this.redis.client.eval(RELEASE_LOCK, 1, BOOKING_GENERATOR_LOCK_KEY, this.instance).catch(() => undefined);
      this.running = false;
    }
  }

  /** Active schedules (optionally some only) with what generation needs. */
  async loadSchedules(where: Prisma.TransportScheduleWhereInput): Promise<ScheduleForGen[]> {
    const rows = await this.prisma.transportSchedule.findMany({
      where: { isActive: true, shift: { isActive: true }, profile: { isActive: true }, ...where },
      select: {
        id: true,
        companyId: true,
        profileId: true,
        shiftId: true,
        direction: true,
        days: true,
        pickupMode: true,
        validFrom: true,
        validTo: true,
        stopPoi: { select: { id: true, name: true, lat: true, lng: true } },
        shift: { select: { id: true, startMin: true, endMin: true, overnight: true, days: true, timeZone: true, isActive: true, sitePoi: { select: { id: true, name: true, lat: true, lng: true } } } },
        profile: { select: { isActive: true } },
      },
    });
    // The services re-check what an in-memory store may not evaluate (relation filters).
    return rows.filter((r) => r.shift?.isActive !== false && r.profile?.isActive !== false) as unknown as ScheduleForGen[];
  }

  /** Consent + default stop / home point per passenger (one query each). */
  async pickupInfo(profileIds: string[]): Promise<Map<string, PickupInfo>> {
    const out = new Map<string, PickupInfo>();
    if (!profileIds.length) return out;
    const [rows, consents] = await Promise.all([
      this.prisma.employeeTransportProfile.findMany({
        where: { id: { in: profileIds } },
        select: { id: true, homeLat: true, homeLng: true, defaultStop: { select: { id: true, name: true, lat: true, lng: true } } },
      }),
      latestConsents(this.prisma, profileIds),
    ]);
    for (const r of rows) {
      const consent = currentConsents(consents.get(r.id) ?? []).find((c) => c.purpose === ROUTING_CONSENT_PURPOSE)?.active ?? false;
      const home: GeoPoint | null = r.defaultStop
        ? { lat: r.defaultStop.lat, lng: r.defaultStop.lng, label: r.defaultStop.name, poiId: r.defaultStop.id }
        : r.homeLat !== null && r.homeLng !== null
          ? { lat: r.homeLat, lng: r.homeLng, label: null, poiId: null }
          : null;
      out.set(r.id, { consent, home });
    }
    return out;
  }

  /** Companies allowed to generate now (ACTIVE, `etms` add-on on) with their cut-off. */
  private async companies(ids: string[]): Promise<Map<string, { cutoffMin: number }>> {
    const rows = await this.prisma.company.findMany({ where: { id: { in: ids } }, select: { id: true, status: true, settings: true, isPlatform: true } });
    const out = new Map<string, { cutoffMin: number }>();
    for (const c of rows) {
      if (c.status !== 'ACTIVE' || !companyFeatures(c).includes('etms')) continue;
      out.set(c.id, { cutoffMin: cutoffMinutes(c.settings, TRANSPORT_E3_LIMITS.defaultCutoffMin) });
    }
    return out;
  }

  /**
   * Plans the legs of [fromMs, toMs) without writing: rows to insert and how many dates exceptions skipped. Shared by
   * generate() and the schedules preview.
   */
  async plan(schedules: ScheduleForGen[], fromMs: number, toMs: number): Promise<{ rows: Prisma.TransportBookingCreateManyInput[]; skippedByException: number }> {
    if (!schedules.length) return { rows: [], skippedByException: 0 };
    const companies = await this.companies([...new Set(schedules.map((s) => s.companyId))]);
    const live = schedules.filter((s) => companies.has(s.companyId));
    if (!live.length) return { rows: [], skippedByException: 0 };
    const [info, exceptions] = await Promise.all([
      this.pickupInfo([...new Set(live.map((s) => s.profileId))]),
      this.prisma.transportScheduleException.findMany({
        where: { scheduleId: { in: live.map((s) => s.id) }, date: { gte: dateOnly(dayKeyOf(new Date(fromMs - 2 * 24 * H))), lte: dateOnly(dayKeyOf(new Date(toMs + 2 * 24 * H))) } },
        select: { scheduleId: true, date: true, kind: true, override: true },
      }),
    ]);
    const exByKey = new Map(exceptions.map((e) => [`${e.scheduleId}|${dayKeyOf(e.date)}`, e]));
    const rows: Prisma.TransportBookingCreateManyInput[] = [];
    let skippedByException = 0;
    for (const s of live) {
      const cutoffMin = companies.get(s.companyId)!.cutoffMin;
      for (const occ of scheduleOccurrences(s, s.shift, fromMs, toMs)) {
        const ex = exByKey.get(`${s.id}|${occ.serviceDate}`);
        if (ex?.kind === 'SKIP') {
          skippedByException++;
          continue;
        }
        const ov = ex?.kind === 'OVERRIDE' ? overrideOf(ex.override) : null;
        const window = ov?.timeMin !== undefined ? legWindow(s.shift, s.direction, occ.serviceDate, ov.timeMin) : occ.window;
        rows.push(bookingData(s, occ.serviceDate, window, legPoints(s, info.get(s.profileId), ov?.pickup ?? null), cutoffMin));
      }
    }
    return { rows, skippedByException };
  }

  /**
   * Creates the missing bookings of the next 72 h (window start ≥ now). `scheduleIds` limits it (called right after a
   * schedule is saved). Idempotent: running it twice creates nothing the second time.
   */
  async generate(now: number, scheduleIds?: string[]): Promise<GenerateResult> {
    if (!this.enabled) return { created: 0, skippedByException: 0 };
    const schedules = await this.loadSchedules(scheduleIds ? { id: { in: scheduleIds } } : {});
    const { rows, skippedByException } = await this.plan(schedules, now, now + TRANSPORT_E3_LIMITS.generatorHorizonHours * H);
    let created = 0;
    for (let i = 0; i < rows.length; i += 500) {
      created += (await this.prisma.transportBooking.createMany({ data: rows.slice(i, i + 500), skipDuplicates: true })).count;
    }
    return { created, skippedByException };
  }

  /** Unseated bookings whose window has ended → EXPIRED. */
  async expire(now: number): Promise<number> {
    const r = await this.prisma.transportBooking.updateMany({
      where: { status: { in: [...UNSEATED_STATUSES] }, windowEnd: { lt: new Date(now) } },
      data: { status: 'EXPIRED', statusReason: EXPIRED_REASON, version: { increment: 1 } },
    });
    return r.count;
  }

  /**
   * After a schedule / exception change: future unseated bookings of the schedule are re-timed / re-pointed to the
   * current pattern, cancelled when their date no longer occurs (reason `SCHEDULE_CHANGED_REASON` / `SKIPPED_REASON`),
   * and bookings this code cancelled come back when their date occurs again. Seated bookings are never touched (the
   * dispatcher moves those). Then the missing dates are generated. Returns counts.
   */
  async resync(scheduleId: string, now: number, db: Prisma.TransactionClient | PrismaService = this.prisma): Promise<{ updated: number; cancelled: number; restored: number; seated: number }> {
    const counts = { updated: 0, cancelled: 0, restored: 0, seated: 0 };
    const [schedule] = await this.loadSchedules({ id: scheduleId });
    const bookings = await db.transportBooking.findMany({
      where: { scheduleId, windowStart: { gt: new Date(now) } },
      select: { id: true, status: true, statusReason: true, serviceDate: true, profileId: true, windowStart: true, version: true },
    });
    if (!bookings.length) return counts;
    const planned = schedule ? (await this.plan([schedule], now - 2 * 24 * H, now + 40 * 24 * H)).rows : [];
    const byDate = new Map(planned.map((r) => [dayKeyOf(r.serviceDate as Date), r]));
    for (const b of bookings) {
      const want = byDate.get(dayKeyOf(b.serviceDate));
      const unseated = (UNSEATED_STATUSES as readonly string[]).includes(b.status);
      if (!unseated && b.status !== 'CANCELLED') {
        counts.seated += b.status === 'ASSIGNED' || b.status === 'CONFIRMED' ? 1 : 0;
        continue;
      }
      if (unseated && !want) {
        counts.cancelled += (await db.transportBooking.updateMany({ where: { id: b.id, version: b.version }, data: { status: 'CANCELLED', statusReason: SCHEDULE_CHANGED_REASON, version: { increment: 1 } } })).count;
        continue;
      }
      if (!want) continue;
      const data = {
        windowStart: want.windowStart,
        windowEnd: want.windowEnd,
        cutoffAt: want.cutoffAt,
        timeZone: want.timeZone,
        shiftId: want.shiftId,
        pickupLabel: want.pickupLabel,
        pickupLat: want.pickupLat,
        pickupLng: want.pickupLng,
        pickupPoiId: want.pickupPoiId,
        dropLabel: want.dropLabel,
        dropLat: want.dropLat,
        dropLng: want.dropLng,
        dropPoiId: want.dropPoiId,
      };
      if (unseated) {
        counts.updated += (await db.transportBooking.updateMany({ where: { id: b.id, version: b.version }, data: { ...data, version: { increment: 1 } } })).count;
      } else if (b.statusReason === SKIPPED_REASON || b.statusReason === SCHEDULE_CHANGED_REASON) {
        // A date this code cancelled occurs again: bring the booking back (unless the passenger booked otherwise meanwhile).
        try {
          counts.restored += (
            await db.transportBooking.updateMany({ where: { id: b.id, version: b.version, status: 'CANCELLED' }, data: { ...data, status: 'PENDING_ASSIGNMENT', statusReason: null, version: { increment: 1 } } })
          ).count;
        } catch (e) {
          if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
        }
      }
    }
    return counts;
  }
}
