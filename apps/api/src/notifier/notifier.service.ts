import { ensureStreamGroup, isNoGroupError } from '../redis/stream-groups';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { WebhookWorkerService } from '../webhooks/webhook-worker.service';
import { Alert, MessageTemplate, NotificationLog, NotificationStatus, NotifyChannel } from '@prisma/client';
import { ALERT_TYPE_MAP, AlertSeverity, AlertTypeCode, isParkingAlarm, NotifierMetrics } from '@veetracer/shared';
import { hostname } from 'node:os';
import { RecipientExpander, Recipient } from '../alerts/recipients/recipient-expander';
import { RecipientListRow } from '../alerts/logic/recipients';
import { RulesRepository } from '../alerts/rules-data';
import { MailAttachment, MailerService } from '../auth/mailer.service';
import { APP_ENV } from '../config/config.module';
import { AppEnv } from '../config/env';
import { DriverEventWorkerService } from '../driver-events/driver-event-worker.service';
import { mediaPath } from '../driver-events/media-store';
import { RateMeter } from '../monitoring/heartbeat';
import { GeocodingService } from '../geocoding/geocoding.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisKeys } from '../redis/keys';
import { RedisService } from '../redis/redis.service';
import { htmlToText, isSendable } from '../templates/render';
import { loadAlertContext, Rendered, renderTemplate } from '../templates/template-renderer';
import { withRetries } from './retry';
import { createPushProvider, PushProvider, pushStyle, transportPushData } from './push';
import { TRANSPORT_PUSH_CHANNEL } from '@veetracer/shared';
import { ArattaiOtp } from './arattai';
import { createSmsProvider, SmsProvider } from './sms';
import { notConfiguredReason, outcome, writesDevCopy } from './delivery-outcome';
import { dedupeKey, deadBeforeRun, deadReason, maskRecipient, MAX_DELIVERIES, onJobFailure, providerRef } from './delivery-state';
import { FinishInput, NotificationLedger } from './notification-ledger';
import type { NotifySweeper } from './notify-sweeper';

