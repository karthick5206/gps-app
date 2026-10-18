import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { ReportSchedulesService } from './report-schedules.service';
import { computeNextRunAt } from './schedule-time';

export const REPORT_SCHEDULER_LOCK_KEY = 'vt:reports:scheduler:lock';
const RELEASE_LOCK = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;
const BATCH = 20;

/**
 * Runs due report schedules every minute. A Valkey `SET NX` lock makes sure only one api instance works at a time;
 * `nextRunAt` is advanced before generating so a schedule never runs twice for the same slot.
 * Disable with REPORT_SCHEDULER=off.
 */
@Injectable()
export class ReportSchedulerService {
  private readonly logger = new Logger('ReportScheduler');
  private readonly instance = randomUUID();
  private readonly enabled = (process.env.REPORT_SCHEDULER ?? 'on').toLowerCase() !== 'off';
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly schedules: ReportSchedulesService,
  ) {}

  @Interval(60_000)
  async tick(): Promise<void> {
    if (!this.enabled || this.running) return;
    this.running = true;
    let locked = false;
    try {
      locked = (await this.redis.client.set(REPORT_SCHEDULER_LOCK_KEY, this.instance, 'PX', 10 * 60_000, 'NX')) === 'OK';
      if (!locked) return;
      await this.runDue(Date.now());
    } catch (error) {
      this.logger.error(`Scheduler tick failed: ${(error as Error).message}`);
    } finally {
      if (locked) await this.redis.client.eval(RELEASE_LOCK, 1, REPORT_SCHEDULER_LOCK_KEY, this.instance).catch(() => undefined);
      this.running = false;
    }
  }

  async runDue(now: number): Promise<number> {
    const due = await this.prisma.reportSchedule.findMany({
      where: { isActive: true, OR: [{ nextRunAt: { lte: new Date(now) } }, { nextRunAt: null }] },
      orderBy: { nextRunAt: 'asc' },
      take: BATCH,
    });
    let ran = 0;
    for (const schedule of due) {
      const company = await this.prisma.company.findUnique({ where: { id: schedule.companyId }, select: { timezone: true, status: true } });
      if (!company) continue;
      const next = new Date(computeNextRunAt(schedule, company.timezone, now));
      // Claim the slot first (compare-and-set on the old nextRunAt).
      const claimed = await this.prisma.reportSchedule.updateMany({
        where: { id: schedule.id, nextRunAt: schedule.nextRunAt },
        data: { nextRunAt: next },
      });
      if (!claimed.count || schedule.nextRunAt === null || company.status !== 'ACTIVE') continue;
      const run = await this.schedules.execute(schedule, { requestedById: null, runAt: now });
      ran++;
      this.logger.log(`Schedule "${schedule.name}" → run ${run.id} ${run.status}; next ${next.toISOString()}`);
    }
    return ran;
  }
}
