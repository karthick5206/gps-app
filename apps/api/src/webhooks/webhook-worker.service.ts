import { Injectable, Logger } from '@nestjs/common';
import { WebhookEndpoint } from '@prisma/client';
import { ALERT_TYPE_MAP, AlertTypeCode } from '@veetracer/shared';
import { hostname } from 'node:os';
import { MailerService } from '../auth/mailer.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisKeys } from '../redis/keys';
import { RedisService } from '../redis/redis.service';
import { alertEvents, WebhookEventMessage } from './events';
import { queueEvent } from './fanout';
import { refreshWebhookCompany, syncWebhookCompanies } from './webhook-companies';
import { WebhookSender } from './webhook-sender';

const READ_COUNT = 50;
const BLOCK_MS = 2000;
const CONCURRENCY = 8;
const POLL_EVERY_MS = 15_000;
const CLAIM_IDLE_MS = 60_000;

type RawEntry = [id: string, fields: string[] | null];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Webhook delivery, running inside the notifier process. Consumer group `webhooks` on `vt:webhooks`:
 * `event` entries fan out to the subscribed endpoints, `deliveryId` entries (tests, redeliveries) are sent at once.
 * Retries are due rows in WebhookDelivery, picked up every 15 s, so nothing is lost across restarts.
 */
