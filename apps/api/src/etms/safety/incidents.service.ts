import { BadRequestException, ConflictException, ForbiddenException, Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  SOS_LIMITS,
  SOS_OUTBOX_TYPES,
  type IncidentDetail,
  type IncidentEventDto,
  type IncidentEventKind,
  type IncidentKind,
  type IncidentListItem,
  type IncidentListResponse,
  type IncidentRaiserType,
  type IncidentResolution,
  type IncidentStatus,
} from '@veetracer/shared';
import { AuthContext } from '../../access/auth-context';
import { requireSupportReason } from '../../access/access-reason';
import { transportNotFound } from '../../access/transport-scope';
import { AuditService } from '../../audit/audit.service';
import { PrismaService } from '../../prisma/prisma.service';
import { SafetyOutboxRelayService } from './safety-outbox-relay.service';
import { cleanNote, fixStale, incidentAccess, incidentListWhere, isResolution, notifyState, shortName, type IncidentAccess } from './sos-rules';

export const INCIDENT_ENTITY = 'TransportIncident';
/** `what` of the incident detail ACCESS audit entry (labelled in the customer's sensitive-access log). */
export const INCIDENT_READ = 'incident-detail';
const LIST_MAX = 100;

type Row = Prisma.TransportIncidentGetPayload<object>;

/** The data owner of an incident (whose sensitive-access log records its reads): the customer, else the operator. */
function incidentOwner(ctx: Pick<AuthContext, 'companyId'>, row: Pick<Row, 'customerCompanyId' | 'providerCompanyId'>): string {
  return row.customerCompanyId ?? row.providerCompanyId ?? ctx.companyId;
}

/**
 * Dispatcher side of the durable SOS (doc 05 §2.10; WP 5.4): the open SOS lane (list, polled every 15 s while the socket
 * is down), detail with the append-only history, acknowledge (note required) and resolve (outcome + note). Each write
 * is a compare-and-set on the status, appends a TransportIncidentEvent, writes the audit log (E0.5: SOS acks audited)
 * and a SAFETY outbox row (socket refresh for every dispatcher), all in one transaction.
 */
