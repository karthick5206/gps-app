import { Injectable, Logger } from '@nestjs/common';
import { Alert, MessageTemplate, NotificationLog, NotificationStatus, NotifyChannel, Prisma } from '@prisma/client';
import { ALERT_TYPE_MAP, AlertSeverity, AlertTypeCode } from '@veetracer/shared';
import { hostname } from 'node:os';
import { RecipientExpander, Recipient } from '../alerts/recipients/recipient-expander';
import { RecipientListRow } from '../alerts/logic/recipients';
import { RulesRepository } from '../alerts/rules-data';
import { MailerService } from '../auth/mailer.service';
import { GeocodingService } from '../geocoding/geocoding.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisKeys } from '../redis/keys';
import { RedisService } from '../redis/redis.service';
import { htmlToText, isSendable } from '../templates/render';
import { loadAlertContext, Rendered, renderTemplate } from '../templates/template-renderer';
import { withRetries } from './retry';
import { createPushProvider, PushProvider } from './push';
import { createSmsProvider, SmsProvider } from './sms';

const READ_COUNT = 50;
const BLOCK_MS = 2000;
const CONCURRENCY = 8;
const CLAIM_IDLE_MS = 60_000;
const CLAIM_EVERY_MS = 30_000;
const CACHE_TTL_MS = 30_000;
const GEOCODE_TIMEOUT_MS = 4000;
const GEOCODE_MAX_INFLIGHT = 2;