@Injectable()
export class WebhookWorkerService {
  private readonly logger = new Logger('Webhooks');
  private readonly consumer = `${process.env.NOTIFIER_CONSUMER ?? `notifier-${hostname()}`}-wh`;
  readonly sender: WebhookSender;
  private stopping = false;
  private inflight = 0;
  private stats = { sent: 0, failed: 0 };

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly mailer: MailerService,
  ) {
    this.sender = new WebhookSender(prisma, { onEndpointDisabled: (ep, reason) => this.notifyDisabled(ep, reason) });
  }

  stop(): void {
    this.stopping = true;
  }

  /** Alert jobs from `vt:notify`: alert.created plus geofence.enter / geofence.exit / fuel.event by type. */
  async onAlert(alertId: string): Promise<void> {
    const alert = await this.prisma.alert.findUnique({ where: { id: alertId } });
    if (!alert) return;
    const has = await this.redis.client.sismember(RedisKeys.webhookCompanies, alert.companyId);
    if (!has) return;
    const object = await this.prisma.trackedObject.findUnique({ where: { id: alert.objectId }, select: { name: true, plateNumber: true } });
    const geofence = alert.geofenceId ? await this.prisma.geofence.findUnique({ where: { id: alert.geofenceId }, select: { name: true } }) : null;
    const data = {
      alertId: alert.id,
      vehicleId: alert.objectId,
      vehicleName: object?.name ?? null,
      plateNumber: object?.plateNumber ?? null,
      type: alert.type,
      typeLabel: ALERT_TYPE_MAP[alert.type as AlertTypeCode]?.label ?? alert.type,
      severity: alert.severity,
      message: alert.message,
      occurredAt: alert.occurredAt.toISOString(),
      lat: alert.lat,
      lng: alert.lng,
      address: alert.address,
      geofenceId: alert.geofenceId,
      geofenceName: geofence?.name ?? null,
      details: alert.data,
    };
    for (const type of alertEvents(alert.type)) {
      await this.handleEvent({ id: `${type}_${alert.id}`, type, companyId: alert.companyId, occurredAt: alert.occurredAt.toISOString(), data });
    }
  }

  async handleEvent(e: WebhookEventMessage): Promise<void> {
    const ids = await queueEvent(this.prisma, e);
    await Promise.all(ids.map((id) => this.send(id)));
  }

  private async send(id: string): Promise<void> {
    this.inflight++;
    try {
      const d = await this.sender.attempt(id);
      if (d?.status === 'SUCCEEDED') this.stats.sent++;
      else if (d) this.stats.failed++;
    } catch (error) {
      this.logger.error(`Delivery ${id} failed: ${(error as Error).message}`);
    } finally {
      this.inflight--;
    }
  }

  async run(): Promise<void> {
    try {
      await this.redis.client.xgroup('CREATE', RedisKeys.webhooksStream, RedisKeys.webhooksGroup, '0', 'MKSTREAM');
    } catch (error) {
      if (!(error as Error).message.includes('BUSYGROUP')) throw error;
    }
    await syncWebhookCompanies(this.prisma, this.redis.client).catch((e: Error) => this.logger.warn(`Company set sync failed: ${e.message}`));
    this.logger.log(`Consumer ${this.consumer} reading ${RedisKeys.webhooksStream}`);
    const poller = setInterval(() => void this.pollDue(), POLL_EVERY_MS);
    const statsTimer = setInterval(() => this.logStats(), 60_000);
    let backlog = true;
    try {
      while (!this.stopping) {
        try {
          const entries = await this.read(backlog ? '0' : '>');
          if (backlog && !entries.length) {
            backlog = false;
            await this.claimStale();
          }
          await this.processEntries(entries);
        } catch (error) {
          this.logger.error(`Webhook loop error: ${(error as Error).message}`);
          await sleep(1000);
        }
      }
    } finally {
      clearInterval(poller);
      clearInterval(statsTimer);
    }
  }

  private async read(id: '0' | '>'): Promise<RawEntry[]> {
    const args = ['GROUP', RedisKeys.webhooksGroup, this.consumer, 'COUNT', READ_COUNT] as const;
    const reply = (
      id === '>'
        ? await this.redis.client.xreadgroup(...args, 'BLOCK', BLOCK_MS, 'STREAMS', RedisKeys.webhooksStream, id)
        : await this.redis.client.xreadgroup(...args, 'STREAMS', RedisKeys.webhooksStream, id)
    ) as [string, RawEntry[]][] | null;
    return reply?.[0]?.[1] ?? [];
  }

  private async claimStale(): Promise<void> {
    const [, raw] = (await this.redis.client.xautoclaim(RedisKeys.webhooksStream, RedisKeys.webhooksGroup, this.consumer, CLAIM_IDLE_MS, '0-0', 'COUNT', READ_COUNT)) as [string, RawEntry[]];
    await this.processEntries(raw);
  }

  private async processEntries(entries: RawEntry[]): Promise<void> {
    let next = 0;
    const worker = async () => {
      while (next < entries.length) {
        const [id, fields] = entries[next++];
        try {
          for (let i = 0; fields && i < fields.length; i += 2) {
            if (fields[i] === 'event') await this.handleEvent(JSON.parse(fields[i + 1]) as WebhookEventMessage);
            else if (fields[i] === 'deliveryId') await this.send(fields[i + 1]);
          }
        } catch (error) {
          this.logger.error(`Webhook entry ${id} failed: ${(error as Error).message}`);
        }
        await this.redis.client.xack(RedisKeys.webhooksStream, RedisKeys.webhooksGroup, id);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, entries.length) }, worker));
  }

  /** Retries (and anything not sent at once) whose time has come. */
  async pollDue(now = new Date()): Promise<void> {
    if (this.stopping || this.inflight > CONCURRENCY * 4) return;
    try {
      const due = await this.prisma.webhookDelivery.findMany({
        where: { status: { in: ['PENDING', 'RETRYING'] }, nextAttemptAt: { lte: now } },
        orderBy: { nextAttemptAt: 'asc' },
        take: 100,
        select: { id: true },
      });
      // Brand-new rows have no nextAttemptAt yet; send those left behind (e.g. crash before the first attempt).
      const stale = await this.prisma.webhookDelivery.findMany({
        where: { status: 'PENDING', nextAttemptAt: null, createdAt: { lt: new Date(now.getTime() - 60_000) } },
        take: 100,
        select: { id: true },
      });
      const ids = [...due, ...stale].map((d) => d.id);
      for (let i = 0; i < ids.length; i += CONCURRENCY) await Promise.all(ids.slice(i, i + CONCURRENCY).map((id) => this.send(id)));
    } catch (error) {
      this.logger.error(`Retry poll failed: ${(error as Error).message}`);
    }
  }

  /** E-mails the company's admins when an endpoint is switched off (the Developer API page also shows it). */
  private async notifyDisabled(endpoint: WebhookEndpoint, reason: string): Promise<void> {
    await refreshWebhookCompany(this.prisma, this.redis.client, endpoint.companyId);
    const admins = await this.prisma.user.findMany({
      where: { companyId: endpoint.companyId, isActive: true, email: { not: null }, roles: { some: { role: { name: 'Admin', isSystem: true } } } },
      select: { email: true },
      take: 20,
    });
    await this.prisma.auditLog.create({
      data: { companyId: endpoint.companyId, userId: null, action: 'UPDATE', entity: 'WebhookEndpoint', entityId: endpoint.id, changes: { isActive: { from: true, to: false }, reason } },
    });
    const subject = `VeeTrax webhook disabled: ${endpoint.name}`;
    const text = `The webhook endpoint "${endpoint.name}" (${endpoint.url}) was switched off. ${reason}\n\nFix the receiver, then turn the endpoint back on under Administration → Developer API → Webhooks.`;
    for (const a of admins) {
      if (a.email) await this.mailer.send({ to: a.email, subject, text, html: `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>` }).catch(() => undefined);
    }
  }

  private logStats(): void {
    if (!this.stats.sent && !this.stats.failed) return;
    this.logger.log(`webhooks sent=${this.stats.sent} failed=${this.stats.failed}`);
    this.stats = { sent: 0, failed: 0 };
  }
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
