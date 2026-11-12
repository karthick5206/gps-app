import { Injectable, Logger, Optional } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { OutboxEvent, Prisma } from '@prisma/client';
import { SOS_OUTBOX_TYPES, sosPushText, type IncidentKind, type IncidentStatus, type TransportSosSocketPayload } from '@veetracer/shared';
import { NOTIFY_STREAM_MAXLEN } from '../../alerts/alert-dto';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisKeys } from '../../redis/keys';
import { RedisService } from '../../redis/redis.service';
import { etmsServerEnabled } from '../transport-feature.guard';
import { SOS_CHANNEL, sosLocalBus, type SosFanoutMessage } from './sos-bus';
import { SosDirectSender, TRANSPORT_INCIDENT_REF } from './sos-direct-sender';
import { safetyBackoffMs } from './sos-rules';

/** Lease of a claimed outbox row: another relay instance may take it over after this (at-least-once). */
export const OUTBOX_LEASE_MS = 30_000;
export const OUTBOX_BATCH = 50;
/** A Valkey command that does not answer within this time counts as "Valkey down" (ioredis may queue while reconnecting). */
export const VALKEY_TIMEOUT_MS = 2_000;
/** Dispatcher logins pushed per incident (company users holding etms_incidents:view). */
export const MAX_SOS_RECIPIENTS = 200;

export interface RelayPassResult {
  claimed: number;
  published: number;
  direct: number;
  pending: number;
}