type RawEntry = [id: string, fields: string[] | null];
interface Job {
  id: string;
  alertId: string | null;
  logIds: string[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function toJobs(raw: RawEntry[]): Job[] {
  return raw.map(([id, fields]) => {
    const job: Job = { id, alertId: null, logIds: [] };
    for (let i = 0; fields && i < fields.length; i += 2) {
      if (fields[i] === 'alertId') job.alertId = fields[i + 1];
      else if (fields[i] === 'logIds') {
        try {
          job.logIds = JSON.parse(fields[i + 1]) as string[];
        } catch {
          job.logIds = [];
        }
      }
    }
    return job;
  });
}

/**
 * Consumer group `notifier` on `vt:notify`. Alert jobs: fill the address, resolve recipients per channel for the
 * alert's severity, render the company template (system fallback) and send; test jobs: send pre-rendered QUEUED logs.
 */
@Injectable()
export class NotifierService {
  private readonly logger = new Logger('Notifier');
  private readonly consumer = process.env.NOTIFIER_CONSUMER ?? `notifier-${hostname()}`;
  private readonly sms: SmsProvider = createSmsProvider();
  private readonly push: PushProvider = createPushProvider();
  private readonly rules: RulesRepository;
  private readonly expander: RecipientExpander;
  private readonly lists = new Map<string, { rows: RecipientListRow[]; at: number }>();
  private readonly templates = new Map<string, { rows: MessageTemplate[]; at: number }>();
  private stopping = false;
  private geocodeInflight = 0;
  private lastClaimAt = 0;
  private stats = { jobs: 0, sent: 0, failed: 0, skipped: 0, ms: 0 };

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly mailer: MailerService,
    private readonly geocoding: GeocodingService,
  ) {
    this.rules = new RulesRepository(prisma);
    this.expander = new RecipientExpander(prisma);
  }

  stop(): void {
    this.stopping = true;
  }

  invalidate(companyId: string | null): void {
    this.rules.invalidate(companyId);
    if (!companyId) {
      this.lists.clear();
      this.templates.clear();
      return;
    }
    this.lists.delete(companyId);
    this.templates.delete(companyId);
  }

  async run(): Promise<void> {
    try {
      await this.redis.client.xgroup('CREATE', RedisKeys.notifyStream, RedisKeys.notifierGroup, '0', 'MKSTREAM');
      this.logger.log(`Created consumer group ${RedisKeys.notifierGroup}`);
    } catch (error) {
      if (!(error as Error).message.includes('BUSYGROUP')) throw error;
    }
    this.logger.log(`Consumer ${this.consumer} reading ${RedisKeys.notifyStream} (SMS provider: ${this.sms.name}, geocoder: ${this.geocoding.enabled ? 'on' : 'off'})`);
    const statsTimer = setInterval(() => this.logStats(), 30_000);
    let backlog = true;
    try {
      while (!this.stopping) {
        try {
          if (Date.now() - this.lastClaimAt > CLAIM_EVERY_MS) await this.claimStale();
          const jobs = await this.read(backlog ? '0' : '>');
          if (backlog && !jobs.length) backlog = false;
          await this.processAll(jobs);
        } catch (error) {
          this.logger.error(`Notifier loop error: ${(error as Error).message}`);
          await sleep(1000);
        }
      }
    } finally {
      clearInterval(statsTimer);
    }
  }

  private async read(id: '0' | '>'): Promise<Job[]> {
    const args = ['GROUP', RedisKeys.notifierGroup, this.consumer, 'COUNT', READ_COUNT] as const;
    const reply = (
      id === '>'
        ? await this.redis.client.xreadgroup(...args, 'BLOCK', BLOCK_MS, 'STREAMS', RedisKeys.notifyStream, id)
        : await this.redis.client.xreadgroup(...args, 'STREAMS', RedisKeys.notifyStream, id)
    ) as [string, RawEntry[]][] | null;
    return reply?.[0] ? toJobs(reply[0][1].filter(([, f]) => f !== null)) : [];
  }

  private async claimStale(): Promise<void> {
    this.lastClaimAt = Date.now();
    const [, raw] = (await this.redis.client.xautoclaim(
      RedisKeys.notifyStream,
      RedisKeys.notifierGroup,
      this.consumer,
      CLAIM_IDLE_MS,
      '0-0',
      'COUNT',
      READ_COUNT,
    )) as [string, RawEntry[]];
    const jobs = toJobs(raw.filter(([, f]) => f !== null));
    if (jobs.length) {
      this.logger.warn(`Re-claimed ${jobs.length} stale notification job(s)`);
      await this.processAll(jobs);
    }
  }

  private async processAll(jobs: Job[]): Promise<void> {
    if (!jobs.length) return;
    let next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        const started = Date.now();
        try {
          if (job.alertId) await this.handleAlert(job.alertId);
          if (job.logIds.length) await this.handleLogs(job.logIds);
        } catch (error) {
          this.logger.error(`Job ${job.id} failed: ${(error as Error).message}`);
        }
        this.stats.jobs++;
        this.stats.ms += Date.now() - started;
        await this.redis.client.xack(RedisKeys.notifyStream, RedisKeys.notifierGroup, job.id);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
  }

  // ───────────── alert jobs ─────────────
  async handleAlert(alertId: string): Promise<void> {
    const alert = await this.prisma.alert.findUnique({ where: { id: alertId } });
    if (!alert) return;
    // Re-delivered job (crash between sending and XACK): don't notify twice.
    if (await this.prisma.notificationLog.count({ where: { alertId } })) return;
    await this.fillAddress(alert);
    const ctx = await loadAlertContext(this.prisma, alert);
    if (!ctx) return;

    const rules = await this.rules.get(alert.companyId);
    const setting = rules.effective(alert.objectId).get(alert.type as AlertTypeCode);
    const channels = (setting?.channels[alert.severity as AlertSeverity] ?? []).filter((c) => c !== 'INAPP');
    if (!channels.length) return;

    const lists = await this.listsFor(alert.companyId);
    const chain = await this.expander.chainFor(ctx.object);
    const resolved = await this.expander.resolve(ctx.object, alert.type, alert.severity as AlertSeverity, channels, lists, chain);
    const label = ALERT_TYPE_MAP[alert.type as AlertTypeCode]?.label ?? alert.type;

    for (const c of resolved) {
      if (!c.recipients.length) continue;
      const template = c.channel === 'WHATSAPP' ? null : await this.templateFor(alert.companyId, alert.type, c.channel);
      const rendered: Rendered = template
        ? renderTemplate(template, ctx.vars)
        : {
            templateId: null,
            subject: `[${alert.severity}] ${label}: ${ctx.object.name}`,
            body: `${label}: ${ctx.object.name} — ${alert.message} (${ctx.vars.time}) ${ctx.vars.map_link}`,
            text: `${label}: ${ctx.object.name} — ${alert.message} (${ctx.vars.time}) ${ctx.vars.map_link}`,
            missing: [],
          };
      await Promise.all(c.recipients.map((r) => this.deliver(alert, c.channel, r, rendered)));
    }
  }

  /** Reverse-geocode the alert position (bounded concurrency + timeout; never blocks delivery for long). */
  private async fillAddress(alert: Alert): Promise<void> {
    if (alert.address || alert.lat === null || alert.lng === null || !this.geocoding.enabled) return;
    if (this.geocodeInflight >= GEOCODE_MAX_INFLIGHT) return;
    this.geocodeInflight++;
    try {
      const address = await Promise.race([
        this.geocoding.reverse(alert.lat, alert.lng),
        sleep(GEOCODE_TIMEOUT_MS).then(() => null),
      ]);
      if (address) {
        alert.address = address;
        await this.prisma.alert.update({ where: { id: alert.id }, data: { address } });
      }
    } catch (error) {
      this.logger.warn(`Address lookup failed: ${(error as Error).message}`);
    } finally {
      this.geocodeInflight--;
    }
  }

  private async deliver(alert: Alert, channel: NotifyChannel, r: Recipient, msg: Rendered): Promise<void> {
    const base = {
      companyId: alert.companyId,
      alertId: alert.id,
      channel,
      recipient: r.address,
      templateId: msg.templateId,
      subject: msg.subject,
      body: msg.body,
    };
    if (channel === 'WHATSAPP') {
      await this.writeLog({ ...base, status: 'SKIPPED', error: 'WhatsApp not configured', provider: null });
      return;
    }
    if (channel === 'PUSH') {
      const res = await this.sendPush(r.address, msg, { alertId: alert.id, objectId: alert.objectId, type: alert.type, severity: alert.severity });
      await this.writeLog({ ...base, ...res, provider: this.push.name });
      return;
    }
    const { error } = await withRetries(() => this.send(channel, r.address, msg));
    await this.writeLog({ ...base, status: error ? 'FAILED' : 'SENT', error, provider: channel === 'SMS' ? this.sms.name : 'mailer' });
  }

  private send(channel: NotifyChannel, to: string, msg: Rendered): Promise<unknown> {
    if (channel === 'EMAIL') return this.mailer.send({ to, subject: msg.subject ?? '(no subject)', html: msg.body, text: msg.text || htmlToText(msg.body) });
    if (channel === 'SMS') {
      return this.sms.send({ to, text: msg.text, dltTemplateId: msg.dltTemplateId, senderId: msg.senderId, variables: msg.dltValues });
    }
    return Promise.reject(new Error(`${channel} not configured`));
  }

/**
   * Push to every app install of a user (`user:<id>`) whose sign-in session is still valid.
   * Tokens the push service reports as unregistered are deleted.
   */
  private async sendPush(recipient: string, msg: Rendered, data: Record<string, unknown>): Promise<{ status: NotificationStatus; error: string | null }> {
    if (!this.push.enabled) return { status: 'SKIPPED', error: 'Push not configured' };
    const userId = recipient.startsWith('user:') ? recipient.slice(5) : null;
    if (!userId) return { status: 'SKIPPED', error: 'Not a user recipient' };
    const now = new Date();
    const rows = await this.prisma.pushToken.findMany({
      where: { userId, OR: [{ sessionId: null }, { session: { revokedAt: null, expiresAt: { gt: now } } }] },
      select: { token: true },
    });
    if (!rows.length) return { status: 'SKIPPED', error: 'Mobile app not signed in' };
    const title = msg.subject?.trim() || 'VeeTrax alert';
    const body = (msg.text || htmlToText(msg.body)).slice(0, 500);
    let result: Awaited<ReturnType<PushProvider['send']>> | null = null;
    const { error } = await withRetries(async () => {
      result = await this.push.send(rows.map((r) => r.token), { title, body, data });
    });
    const res = result as Awaited<ReturnType<PushProvider['send']>> | null;
    if (res?.invalidTokens.length) await this.prisma.pushToken.deleteMany({ where: { token: { in: res.invalidTokens } } });
    if (error) return { status: 'FAILED', error };
    if (!res?.sent) return { status: 'FAILED', error: res?.error ?? 'No device accepted the push' };
    return { status: 'SENT', error: res.error };
  }

  private async writeLog(data: Prisma.NotificationLogUncheckedCreateInput & { status: NotificationStatus }): Promise<void> {
    await this.prisma.notificationLog.create({ data: { ...data, sentAt: data.status === 'SENT' ? new Date() : null } });
    if (data.status === 'SENT') this.stats.sent++;
    else if (data.status === 'FAILED') this.stats.failed++;
    else this.stats.skipped++;
  }

  // ───────────── pre-rendered (test) jobs ─────────────
  async handleLogs(ids: string[]): Promise<void> {
    const logs = await this.prisma.notificationLog.findMany({ where: { id: { in: ids }, status: 'QUEUED' } });
    await Promise.all(logs.map((log) => this.sendLog(log)));
  }

  private async sendLog(log: NotificationLog): Promise<void> {
    let status: NotificationStatus;
    let error: string | null = null;
    let provider: string | null = null;
    if (log.channel === 'PUSH') {
      ({ status, error } = await this.sendPush(log.recipient, { templateId: log.templateId, subject: log.subject, body: log.body, text: log.body, missing: [] }, { test: true }));
      provider = this.push.name;
    } else if (log.channel === 'WHATSAPP' || log.channel === 'INAPP') {
      status = 'SKIPPED';
      error = `${log.channel} not configured`;
    } else {
      let msg: Rendered = { templateId: log.templateId, subject: log.subject, body: log.body, text: log.channel === 'EMAIL' ? htmlToText(log.body) : log.body, missing: [] };
      if (log.channel === 'SMS' && log.templateId) {
        const t = await this.prisma.messageTemplate.findUnique({ where: { id: log.templateId }, select: { dltTemplateId: true, senderId: true } });
        msg = { ...msg, dltTemplateId: t?.dltTemplateId ?? null, senderId: t?.senderId ?? null };
      }
      const result = await withRetries(() => this.send(log.channel, log.recipient, msg));
      error = result.error;
      status = error ? 'FAILED' : 'SENT';
      provider = log.channel === 'SMS' ? this.sms.name : 'mailer';
    }
    await this.prisma.notificationLog.update({ where: { id: log.id }, data: { status, error, provider, sentAt: status === 'SENT' ? new Date() : null } });
    if (status === 'SENT') this.stats.sent++;
    else if (status === 'FAILED') this.stats.failed++;
    else this.stats.skipped++;
  }

  // ───────────── caches ─────────────
  private async listsFor(companyId: string): Promise<RecipientListRow[]> {
    const hit = this.lists.get(companyId);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.rows;
    const rows = await this.expander.loadLists(companyId);
    this.lists.set(companyId, { rows, at: Date.now() });
    return rows;
  }

  private async templateFor(companyId: string, purpose: string, channel: NotifyChannel): Promise<MessageTemplate | null> {
    let hit = this.templates.get(companyId);
    if (!hit || Date.now() - hit.at > CACHE_TTL_MS) {
      const rows = await this.prisma.messageTemplate.findMany({ where: { OR: [{ companyId: null }, { companyId }], language: 'en' } });
      hit = { rows, at: Date.now() };
      this.templates.set(companyId, hit);
    }
    const candidates = hit.rows.filter((t) => t.purpose === purpose && t.channel === channel && isSendable(t));
    return candidates.find((t) => t.companyId === companyId) ?? candidates.find((t) => t.companyId === null) ?? null;
  }

  private logStats(): void {
    const s = this.stats;
    if (!s.jobs) return;
    this.stats = { jobs: 0, sent: 0, failed: 0, skipped: 0, ms: 0 };
    this.logger.log(`jobs=${s.jobs} sent=${s.sent} failed=${s.failed} skipped=${s.skipped} avgJobMs=${(s.ms / s.jobs).toFixed(1)}`);
  }
}