const READ_COUNT = 50;
const BLOCK_MS = 2000;
const CONCURRENCY = 8;
const CLAIM_IDLE_MS = 60_000;
const CLAIM_EVERY_MS = 30_000;
const CACHE_TTL_MS = 30_000;
const GEOCODE_TIMEOUT_MS = 4000;
const GEOCODE_MAX_INFLIGHT = 2;
/** Driver event e-mails wait this long for the dashcam snapshot (other channels are never delayed). */
const EMAIL_SNAPSHOT_WAIT_MS = Number(process.env.DRIVER_EVENT_EMAIL_WAIT_MS ?? 25_000);

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
  private readonly ledger: NotificationLedger;
  /** Jobs declared DEAD since start (delivery budget used up). */
  deadJobs = 0;
  /** Last DEAD job; separate from lastError, which the next ordinary failure overwrites (D6 G2). */
  private lastDead: { message: string; at: string } | null = null;
  /** The sweeper of this process (notifier/main.ts), for the un-notified alert counts in the heartbeat. */
  private sweeper: Pick<NotifySweeper, 'stats'> | null = null;
  private readonly lists = new Map<string, { rows: RecipientListRow[]; at: number }>();
  private readonly templates = new Map<string, { rows: MessageTemplate[]; at: number }>();
  private stopping = false;
  private geocodeInflight = 0;
  private lastClaimAt = 0;
  private stats = { jobs: 0, sent: 0, failed: 0, skipped: 0, ms: 0 };
  private arattaiClient: ArattaiOtp | null = null;
  private switches: { at: number; row: { smsEnabled: boolean; emailEnabled: boolean; whatsappEnabled: boolean; arattaiEnabled: boolean } | null } | null = null;
  /** E-mails waiting for a driver event snapshot. */
  private readonly deferred = new Set<Promise<void>>();
  /** Since start, for the System Health heartbeat. */
  private readonly totals = { jobs: 0, sent: {} as Record<string, number>, failed: {} as Record<string, number>, skipped: 0 };
  private lastError: { message: string; at: string } | null = null;
  private readonly jobRate = new RateMeter();

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly mailer: MailerService,
    private readonly geocoding: GeocodingService,
    @Optional() private readonly webhooks?: WebhookWorkerService,
    @Optional() private readonly driverEvents?: DriverEventWorkerService,
    @Optional() @Inject(APP_ENV) private readonly env?: AppEnv,
  ) {
    this.rules = new RulesRepository(prisma);
    this.expander = new RecipientExpander(prisma);
    this.ledger = new NotificationLedger(prisma);
  }

  stop(): void {
    this.stopping = true;
  }

  /** Waits for deferred (snapshot) e-mails before the process exits. */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.deferred]);
  }

  attachSweeper(sweeper: Pick<NotifySweeper, 'stats'>): void {
    this.sweeper = sweeper;
  }

  metrics(): NotifierMetrics {
    const sweep = this.sweeper?.stats();
    return {
      jobs: this.totals.jobs,
      jobsPerSec: this.jobRate.rate(this.totals.jobs),
      sent: { ...this.totals.sent },
      failed: { ...this.totals.failed },
      skipped: this.totals.skipped,
      lastError: this.lastError,
      deadJobs: this.deadJobs,
      lastDead: this.lastDead,
      unnotifiedAlerts: sweep?.unnotifiedAlerts ?? null,
      lastSweepAt: sweep?.lastSweepAt ?? null,
      sweptAlerts: sweep?.sweptAlerts ?? 0,
    };
  }

  private count(channel: string, status: NotificationStatus, error: string | null): void {
    if (status === 'SENT') {
      this.stats.sent++;
      this.totals.sent[channel] = (this.totals.sent[channel] ?? 0) + 1;
    } else if (status === 'FAILED') {
      this.stats.failed++;
      this.totals.failed[channel] = (this.totals.failed[channel] ?? 0) + 1;
      this.lastError = { message: `${channel}: ${error ?? 'failed'}`.slice(0, 300), at: new Date().toISOString() };
    } else {
      this.stats.skipped++;
      this.totals.skipped++;
    }
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
          if (isNoGroupError(error)) {
            // The cache lost its data (restart without persistence): recreate the group and carry on.
            await ensureStreamGroup(this.redis.client, RedisKeys.notifyStream, RedisKeys.notifierGroup).catch(() => undefined);
            backlog = true;
          }
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
    const jobs = reply?.[0] ? toJobs(reply[0][1].filter(([, f]) => f !== null)) : [];
    // Re-reading our own pending entries (restart) counts as a redelivery: carry the stream's delivery counts.
    if (id === '0' && jobs.length) this.pendingDeliveries = await this.deliveryCounts(jobs.map((j) => j.id));
    return jobs;
  }

  /** Delivery counts of the entries returned by the last backlog read (consumed by processAll). */
  private pendingDeliveries = new Map<string, number>();

  /** times_delivered per pending stream entry (XPENDING); missing entries count as 1. */
  private async deliveryCounts(ids: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!ids.length) return out;
    const pipeline = this.redis.client.pipeline();
    for (const id of ids) pipeline.xpending(RedisKeys.notifyStream, RedisKeys.notifierGroup, id, id, 1);
    const results = (await pipeline.exec()) ?? [];
    results.forEach(([error, reply], i) => {
      const row = !error && Array.isArray(reply) ? (reply[0] as [string, string, number, number] | undefined) : undefined;
      out.set(ids[i], row ? Number(row[3]) || 1 : 1);
    });
    return out;
  }

  private async claimStale(): Promise<void> {
    this.lastClaimAt = Date.now();
    const [, raw, deleted] = (await this.redis.client.xautoclaim(
      RedisKeys.notifyStream,
      RedisKeys.notifierGroup,
      this.consumer,
      CLAIM_IDLE_MS,
      '0-0',
      'COUNT',
      READ_COUNT,
    )) as [string, RawEntry[], string[]?];
    // Entries trimmed from the stream (MAXLEN) while pending: nothing to run; the sweeper re-queues their alerts.
    if (deleted?.length) await this.redis.client.xack(RedisKeys.notifyStream, RedisKeys.notifierGroup, ...deleted);
    const jobs = toJobs(raw.filter(([, f]) => f !== null));
    if (jobs.length) {
      this.logger.warn(`Re-claimed ${jobs.length} stale notification job(s)`);
      await this.processAll(jobs, await this.deliveryCounts(jobs.map((j) => j.id)));
    }
  }

  /**
   * Runs the jobs. A job is XACKed only when it finished; a job that threw stays pending, so XAUTOCLAIM redelivers
   * it after CLAIM_IDLE_MS. At MAX_DELIVERIES deliveries it is declared DEAD (D6 G2).
   */
  async processAll(jobs: Job[], deliveries?: Map<string, number>): Promise<void> {
    if (!jobs.length) return;
    const counts = deliveries ?? this.pendingDeliveries;
    this.pendingDeliveries = new Map();
    let next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const job = jobs[next++];
        const count = counts.get(job.id) ?? 1;
        if (deadBeforeRun(count)) {
          await this.markDead(job, count, 'redelivered without finishing');
          continue;
        }
        const started = Date.now();
        let failure: string | null = null;
        try {
          if (job.alertId) await this.handleAlert(job.alertId);
          if (job.logIds.length) await this.handleLogs(job.logIds);
        } catch (error) {
          failure = (error as Error).message || String(error);
          this.logger.error(`Job ${job.id} failed (delivery ${count}/${MAX_DELIVERIES}): ${failure}`);
          this.lastError = { message: failure.slice(0, 300), at: new Date().toISOString() };
        }
        // Webhook events for the alert (after handleAlert, so the address is filled); deduplicated per endpoint, so
        // they also run for a failed job and its redeliveries.
        if (job.alertId && this.webhooks) {
          await this.webhooks.onAlert(job.alertId).catch((error: Error) => this.logger.error(`Webhook events for ${job.alertId} failed: ${error.message}`));
        }
        this.stats.jobs++;
        this.totals.jobs++;
        this.stats.ms += Date.now() - started;
        if (failure === null) await this.redis.client.xack(RedisKeys.notifyStream, RedisKeys.notifierGroup, job.id);
        else if (onJobFailure(count) === 'dead') await this.markDead(job, count, failure);
        // else: left pending; XAUTOCLAIM redelivers it.
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, worker));
  }

  /**
   * DEAD job: the alert gets notifyError (the sweeper skips it), its unfinished rows are closed as FAILED, then the
   * entry is acknowledged. If the DB write fails the entry stays pending and is retried on the next claim.
   */
  private async markDead(job: Job, deliveries: number, lastError: string | null): Promise<void> {
    const reason = deadReason(deliveries, lastError);
    const leaseOver = { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lt: new Date() } }] };
    if (job.alertId) {
      await this.prisma.alert.updateMany({ where: { id: job.alertId, notifiedAt: null }, data: { notifyError: reason } });
      await this.prisma.notificationLog.updateMany({ where: { alertId: job.alertId, status: 'QUEUED', ...leaseOver }, data: { status: 'FAILED', error: reason, nextAttemptAt: null } });
    }
    if (job.logIds.length) {
      await this.prisma.notificationLog.updateMany({ where: { id: { in: job.logIds }, status: 'QUEUED', ...leaseOver }, data: { status: 'FAILED', error: reason, nextAttemptAt: null } });
    }
    await this.redis.client.xack(RedisKeys.notifyStream, RedisKeys.notifierGroup, job.id);
    this.deadJobs++;
    this.lastDead = { message: `DEAD ${job.alertId ? `alert ${job.alertId}` : `job ${job.id}`}: ${reason}`.slice(0, 300), at: new Date().toISOString() };
    this.lastError = this.lastDead;
    this.logger.error(`Job ${job.id} is DEAD (${job.alertId ? `alert ${job.alertId}` : `${job.logIds.length} message(s)`}): ${reason}`);
  }

  // ───────────── alert jobs ─────────────
  /**
   * Parking mode alarm escalation when nobody acknowledges (SMS, IVR voice call): reserved, not active yet. The
   * schedule keeps its settings in ParkingSchedule.escalation; the delayed job will start here.
   */
  private escalateAlarm(_alert: Alert): void {
    // Intentionally empty until SMS / voice-call escalation is enabled.
  }

  /**
   * One alert job. Throws on infrastructure errors (DB down …), so the job is redelivered. Every recipient is claimed
   * in the ledger first (per-recipient dedupe), so a redelivered or swept job only completes the missing recipients.
   * notifiedAt is set when the job finished, also for zero channels / recipients and all-SKIPPED (D6 G2).
   */
  async handleAlert(alertId: string): Promise<void> {
    const alert = await this.prisma.alert.findUnique({ where: { id: alertId } });
    if (!alert) return;
    // Finished earlier (the stream entry and a sweep both queued it, or a redelivery after the XACK was lost).
    if (alert.notifiedAt || alert.notifyError) return;
    await this.fillAddress(alert);
    // ADAS / DMS / crash: driver event row + dashcam snapshot request (idempotent per alert).
    const eventId = this.driverEvents ? await this.driverEvents.onAlert(alert).catch((e: Error) => {
      this.logger.error(`Driver event for ${alert.id} failed: ${e.message}`);
      return null;
    }) : null;
    // Rows without a dedupe key were written by the notifier before v1.8.3 (the alert was already handled): keep the
    // old alert-level guard for them only.
    if (await this.prisma.notificationLog.count({ where: { alertId, dedupeKey: null } })) return this.markNotified(alertId);
    const ctx = await loadAlertContext(this.prisma, alert);
    if (!ctx) return this.markNotified(alertId);

    const rules = await this.rules.get(alert.companyId);
    const setting = rules.effective(alert.objectId).get(alert.type as AlertTypeCode);
    const channels = (setting?.channels[alert.severity as AlertSeverity] ?? []).filter((c) => c !== 'INAPP');
    // Parking mode alarm: always pushed (siren channel), to everyone who can see the vehicle.
    const alarm = isParkingAlarm(alert.data as Record<string, unknown> | null);
    if (alarm && !channels.includes('PUSH')) channels.push('PUSH');
    if (!channels.length) return this.markNotified(alertId);

    const lists = await this.listsFor(alert.companyId);
    const chain = await this.expander.chainFor(ctx.object);
    const resolved = await this.expander.resolve(ctx.object, alert.type, alert.severity as AlertSeverity, channels, lists, chain);
    if (alarm) {
      const viewers = await this.expander.expand(ctx.object, [{ kind: 'DYNAMIC', value: 'ALL_VIEWERS' }], 'PUSH');
      const push = resolved.find((c) => c.channel === 'PUSH');
      if (push) {
        const have = new Set(push.recipients.map((r) => r.address));
        push.recipients.push(...viewers.filter((v) => !have.has(v.address)));
      }
      this.escalateAlarm(alert);
    }
    const label = ALERT_TYPE_MAP[alert.type as AlertTypeCode]?.label ?? alert.type;

    let busy = 0;
    for (const c of resolved) {
      if (!c.recipients.length) continue;
      const template = c.channel === 'WHATSAPP' || c.channel === 'ARATTAI' ? null : await this.templateFor(alert.companyId, alert.type, c.channel);
      const rendered: Rendered = template
        ? renderTemplate(template, ctx.vars)
        : {
            templateId: null,
            subject: `[${alert.severity}] ${label}: ${ctx.object.name}`,
            body: `${label}: ${ctx.object.name} — ${alert.message} (${ctx.vars.time}) ${ctx.vars.map_link}`,
            text: `${label}: ${ctx.object.name} — ${alert.message} (${ctx.vars.time}) ${ctx.vars.map_link}`,
            missing: [],
          };
      if (c.channel === 'EMAIL' && eventId) {
        this.deferEmail(alert, c.recipients, rendered, eventId);
        continue;
      }
      const results = await Promise.all(c.recipients.map((r) => this.deliver(alert, c.channel, r, rendered)));
      busy += results.filter((x) => x === 'busy').length;
    }
    if (busy) {
      // Another worker holds a live lease on some recipient: leave the alert un-notified. If that worker finishes, the
      // next sweep finds every row final; if it died, the sweep takes the lease over once it expires.
      this.logger.warn(`Alert ${alertId}: ${busy} recipient(s) leased by another worker; left for the sweeper`);
      return;
    }
    await this.markNotified(alertId);
  }

  private async markNotified(alertId: string): Promise<void> {
    await this.prisma.alert.updateMany({ where: { id: alertId, notifiedAt: null }, data: { notifiedAt: new Date() } });
  }

  /** Sends a driver event e-mail once its snapshot arrived (or after EMAIL_SNAPSHOT_WAIT_MS without it). */
  private deferEmail(alert: Alert, recipients: Recipient[], rendered: Rendered, eventId: string): void {
    const task = (async () => {
      const photo = await this.driverEvents!.photoFor(eventId, EMAIL_SNAPSHOT_WAIT_MS);
      const link = `${this.env?.webUrl ?? ''}/driver-events?event=${eventId}`;
      const msg: Rendered = {
        ...rendered,
        body: `${rendered.body}<p><a href="${link}">${photo ? 'View the driver event (snapshot attached)' : 'View the driver event'}</a></p>`,
        text: `${rendered.text || htmlToText(rendered.body)}
Driver event: ${link}`,
      };
      const attachments: MailAttachment[] = photo ? [{ filename: 'snapshot.jpg', path: mediaPath(photo.filePath), contentType: photo.mime }] : [];
      await Promise.all(recipients.map((r) => this.deliver(alert, 'EMAIL', r, msg, attachments)));
    })()
      .catch((error: Error) => this.logger.error(`Driver event e-mail for ${alert.id} failed: ${error.message}`))
      .finally(() => this.deferred.delete(task));
    this.deferred.add(task);
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

  /**
   * One recipient of an alert: claim its ledger row (dedupe key alertId:channel:recipient), send, record the outcome.
   * Returns 'busy' when another worker holds a live lease on the row (nothing was sent here).
   */
  private async deliver(alert: Alert, channel: NotifyChannel, r: Recipient, msg: Rendered, attachments?: MailAttachment[]): Promise<'done' | 'busy'> {
    const key = dedupeKey(alert.id, channel, r.address, this.env?.jwtSecret);
    const claim = await this.ledger.claim({
      companyId: alert.companyId,
      alertId: alert.id,
      channel,
      recipient: r.address,
      templateId: msg.templateId,
      subject: msg.subject,
      body: msg.body,
      dedupeKey: key,
    });
    if (claim.kind === 'busy') return 'busy';
    if (claim.kind === 'abandoned') this.count(channel, 'FAILED', 'abandoned after lease takeovers');
    if (claim.kind !== 'claimed') return 'done';
    // Row id + alert id only: the dedupe key is opaque, and no recipient address is logged (no PII in journald).
    if (claim.takeover) this.logger.warn(`Taking over ${channel} row ${claim.id} of alert ${alert.id} (lease expired; a duplicate external message is possible if the earlier send was accepted)`);
    const res = await this.attemptAlert(alert, channel, r, msg, key, attachments);
    await this.ledger.finish(claim.id, claim.attempts, res);
    this.count(channel, res.status, res.error);
    return 'done';
  }

  /** Sends one alert message and maps the provider result to a truthful status (D6 G3). */
  private async attemptAlert(alert: Alert, channel: NotifyChannel, r: Recipient, msg: Rendered, key: string, attachments?: MailAttachment[]): Promise<FinishInput> {
    // Platform Settings → Messaging: a channel the Super Admin switched off is not sent.
    const off = await this.channelOff(channel);
    if (off) return { status: 'SKIPPED', error: off, provider: null, sendAttempts: 0 };
    if (channel === 'WHATSAPP') return { status: 'SKIPPED', error: notConfiguredReason('WHATSAPP'), provider: null, sendAttempts: 0 };
    if (channel === 'ARATTAI') {
      const label = ALERT_TYPE_MAP[alert.type as AlertTypeCode]?.label ?? alert.type;
      const vars = { alert: label, vehicle: (msg.subject ?? '').replace(/^\[[A-Z]+\]\s*[^:]*:\s*/, '') || label, time: new Date(alert.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }), details: alert.message };
      const { error, attempts } = await withRetries(() => this.arattai.sendAlert(r.address, vars));
      return { ...outcome({ channel, configured: true, error }), provider: 'arattai', sendAttempts: attempts };
    }
    if (channel === 'PUSH') {
      const parkingAlarm = isParkingAlarm(alert.data as Record<string, unknown> | null);
      const res = await this.sendPush(r.address, msg, { alertId: alert.id, objectId: alert.objectId, type: alert.type, severity: alert.severity, ...(parkingAlarm ? { parkingAlarm: true } : {}) });
      return { ...res, provider: this.push.name };
    }
    return this.sendDirect(channel, r.address, msg, key, attachments);
  }

  /** Arattai alerts (Platform Settings → Messaging). */
  private get arattai(): ArattaiOtp {
    return (this.arattaiClient ??= new ArattaiOtp(this.prisma));
  }

  /** Why a channel is not sent: switched off by the Super Admin (Platform Settings → Messaging); null = send. Cached 30 s. */
  private async channelOff(channel: NotifyChannel): Promise<string | null> {
    if (channel === 'PUSH' || channel === 'INAPP') return null;
    if (!this.switches || Date.now() - this.switches.at > 30_000) {
      const row = await this.prisma.messagingSettings.findUnique({ where: { id: 'default' }, select: { smsEnabled: true, emailEnabled: true, whatsappEnabled: true, arattaiEnabled: true } }).catch(() => null);
      this.switches = { at: Date.now(), row };
    }
    const r = this.switches.row;
    // No settings saved yet: SMS and e-mail on (as before), WhatsApp and Arattai off.
    const on = { SMS: r?.smsEnabled ?? true, EMAIL: r?.emailEnabled ?? true, WHATSAPP: r?.whatsappEnabled ?? false, ARATTAI: r?.arattaiEnabled ?? false }[channel];
    const name = channel === 'ARATTAI' ? 'Arattai' : channel === 'WHATSAPP' ? 'WhatsApp' : channel === 'EMAIL' ? 'E-mail' : 'SMS';
    return on ? null : `${name} is switched off in Platform Settings`;
  }

  /**
   * E-mail / SMS. An unconfigured provider (console SMS, no mail provider) is never reported as SENT: the row is
   * SKIPPED "provider not configured". In development the console / var/mail copy is still written ("development copy
   * only"); in production the provider is not called at all. `key` (dedupe key) gives a stable e-mail Message-ID.
   */
  private async sendDirect(channel: NotifyChannel, to: string, msg: Rendered, key: string | null, attachments?: MailAttachment[]): Promise<FinishInput> {
    if (channel !== 'EMAIL' && channel !== 'SMS') {
      return { status: 'SKIPPED', error: notConfiguredReason(channel), provider: null, sendAttempts: 0 };
    }
    const provider = channel === 'SMS' ? this.sms.name : (this.mailer.provider ?? 'mailer');
    const configured = channel === 'SMS' ? this.sms.configured : !!this.mailer.provider;
    if (!configured) {
      let devCopy = false;
      if (writesDevCopy()) {
        devCopy = await this.send(channel, to, msg, null, attachments).then(
          () => true,
          (e: Error) => (this.logger.warn(`Development copy of ${channel} to ${maskRecipient(to)} failed: ${e.message}`), false),
        );
      }
      return { ...outcome({ channel, configured: false, devCopy }), provider, sendAttempts: 0 };
    }
    let messageId: string | null = null;
    const { error, attempts } = await withRetries(async () => {
      messageId = await this.send(channel, to, msg, key, attachments);
    });
    return { ...outcome({ channel, configured: true, error, messageId }), provider, sendAttempts: attempts };
  }

  /** Raw provider call; returns the provider message id where there is one. */
  private async send(channel: NotifyChannel, to: string, msg: Rendered, key: string | null, attachments?: MailAttachment[]): Promise<string | null> {
    if (channel === 'EMAIL') {
      const res = await this.mailer.sendWithResult({
        to,
        subject: msg.subject ?? '(no subject)',
        html: msg.body,
        text: msg.text || htmlToText(msg.body),
        ...(attachments?.length ? { attachments } : {}),
        // Provider idempotency (D6 G2 #5): the same notification always carries the same Message-ID (SMTP).
        ...(key ? { messageId: `<${providerRef(key)}@veetrax.notify>` } : {}),
      });
      return res.messageId;
    }
    if (channel === 'SMS') {
      const res = await this.sms.send({ to, text: msg.text, dltTemplateId: msg.dltTemplateId, senderId: msg.senderId, variables: msg.dltValues });
      return res.messageId;
    }
    throw new Error(`${channel} not configured`);
  }

