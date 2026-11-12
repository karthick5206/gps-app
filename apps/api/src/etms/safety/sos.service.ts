import { ForbiddenException, Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SOS_OUTBOX_TYPES, type SosReceipt } from '@veetracer/shared';
import { randomUUID } from 'crypto';
import { AuthContext } from '../../access/auth-context';
import { transportNotFound } from '../../access/transport-scope';
import { PrismaService } from '../../prisma/prisma.service';
import { idempotencyReused, isUniqueViolation } from '../dispatch/e3-common';
import { SafetyOutboxRelayService } from './safety-outbox-relay.service';
import { cleanSos, notifyState, toReceipt, type CleanSos } from './sos-rules';

/** REPEATED events kept per incident (further presses only raise repeatCount: bounded writes under abuse; a replay of
 *  such an uncounted press merges again, harmlessly: same incident, merged: true). */
export const MAX_REPEAT_EVENTS = 50;
const IN_PROGRESS = ['STARTED', 'IN_PROGRESS'];

type Db = Prisma.TransactionClient;

interface Raiser {
  type: 'PASSENGER' | 'DRIVER';
  profileId: string | null;
  driverId: string | null;
}

interface TripLink {
  tripId: string;
  providerCompanyId: string;
  customerCompanyId: string | null;
  vehicleLabel: string | null;
}

export interface SosResult {
  receipt: SosReceipt;
  /** 201 for a new incident, 200 for a replay or a merge. */
  created: boolean;
  replay: boolean;
}

/**
 * Durable SOS raise (WP 5.4; doc 05 §3.7, doc 10 §6.1–6.2). PostgreSQL first: the incident, its CREATED event and the
 * SAFETY outbox row are written in ONE transaction before anything else; Valkey is never touched on this path, so an
 * SOS is accepted while Valkey is down. Never refused for its body, never rate-limited (429): presses while the
 * raiser's SOS is still OPEN merge into it (REPEATED, bounded). Idempotent on (login, Idempotency-Key).
 */
