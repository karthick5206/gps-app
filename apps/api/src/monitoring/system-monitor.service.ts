import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { HealthEvent, HealthIssue, SystemAlertTestResult, SystemHealthSummary } from '@veetracer/shared';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { MailerService } from '../auth/mailer.service';
import { APP_ENV } from '../config/config.module';
import { AppEnv } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import { RedisKeys } from '../redis/keys';
import { RedisService } from '../redis/redis.service';
import { worst } from './checks';
import { apiMetrics } from './api-metrics';
import { HeartbeatHandle, startHeartbeat } from './heartbeat';
import { EVENTS_MAX, SystemHealthService } from './system-health.service';
import { AlertRecord, diffIssues } from './transitions';
import { shortError, withTimeout } from './util';

const EVALUATE_MS = 15_000;
const SAMPLE_MS = 10_000;
const SA_EMAIL_REFRESH_MS = 5 * 60_000;
const VALKEY_TIMEOUT_MS = 2000;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * Evaluates the System Health checks every 15 s (one API instance at a time, Valkey SET NX lock), records status
 * transitions, e-mails the Super Admin (+ SYSTEM_ALERT_EMAILS) on WARN/CRITICAL and on recovery, and publishes
 * `vt:health:updates` for the Super Admin's sockets. Also writes the API heartbeat and the 10-second throughput sample.
 *
 * Works without PostgreSQL (the Super Admin e-mail is cached in memory and Valkey) and, as far as possible, without
 * Valkey (state is kept in memory; every API instance then evaluates on its own).
 */
