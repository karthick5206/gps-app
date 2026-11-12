import { Injectable, Logger, Optional } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { OutboxEvent, Prisma } from '@prisma/client';
import { SOS_OUTBOX_TYPES, SOS_RELAY_LATE_MS, sosLatePushText, sosPushText, type IncidentKind, type IncidentStatus, type TransportSosSocketPayload } from '@veetracer/shared';
import { NOTIFY_STREAM_MAXLEN } from '../../alerts/alert-dto';
import { PrismaService } from '../../prisma/prisma.service';
import { RedisKeys } from '../../redis/keys';
import { RedisService } from '../../redis/redis.service';
import { etmsServerEnabled } from '../transport-feature.guard';
import { SOS_CHANNEL, sosLocalBus, type SosFanoutMessage } from './sos-bus';
import { SosDirectSender, TRANSPORT_INCIDENT_LATE_REF, TRANSPORT_INCIDENT_REF } from './sos-direct-sender';
import { incidentAccess, safetyBackoffMs } from './sos-rules';
import { providerAgreementScopes } from '../../access/auth-context.service';
import { companyFeatures } from '../../common/company-features';

/** Lease of a claimed outbox row: another relay instance may take it over after this (at-least-once). */
export const OUTBOX_LEASE_MS = 30_000;
export const OUTBOX_BATCH = 50;
/** A Valkey command that does not answer within this time counts as "Valkey down" (ioredis may queue while reconnecting). */
export const VALKEY_TIMEOUT_MS = 2_000;
/** Dispatcher logins pushed per incident (company users holding etms_incidents:view). */
export const MAX_SOS_RECIPIENTS = 200;
/**
 * QA B9: while NO company has the ETMS add-on and nothing is due, the 2 s tick backs off (2 s → 4 → … → 30 s) and
 * only re-checks (two tiny queries per step). With an ETMS company the poll stays at 2 s (SOS latency ≤ 2 s across API
 * instances), but an idle tick is one non-transactional EXISTS on the partial pending index instead of BEGIN / SKIP
 * LOCKED / COMMIT. An SOS raised in this process kicks the relay at once, whatever the back-off.
 */
export const RELAY_POLL_MS = 2_000;
export const RELAY_IDLE_MAX_MS = 30_000;

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
 *
 * Security review M2 (stale replay): rows that waited (relay off, rollback to a version without the relay, long outage)
 * never ring as a new SOS. A creation row whose incident is no longer OPEN is settled with a socket refresh carrying
 * the real status and no push; one still OPEN but older than SOS_RELAY_LATE_MS (15 min) gets the quiet "missed SOS,
 * still open since HH:MM" push (no siren). A still-OPEN SOS is never dropped.
 */
