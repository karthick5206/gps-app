import { BadRequestException } from '@nestjs/common';
import { ReportSchedule } from '@prisma/client';
import { ReportRequest } from '@veetracer/shared';
import { ReportSchedulesService } from './report-schedules.service';
import { normalizeScheduleOptions, scheduleRunOptions } from './schedule-options';

describe('normalizeScheduleOptions', () => {
  it('keeps only the schedule types and the options each type accepts', () => {
    const out = normalizeScheduleOptions(
      {
        HALT: { minDurationMin: 45, alertTypes: ['OVERSPEED'] },
        ALERTS: { alertTypes: ['OVERSPEED', 'OVERSPEED', 'SOS'] },
        OVERSPEED: { minOverspeedSec: 30 },
        TRIPS: { minDurationMin: 5 },
      },
      ['HALT', 'ALERTS', 'TRIPS'],
    );
    expect(out).toEqual({ HALT: { minDurationMin: 45 }, ALERTS: { alertTypes: ['OVERSPEED', 'SOS'] } });
  });

  it('returns {} for nothing saved and drops empty entries', () => {
    expect(normalizeScheduleOptions(undefined, ['HALT'])).toEqual({});
    expect(normalizeScheduleOptions({}, ['HALT'])).toEqual({});
    expect(normalizeScheduleOptions({ ALERTS: { alertTypes: [] }, HALT: {} }, ['ALERTS', 'HALT'])).toEqual({});
  });

  it('applies the on-screen validation rules', () => {
    expect(() => normalizeScheduleOptions({ HALT: { minDurationMin: 0 } }, ['HALT'])).toThrow(BadRequestException);
    expect(() => normalizeScheduleOptions({ CONTINUOUS_DRIVING: { drivingMin: 10 } }, ['CONTINUOUS_DRIVING'])).toThrow(BadRequestException);
    expect(() => normalizeScheduleOptions({ OVERSPEED: { minOverspeedSec: 'x' } }, ['OVERSPEED'])).toThrow(BadRequestException);
    expect(() => normalizeScheduleOptions([], ['HALT'])).toThrow(BadRequestException);
  });

  it('run options are undefined when none are saved (same request as before the change)', () => {
    expect(scheduleRunOptions({}, 'HALT')).toBeUndefined();
    expect(scheduleRunOptions(null, 'HALT')).toBeUndefined();
    expect(scheduleRunOptions({ HALT: { minDurationMin: 45 } }, 'TRIPS')).toBeUndefined();
    expect(scheduleRunOptions({ HALT: { minDurationMin: 45 } }, 'HALT')).toEqual({ minDurationMin: 45 });
  });
});

describe('ReportSchedulesService.execute passes saved options to generation', () => {
  const schedule = (options: unknown) =>
    ({
      id: 's1',
      companyId: 'c1',
      ownerId: 'u1',
      name: 'Weekly',
      reportTypes: ['HALT', 'TRIPS', 'ALERTS'],
      scope: {},
      period: 'DAY',
      frequency: 'DAILY',
      dayOfWeek: null,
      dayOfMonth: null,
      timeOfDay: '07:00',
      format: 'CSV',
      recipients: ['ops@example.com'],
      options,
      isActive: true,
      lastRunAt: null,
      nextRunAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }) as unknown as ReportSchedule;

  async function requestsFor(options: unknown): Promise<ReportRequest[]> {
    const seen: ReportRequest[] = [];
    const prisma = {
      company: { findUniqueOrThrow: async () => ({ name: 'Co', timezone: 'Asia/Kolkata' }) },
      reportRun: { create: async () => ({ id: 'r1' }), update: async (a: { data: unknown }) => a.data },
      reportSchedule: { update: async () => ({}) },
      user: { findUnique: async () => ({ name: 'Owner' }) },
      messageTemplate: { findMany: async () => [] },
    };
    const data = {
      generate: async (_ctx: unknown, req: ReportRequest) => {
        seen.push(req);
        return { type: req.type, from: req.from, to: req.to, rows: [], totals: {}, companyName: 'Co', tz: 'Asia/Kolkata', truncated: false, totalRows: 0 };
      },
    };
    const authContext = { forUser: async () => ({ isSuperAdmin: true, permissions: { reports: ['view', 'export'] } }) };
    const mailer = { send: async () => undefined };
    const svc = new ReportSchedulesService(prisma as never, {} as never, data as never, authContext as never, mailer as never);
    const fsp = require('node:fs/promises');
    jest.spyOn(fsp, 'writeFile').mockResolvedValue(undefined as never);
    jest.spyOn(fsp, 'mkdir').mockResolvedValue(undefined as never);
    const run = (await svc.execute(schedule(options), { requestedById: null, runAt: Date.parse('2026-11-10T02:00:00Z') })) as unknown as { status: string; error?: string };
    expect(run.error).toBeUndefined();
    expect(run.status).toBe('SUCCEEDED');
    return seen;
  }

  it('sends no options at all for a schedule without saved options (unchanged behaviour)', async () => {
    const reqs = await requestsFor({});
    expect(reqs.map((r) => r.type)).toEqual(['HALT', 'TRIPS', 'ALERTS']);
    for (const r of reqs) expect('options' in r).toBe(false);
  });

  it('sends each report its own saved options', async () => {
    const reqs = await requestsFor({ HALT: { minDurationMin: 45 }, ALERTS: { alertTypes: ['SOS'] } });
    expect(reqs.find((r) => r.type === 'HALT')?.options).toEqual({ minDurationMin: 45 });
    expect(reqs.find((r) => r.type === 'ALERTS')?.options).toEqual({ alertTypes: ['SOS'] });
    expect('options' in reqs.find((r) => r.type === 'TRIPS')!).toBe(false);
  });
});
