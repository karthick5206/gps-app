import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  SELF_BOOKING_DISABLED,
  TRANSPORT_E3_LIMITS,
  TRANSPORT_SELF_LIMITS as L,
  confirmMismatch,
  selfBookingApprovalOn,
  transportSettingsOf,
  type GeoPoint,
  type MeAdhocEndRef,
  type MeBookingDto,
  type MeCommuteDto,
  type MePlaceDto,
  type MeRequestPlaceDto,
  type MeTransportPolicyDto,
  type MeTripConfirmResult,
  type MeTripReportResult,
  type TransportPassengerStatus,
} from '@veetracer/shared';
import { randomUUID } from 'crypto';
import { AuthContext } from '../../access/auth-context';
import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { addDays } from '../../summarizer/tz';
import { BookingsService } from '../dispatch/bookings.service';
import { conflict, cutoffMinutes, dateOnly, dayKeyOf, idempotencyReused, invalid, notFound, serviceDate, validPoint } from '../dispatch/e3-common';
import { MeTransportService, vehicleWindow } from '../dispatch/me-transport.service';
import { legWindow, todayIn, weekdayOf } from '../dispatch/service-dates';
import { recordTripEvent, seenClientEvent } from '../dispatch/trip-ops';
import { activeRoutingConsents, PeopleService } from '../people/people.service';
import { notEligible } from '../dispatch/booking-rules';
import type { MeAdhocRequestDto, MeCreateBookingDto, MePlaceDto as MePlaceBody, MePlaceUpdateDto, MeTripConfirmDto, MeTripReportDto } from './self-service.dto';

const MIN = 60_000;
/**
 * Whether passenger self-service is switched on for the company (`Company.settings.etms.selfBooking`, default off).
 * Exported for tests and for the isolation matrix.
 */
export const selfBookingOn = (settings: unknown): boolean => transportSettingsOf(settings).selfBooking === true;

/** D-A5: the status a passenger's own booking / request starts in (company `etms.selfBookingApproval`, default on). */
export const approvalStatus = (settings: unknown): 'REQUESTED' | 'PENDING_ASSIGNMENT' => (selfBookingApprovalOn(settings) ? 'REQUESTED' : 'PENDING_ASSIGNMENT');

interface StoredPlace {
  id: string;
  label: string;
  lat: number;
  lng: number;
  createdAt: string;
}

/** The saved places stored on a profile (`preferences.places`); malformed entries are skipped. */
export function placesOf(preferences: unknown): StoredPlace[] {
  const p = preferences && typeof preferences === 'object' && !Array.isArray(preferences) ? (preferences as Record<string, unknown>).places : undefined;
  if (!Array.isArray(p)) return [];
  return p.filter(
    (x): x is StoredPlace =>
      !!x && typeof x === 'object' && typeof (x as StoredPlace).id === 'string' && typeof (x as StoredPlace).label === 'string' && validPoint(x as StoredPlace) && typeof (x as StoredPlace).createdAt === 'string',
  );
}

const placeDto = (p: StoredPlace, consent: boolean): MePlaceDto => ({ id: p.id, label: p.label, lat: consent ? p.lat : null, lng: consent ? p.lng : null, createdAt: p.createdAt });

/**
 * WP 3.9 wave 2: 409 like every other CONSENT_REQUIRED of the booking rules (D-A3; was 403 in E5). The apps key on the
 * code, not the status (apps/mobile self-service.ts selfErrorText).
 */
const consentRequired = () => new ConflictException({ message: 'Allow the use of your location for transport (Privacy) to use a personal place', code: 'CONSENT_REQUIRED' });

/** Categories of company places a passenger may pick in an ad-hoc request (plus shift sites and their own stops). */
export const REQUEST_PLACE_CATEGORIES = ['OFFICE', 'SHUTTLE_STOP'] as const;