@Injectable()
export class SafetyOutboxRelayService {
  private readonly logger = new Logger('EtmsSafetyRelay');
  private running = false;
  private again = false;
  /** B9 back-off while no company has ETMS: next company check not before this time; current step. */
  private idleUntil = 0;
  private idleStep = RELAY_POLL_MS;
  /** Tests: the clock. */
  now: () => number = () => Date.now();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    @Optional() private readonly direct?: SosDirectSender,
  ) {}

  get enabled(): boolean {
    return etmsServerEnabled() && (process.env.ETMS_SOS_RELAY ?? 'on').toLowerCase() !== 'off';
  }

  @Interval(RELAY_POLL_MS)
  async tick(force = false): Promise<void> {
    if (!this.enabled) return;
    if (this.running) {
      this.again = true;
      return;
    }
    if (!force && this.now() < this.idleUntil) return;
    this.running = true;
    try {
      if (!force) {
        // Rows still due (e.g. the last ETMS company was switched off after an SOS) are relayed in any case.
        const due = await this.anyDue();
        if (!due && !(await this.anyEtmsCompany())) {
          this.idleStep = Math.min(RELAY_IDLE_MAX_MS, this.idleStep * 2);
          this.idleUntil = this.now() + this.idleStep;
          return;
        }
        this.idleStep = RELAY_POLL_MS;
        this.idleUntil = 0;
        if (!due) return;
      } else {
        this.idleStep = RELAY_POLL_MS;
        this.idleUntil = 0;
      }
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

  /** Run a pass now (after an SOS commit) instead of waiting for the next tick, whatever the back-off. Never throws. */
  kick(): void {
    setImmediate(() => void this.tick(true));
  }

  /** B9: any active, non-platform company with the ETMS add-on (an SOS can only be raised in one). */
  private async anyEtmsCompany(): Promise<boolean> {
    const [r] = await this.prisma.$queryRaw<{ any: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM "Company" WHERE "status" = 'ACTIVE' AND NOT "isPlatform" AND "settings"->'features' @> '["etms"]'::jsonb) AS "any"`;
    return r?.any === true;
  }

  /** B9: a due SAFETY row exists (partial pending index; no transaction, no lock). */
  private async anyDue(): Promise<boolean> {
    const [r] = await this.prisma.$queryRaw<{ any: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM "OutboxEvent" WHERE "class" = 'SAFETY'::"OutboxClass" AND "publishedAt" IS NULL AND "deadAt" IS NULL AND "availableAt" <= now()) AS "any"`;
    return r?.any === true;
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
    const message = fanout(incident);
    // L1: a "linked" row (a repeat press added the other party) is delivered like a creation, to that party only.
    const linked = row.type === SOS_OUTBOX_TYPES.linked;
    const creation = row.type === SOS_OUTBOX_TYPES.created || linked;
    if (creation && incident.status !== 'OPEN') {
      // M2: handled meanwhile (from the polled lane): refresh the lanes with the real status, never a siren.
      await this.refreshOnly(message);
      await this.finish(row, null, 'NOTIFY_PUBLISHED', {});
      this.logger.log(`SAFETY outbox row ${row.id}: incident already ${incident.status}, settled without a push`);
      return 'published';
    }
    const late = creation && Date.now() - row.createdAt.getTime() > SOS_RELAY_LATE_MS;
    const logIds = creation ? await this.pushRows(row, incident, late, linked) : [];
    try {
      await withTimeout(this.redis.client.publish(SOS_CHANNEL, JSON.stringify(message)), VALKEY_TIMEOUT_MS);
      if (logIds.length) {
        await withTimeout(this.redis.client.xadd(RedisKeys.notifyStream, 'MAXLEN', '~', NOTIFY_STREAM_MAXLEN, '*', 'logIds', JSON.stringify(logIds), 'companyId', row.companyId), VALKEY_TIMEOUT_MS);
      }
      await this.finish(row, incident, 'NOTIFY_PUBLISHED', { via: 'valkey', pushRows: logIds.length, ...(late ? { late: true } : {}) });
      return 'published';
    } catch (error) {
      const reason = (error as Error).message;
      const sockets = sosLocalBus.emit(message);
      const pushSent = logIds.length && this.direct ? await this.direct.sendRows(logIds) : 0;
      if (sockets > 0 || pushSent > 0) {
        await this.finish(row, incident, 'NOTIFY_DIRECT', { via: 'direct', sockets, pushSent, valkeyError: reason.slice(0, 200), ...(late ? { late: true } : {}) });
        return 'direct';
      }
      await this.prisma.outboxEvent.updateMany({ where: { id: row.id, publishedAt: null }, data: { lastError: `Valkey down, nobody reachable directly: ${reason}`.slice(0, 500) } });
      return 'pending';
    }
  }

  /** Socket refresh only (Valkey, else this process's sockets); best effort: the lanes also poll PostgreSQL. */
  private async refreshOnly(message: SosFanoutMessage): Promise<void> {
    try {
      await withTimeout(this.redis.client.publish(SOS_CHANNEL, JSON.stringify(message)), VALKEY_TIMEOUT_MS);
    } catch {
      sosLocalBus.emit(message);
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
   * PUSH rows for the dispatcher logins of the companies that see the incident (recipientCompanies: the same rule as
   * the incidents lane). One row per outbox row and
   * login (dedupeKey), generic text in the login's language; only logins with a signed-in app. Returns the QUEUED ids.
   * `late` (M2): the quiet "still open since HH:MM" form (company time zone), no siren.
   */
  private async pushRows(row: OutboxEvent, incident: IncidentRow, late = false, otherPartyOnly = false): Promise<string[]> {
    const own = incident.raiserType === 'DRIVER' ? incident.providerCompanyId : incident.customerCompanyId;
    const companies = (await this.recipientCompanies(incident)).filter((c) => !otherPartyOnly || c !== own);
    if (!companies.length) return [];
    const now = new Date();
    const users = await this.prisma.user.findMany({
      where: {
        companyId: { in: companies },
        isActive: true,
        roles: { some: { role: { permissions: { some: { menu: 'etms_incidents', actions: { has: 'view' } } } } } },
        pushTokens: { some: { OR: [{ sessionId: null }, { session: { revokedAt: null, expiresAt: { gt: now } } }] } },
      },
      select: { id: true, companyId: true, preferences: true, company: { select: { timezone: true } } },
      take: MAX_SOS_RECIPIENTS,
    });
    if (users.length) {
      await this.prisma.notificationLog.createMany({
        data: users.map((u) => {
          const lang = (u.preferences as { language?: unknown } | null)?.language;
          const language = typeof lang === 'string' ? lang : null;
          const text = late ? sosLatePushText(language, clockTime(incident.raisedAt, u.company?.timezone)) : sosPushText(language);
          return { companyId: u.companyId, channel: 'PUSH' as const, recipient: `user:${u.id}`, subject: text.title, body: text.body, status: 'QUEUED' as const, refType: late ? TRANSPORT_INCIDENT_LATE_REF : TRANSPORT_INCIDENT_REF, refId: incident.id, dedupeKey: `sos:${row.id}:${u.id}:PUSH` };
        }),
        skipDuplicates: true,
      });
    }
    const rows = await this.prisma.notificationLog.findMany({ where: { dedupeKey: { startsWith: `sos:${row.id}:` }, status: 'QUEUED' }, select: { id: true } });
    return rows.map((r) => r.id);
  }

  /**
   * Security review L4 / QA B6: the companies whose dispatchers may see the incident, by exactly the lane's rule —
   * each party gets the AuthContext it would have on a request (add-on `etms` on, active company; a provider's
   * agreements only with `etmsProvider`, through providerAgreementScopes = AuthContextService.agreementsOf, which also
   * requires the customer to be active, non-platform and ETMS-on) and must pass incidentAccess. A company whose module
   * is off gets no push (its etms_incidents menu is stripped too).
   */
  async recipientCompanies(i: Pick<IncidentRow, 'raiserType' | 'providerCompanyId' | 'customerCompanyId'>): Promise<string[]> {
    const ids = [...new Set([i.providerCompanyId, i.customerCompanyId].filter((x): x is string => !!x))];
    if (!ids.length) return [];
    const companies = await this.prisma.company.findMany({ where: { id: { in: ids } }, select: { id: true, status: true, settings: true, isPlatform: true } });
    const out: string[] = [];
    for (const c of companies) {
      const features = companyFeatures(c);
      if (c.status !== 'ACTIVE' || !features.includes('etms')) continue;
      const agreements = c.id === i.providerCompanyId && features.includes('etmsProvider') ? await providerAgreementScopes(this.prisma, c.id) : [];
      if (incidentAccess({ companyId: c.id, homeCompanyId: c.id, isSuperAdmin: false, agreements }, i) !== 'none') out.push(c.id);
    }
    return ids.filter((id) => out.includes(id));
  }
}

/** "09:41" in the company's time zone (24 h; falls back to UTC for an unknown zone). */
export function clockTime(at: Date, timezone: string | null | undefined): string {
  const fmt = (timeZone: string) => new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
  try {
    return fmt(timezone || 'UTC');
  } catch {
    return fmt('UTC');
  }
}

/** Socket payload: always the incident's CURRENT status (M2: a late creation row of a handled SOS is no "OPEN"). */
export function fanout(i: IncidentRow): SosFanoutMessage {
  const payload: TransportSosSocketPayload = {
    incidentId: i.id,
    kind: i.kind as IncidentKind,
    tripId: i.tripId,
    vehicle: i.vehicleLabel,
    raisedAt: i.raisedAt.toISOString(),
    status: i.status as IncidentStatus,
  };
  return { providerCompanyId: i.providerCompanyId, customerCompanyId: i.customerCompanyId, raiserType: i.raiserType, payload };
}
