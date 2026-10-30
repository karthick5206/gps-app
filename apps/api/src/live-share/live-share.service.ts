import { BadRequestException, GoneException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { LIVE_SHARE_MAX_HOURS, type LiveShareCreatedDto, type LiveShareDto, type PublicLiveShareDto } from '@veetracer/shared';
import { createHash, randomBytes } from 'node:crypto';
import { allCompaniesOr, objectScopeWhere } from '../access/access-rules';
import { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { loadEnv } from '../config/env';
import { GeocodingService } from '../geocoding/geocoding.service';
import { LicencePolicyService } from '../licences/licence-policy.service';
import { LiveStateService } from '../live/live-state.service';
import { PrismaService } from '../prisma/prisma.service';
import { localDayKey } from '../summarizer/tz';

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
const HOUR_MS = 3_600_000;
/** Trail on the public page: since the share started, at most this far back and this many points. */
const TRAIL_MS = HOUR_MS;
const TRAIL_MAX = 720;

type ShareRow = { id: string; objectId: string; note: string | null; hours: number; createdAt: Date; expiresAt: Date; revokedAt: Date | null; createdById: string | null; viewCount: number; lastViewedAt: Date | null };

/**
 * Live location share links: a signed-in user with access to the vehicle creates a link valid for N hours; anyone with
 * the link sees the live position, status and recent path in a browser, until it expires or is stopped.
 */
@Injectable()
export class LiveShareService {
  private readonly webUrl = loadEnv().webUrl.replace(/\/+$/, '');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly liveState: LiveStateService,
    private readonly geocoder: GeocodingService,
    @Optional() private readonly licences?: LicencePolicyService,
  ) {}

  private async object(ctx: AuthContext, objectId: string) {
    const o = await this.prisma.trackedObject.findFirst({ where: { AND: [allCompaniesOr(ctx, objectScopeWhere(ctx)), { id: objectId, isActive: true }] }, select: { id: true, name: true, companyId: true } });
    if (!o) throw new NotFoundException('Vehicle not found');
    return o;
  }

  private toDto(r: ShareRow, names: Map<string, string>, now = Date.now()): LiveShareDto {
    return {
      id: r.id,
      objectId: r.objectId,
      note: r.note,
      hours: r.hours,
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      revokedAt: r.revokedAt?.toISOString() ?? null,
      createdByName: r.createdById ? (names.get(r.createdById) ?? null) : null,
      viewCount: r.viewCount,
      lastViewedAt: r.lastViewedAt?.toISOString() ?? null,
      active: !r.revokedAt && r.expiresAt.getTime() > now,
    };
  }

  private async names(rows: ShareRow[]): Promise<Map<string, string>> {
    const ids = [...new Set(rows.flatMap((r) => (r.createdById ? [r.createdById] : [])))];
    const users = ids.length ? await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
    return new Map(users.map((u) => [u.id, u.name]));
  }

  async create(ctx: AuthContext, objectId: string, hours: number, note?: string): Promise<LiveShareCreatedDto> {
    if (!Number.isFinite(hours) || hours < 1 || hours > LIVE_SHARE_MAX_HOURS) throw new BadRequestException(`Hours must be between 1 and ${LIVE_SHARE_MAX_HOURS}`);
    const o = await this.object(ctx, objectId);
    if ((await this.licences?.lockedObjectIds({ companyId: o.companyId, isSuperAdmin: false }))?.has(o.id)) {
      throw new BadRequestException('This vehicle’s licence has expired. Renew it to share its location.');
    }
    const token = randomBytes(24).toString('base64url');
    const h = Math.round(hours);
    const row = await this.prisma.liveShare.create({
      data: { tokenHash: hash(token), companyId: o.companyId, objectId: o.id, createdById: ctx.userId, note: note?.trim().slice(0, 200) || null, hours: h, expiresAt: new Date(Date.now() + h * HOUR_MS) },
    });
    await this.audit.record({ ...ctx, companyId: o.companyId }, { action: 'CREATE', entity: 'LiveShare', entityId: row.id, after: { objectId: o.id, vehicle: o.name, hours: h, expiresAt: row.expiresAt.toISOString() } });
    return { ...this.toDto(row, await this.names([row])), url: `${this.webUrl}/share/${token}` };
  }

  async list(ctx: AuthContext, objectId: string): Promise<LiveShareDto[]> {
    await this.object(ctx, objectId);
    const rows = await this.prisma.liveShare.findMany({ where: { objectId }, orderBy: { createdAt: 'desc' }, take: 20 });
    const names = await this.names(rows);
    return rows.map((r) => this.toDto(r, names));
  }

  async revoke(ctx: AuthContext, id: string): Promise<LiveShareDto> {
    const row = await this.prisma.liveShare.findUnique({ where: { id } });
    if (!row) throw new NotFoundException('Share not found');
    await this.object(ctx, row.objectId);
    const updated = row.revokedAt ? row : await this.prisma.liveShare.update({ where: { id }, data: { revokedAt: new Date() } });
    if (!row.revokedAt) await this.audit.record({ ...ctx, companyId: row.companyId }, { action: 'UPDATE', entity: 'LiveShare', entityId: id, before: { revokedAt: null }, after: { revokedAt: updated.revokedAt?.toISOString() } });
    return this.toDto(updated, await this.names([updated]));
  }

  /** Public page: live position, status and recent path (no sign-in; the token is the key). */
  async view(token: string, now = Date.now()): Promise<PublicLiveShareDto> {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw new NotFoundException('This link is not valid.');
    const share = await this.prisma.liveShare.findUnique({
      where: { tokenHash: hash(token) },
      include: { object: { select: { id: true, name: true, plateNumber: true, type: true, vehicleType: true, isActive: true, company: { select: { name: true, timezone: true } } } } },
    });
    if (!share || !share.object.isActive) throw new NotFoundException('This link is not valid.');
    if (share.revokedAt) throw new GoneException('Sharing was stopped by the sender.');
    if (share.expiresAt.getTime() <= now) throw new GoneException('This link has expired.');
    if ((await this.licences?.lockedObjectIds({ companyId: share.companyId, isSuperAdmin: false }))?.has(share.objectId)) throw new GoneException('This link is not available right now.');

    const o = share.object;
    const live = (await this.liveState.read([o.id])).get(o.id) ?? null;
    const since = new Date(Math.max(share.createdAt.getTime(), now - TRAIL_MS));
    const [trail, today, creator, address] = await Promise.all([
      this.prisma.$queryRaw<{ t: number; lat: number; lng: number }[]>`
        SELECT (extract(epoch from "fixTime") * 1000)::float8 AS t, lat, lng FROM "Position"
        WHERE "objectId" = ${o.id}::uuid AND "fixTime" >= ${since} AND (flags & 64) = 0
        ORDER BY "fixTime" DESC LIMIT ${TRAIL_MAX}`,
      this.prisma.dailySummary.findUnique({ where: { objectId_day: { objectId: o.id, day: new Date(`${localDayKey(now, o.company.timezone)}T00:00:00Z`) } }, select: { distanceKm: true } }),
      share.createdById ? this.prisma.user.findUnique({ where: { id: share.createdById }, select: { name: true } }) : null,
      live?.lat != null && live.lng != null ? this.geocoder.reverse(live.lat, live.lng).catch(() => null) : null,
    ]);
    // Count the view (at most once a minute per share, to keep polling cheap).
    if (!share.lastViewedAt || now - share.lastViewedAt.getTime() > 60_000) {
      await this.prisma.liveShare.update({ where: { id: share.id }, data: { viewCount: { increment: 1 }, lastViewedAt: new Date(now) } }).catch(() => undefined);
    }
    return {
      name: o.name,
      plateNumber: o.plateNumber,
      type: o.type,
      vehicleType: o.vehicleType,
      companyName: o.company.name,
      sharedByName: creator?.name ?? null,
      note: share.note,
      expiresAt: share.expiresAt.toISOString(),
      live: {
        lat: live?.lat ?? null,
        lng: live?.lng ?? null,
        speedKph: Math.round(live?.speedKph ?? 0),
        course: Math.round(live?.course ?? 0),
        status: live?.status ?? 'NO_DATA',
        statusSince: live?.statusSince ?? null,
        ignition: live?.ignition ?? null,
        fixTime: live?.fixTime ?? null,
        serverTime: live?.serverTime ?? null,
        batteryLevel: live?.batteryLevel ?? null,
        charging: live?.charging ?? null,
        satellites: live?.satellites ?? null,
        address,
      },
      trail: trail.reverse().map((p) => [p.t, Math.round(p.lat * 1e6) / 1e6, Math.round(p.lng * 1e6) / 1e6]),
      todayKm: today ? Math.round(today.distanceKm * 10) / 10 : null,
    };
  }
}