/**
 * Passenger self-service (E5 WP 5.3; doc 05 §2.8, doc 08 §4.2). Every method works on the caller's own active passenger
 * profile only (PeopleService.myProfileRow: 403 NOT_A_PASSENGER) and, except `policy`, only while the company setting
 * `etms.selfBooking` is on (404 SELF_BOOKING_DISABLED). Booking reuses the E3 BookingsService.create (idempotency,
 * rate limit, duplicate index, consent-gated home pickup / "needs location", audit), with self-service limits on top:
 * an active shift that runs that day, one seat, at most TRANSPORT_SELF_LIMITS.maxDaysAhead days ahead and never after
 * the company cut-off (409 AFTER_CUTOFF).
 */
@Injectable()
export class SelfServiceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly people: PeopleService,
    private readonly bookings: BookingsService,
    private readonly me: MeTransportService,
  ) {}

  // ───────────────────────────── policy ─────────────────────────────

  async policy(ctx: AuthContext): Promise<MeTransportPolicyDto> {
    const profile = await this.people.myProfileRow(ctx);
    const company = await this.company(ctx);
    const on = selfBookingOn(company.settings);
    const consent = (await activeRoutingConsents(this.prisma, [profile.id])).has(profile.id);
    const base: MeTransportPolicyDto = {
      selfBooking: on,
      cutoffMin: cutoffMinutes(company.settings, TRANSPORT_E3_LIMITS.defaultCutoffMin),
      maxDaysAhead: L.maxDaysAhead,
      shifts: [],
      stops: [],
      routingConsent: consent,
      // WP 5.4 durable SOS (POST /me/transport/sos) is on this server; ETMS SOS is never gated by selfBooking.
      sos: true,
      deskPhone: transportSettingsOf(company.settings).deskPhone ?? null,
      // WP 3.9 wave 2 (D-A5 / D-A7): ad-hoc requests come with self-service; approval follows the company setting.
      timeZone: company.timezone,
      adhocRequests: on,
      approvalRequired: selfBookingApprovalOn(company.settings),
    };
    if (!on) return base;
    const shifts = await this.prisma.transportShift.findMany({ where: { companyId: ctx.companyId, isActive: true }, include: { sitePoi: { select: { id: true, name: true } } }, orderBy: [{ startMin: 'asc' }], take: 100 });
    const stops = await this.allowedStops(ctx, profile.id, profile.defaultStopPoiId);
    return {
      ...base,
      shifts: shifts.filter((s) => s.companyId === ctx.companyId).map((s) => ({ id: s.id, name: s.name, siteName: s.sitePoi?.name ?? null, startMin: s.startMin, endMin: s.endMin, overnight: s.overnight, days: [...s.days].sort(), timeZone: s.timeZone })),
      stops: [...stops.values()].map((p) => ({ id: p.id, name: p.name })),
    };
  }

  // ───────────────────────────── booking ─────────────────────────────

  async createBooking(ctx: AuthContext, dto: MeCreateBookingDto, rawKey: string | undefined): Promise<{ value: MeBookingDto; replay: boolean }> {
    const profile = await this.people.myProfileRow(ctx);
    const company = await this.requireOn(ctx);
    const day = serviceDate(dto.serviceDate);
    const shift = await this.prisma.transportShift.findFirst({ where: { id: dto.shiftId, companyId: ctx.companyId, isActive: true } });
    if (!shift || shift.companyId !== ctx.companyId) throw invalid('Unknown or archived shift');
    const today = todayIn(shift.timeZone);
    if (day < today) throw invalid('The service date is in the past');
    if (day > addDays(today, L.maxDaysAhead)) throw invalid(`Book at most ${L.maxDaysAhead} days ahead`);
    if (!shift.days.includes(weekdayOf(day))) throw invalid('The shift does not run on that day');
    const w = legWindow(shift, dto.direction, day);
    const cutoffAt = w.start - cutoffMinutes(company.settings, TRANSPORT_E3_LIMITS.defaultCutoffMin) * MIN;
    if (Date.now() >= cutoffAt) throw conflict('AFTER_CUTOFF', 'The booking cut-off for this trip has passed; contact the transport desk');

    // The passenger's end of the leg; the company end defaults to the shift's site inside BookingsService.create.
    let point: GeoPoint | undefined;
    if (dto.place.kind === 'SAVED') {
      if (!(await this.consent(profile.id))) throw consentRequired();
      const saved = placesOf(profile.preferences).find((p) => p.id === (dto.place as { placeId: string }).placeId);
      if (!saved) throw invalid('Unknown saved place');
      point = { lat: saved.lat, lng: saved.lng, label: saved.label, poiId: null };
    } else if (dto.place.kind === 'STOP') {
      const stops = await this.allowedStops(ctx, profile.id, profile.defaultStopPoiId);
      const stop = stops.get(dto.place.poiId);
      if (!stop) throw invalid('Choose one of your transport stops');
      point = { lat: stop.lat, lng: stop.lng, label: stop.name, poiId: stop.id };
    }
    // HOME: no point, so create() takes the routing pickup only with an active consent, else the booking is made
    // "needs location" (the E3 rule, unchanged).

    // Own profile, own company: the passenger's branch scope does not apply to their own booking (the profile is
    // fixed to the caller's own, so no other row can be reached through this context).
    const selfCtx: AuthContext = { ...ctx, dataScope: 'COMPANY', branchIds: [], agreements: [] };
    const res = await this.bookings.create(
      selfCtx,
      {
        passengerId: profile.id,
        serviceDate: day,
        direction: dto.direction,
        shiftId: shift.id,
        ...(point ? (dto.direction === 'IN' ? { pickup: point } : { drop: point }) : {}),
        passengerCount: 1,
        note: dto.note?.trim() ? `Booked by passenger: ${dto.note.trim().slice(0, L.bookingNoteMax)}` : 'Booked by passenger',
      },
      rawKey,
      // WP 3.9: the shared eligibility / consent rules apply; after the cut-off a passenger is refused (AFTER_CUTOFF).
      // D-A5: REQUESTED while the company's approval setting is on (default), else straight to PENDING_ASSIGNMENT.
      { actor: 'PASSENGER', status: approvalStatus(company.settings) },
    );
    return { value: await this.me.booking(ctx, res.value.id), replay: res.replay };
  }

  // ───────────────────────────── ad-hoc requests (WP 3.9 wave 2, D-A5 / D-A7) ─────────────────────────────

  /**
   * POST /me/transport/requests: the passenger's own ad-hoc ride (COMMUTE or POINT_TO_POINT) from / to home, a saved
   * place, a company place of `requestPlaces`, a one-time map point or the shift's site. Personal ends (HOME, SAVED,
   * MAP) need the active routing consent (409 CONSENT_REQUIRED, checked before anything is stored; a request never
   * becomes "needs location"). Self-service limits: one seat, at most maxDaysAhead days ahead, never after the cut-off
   * (BookingsService.create with actor PASSENGER: 409 AFTER_CUTOFF), plus every shared booking rule. REQUESTED while
   * the company's approval setting is on (default), else PENDING_ASSIGNMENT.
   */
  async createRequest(ctx: AuthContext, dto: MeAdhocRequestDto, rawKey: string | undefined): Promise<{ value: MeBookingDto; replay: boolean }> {
    const profile = await this.people.myProfileRow(ctx);
    const company = await this.requireOn(ctx);
    const day = serviceDate(dto.serviceDate);
    const p2p = dto.journey === 'POINT_TO_POINT';
    const shift = dto.shiftId ? await this.prisma.transportShift.findFirst({ where: { id: dto.shiftId, companyId: ctx.companyId, isActive: true }, include: { sitePoi: true } }) : null;
    if (dto.shiftId && (!shift || shift.companyId !== ctx.companyId)) throw invalid('Unknown or archived shift');
    const hasWindow = !!dto.windowStart && !!dto.windowEnd;
    if ((dto.windowStart || dto.windowEnd) && !hasWindow) throw invalid('Give both window start and end');
    if (p2p) {
      if (!hasWindow) throw invalid('A point-to-point request needs the time window');
    } else {
      if (!dto.direction) throw invalid('Choose the direction (to or from the office)');
      if (!shift && !hasWindow) throw invalid('Choose a shift or give the time window');
    }
    const today = todayIn(shift?.timeZone ?? company.timezone);
    if (day < today) throw invalid('The service date is in the past');
    if (day > addDays(today, L.maxDaysAhead)) throw invalid(`Book at most ${L.maxDaysAhead} days ahead`);

    // Ends: consent first for personal points (never stored without it).
    const consent = await this.consent(profile.id);
    const pickup = await this.endPoint(ctx, profile, dto.pickup, shift, consent);
    const drop = await this.endPoint(ctx, profile, dto.destination, shift, consent);

    const selfCtx: AuthContext = { ...ctx, dataScope: 'COMPANY', branchIds: [], agreements: [] };
    const res = await this.bookings.create(
      selfCtx,
      {
        passengerId: profile.id,
        serviceDate: day,
        journey: dto.journey,
        ...(p2p ? {} : { direction: dto.direction }),
        shiftId: shift?.id ?? null,
        pickup,
        drop,
        ...(hasWindow ? { windowStart: dto.windowStart, windowEnd: dto.windowEnd } : {}),
        passengerCount: 1,
        note: dto.note?.trim() ? `Requested by passenger: ${dto.note.trim().slice(0, L.bookingNoteMax)}` : 'Requested by passenger',
      },
      rawKey,
      { actor: 'PASSENGER', status: approvalStatus(company.settings), purpose: dto.purpose ?? null },
    );
    return { value: await this.me.booking(ctx, res.value.id), replay: res.replay };
  }

  /** GET /me/transport/request-places?q=: the company places a passenger may pick (see requestPlaceRows), at most 50. */
  async requestPlaces(ctx: AuthContext, q: string | undefined): Promise<MeRequestPlaceDto[]> {
    const profile = await this.people.myProfileRow(ctx);
    await this.requireOn(ctx);
    return (await this.requestPlaceRows(ctx, profile, q)).map((p) => ({ id: p.id, name: p.name, category: p.category ?? null }));
  }

  /**
   * Active places of the caller's company of categories OFFICE / SHUTTLE_STOP, the sites of active shifts and the
   * passenger's own stops (default stop, schedule stops); optional name search; at most 50 (or the one `onlyId`).
   */
  private async requestPlaceRows(ctx: AuthContext, profile: { id: string; defaultStopPoiId: string | null }, q: string | undefined, onlyId?: string) {
    const own = [...(await this.allowedStops(ctx, profile.id, profile.defaultStopPoiId)).keys()];
    const term = (q ?? '').trim().slice(0, 100);
    const rows = await this.prisma.poi.findMany({
      where: {
        companyId: ctx.companyId,
        isActive: true,
        OR: [{ category: { in: [...REQUEST_PLACE_CATEGORIES] } }, { id: { in: own } }],
        ...(onlyId ? { id: onlyId } : {}),
        ...(term ? { name: { contains: term, mode: 'insensitive' as const } } : {}),
      },
      select: { id: true, name: true, category: true, lat: true, lng: true, companyId: true, isActive: true },
      orderBy: { name: 'asc' },
      take: 50,
    });
    return rows.filter((r) => r.companyId === ctx.companyId && r.isActive !== false && ((REQUEST_PLACE_CATEGORIES as readonly string[]).includes(r.category ?? '') || own.includes(r.id)) && (!onlyId || r.id === onlyId));
  }

  /** One end of a request as a booking point (D-A3 consent for HOME / SAVED / MAP; PLACE from requestPlaceRows). */
  private async endPoint(
    ctx: AuthContext,
    profile: Awaited<ReturnType<PeopleService['myProfileRow']>>,
    end: MeAdhocEndRef,
    shift: { sitePoi: { id: string; name: string; lat: number; lng: number; isActive?: boolean } | null } | null,
    consent: boolean,
  ): Promise<GeoPoint> {
    switch (end.kind) {
      case 'HOME': {
        if (!consent) throw consentRequired();
        // The routing pickup, as for a desk COMMUTE booking: the default stop when set, else the home point.
        if (profile.defaultStop) return { lat: profile.defaultStop.lat, lng: profile.defaultStop.lng, label: profile.defaultStop.name, poiId: profile.defaultStop.id };
        if (profile.homeLat === null || profile.homeLng === null) throw invalid('Set your home location in your transport profile first');
        return { lat: profile.homeLat, lng: profile.homeLng, label: 'Home', poiId: null };
      }
      case 'SAVED': {
        if (!consent) throw consentRequired();
        const saved = placesOf(profile.preferences).find((p) => p.id === end.placeId);
        if (!end.placeId || !saved) throw invalid('Unknown saved place');
        return { lat: saved.lat, lng: saved.lng, label: saved.label, poiId: null };
      }
      case 'MAP': {
        if (!consent) throw consentRequired();
        const p = { lat: Number(end.lat), lng: Number(end.lng) };
        if (end.lat === undefined || end.lng === undefined || !validPoint(p)) throw invalid('A map point must have a valid latitude and longitude (not 0, 0)');
        return { ...p, label: end.label?.trim().slice(0, L.placeLabelMax) || null, poiId: null };
      }
      case 'PLACE': {
        if (!end.poiId) throw invalid('Choose a place');
        const [poi] = await this.requestPlaceRows(ctx, profile, undefined, end.poiId);
        if (!poi) throw notEligible('PLACE_NOT_ALLOWED', 'Choose one of the places offered for requests');
        return { lat: poi.lat, lng: poi.lng, label: poi.name, poiId: poi.id };
      }
      case 'SHIFT_SITE': {
        if (!shift) throw invalid('Choose the shift whose site you mean');
        if (!shift.sitePoi || shift.sitePoi.isActive === false) throw invalid('The shift has no active site');
        return { lat: shift.sitePoi.lat, lng: shift.sitePoi.lng, label: shift.sitePoi.name, poiId: shift.sitePoi.id };
      }
      default:
        throw invalid('Unknown place kind');
    }
  }

  // ───────────────────────────── commute ─────────────────────────────

  async commute(ctx: AuthContext): Promise<MeCommuteDto> {
    const profile = await this.people.myProfileRow(ctx);
    const company = await this.requireOn(ctx);
    const today = todayIn(company.timezone);
    const until = addDays(today, L.maxDaysAhead);
    const schedules = await this.prisma.transportSchedule.findMany({
      where: { companyId: ctx.companyId, profileId: profile.id, isActive: true },
      include: { shift: { select: { name: true } }, stopPoi: { select: { name: true } }, exceptions: { where: { date: { gte: dateOnly(today), lte: dateOnly(until) } }, orderBy: { date: 'asc' } } },
      orderBy: [{ direction: 'asc' }],
      take: 20,
    });
    const upcoming = await this.prisma.transportBooking.findMany({
      where: { customerCompanyId: ctx.companyId, profileId: profile.id, serviceDate: { gte: dateOnly(today), lte: dateOnly(until) } },
      orderBy: [{ windowStart: 'asc' }],
      take: 60,
    });
    return {
      schedules: schedules
        .filter((s) => s.profileId === profile.id)
        .map((s) => ({
          id: s.id,
          shiftName: s.shift.name,
          direction: s.direction,
          days: [...s.days].sort(),
          pickupMode: s.pickupMode,
          stopName: s.stopPoi?.name ?? null,
          validFrom: dayKeyOf(s.validFrom),
          validTo: s.validTo ? dayKeyOf(s.validTo) : null,
          exceptions: (s.exceptions ?? []).map((e) => ({ date: dayKeyOf(e.date), kind: e.kind })),
        })),
      upcoming: upcoming
        .filter((b) => b.profileId === profile.id)
        .map((b) => ({ id: b.id, serviceDate: dayKeyOf(b.serviceDate), direction: b.direction, status: b.status, windowStart: b.windowStart.toISOString(), windowEnd: b.windowEnd.toISOString(), timeZone: b.timeZone })),
    };
  }

  // ───────────────────────────── saved places ─────────────────────────────

  async places(ctx: AuthContext): Promise<MePlaceDto[]> {
    const profile = await this.people.myProfileRow(ctx);
    await this.requireOn(ctx);
    const consent = await this.consent(profile.id);
    return placesOf(profile.preferences).map((p) => placeDto(p, consent));
  }

  async addPlace(ctx: AuthContext, dto: MePlaceBody): Promise<MePlaceDto> {
    const profile = await this.people.myProfileRow(ctx);
    await this.requireOn(ctx);
    if (!(await this.consent(profile.id))) throw consentRequired();
    if (!validPoint(dto)) throw invalid('A place must have a valid latitude and longitude (not 0, 0)');
    const place: StoredPlace = { id: randomUUID(), label: cleanLabel(dto.label), lat: dto.lat, lng: dto.lng, createdAt: new Date().toISOString() };
    await this.writePlaces(ctx, profile.id, (list) => {
      if (list.length >= L.maxPlaces) throw invalid(`Keep at most ${L.maxPlaces} saved places`);
      return [...list, place];
    }, 'CREATE', place.id);
    return placeDto(place, true);
  }

  async updatePlace(ctx: AuthContext, id: string, dto: MePlaceUpdateDto): Promise<MePlaceDto> {
    const profile = await this.people.myProfileRow(ctx);
    await this.requireOn(ctx);
    if (!(await this.consent(profile.id))) throw consentRequired();
    let out: StoredPlace | null = null;
    await this.writePlaces(ctx, profile.id, (list) => {
      const cur = list.find((p) => p.id === id);
      if (!cur) throw notFound();
      const next: StoredPlace = { ...cur, ...(dto.label !== undefined ? { label: cleanLabel(dto.label) } : {}), ...(dto.lat !== undefined ? { lat: dto.lat } : {}), ...(dto.lng !== undefined ? { lng: dto.lng } : {}) };
      if (!validPoint(next)) throw invalid('A place must have a valid latitude and longitude (not 0, 0)');
      out = next;
      return list.map((p) => (p.id === id ? next : p));
    }, 'UPDATE', id);
    return placeDto(out!, true);
  }

  /** Deleting a place needs no consent (a passenger can always remove their own data). */
  async deletePlace(ctx: AuthContext, id: string): Promise<{ deleted: true }> {
    const profile = await this.people.myProfileRow(ctx);
    await this.requireOn(ctx);
    await this.writePlaces(ctx, profile.id, (list) => {
      if (!list.some((p) => p.id === id)) throw notFound();
      return list.filter((p) => p.id !== id);
    }, 'DELETE', id);
    return { deleted: true };
  }

  // ───────────────────────────── confirm / report ─────────────────────────────

  /**
   * Passenger confirmation of pickup / drop (owner decision P5 default: the driver is authoritative; this is a dispute
   * signal). Recorded as a PASSENGER_CONFIRM trip event; the seat status is never changed. Only inside the passenger's
   * vehicle window (from shortly before the start until the drop + grace), else 409 INVALID_STATE.
   */
  async confirm(ctx: AuthContext, tripId: string, dto: MeTripConfirmDto): Promise<MeTripConfirmResult> {
    const seat = await this.seat(ctx, tripId);
    if (await this.seen(ctx, tripId, dto.clientEventId, 'PASSENGER_CONFIRM', dto.kind)) {
      return { clientEventId: dto.clientEventId, outcome: 'DUPLICATE', myStatus: seat.status as TransportPassengerStatus, mismatch: confirmMismatch(dto.kind, seat.status as TransportPassengerStatus) };
    }
    const pt = seat.trip.plannedTrip;
    const w = vehicleWindow(pt, seat);
    const now = Date.now();
    // A no-show passenger has no window (vehicleWindow null) but may still dispute it until the trip is over.
    const noShowOpen = seat.status === 'NO_SHOW' && pt && pt.status !== 'CANCELLED' && now <= pt.plannedEnd.getTime() + 120 * MIN;
    if (!noShowOpen && (!w || now < w.start || now > w.end)) throw conflict('INVALID_STATE', 'You can confirm a pickup or drop only during your trip');
    const status = seat.status as TransportPassengerStatus;
    const mismatch = confirmMismatch(dto.kind, status);
    const outcome = await this.appendEvent(ctx, seat, dto.clientEventId, 'PASSENGER_CONFIRM', {
      reasonCode: dto.kind,
      stopSeq: dto.kind === 'PICKUP' ? seat.pickupSeq : seat.dropSeq,
      data: { kind: dto.kind, recordedStatus: status, mismatch },
    });
    return { clientEventId: dto.clientEventId, outcome, myStatus: status, mismatch };
  }

  /** Delay / missed pickup / concern about a trip of the caller's (PASSENGER_REPORT event; the desk sees it on the trip). */
  async report(ctx: AuthContext, tripId: string, dto: MeTripReportDto): Promise<MeTripReportResult> {
    const seat = await this.seat(ctx, tripId);
    if (await this.seen(ctx, tripId, dto.clientEventId, 'PASSENGER_REPORT', dto.category)) {
      return { clientEventId: dto.clientEventId, outcome: 'DUPLICATE', receivedAt: new Date().toISOString() };
    }
    const pt = seat.trip.plannedTrip;
    const now = Date.now();
    if (!pt || now < pt.plannedStart.getTime() - L.reportBeforeStartMin * MIN || now > pt.plannedEnd.getTime() + L.reportAfterEndMin * MIN) {
      throw conflict('INVALID_STATE', 'Reports are accepted from shortly before the trip until two days after it');
    }
    const note = dto.note?.trim() ? dto.note.trim().slice(0, L.reportNoteMax) : null;
    const outcome = await this.appendEvent(ctx, seat, dto.clientEventId, 'PASSENGER_REPORT', { reasonCode: dto.category, data: { category: dto.category, ...(note ? { note } : {}) } });
    return { clientEventId: dto.clientEventId, outcome, receivedAt: new Date(now).toISOString() };
  }

  // ───────────────────────────── helpers ─────────────────────────────

  private company(ctx: AuthContext) {
    return this.prisma.company.findUniqueOrThrow({ where: { id: ctx.companyId }, select: { settings: true, timezone: true } });
  }

  /** The company row when self-service is on; plain 404 SELF_BOOKING_DISABLED otherwise (default). */
  private async requireOn(ctx: AuthContext) {
    const company = await this.company(ctx);
    if (!selfBookingOn(company.settings)) throw new NotFoundException({ message: 'Not found', code: SELF_BOOKING_DISABLED });
    return company;
  }

  private async consent(profileId: string): Promise<boolean> {
    return (await activeRoutingConsents(this.prisma, [profileId])).has(profileId);
  }

  /**
   * Company places the passenger may pick as their end of a self-booked leg: their default stop, the stops of their own
   * schedules and the sites of active shifts. Never every company place (that list is not the passenger's business).
   */
  private async allowedStops(ctx: AuthContext, profileId: string, defaultStopPoiId: string | null) {
    const [schedules, shifts] = await Promise.all([
      this.prisma.transportSchedule.findMany({ where: { companyId: ctx.companyId, profileId, isActive: true, stopPoiId: { not: null } }, select: { stopPoiId: true } }),
      this.prisma.transportShift.findMany({ where: { companyId: ctx.companyId, isActive: true, sitePoiId: { not: null } }, select: { sitePoiId: true } }),
    ]);
    const ids = [...new Set([defaultStopPoiId, ...schedules.map((s) => s.stopPoiId), ...shifts.map((s) => s.sitePoiId)].filter((x): x is string => !!x))];
    if (!ids.length) return new Map<string, { id: string; name: string; lat: number; lng: number }>();
    const pois = await this.prisma.poi.findMany({ where: { id: { in: ids }, companyId: ctx.companyId, isActive: true }, select: { id: true, name: true, lat: true, lng: true, companyId: true } });
    return new Map(pois.filter((p) => p.companyId === ctx.companyId).map((p) => [p.id, { id: p.id, name: p.name, lat: p.lat, lng: p.lng }]));
  }

  /** Read-modify-write of `preferences.places` under a row lock (other preference keys are kept), audited without coordinates. */
  private async writePlaces(ctx: AuthContext, profileId: string, change: (list: StoredPlace[]) => StoredPlace[], action: 'CREATE' | 'UPDATE' | 'DELETE', placeId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "EmployeeTransportProfile" WHERE id = ${profileId}::uuid FOR UPDATE`;
      const row = await tx.employeeTransportProfile.findFirst({ where: { id: profileId, companyId: ctx.companyId, userId: ctx.userId, isActive: true }, select: { preferences: true } });
      if (!row) throw notFound();
      const before = placesOf(row.preferences);
      const after = change(before);
      const base = row.preferences && typeof row.preferences === 'object' && !Array.isArray(row.preferences) ? (row.preferences as Record<string, unknown>) : {};
      const done = await tx.employeeTransportProfile.updateMany({ where: { id: profileId, companyId: ctx.companyId, userId: ctx.userId }, data: { preferences: { ...base, places: after } as unknown as Prisma.InputJsonValue } });
      if (!done.count) throw notFound();
      // Audit: counts and the place id only (a saved place is a personal location; never stored in clear in the audit).
      await this.audit.record(ctx, { action: 'UPDATE', entity: 'EmployeeTransportProfile', entityId: profileId, before: { savedPlaces: before.length }, after: { savedPlaces: after.length, placeCommand: action, placeId } }, tx);
    });
  }

  /** The caller's own seat on the trip (other trips / passengers, a cancelled seat: 404). A no-show seat is still found. */
  private async seat(ctx: AuthContext, tripId: string) {
    const profile = await this.people.myProfileRow(ctx);
    await this.requireOn(ctx);
    const seat = await this.prisma.transportTripPassenger.findFirst({
      where: { tripId, customerCompanyId: ctx.companyId, booking: { profileId: profile.id }, status: { not: 'CANCELLED' } },
      include: { booking: { select: { profileId: true } }, trip: { include: { plannedTrip: true } } },
    });
    if (!seat || seat.booking.profileId !== profile.id || seat.status === 'CANCELLED') throw notFound();
    return seat;
  }

  /**
   * Whether this clientEventId was already recorded on the trip by the same user for the same command and the same
   * reason (PICKUP / DROP, report category). Another user, command or reason with the same id: 422 IDEMPOTENCY_KEY_REUSED.
   */
  private async seen(ctx: AuthContext, tripId: string, clientEventId: string, kind: string, reasonCode: string): Promise<boolean> {
    if (!(await seenClientEvent(this.prisma, tripId, clientEventId, ctx.userId, kind))) return false;
    const prior = await this.prisma.transportTripEvent.findFirst({ where: { tripId, clientEventId }, select: { reasonCode: true } });
    if (prior && prior.reasonCode !== reasonCode) throw idempotencyReused();
    return true;
  }

  /** Appends a passenger event (idempotent on the trip's clientEventId unique index: a concurrent twin = DUPLICATE). */
  private async appendEvent(
    ctx: AuthContext,
    seat: { id: string; tripId: string; trip: { providerCompanyId: string; customerCompanyId: string | null } },
    clientEventId: string,
    kind: 'PASSENGER_CONFIRM' | 'PASSENGER_REPORT',
    e: { reasonCode: string; stopSeq?: number; data: Record<string, unknown> },
  ): Promise<'ACCEPTED' | 'DUPLICATE'> {
    try {
      await recordTripEvent(this.prisma as unknown as Prisma.TransactionClient, ctx, {
        tripId: seat.tripId,
        providerCompanyId: seat.trip.providerCompanyId,
        customerCompanyId: seat.trip.customerCompanyId,
        kind,
        passengerTripId: seat.id,
        stopSeq: e.stopSeq ?? null,
        reasonCode: e.reasonCode,
        clientEventId,
        actorType: 'PASSENGER',
        source: 'PASSENGER_APP',
        data: e.data,
      });
      return 'ACCEPTED';
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002' && (await this.seen(ctx, seat.tripId, clientEventId, kind, e.reasonCode))) return 'DUPLICATE';
      throw err;
    }
  }
}

function cleanLabel(v: string): string {
  const label = (v ?? '').trim().replace(/\s+/g, ' ').slice(0, L.placeLabelMax);
  if (!label) throw invalid('Give the place a name');
  return label;
}