@Injectable()
export class IncidentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Optional() private readonly relay?: SafetyOutboxRelayService,
  ) {}

  async list(ctx: AuthContext, q: { open?: string; limit?: string }): Promise<IncidentListResponse> {
    const scope = incidentListWhere(ctx);
    const openOnly = q.open === '1' || q.open === 'true';
    const take = Math.min(LIST_MAX, Math.max(1, Number.parseInt(q.limit ?? '', 10) || 50));
    const where: Prisma.TransportIncidentWhereInput = { AND: [scope, openOnly ? { status: { in: ['OPEN', 'ACKNOWLEDGED'] } } : {}] };
    const rows = (await this.prisma.transportIncident.findMany({ where, orderBy: { receivedAt: 'desc' }, take: take * 2 }))
      .filter((r) => incidentAccess(ctx, r) !== 'none')
      .filter((r) => !openOnly || r.status !== 'RESOLVED')
      // OPEN first (oldest first: the longest waiting on top), then acknowledged / resolved newest first.
      .sort((a, b) => (a.status === 'OPEN') !== (b.status === 'OPEN') ? (a.status === 'OPEN' ? -1 : 1) : a.status === 'OPEN' ? a.receivedAt.getTime() - b.receivedAt.getTime() : b.receivedAt.getTime() - a.receivedAt.getTime())
      .slice(0, take);
    const items = await this.items(ctx, rows);
    const openCount = (await this.prisma.transportIncident.findMany({ where: { AND: [scope, { status: 'OPEN' }] }, select: { id: true, status: true, raiserType: true, providerCompanyId: true, customerCompanyId: true }, take: 500 }))
      .filter((r) => r.status === 'OPEN' && incidentAccess(ctx, r) !== 'none').length;
    return { items, openCount };
  }

  /**
   * Detail with the history. Security review M1: the read is audited in the data owner's log (the incident's customer
   * company, else the operator), like the E1b passenger reads, so a customer sees in its sensitive-access log when its
   * provider or VeeTrax support opened one of its SOS; the Super Admin must give a reason (controller), logged here.
   */
  async detail(ctx: AuthContext, id: string, access: { reasonHeader?: string } = {}): Promise<IncidentDetail> {
    const { row } = await this.load(ctx, id, 'view');
    // M1 + L8: VeeTrax support gives a reason; the 400 names the data owner so the web remembers it per company.
    const reason = requireSupportReason(ctx, access.reasonHeader, incidentOwner(ctx, row));
    const [item] = await this.items(ctx, [row], { full: true });
    const events = await this.prisma.transportIncidentEvent.findMany({ where: { incidentId: row.id }, orderBy: { at: 'asc' }, take: 200 });
    const actors = await this.names(events.map((e) => e.actorUserId));
    // Reading an incident with its location and raiser is a sensitive read (doc 05 §6 audit row).
    await this.auditRead(ctx, row, reason);
    return {
      ...item!,
      note: row.note,
      resolution: (row.resolution as IncidentResolution | null) ?? null,
      events: events
        .filter((e) => e.incidentId === row.id)
        .sort((a, b) => a.at.getTime() - b.at.getTime())
        .map<IncidentEventDto>((e) => ({
          id: e.id,
          kind: e.kind as IncidentEventKind,
          at: e.at.toISOString(),
          actorLabel: e.actorType === 'SYSTEM' ? null : e.actorUserId ? this.label(ctx, row, actors.get(e.actorUserId) ?? null, true) : null,
          note: e.kind === 'ACKNOWLEDGED' || e.kind === 'RESOLVED' || e.kind === 'REPEATED' ? e.note : null,
          ...(e.kind === 'RESOLVED' && (e.data as { resolution?: IncidentResolution } | null)?.resolution ? { resolution: (e.data as { resolution: IncidentResolution }).resolution } : {}),
        })),
    };
  }

  async ack(ctx: AuthContext, id: string, body: unknown): Promise<IncidentDetail> {
    const note = cleanNote((body as { note?: unknown } | null)?.note, SOS_LIMITS.ackNoteMax);
    if (!note) throw new BadRequestException({ message: 'Write what was done (a note is required)', code: 'NOTE_REQUIRED' });
    const { row } = await this.load(ctx, id, 'manage');
    if (row.status === 'ACKNOWLEDGED') return this.detail(ctx, id); // idempotent: someone (or this user) already did
    if (row.status !== 'OPEN') throw new ConflictException({ message: 'This incident is already resolved', code: 'INVALID_TRANSITION' });
    await this.transition(ctx, row, 'ACKNOWLEDGED', note, null);
    return this.detail(ctx, id);
  }

  async resolve(ctx: AuthContext, id: string, body: unknown): Promise<IncidentDetail> {
    const b = (body ?? {}) as { note?: unknown; resolution?: unknown };
    if (!isResolution(b.resolution)) throw new BadRequestException({ message: 'Choose an outcome', code: 'VALIDATION' });
    const note = cleanNote(b.note, SOS_LIMITS.resolveNoteMax);
    if (!note) throw new BadRequestException({ message: 'Write what happened (a note is required)', code: 'NOTE_REQUIRED' });
    const { row } = await this.load(ctx, id, 'manage');
    if (row.status === 'RESOLVED') throw new ConflictException({ message: 'This incident is already resolved', code: 'INVALID_TRANSITION' });
    await this.transition(ctx, row, 'RESOLVED', note, b.resolution);
    return this.detail(ctx, id);
  }

  /** Compare-and-set + event + audit + outbox in one transaction; a lost race answers 409 (or the ack replay above). */
  private async transition(ctx: AuthContext, row: Row, to: 'ACKNOWLEDGED' | 'RESOLVED', note: string, resolution: IncidentResolution | null): Promise<void> {
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const data: Prisma.TransportIncidentUpdateManyMutationInput =
        to === 'ACKNOWLEDGED'
          ? { status: 'ACKNOWLEDGED', acknowledgedAt: now, acknowledgedByUserId: ctx.userId, ackNote: note }
          : { status: 'RESOLVED', resolvedAt: now, resolvedByUserId: ctx.userId, resolution, resolveNote: note, ...(row.acknowledgedAt ? {} : { acknowledgedAt: now, acknowledgedByUserId: ctx.userId, ackNote: note }) };
      const r = await tx.transportIncident.updateMany({ where: { id: row.id, status: row.status }, data });
      if (!r.count) throw new ConflictException({ message: 'Changed by someone else meanwhile; reload', code: 'INVALID_TRANSITION' });
      await tx.transportIncidentEvent.create({ data: { incidentId: row.id, kind: to, actorType: 'DISPATCHER', actorUserId: ctx.userId, note, data: resolution ? { resolution } : {} } });
      await this.audit.record(ctx, { action: 'UPDATE', entity: INCIDENT_ENTITY, entityId: row.id, before: { status: row.status }, after: { status: to, note, ...(resolution ? { resolution } : {}) } }, tx);
      await tx.outboxEvent.create({
        data: {
          companyId: ctx.companyId,
          providerCompanyId: row.providerCompanyId,
          customerCompanyId: row.customerCompanyId,
          type: to === 'ACKNOWLEDGED' ? SOS_OUTBOX_TYPES.acknowledged : SOS_OUTBOX_TYPES.resolved,
          aggregateType: 'incident',
          aggregateId: row.id,
          class: 'SAFETY',
          payload: { incidentId: row.id, status: to },
          occurredAt: now,
        },
      });
    });
    this.relay?.kick();
  }

  private async auditRead(ctx: AuthContext, row: Row, reason: string | null): Promise<void> {
    const owner = incidentOwner(ctx, row);
    const details = {
      what: INCIDENT_READ,
      ...(owner !== ctx.companyId ? { actingCompanyId: ctx.companyId } : {}),
      ...(ctx.isSuperAdmin ? { superAdmin: true } : {}),
      ...(reason ? { reason: reason.slice(0, 300) } : {}),
    };
    const entry = { action: 'ACCESS' as const, entity: INCIDENT_ENTITY, entityId: row.id, details };
    if (owner === ctx.companyId) await this.audit.record(ctx, entry);
    else await this.audit.recordSystem({ companyId: owner, userId: ctx.userId, ip: ctx.ip }, entry);
  }

  /** The row if the caller may see it (404 otherwise); `manage` needs edit rights on it (403 FORBIDDEN_GRANT). */
  private async load(ctx: AuthContext, id: string, need: 'view' | 'manage'): Promise<{ row: Row; access: IncidentAccess }> {
    const row = await this.prisma.transportIncident.findUnique({ where: { id } });
    const access = row ? incidentAccess(ctx, row) : 'none';
    if (!row || access === 'none') throw transportNotFound();
    if (need === 'manage' && access !== 'manage') {
      if (ctx.isSuperAdmin) throw new ForbiddenException({ message: "VeeTrax support can view incidents but not act on them; the company's dispatchers acknowledge and resolve", code: 'FORBIDDEN_GRANT' });
      throw new ForbiddenException({ message: 'Your agreement with this customer allows viewing incidents only', code: 'FORBIDDEN_GRANT' });
    }
    return { row, access };
  }

  /**
   * List items. `full`: the detail read (audited). In the lane (not audited) VeeTrax support sees the short name and no
   * location (M1): the full raiser and the location are behind the reasoned, audited detail.
   */
  private async items(ctx: AuthContext, rows: Row[], opts: { full: boolean } = { full: false }): Promise<IncidentListItem[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const [outbox, profiles, drivers, users] = await Promise.all([
      this.prisma.outboxEvent.findMany({ where: { aggregateType: 'incident', aggregateId: { in: ids }, type: SOS_OUTBOX_TYPES.created }, select: { aggregateId: true, publishedAt: true, deadAt: true } }),
      this.prisma.employeeTransportProfile.findMany({ where: { id: { in: rows.map((r) => r.raiserProfileId).filter((x): x is string => !!x) } }, select: { id: true, displayName: true, employeeCode: true } }),
      this.prisma.driver.findMany({ where: { id: { in: rows.map((r) => r.raiserDriverId).filter((x): x is string => !!x) } }, select: { id: true, name: true } }),
      this.names(rows.map((r) => r.acknowledgedByUserId)),
    ]);
    const ob = new Map(outbox.map((o) => [o.aggregateId, o]));
    const prof = new Map(profiles.map((p) => [p.id, p]));
    const drv = new Map(drivers.map((d) => [d.id, d]));
    return rows.map((r) => {
      const p = r.raiserProfileId ? prof.get(r.raiserProfileId) : undefined;
      const d = r.raiserDriverId ? drv.get(r.raiserDriverId) : undefined;
      const own = this.ownSide(ctx, r, opts.full);
      const redactFix = ctx.isSuperAdmin && !opts.full;
      const raiserLabel = r.anonymisedAt ? '—' : p ? (own ? `${p.displayName} (${p.employeeCode})` : shortName(p.displayName)) : d ? (own ? d.name : shortName(d.name)) : '—';
      return {
        id: r.id,
        kind: r.kind as IncidentKind,
        status: r.status as IncidentStatus,
        raiserType: r.raiserType as IncidentRaiserType,
        raiserLabel,
        tripId: r.tripId,
        tripLabel: null,
        vehiclePlate: r.vehicleLabel,
        raisedAt: r.raisedAt.toISOString(),
        receivedAt: r.receivedAt.toISOString(),
        lastFix: !redactFix && r.fixLat !== null && r.fixLng !== null && r.fixAt ? { lat: r.fixLat, lng: r.fixLng, ...(r.fixAccuracyM !== null ? { accuracyM: r.fixAccuracyM } : {}), at: r.fixAt.toISOString(), stale: fixStale(r.fixAt, r.receivedAt) } : null,
        repeatCount: r.repeatCount,
        notify: notifyState(ob.get(r.id)),
        acknowledgedAt: r.acknowledgedAt?.toISOString() ?? null,
        acknowledgedBy: r.acknowledgedByUserId ? this.label(ctx, r, users.get(r.acknowledgedByUserId) ?? null, opts.full) : null,
        resolvedAt: r.resolvedAt?.toISOString() ?? null,
      };
    });
  }

  /** The caller's company is the raiser's own company (full names) — otherwise agreement view (short names). */
  private ownSide(ctx: AuthContext, r: Pick<Row, 'raiserType' | 'providerCompanyId' | 'customerCompanyId'>, full: boolean): boolean {
    // VeeTrax support: full names only in the reasoned, audited detail (M1), whichever company it switched into.
    if (ctx.isSuperAdmin) return full;
    const raiserCompany = r.raiserType === 'DRIVER' ? r.providerCompanyId : r.customerCompanyId;
    return raiserCompany === ctx.companyId;
  }

  private label(ctx: AuthContext, r: Row, name: string | null, full: boolean): string | null {
    if (!name) return null;
    return this.ownSide(ctx, r, full) ? name : shortName(name);
  }

  private async names(ids: (string | null)[]): Promise<Map<string, string>> {
    const uniq = [...new Set(ids.filter((x): x is string => !!x))];
    if (!uniq.length) return new Map();
    const users = await this.prisma.user.findMany({ where: { id: { in: uniq } }, select: { id: true, name: true } });
    return new Map(users.map((u) => [u.id, u.name]));
  }
}
