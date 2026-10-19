import { Injectable, Logger, Optional } from '@nestjs/common';
import { Interval, Timeout } from '@nestjs/schedule';
import { LICENCE_TYPE_LABELS, LicenceType } from '@veetracer/shared';
import { randomUUID } from 'node:crypto';
import { NotifyQueueService, QueuedMessage } from '../alerts/notify-queue.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { invoiceDate } from './invoice-pdf';
import { PoolsService } from './pools.service';
import { reminderDue } from './seat-logic';

export const LICENCE_JOB_LOCK_KEY = 'vt:licences:lock';
const RELEASE_LOCK = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;
const LOCK_MS = 15 * 60_000;
const DAY_MS = 86_400_000;

interface DueSeat {
  type: LicenceType;
  subject: string;
  expiresAt: Date;
  daysLeft: number;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function reminderText(pool: string, seats: DueSeat[], graceDays: number): { subject: string; lines: string[] } {
  const expired = seats.filter((s) => s.daysLeft <= 0).length;
  const subject = expired
    ? `VeeTrax: ${expired} licence(s) of ${pool} expired — renew to keep access`
    : `VeeTrax: ${seats.length} licence(s) of ${pool} expire soon`;
  const lines = seats.map(
    (s) =>
      `${LICENCE_TYPE_LABELS[s.type]} — ${s.subject}: ${s.daysLeft <= 0 ? `expired on ${invoiceDate(s.expiresAt.toISOString())} (viewing stops after ${graceDays} days)` : `expires on ${invoiceDate(s.expiresAt.toISOString())} (in ${s.daysLeft} day${s.daysLeft === 1 ? '' : 's'})`}`,
  );
  return { subject, lines };
}

/**
 * Hourly licence job: expiry reminders 30 / 15 / 7 / 1 days before and on the expiry day (one digest per pool, e-mail +
 * push to the company's billing admins and, for partner seats, the partner's), and pool rebalancing (free seats taken
 * by subjects whose seat expired). Each seat remembers the last reminder (claimed with a conditional update), so
 * restarts and several api instances never send twice. A Valkey lock keeps it to one instance. LICENCE_JOB=off disables.
 */
@Injectable()
export class LicenceRemindersService {
  private readonly logger = new Logger('LicenceJob');
  private readonly instance = randomUUID();
  private readonly enabled = (process.env.LICENCE_JOB ?? 'on').toLowerCase() !== 'off';
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly pools: PoolsService,
    @Optional() private readonly queue?: NotifyQueueService,
  ) {}

  @Timeout(120_000)
  initial(): Promise<void> {
    return this.tick();
  }

  @Interval(60 * 60_000)
  async tick(): Promise<void> {
    if (!this.enabled || this.running) return;
    this.running = true;
    let locked = false;
    try {
      locked = (await this.redis.client.set(LICENCE_JOB_LOCK_KEY, this.instance, 'PX', LOCK_MS, 'NX')) === 'OK';
      if (!locked) return;
      await this.run(Date.now());
    } catch (error) {
      this.logger.error(`Licence job failed: ${(error as Error).message}`);
    } finally {
      if (locked) await this.redis.client.eval(RELEASE_LOCK, 1, LICENCE_JOB_LOCK_KEY, this.instance).catch(() => undefined);
      this.running = false;
    }
  }

  async run(now: number): Promise<{ reminded: number; moved: number }> {
    let moved = 0;
    const companies = await this.prisma.company.findMany({ where: { isPlatform: false, status: 'ACTIVE', licenceSeats: { some: {} } }, select: { id: true } });
    for (const c of companies) {
      moved += await this.prisma.$transaction((tx) => this.pools.rebalance(tx, c.id, now)).catch((e: Error) => {
        this.logger.error(`Rebalance of ${c.id} failed: ${e.message}`);
        return 0;
      });
    }
    const reminded = await this.remind(now);
    if (moved || reminded) this.logger.log(`Licences: ${moved} seat(s) reassigned, ${reminded} reminder(s) queued`);
    return { reminded, moved };
  }

  private async remind(now: number): Promise<number> {
    const settings = await this.prisma.platformBillingSettings.findUnique({ where: { id: 'default' }, select: { graceDays: true } });
    const grace = settings?.graceDays ?? 15;
    const seats = await this.prisma.licenceSeat.findMany({
      where: {
        expiresAt: { lte: new Date(now + 31 * DAY_MS), gt: new Date(now - 2 * DAY_MS) },
        OR: [{ companyId: null }, { userId: { not: null } }, { deviceId: { not: null } }, { fuelObjectId: { not: null } }],
      },
      include: {
        company: { select: { id: true, name: true, isPlatform: true } },
        partner: { select: { id: true, name: true, homeCompanyId: true } },
        user: { select: { name: true } },
        device: { select: { uniqueId: true } },
        fuelConfig: { select: { object: { select: { name: true } } } },
      },
    });
    // pool key → recipients' company + digest lines
    const digests = new Map<string, { companyIds: string[]; pool: string; seats: DueSeat[] }>();
    for (const s of seats) {
      if (s.company?.isPlatform) continue;
      const due = reminderDue(s.expiresAt, s.notifiedState, now);
      if (!due) continue;
      const claimed = await this.prisma.licenceSeat.updateMany({ where: { id: s.id, notifiedState: s.notifiedState }, data: { notifiedState: due.state } });
      if (claimed.count !== 1) continue;
      const subject = s.user?.name ?? (s.device ? `device ${s.device.uniqueId}` : s.fuelConfig ? `fuel sensor on ${s.fuelConfig.object.name}` : 'unassigned seat');
      const key = s.companyId ?? `partner:${s.partnerId}`;
      const companyIds = [s.companyId, s.partner?.homeCompanyId].filter((x): x is string => !!x);
      const d = digests.get(key) ?? { companyIds: [], pool: s.company?.name ?? s.partner?.name ?? 'your account', seats: [] };
      for (const id of companyIds) if (!d.companyIds.includes(id)) d.companyIds.push(id);
      d.seats.push({ type: s.type as LicenceType, subject, expiresAt: s.expiresAt, daysLeft: due.daysLeft });
      digests.set(key, d);
    }
    let queued = 0;
    for (const d of digests.values()) {
      const { subject, lines } = reminderText(d.pool, d.seats, grace);
      const html = `<p>${esc(subject)}</p><ul>${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul><p>Renew in VeeTrax → Billing &amp; Licences.</p>`;
      for (const companyId of d.companyIds) {
        const admins = await this.prisma.user.findMany({
          where: { companyId, isActive: true, roles: { some: { role: { permissions: { some: { menu: 'billing' } } } } } },
          select: { id: true, email: true },
        });
        const messages: QueuedMessage[] = [];
        for (const a of admins) {
          if (a.email) messages.push({ channel: 'EMAIL', recipient: a.email, templateId: null, subject, body: html });
          messages.push({ channel: 'PUSH', recipient: `user:${a.id}`, templateId: null, subject, body: lines.slice(0, 3).join('\n') });
        }
        if (messages.length && this.queue) queued += (await this.queue.enqueueMessages(companyId, messages)).length;
      }
    }
    return queued;
  }
}