@Injectable()
export class SosService {
  private readonly logger = new Logger('EtmsSos');

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly relay?: SafetyOutboxRelayService,
  ) {}

  /** POST /api/me/transport/sos: the caller's own passenger profile (any state: SOS is never blocked by a deactivation). */
  async raisePassenger(ctx: AuthContext, body: unknown, key: string | undefined): Promise<SosResult> {
    const profile = await this.prisma.employeeTransportProfile.findFirst({ where: { userId: ctx.userId, companyId: ctx.companyId }, select: { id: true, userId: true, companyId: true } });
    if (!profile || profile.userId !== ctx.userId || profile.companyId !== ctx.companyId) throw new ForbiddenException({ message: 'You are not registered as a transport passenger', code: 'NOT_A_PASSENGER' });
    return this.raise(ctx, { type: 'PASSENGER', profileId: profile.id, driverId: null }, cleanSos(body, key));
  }

  /** POST /api/driver/v1/sos: the caller's own Driver row (an archived driver may still raise an SOS). */
  async raiseDriver(ctx: AuthContext, body: unknown, key: string | undefined): Promise<SosResult> {
    const driver = await this.prisma.driver.findFirst({ where: { userId: ctx.userId }, select: { id: true, userId: true, companyId: true } });
    if (!driver || driver.userId !== ctx.userId || driver.companyId !== ctx.companyId) throw new ForbiddenException({ message: 'This login is not linked to a driver', code: 'NOT_A_DRIVER' });
    return this.raise(ctx, { type: 'DRIVER', profileId: null, driverId: driver.id }, cleanSos(body, key));
  }

  /** GET /api/me/transport/sos/:id: a passenger's own incident only (403 NOT_A_PASSENGER, anything else 404). */
  async receiptPassenger(ctx: AuthContext, id: string): Promise<SosReceipt> {
    const profile = await this.prisma.employeeTransportProfile.findFirst({ where: { userId: ctx.userId, companyId: ctx.companyId }, select: { id: true, userId: true, companyId: true } });
    if (!profile || profile.userId !== ctx.userId || profile.companyId !== ctx.companyId) throw new ForbiddenException({ message: 'You are not registered as a transport passenger', code: 'NOT_A_PASSENGER' });
    return this.receipt(ctx, id);
  }

  /** GET /api/driver/v1/sos/:id: a driver's own incident only (403 NOT_A_DRIVER, anything else 404). */
  async receiptDriver(ctx: AuthContext, id: string): Promise<SosReceipt> {
    const driver = await this.prisma.driver.findFirst({ where: { userId: ctx.userId }, select: { id: true, userId: true, companyId: true } });
    if (!driver || driver.userId !== ctx.userId || driver.companyId !== ctx.companyId) throw new ForbiddenException({ message: 'This login is not linked to a driver', code: 'NOT_A_DRIVER' });
    return this.receipt(ctx, id);
  }

  private async receipt(ctx: AuthContext, id: string): Promise<SosReceipt> {
    const row = await this.prisma.transportIncident.findFirst({ where: { id, raiserUserId: ctx.userId } });
    if (!row || row.raiserUserId !== ctx.userId) throw transportNotFound();
    return this.toReceipt(row, false, true);
  }

  private async raise(ctx: AuthContext, raiser: Raiser, c: CleanSos, retry = 0): Promise<SosResult> {
    const replay = await this.replayOf(ctx, c);
    if (replay) return replay;
    const link = await this.tripLink(ctx, raiser, c.tripId);
    const tripLinked = !c.tripRequested || (!!link && link.tripId === c.tripId);
    try {
      const out = await this.prisma.$transaction(async (tx) => {
        const open = await tx.transportIncident.findFirst({ where: { raiserUserId: ctx.userId, kind: 'SOS', status: 'OPEN' } });
        if (open && open.raiserUserId === ctx.userId && open.status === 'OPEN') {
          const events = await tx.transportIncidentEvent.count({ where: { incidentId: open.id, kind: 'REPEATED' } });
          const fixNewer = c.fix && (!open.fixAt || new Date(c.fix.at) > open.fixAt);
          const updated = await tx.transportIncident.update({
            where: { id: open.id },
            data: {
              repeatCount: { increment: 1 },
              lastRepeatAt: new Date(),
              ...(fixNewer && c.fix ? { fixLat: c.fix.lat, fixLng: c.fix.lng, fixAccuracyM: c.fix.accuracyM ?? null, fixAt: new Date(c.fix.at) } : {}),
              ...(!open.tripId && link ? { tripId: link.tripId, providerCompanyId: open.providerCompanyId ?? link.providerCompanyId, customerCompanyId: open.customerCompanyId ?? link.customerCompanyId, vehicleLabel: link.vehicleLabel } : {}),
            },
          });
          if (events < MAX_REPEAT_EVENTS) {
            await tx.transportIncidentEvent.create({ data: { incidentId: open.id, kind: 'REPEATED', actorType: raiser.type, actorUserId: ctx.userId, clientKey: c.serverKey ? null : c.key, requestHash: c.hash, note: c.note, data: { tripLinked } } });
          }
          return { row: updated, created: false };
        }
        return { row: await this.create(tx, ctx, raiser, c, link), created: true };
      });
      if (out.created) this.relay?.kick();
      return { receipt: await this.toReceipt(out.row, !out.created, tripLinked), created: out.created, replay: false };
    } catch (e) {
      // Same key raced (unique raiser + key), or a second device created the OPEN SOS first (partial unique): once more,
      // which answers the replay or merges.
      if (retry < 2 && isUniqueViolation(e)) return this.raise(ctx, raiser, c, retry + 1);
      throw e;
    }
  }

  private async create(tx: Db, ctx: AuthContext, raiser: Raiser, c: CleanSos, link: TripLink | null) {
    const id = randomUUID();
    const providerCompanyId = raiser.type === 'DRIVER' ? ctx.companyId : (link?.providerCompanyId ?? null);
    const customerCompanyId = raiser.type === 'PASSENGER' ? ctx.companyId : (link?.customerCompanyId ?? null);
    const row = await tx.transportIncident.create({
      data: {
        id,
        kind: 'SOS',
        status: 'OPEN',
        severity: 'CRITICAL',
        raiserType: raiser.type,
        raiserUserId: ctx.userId,
        raiserDriverId: raiser.driverId,
        raiserProfileId: raiser.profileId,
        providerCompanyId,
        customerCompanyId,
        tripId: link?.tripId ?? null,
        vehicleLabel: link?.vehicleLabel ?? null,
        idempotencyKey: c.key,
        requestHash: c.hash,
        raisedAt: c.raisedAt,
        note: c.note,
        fixLat: c.fix?.lat ?? null,
        fixLng: c.fix?.lng ?? null,
        fixAccuracyM: c.fix?.accuracyM ?? null,
        fixAt: c.fix ? new Date(c.fix.at) : null,
      },
    });
    await tx.transportIncidentEvent.create({ data: { incidentId: id, kind: 'CREATED', actorType: raiser.type, actorUserId: ctx.userId, data: { tripId: link?.tripId ?? null, serverKey: c.serverKey } } });
    await tx.outboxEvent.create({
      data: {
        companyId: ctx.companyId,
        providerCompanyId,
        customerCompanyId,
        type: SOS_OUTBOX_TYPES.created,
        aggregateType: 'incident',
        aggregateId: id,
        class: 'SAFETY',
        payload: { incidentId: id, kind: 'SOS', tripId: link?.tripId ?? null, raiserType: raiser.type },
        idempotencyKey: c.serverKey ? null : c.key,
        occurredAt: c.raisedAt,
      },
    });
    return row;
  }

  /** Same login + key: the original receipt (merged repeats are found through their REPEATED event). */
  private async replayOf(ctx: AuthContext, c: CleanSos): Promise<SosResult | null> {
    if (c.serverKey) return null;
    const own = await this.prisma.transportIncident.findFirst({ where: { raiserUserId: ctx.userId, idempotencyKey: c.key } });
    if (own && own.raiserUserId === ctx.userId && own.idempotencyKey === c.key) {
      if (own.requestHash !== c.hash) throw idempotencyReused();
      return { receipt: await this.toReceipt(own, false, true), created: false, replay: true };
    }
    const ev = await this.prisma.transportIncidentEvent.findFirst({ where: { actorUserId: ctx.userId, clientKey: c.key } });
    if (ev && ev.actorUserId === ctx.userId && ev.clientKey === c.key) {
      if (ev.requestHash !== c.hash) throw idempotencyReused();
      const row = await this.prisma.transportIncident.findUnique({ where: { id: ev.incidentId } });
      if (row) return { receipt: await this.toReceipt(row, true, (ev.data as { tripLinked?: boolean } | null)?.tripLinked !== false), created: false, replay: true };
    }
    return null;
  }

  /**
   * The trip to link: the requested one if it is the caller's (passenger: a seat of theirs on it; driver: assigned to
   * them in their company); with no tripId, the caller's trip in progress. Never throws: no link is a valid outcome.
   */
  private async tripLink(ctx: AuthContext, raiser: Raiser, tripId: string | null): Promise<TripLink | null> {
    try {
      if (raiser.type === 'PASSENGER') return await this.passengerTrip(raiser.profileId!, tripId);
      return await this.driverTrip(ctx, raiser.driverId!, tripId);
    } catch (error) {
      this.logger.warn(`SOS trip link skipped: ${(error as Error).message}`);
      return null;
    }
  }

  private async passengerTrip(profileId: string, tripId: string | null): Promise<TripLink | null> {
    const since = new Date(Date.now() - 2 * 86_400_000);
    const bookings = await this.prisma.transportBooking.findMany({ where: { profileId, ...(tripId ? {} : { serviceDate: { gte: since } }) }, select: { id: true, profileId: true }, take: 200 });
    const ids = bookings.filter((b) => b.profileId === profileId).map((b) => b.id);
    if (!ids.length) return null;
    const seats = await this.prisma.transportTripPassenger.findMany({
      where: { bookingId: { in: ids }, ...(tripId ? { tripId } : {}), status: { in: ['PENDING', 'BOARDED'] } },
      select: { bookingId: true, tripId: true, status: true, trip: { select: { id: true, providerCompanyId: true, customerCompanyId: true, plannedTrip: { select: { status: true, objectId: true } } } } },
      take: 50,
    });
    const mine = seats.filter((s) => ids.includes(s.bookingId) && s.trip && (!tripId || s.tripId === tripId) && s.status !== 'CANCELLED');
    const pick = tripId ? mine[0] : mine.find((s) => IN_PROGRESS.includes(s.trip!.plannedTrip?.status ?? ''));
    if (!pick?.trip) return null;
    return { tripId: pick.trip.id, providerCompanyId: pick.trip.providerCompanyId, customerCompanyId: pick.trip.customerCompanyId, vehicleLabel: await this.plate(pick.trip.plannedTrip?.objectId) };
  }

  private async driverTrip(ctx: AuthContext, driverId: string, tripId: string | null): Promise<TripLink | null> {
    let trip: { id: string; providerCompanyId: string; customerCompanyId: string | null; plannedTrip: { driverId: string | null; objectId: string; status: string } | null } | null;
    if (tripId) {
      trip = await this.prisma.transportTrip.findFirst({ where: { id: tripId, providerCompanyId: ctx.companyId }, select: { id: true, providerCompanyId: true, customerCompanyId: true, plannedTrip: { select: { driverId: true, objectId: true, status: true } } } });
    } else {
      const pt = await this.prisma.plannedTrip.findFirst({ where: { driverId, companyId: ctx.companyId, origin: 'ETMS', status: { in: IN_PROGRESS as never } }, select: { id: true, driverId: true, companyId: true } });
      if (!pt || pt.driverId !== driverId || pt.companyId !== ctx.companyId) return null;
      trip = await this.prisma.transportTrip.findFirst({ where: { plannedTripId: pt.id, providerCompanyId: ctx.companyId }, select: { id: true, providerCompanyId: true, customerCompanyId: true, plannedTrip: { select: { driverId: true, objectId: true, status: true } } } });
    }
    if (!trip || trip.providerCompanyId !== ctx.companyId || trip.plannedTrip?.driverId !== driverId) return null;
    return { tripId: trip.id, providerCompanyId: trip.providerCompanyId, customerCompanyId: trip.customerCompanyId, vehicleLabel: await this.plate(trip.plannedTrip.objectId) };
  }

  private async plate(objectId: string | null | undefined): Promise<string | null> {
    if (!objectId) return null;
    const o = await this.prisma.trackedObject.findUnique({ where: { id: objectId }, select: { plateNumber: true, name: true } });
    return o ? (o.plateNumber ?? o.name) : null;
  }

  private async toReceipt(row: { id: string; status: string; raiserType: string; providerCompanyId: string | null; customerCompanyId: string | null; receivedAt: Date; acknowledgedAt: Date | null; acknowledgedByUserId: string | null; resolvedAt: Date | null; tripId: string | null }, merged: boolean, tripLinked: boolean): Promise<SosReceipt> {
    const [outbox, ackBy] = await Promise.all([
      this.prisma.outboxEvent.findFirst({ where: { aggregateType: 'incident', aggregateId: row.id, type: SOS_OUTBOX_TYPES.created }, select: { publishedAt: true, deadAt: true } }),
      row.acknowledgedByUserId ? this.prisma.user.findUnique({ where: { id: row.acknowledgedByUserId }, select: { name: true } }) : Promise.resolve(null),
    ]);
    return toReceipt(row, { merged, tripLinked, notify: notifyState(outbox), ackByName: ackBy?.name ?? null });
  }
}
