import { Injectable, Logger } from '@nestjs/common';
import { Interval, Timeout } from '@nestjs/schedule';
import { AlertDto } from '@veetracer/shared';
import { randomUUID } from 'node:crypto';
import { NOTIFY_STREAM_MAXLEN } from '../alerts/alert-dto';
import { loadCompanyRules } from '../alerts/rules-data';
import { PrismaService } from '../prisma/prisma.service';
import { RedisKeys } from '../redis/keys';
import { RedisService } from '../redis/redis.service';
import { ReminderAlert, RemindersJob } from './reminders-job';

export const REMINDERS_LOCK_KEY = 'vt:reminders:lock';
const RELEASE_LOCK = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;
const LOCK_MS = 15 * 60_000;

/**
 * Document expiry, driver licence and service reminders (DOCUMENT_EXPIRING / DOCUMENT_EXPIRED / SERVICE_DUE).
 * Checked hourly so a new day (company timezone) or a vehicle crossing its service odometer is picked up soon;
 * each document / reminder alerts once per state (see RemindersJob). The alerts go through the normal notifier
 * (in-app, e-mail, SMS, push per the alert settings). A Valkey lock keeps it to one api instance. REMINDERS=off disables.
 */
@Injectable()
export class RemindersService {
  private readonly logger = new Logger('Reminders');
  private readonly instance = randomUUID();
  private readonly enabled = (process.env.REMINDERS ?? 'on').toLowerCase() !== 'off';
  private readonly job: RemindersJob;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {
    this.job = new RemindersJob({
      prisma,
      rules: (companyId) => loadCompanyRules(prisma, companyId, { geofences: false }),
      raise: (alert) => this.raise(alert),
    });
  }

  @Timeout(90_000)
  initial(): Promise<void> {
    return this.tick();
  }

  @Interval(60 * 60_000)
  async tick(): Promise<void> {
    if (!this.enabled || this.running) return;
    this.running = true;
    let locked = false;
    try {
      locked = (await this.redis.client.set(REMINDERS_LOCK_KEY, this.instance, 'PX', LOCK_MS, 'NX')) === 'OK';
      if (!locked) return;
      await this.runAll(Date.now());
    } catch (error) {
      this.logger.error(`Reminders run failed: ${(error as Error).message}`);
    } finally {
      if (locked) await this.redis.client.eval(RELEASE_LOCK, 1, REMINDERS_LOCK_KEY, this.instance).catch(() => undefined);
      this.running = false;
    }
  }

  /** Every active company that has documents, driver licences or service reminders. */
  async runAll(now: number): Promise<void> {
    const companies = await this.prisma.company.findMany({
      where: {
        status: 'ACTIVE',
        OR: [{ documents: { some: {} } }, { drivers: { some: { OR: [{ licenseExpiry: { not: null } }, { licenseNotifiedState: { not: null } }] } } }, { objects: { some: { services: { some: {} } } } }],
      },
      select: { id: true },
    });
    let raised = 0;
    for (const c of companies) {
      try {
        raised += (await this.job.runCompany(c.id, now)).raised;
      } catch (error) {
        this.logger.error(`Reminders for company ${c.id} failed: ${(error as Error).message}`);
      }
    }
    if (raised) this.logger.log(`Raised ${raised} reminder alert(s)`);
  }

  private async raise(a: ReminderAlert): Promise<void> {
    const id = randomUUID();
    const occurredAt = new Date(a.occurredAt);
    await this.prisma.alert.create({
      data: { id, companyId: a.companyId, objectId: a.object.id, type: a.type, severity: a.severity, message: a.message, data: a.data as object, occurredAt },
    });
    const dto: AlertDto = {
      id,
      objectId: a.object.id,
      objectName: a.object.name,
      plateNumber: a.object.plateNumber,
      branchId: a.object.branchId,
      type: a.type,
      severity: a.severity,
      message: a.message,
      lat: null,
      lng: null,
      address: null,
      geofenceId: null,
      geofenceName: null,
      data: a.data,
      occurredAt: occurredAt.toISOString(),
      status: 'NEW',
      ackByName: null,
      ackAt: null,
      ackNote: null,
    };
    await this.redis.client
      .pipeline()
      .publish(RedisKeys.alertsChannel, JSON.stringify({ companyId: a.companyId, alert: dto }))
      .xadd(RedisKeys.notifyStream, 'MAXLEN', '~', NOTIFY_STREAM_MAXLEN, '*', 'alertId', id, 'companyId', a.companyId)
      .exec();
  }
}