/**
   * Push to every app install of a user (`user:<id>`) whose sign-in session is still valid.
   * Tokens the push service reports as unregistered are deleted. SENT only when Expo accepted at least one ticket.
   */
  private async sendPush(recipient: string, msg: Rendered, data: Record<string, unknown>): Promise<Omit<FinishInput, 'provider'>> {
    if (!this.push.enabled) return { status: 'SKIPPED', error: notConfiguredReason('PUSH'), sendAttempts: 0 };
    const userId = recipient.startsWith('user:') ? recipient.slice(5) : null;
    if (!userId) return { status: 'SKIPPED', error: 'Not a user recipient', sendAttempts: 0 };
    const now = new Date();
    const rows = await this.prisma.pushToken.findMany({
      where: { userId, OR: [{ sessionId: null }, { session: { revokedAt: null, expiresAt: { gt: now } } }] },
      select: { token: true },
    });
    if (!rows.length) return { status: 'SKIPPED', error: 'Mobile app not signed in', sendAttempts: 0 };
    const title = msg.subject?.trim() || 'VeeTrax alert';
    const body = (msg.text || htmlToText(msg.body)).slice(0, 500);
    let result: Awaited<ReturnType<PushProvider['send']>> | null = null;
    const { error, attempts } = await withRetries(async () => {
      const style = data.transport === true ? { channelId: TRANSPORT_PUSH_CHANNEL, sound: 'default' } : pushStyle(data.type, data.parkingAlarm === true);
      const payload = data.transport === true ? transportPushData(data) : data;
      result = await this.push.send(rows.map((r) => r.token), { title, body, data: payload, ...style });
    });
    const res = result as Awaited<ReturnType<PushProvider['send']>> | null;
    if (res?.invalidTokens.length) await this.prisma.pushToken.deleteMany({ where: { token: { in: res.invalidTokens } } });
    if (error) return { status: 'FAILED', error, sendAttempts: attempts };
    if (!res?.sent) return { status: 'FAILED', error: res?.error ?? 'No device accepted the push', sendAttempts: attempts };
    const tickets = res.ticketIds?.length ? res.ticketIds.join(',').slice(0, 1000) : null;
    return { status: 'SENT', error: res.error, providerMessageId: tickets, sendAttempts: attempts };
  }

  // ───────────── pre-rendered (test) jobs ─────────────
  async handleLogs(ids: string[]): Promise<void> {
    const logs = await this.prisma.notificationLog.findMany({ where: { id: { in: ids }, status: 'QUEUED' } });
    await Promise.all(logs.map((log) => this.sendLog(log)));
  }

  /** A pre-rendered QUEUED row: leased like alert rows (redeliveries do not resend a row another worker is sending). */
  private async sendLog(log: NotificationLog): Promise<void> {
    const claimed = await this.ledger.claimQueued(log.id);
    if (claimed === null) return;
    let res: FinishInput;
    if (log.channel === 'PUSH') {
      const data = await this.pushDataFor(log);
      res = data
        ? { ...(await this.sendPush(log.recipient, { templateId: log.templateId, subject: log.subject, body: log.body, text: log.body, missing: [] }, data)), provider: this.push.name }
        : { status: 'SKIPPED', error: 'Notification no longer exists', sendAttempts: 0, provider: this.push.name };
    } else {
      let msg: Rendered = { templateId: log.templateId, subject: log.subject, body: log.body, text: log.channel === 'EMAIL' ? htmlToText(log.body) : log.body, missing: [] };
      if (log.channel === 'SMS' && log.templateId) {
        const t = await this.prisma.messageTemplate.findUnique({ where: { id: log.templateId }, select: { dltTemplateId: true, senderId: true } });
        msg = { ...msg, dltTemplateId: t?.dltTemplateId ?? null, senderId: t?.senderId ?? null };
      }
      res = await this.sendDirect(log.channel, log.recipient, msg, log.id);
    }
    await this.ledger.finish(log.id, claimed, res);
    this.count(log.channel, res.status, res.error);
  }

  /**
   * Push data of a pre-rendered PUSH row. ETMS (refType TRANSPORT_NOTIFICATION, D7 / L4): only { kind, tripId,
   * notificationId }, rebuilt from the in-app notification row, on the app's 'trip' channel; null when that row is gone.
   * Everything else (test messages, reminders): { test: true } as before.
   */
  private async pushDataFor(log: NotificationLog): Promise<Record<string, unknown> | null> {
    if (log.refType !== 'TRANSPORT_NOTIFICATION' || !log.refId) return { test: true };
    const n = await this.prisma.transportNotification.findUnique({ where: { id: log.refId }, select: { id: true, kind: true, tripId: true } });
    return n ? { transport: true, kind: n.kind, tripId: n.tripId, notificationId: n.id } : null;
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