@Injectable()
export class SystemMonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('SystemMonitor');
  private readonly instance = randomUUID();
  private heartbeat: HeartbeatHandle | null = null;
  private evaluating = false;
  private sampling = false;
  private superAdminEmail: string | null = null;
  private superAdminEmailAt = 0;
  /** Fallback state when Valkey is unreachable. */
  private localIssues: HealthIssue[] = [];
  private localRecords = new Map<string, AlertRecord>();
  private localEvents: HealthEvent[] = [];

  constructor(
    private readonly health: SystemHealthService,
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
    private readonly mailer: MailerService,
    @Inject(APP_ENV) private readonly env: AppEnv,
  ) {}

  onModuleInit(): void {
    if (process.env.SYSTEM_MONITOR === 'off') return;
    this.heartbeat = startHeartbeat(this.redis.client, 'api', () => ({ ...apiMetrics }));
    void this.refreshSuperAdminEmail(true);
  }

  async onModuleDestroy(): Promise<void> {
    await this.heartbeat?.stop();
  }

  private get enabled(): boolean {
    return process.env.SYSTEM_MONITOR !== 'off';
  }

  // ── sampler ────────────────────────────────────────────────────────────────

  @Interval(SAMPLE_MS)
  async sample(): Promise<void> {
    if (!this.enabled || this.sampling) return;
    this.sampling = true;
    try {
      const locked = await withTimeout(this.redis.client.set(RedisKeys.healthSamplerLock, this.instance, 'PX', SAMPLE_MS - 1000, 'NX'), VALKEY_TIMEOUT_MS, 'lock');
      if (!locked) return;
      await this.health.pushSample(await this.health.sample());
    } catch (error) {
      this.logger.debug?.(`Sample skipped: ${shortError(error)}`);
    } finally {
      this.sampling = false;
    }
  }

  // ── evaluation ─────────────────────────────────────────────────────────────

  @Interval(EVALUATE_MS)
  async evaluate(): Promise<void> {
    if (!this.enabled || this.evaluating) return;
    this.evaluating = true;
    try {
      await this.evaluateOnce();
    } catch (error) {
      this.logger.error(`Health evaluation failed: ${shortError(error)}`);
    } finally {
      this.evaluating = false;
    }
  }

  async evaluateOnce(now = Date.now()): Promise<void> {
    let valkeyUp = true;
    try {
      const locked = await withTimeout(this.redis.client.set(RedisKeys.healthMonitorLock, this.instance, 'PX', EVALUATE_MS - 1000, 'NX'), VALKEY_TIMEOUT_MS, 'lock');
      if (!locked) return; // another API instance evaluates this round
    } catch {
      valkeyUp = false; // evaluate locally so the outage itself still gets e-mailed
    }
    const collected = await this.health.collect(now);
    let previous = this.localIssues;
    let records = this.localRecords;
    if (valkeyUp) {
      try {
        [previous, records] = await Promise.all([this.health.storedIssues(), this.alertRecords()]);
      } catch {
        valkeyUp = false;
      }
    }
    const cooldownMs = this.health.config.cooldownMin * 60_000;
    const result = diffIssues(previous, collected.issues, records, now, cooldownMs);

    this.localIssues = result.active;
    for (const [id, r] of result.records) this.localRecords.set(id, r);
    this.localEvents = [...[...result.events].reverse(), ...this.localEvents].slice(0, EVENTS_MAX);
    if (valkeyUp) await this.store(result.active, result.events, result.records).catch((e) => this.logger.warn(`Storing health state failed: ${shortError(e)}`));

    for (const e of result.events) this.logger.log(`${e.check}: ${e.from} → ${e.to} — ${e.message}`);
    if (result.alert.length || result.recovered.length) await this.sendAlerts(result.alert, result.recovered, result.active);

    const summary: SystemHealthSummary = {
      status: worst(result.active.map((i) => i.severity)),
      issues: result.active,
      at: new Date(now).toISOString(),
      transitions: result.events,
    };
    if (valkeyUp) await this.redis.client.publish(RedisKeys.healthUpdates, JSON.stringify(summary)).catch(() => undefined);
  }

  /** Events and active issues (Valkey, else this instance's memory). */
  async storedState(): Promise<{ issues: HealthIssue[]; events: HealthEvent[] }> {
    try {
      const [issues, events] = await Promise.all([this.health.storedIssues(), this.health.events()]);
      return { issues, events };
    } catch {
      return { issues: this.localIssues, events: this.localEvents };
    }
  }

  private async alertRecords(): Promise<Map<string, AlertRecord>> {
    const raw = await withTimeout(this.redis.client.hgetall(RedisKeys.healthAlertSent), VALKEY_TIMEOUT_MS, 'HGETALL');
    return new Map(Object.entries(raw).map(([k, v]) => [k, JSON.parse(v) as AlertRecord]));
  }

  private async store(active: HealthIssue[], events: HealthEvent[], records: Map<string, AlertRecord>): Promise<void> {
    const m = this.redis.client.multi().del(RedisKeys.healthIssues);
    if (active.length) m.hset(RedisKeys.healthIssues, Object.fromEntries(active.map((i) => [i.id, JSON.stringify(i)])));
    if (events.length) m.lpush(RedisKeys.healthEvents, ...events.map((e) => JSON.stringify(e))).ltrim(RedisKeys.healthEvents, 0, EVENTS_MAX - 1);
    if (records.size) m.hset(RedisKeys.healthAlertSent, Object.fromEntries([...records].map(([k, v]) => [k, JSON.stringify(v)])));
    await withTimeout(m.exec(), VALKEY_TIMEOUT_MS, 'store');
  }

  // ── e-mail ─────────────────────────────────────────────────────────────────

  async recipients(): Promise<string[]> {
    await this.refreshSuperAdminEmail(false);
    return [...new Set([this.superAdminEmail, ...this.health.config.alertEmails].filter((e): e is string => !!e).map((e) => e.toLowerCase()))];
  }

  get cachedSuperAdminEmail(): string | null {
    return this.superAdminEmail;
  }

  /** From PostgreSQL every 5 min; falls back to the copy in Valkey / memory when the database is down. */
  private async refreshSuperAdminEmail(force: boolean): Promise<void> {
    if (!force && this.superAdminEmail && Date.now() - this.superAdminEmailAt < SA_EMAIL_REFRESH_MS) return;
    try {
      const user = await withTimeout(this.prisma.user.findFirst({ where: { isSuperAdmin: true }, select: { email: true } }), 2000, 'PostgreSQL');
      this.superAdminEmailAt = Date.now();
      this.superAdminEmail = user?.email ?? null;
      if (this.superAdminEmail) await this.redis.client.set(RedisKeys.healthSuperAdminEmail, this.superAdminEmail).catch(() => undefined);
    } catch {
      if (this.superAdminEmail) return;
      this.superAdminEmail = await withTimeout(this.redis.client.get(RedisKeys.healthSuperAdminEmail), VALKEY_TIMEOUT_MS, 'GET').catch(() => null);
    }
  }

  private async sendAlerts(raised: HealthIssue[], recovered: HealthIssue[], active: HealthIssue[]): Promise<void> {
    const to = await this.recipients();
    if (!to.length) {
      this.logger.warn('System alert not sent: no Super Admin e-mail and SYSTEM_ALERT_EMAILS is empty');
      return;
    }
    const crit = raised.filter((i) => i.severity === 'CRITICAL').length;
    let subject: string;
    if (raised.length === 1 && !recovered.length) subject = `[VeeTrax] ${raised[0].severity}: ${raised[0].message}`;
    else if (raised.length) subject = `[VeeTrax] ${raised.length} system issue(s)${crit ? ` (${crit} critical)` : ''}${recovered.length ? `, ${recovered.length} resolved` : ''}`;
    else if (recovered.length === 1) subject = `[VeeTrax] Resolved: ${recovered[0].check}`;
    else subject = `[VeeTrax] ${recovered.length} system issues resolved`;
    if (subject.length > 150) subject = `${subject.slice(0, 147)}…`;
    const { html, text } = this.render(raised, recovered, active);
    await this.mailAll(to, subject, html, text);
  }

  async sendTest(): Promise<SystemAlertTestResult> {
    const to = await this.recipients();
    const issue: HealthIssue = {
      id: 'test',
      check: 'test alert',
      section: 'pipeline',
      severity: 'WARN',
      message: 'This is a test of the VeeTrax system alerts. No action is needed.',
      since: new Date().toISOString(),
    };
    const { html, text } = this.render([issue], [], this.localIssues);
    const errors = await this.mailAll(to, '[VeeTrax] Test system alert', html, text);
    return { recipients: to, sent: to.length - errors.length, errors };
  }

  private async mailAll(to: string[], subject: string, html: string, text: string): Promise<string[]> {
    const errors: string[] = [];
    await Promise.all(
      to.map((address) =>
        this.mailer.send({ to: address, subject, html, text }).catch((error: Error) => {
          errors.push(`${address}: ${error.message}`);
          this.logger.error(`System alert to ${address} failed: ${error.message}`);
        }),
      ),
    );
    return errors;
  }

  private render(raised: HealthIssue[], recovered: HealthIssue[], active: HealthIssue[]): { html: string; text: string } {
    const link = `${this.env.webUrl.replace(/\/$/, '')}/platform/system-health`;
    const color = { CRITICAL: '#dc2626', WARN: '#d97706', OK: '#16a34a' } as const;
    const rows = (items: HealthIssue[], status?: 'OK') =>
      items
        .map(
          (i) =>
            `<tr><td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;color:${color[status ?? i.severity]};font-weight:600;white-space:nowrap">${status ?? i.severity}</td>` +
            `<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;white-space:nowrap">${esc(i.check)}</td>` +
            `<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb">${esc(i.message)}</td>` +
            `<td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;white-space:nowrap;color:#6b7280">${esc(new Date(i.since).toUTCString())}</td></tr>`,
        )
        .join('');
    const table = (title: string, body: string) =>
      `<h3 style="margin:18px 0 6px;font-size:15px">${title}</h3><table style="border-collapse:collapse;font-size:13px;width:100%">` +
      `<tr style="text-align:left;color:#6b7280"><th style="padding:6px 10px">Status</th><th style="padding:6px 10px">Check</th><th style="padding:6px 10px">Details</th><th style="padding:6px 10px">Since</th></tr>${body}</table>`;
    const stillActive = active.filter((a) => !raised.some((r) => r.id === a.id));
    const html =
      `<div style="font-family:Arial,Helvetica,sans-serif;color:#111827;max-width:760px">` +
      `<h2 style="margin:0 0 4px;font-size:18px">VeeTrax system health</h2>` +
      `<p style="margin:0;color:#6b7280;font-size:13px">Reported by the API on ${esc(hostname())} at ${esc(new Date().toUTCString())}.</p>` +
      (raised.length ? table('New issues', rows(raised)) : '') +
      (recovered.length ? table('Resolved', rows(recovered, 'OK')) : '') +
      (stillActive.length ? table('Still active', rows(stillActive)) : '') +
      `<p style="margin-top:18px"><a href="${esc(link)}" style="color:#0f766e;font-weight:600">Open System Health</a></p></div>`;
    const line = (i: HealthIssue, s: string) => `- [${s}] ${i.check}: ${i.message}`;
    const text = [
      `VeeTrax system health (${hostname()}, ${new Date().toUTCString()})`,
      ...(raised.length ? ['', 'New issues:', ...raised.map((i) => line(i, i.severity))] : []),
      ...(recovered.length ? ['', 'Resolved:', ...recovered.map((i) => line(i, 'OK'))] : []),
      ...(stillActive.length ? ['', 'Still active:', ...stillActive.map((i) => line(i, i.severity))] : []),
      '',
      link,
    ].join('\n');
    return { html, text };
  }
}