type IncidentRow = Prisma.TransportIncidentGetPayload<{ select: typeof INCIDENT_SELECT }>;
const INCIDENT_SELECT = { id: true, kind: true, status: true, raiserType: true, providerCompanyId: true, customerCompanyId: true, tripId: true, vehicleLabel: true, raisedAt: true } satisfies Prisma.TransportIncidentSelect;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Valkey did not answer within ${ms} ms`)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e: unknown) => (clearTimeout(t), reject(e instanceof Error ? e : new Error(String(e)))),
    );
  });
}

/**
 * Relay of the SAFETY class of the transactional outbox (doc 10 §6.2, doc 05 §5.2; WP 5.4). Every 2 s (and right after
 * an SOS commits, `kick`), in the API process, any number of instances: rows are claimed with `FOR UPDATE SKIP LOCKED`
 * and leased for 30 s, so a crashed relay's rows are taken over (at-least-once; consumers dedupe on the incident id;
 * push rows are unique per outbox row and recipient).
 *
 *  - Valkey up: PUBLISH the `transport.sos` fan-out on vt:etms:sos (every API instance's /live gateway) and XADD the
 *    dispatcher PUSH rows to vt:notify (notifier, G2 durable delivery) → publishedAt, incident event NOTIFY_PUBLISHED.
 *  - Valkey down: direct send — emit to this process's in-scope dispatcher sockets (sosLocalBus) and send the PUSH rows
 *    with the notifier's ledger (SosDirectSender). If anything reached someone → publishedAt, NOTIFY_DIRECT. Otherwise
 *    the row stays pending (back-off 1 → 15 s) and is published as soon as Valkey answers again: a SAFETY row is never
 *    DEAD and never dropped. The web SOS lane also polls PostgreSQL, so an incident is visible without any of this.
 * Kill switches: ETMS=off, ETMS_SOS_RELAY=off (rows then wait in PostgreSQL).
 */
@Injectable()
export class SafetyOutboxRelayService {
  private readonly logger = new Logger('EtmsSafetyRelay');
  private running = false;
  private again = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    @Optional() private readonly direct?: SosDirectSender,
  ) {}

  get enabled(): boolean {
    return etmsServerEnabled() && (process.env.ETMS_SOS_RELAY ?? 'on').toLowerCase() !== 'off';
  }

  @Interval(2_000)
  async tick(): Promise<void> {
    if (!this.enabled) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.again = false;
        const r = await this.run();
        if (r.claimed) this.logger.log(`SAFETY outbox: claimed=${r.claimed} published=${r.published} direct=${r.direct} pending=${r.pending}`);
      } while (this.again);
    } catch (error) {
      this.logger.error(`SAFETY outbox relay failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** Run a pass now (after an SOS commit) instead of waiting for the next tick. Never throws. */
  kick(): void {
    setImmediate(() => void this.tick());
  }

  /** One pass (also called by tests). */
  async run(): Promise<RelayPassResult> {
    const rows = await this.claim();
    const out: RelayPassResult = { claimed: rows.length, published: 0, direct: 0, pending: 0 };
    for (const row of rows) {
      const r = await this.deliver(row).catch((error: Error) => {
        this.logger.error(`SAFETY outbox row ${row.id} failed: ${error.message}`);
        return 'pending' as const;
      });
      if (r === 'pending') {
        out.pending++;
        await this.prisma.outboxEvent.updateMany({ where: { id: row.id, publishedAt: null }, data: { availableAt: new Date(Date.now() + safetyBackoffMs(row.attempts)) } });
      } else out[r]++;
    }
    return out;
  }

  /** Claim due SAFETY rows: lease them (availableAt = now + lease) and count the attempt, in one short transaction. */
  private async claim(): Promise<OutboxEvent[]> {
    return this.prisma.$transaction(async (tx) => {
      const ids = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "OutboxEvent"
         WHERE "class" = 'SAFETY'::"OutboxClass" AND "publishedAt" IS NULL AND "deadAt" IS NULL AND "availableAt" <= now()
         ORDER BY "availableAt"
         LIMIT ${OUTBOX_BATCH}
         FOR UPDATE SKIP LOCKED`;
      if (!ids.length) return [];
      await tx.outboxEvent.updateMany({ where: { id: { in: ids.map((r) => r.id) } }, data: { availableAt: new Date(Date.now() + OUTBOX_LEASE_MS), attempts: { increment: 1 } } });
      return tx.outboxEvent.findMany({ where: { id: { in: ids.map((r) => r.id) } }, orderBy: { createdAt: 'asc' } });
    });
  }

  private async deliver(row: OutboxEvent): Promise<'published' | 'direct' | 'pending'> {
    const incident = await this.prisma.transportIncident.findUnique({ where: { id: row.aggregateId }, select: INCIDENT_SELECT });
    if (!incident) {
      // Removed by a legal process: nothing to deliver.
      await this.finish(row, null, 'NOTIFY_PUBLISHED', { skipped: 'incident removed' });
      return 'published';
    }
    const message = fanout(incident, row.type);
    const logIds = row.type === SOS_OUTBOX_TYPES.created ? await this.pushRows(row, incident) : [];
    try {
      await withTimeout(this.redis.client.publish(SOS_CHANNEL, JSON.stringify(message)), VALKEY_TIMEOUT_MS);
      if (logIds.length) {
        await withTimeout(this.redis.client.xadd(RedisKeys.notifyStream, 'MAXLEN', '~', NOTIFY_STREAM_MAXLEN, '*', 'logIds', JSON.stringify(logIds), 'companyId', row.companyId), VALKEY_TIMEOUT_MS);
      }
      await this.finish(row, incident, 'NOTIFY_PUBLISHED', { via: 'valkey', pushRows: logIds.length });
      return 'published';
    } catch (error) {
      const reason = (error as Error).message;
      const sockets = sosLocalBus.emit(message);
      const pushSent = logIds.length && this.direct ? await this.direct.sendRows(logIds) : 0;
      if (sockets > 0 || pushSent > 0) {
        await this.finish(row, incident, 'NOTIFY_DIRECT', { via: 'direct', sockets, pushSent, valkeyError: reason.slice(0, 200) });
        return 'direct';
      }
      await this.prisma.outboxEvent.updateMany({ where: { id: row.id, publishedAt: null }, data: { lastError: `Valkey down, nobody reachable directly: ${reason}`.slice(0, 500) } });
      return 'pending';
    }
  }

  /** Mark the row published; for the creation event also record the notification on the incident (append-only). */
  private async finish(row: OutboxEvent, incident: IncidentRow | null, kind: 'NOTIFY_PUBLISHED' | 'NOTIFY_DIRECT', data: Record<string, unknown>): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const r = await tx.outboxEvent.updateMany({ where: { id: row.id, publishedAt: null }, data: { publishedAt: new Date(), lastError: null } });
      if (r.count && incident && row.type === SOS_OUTBOX_TYPES.created) {
        await tx.transportIncidentEvent.create({ data: { incidentId: incident.id, kind, actorType: 'SYSTEM', data: { outboxId: row.id, attempts: row.attempts, ...data } as Prisma.InputJsonValue } });
      }
    });
  }

  /**
   * PUSH rows for the dispatcher logins of the companies that see the incident (raiser's company always, the other
   * party only with an ACTIVE agreement granting RECEIVE_INCIDENTS / MANAGE_INCIDENTS). One row per outbox row and
   * login (dedupeKey), generic text in the login's language; only logins with a signed-in app. Returns the QUEUED ids.
   */
  private async pushRows(row: OutboxEvent, incident: IncidentRow): Promise<string[]> {
    const companies = await this.recipientCompanies(incident);
    if (!companies.length) return [];
    const now = new Date();
    const users = await this.prisma.user.findMany({
      where: {
        companyId: { in: companies },
        isActive: true,
        roles: { some: { role: { permissions: { some: { menu: 'etms_incidents', actions: { has: 'view' } } } } } },
        pushTokens: { some: { OR: [{ sessionId: null }, { session: { revokedAt: null, expiresAt: { gt: now } } }] } },
      },
      select: { id: true, companyId: true, preferences: true },
      take: MAX_SOS_RECIPIENTS,
    });
    if (users.length) {
      await this.prisma.notificationLog.createMany({
        data: users.map((u) => {
          const lang = (u.preferences as { language?: unknown } | null)?.language;
          const text = sosPushText(typeof lang === 'string' ? lang : null);
          return { companyId: u.companyId, channel: 'PUSH' as const, recipient: `user:${u.id}`, subject: text.title, body: text.body, status: 'QUEUED' as const, refType: TRANSPORT_INCIDENT_REF, refId: incident.id, dedupeKey: `sos:${row.id}:${u.id}:PUSH` };
        }),
        skipDuplicates: true,
      });
    }
    const rows = await this.prisma.notificationLog.findMany({ where: { dedupeKey: { startsWith: `sos:${row.id}:` }, status: 'QUEUED' }, select: { id: true } });
    return rows.map((r) => r.id);
  }

  private async recipientCompanies(i: IncidentRow): Promise<string[]> {
    const own = i.raiserType === 'DRIVER' ? i.providerCompanyId : i.customerCompanyId;
    const other = i.raiserType === 'DRIVER' ? i.customerCompanyId : i.providerCompanyId;
    const out = new Set<string>();
    if (own) out.add(own);
    if (other && other !== own && i.providerCompanyId && i.customerCompanyId) {
      const now = new Date();
      const agreement = await this.prisma.transportServiceAgreement.findFirst({
        where: {
          providerCompanyId: i.providerCompanyId,
          customerCompanyId: i.customerCompanyId,
          status: 'ACTIVE',
          validFrom: { lte: now },
          OR: [{ validTo: null }, { validTo: { gt: now } }],
          grants: { hasSome: ['RECEIVE_INCIDENTS', 'MANAGE_INCIDENTS'] },
        },
        select: { id: true },
      });
      if (agreement) out.add(other);
    }
    return [...out];
  }
}

export function fanout(i: IncidentRow, type: string): SosFanoutMessage {
  const payload: TransportSosSocketPayload = {
    incidentId: i.id,
    kind: i.kind as IncidentKind,
    tripId: i.tripId,
    vehicle: i.vehicleLabel,
    raisedAt: i.raisedAt.toISOString(),
    status: (type === SOS_OUTBOX_TYPES.created ? 'OPEN' : i.status) as IncidentStatus,
  };
  return { providerCompanyId: i.providerCompanyId, customerCompanyId: i.customerCompanyId, raiserType: i.raiserType, payload };
}
