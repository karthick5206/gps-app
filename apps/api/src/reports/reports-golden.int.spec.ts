import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';
import { REPORT_TYPES, ReportRequest, ReportType } from '@veetracer/shared';
import { AuthContextService } from '../access/auth-context.service';
import { AttendanceService } from '../attendance/attendance.service';
import { AuditService } from '../audit/audit.service';
import { ReportDataService } from './report-data.service';
import { renderReport } from './report-files';

/**
 * Golden test: every one of the 33 report types returns exactly the same rows, totals and CSV export for a fixed
 * fixture database before and after a change. The golden file (__golden__/reports-golden.json) was written on the
 * unchanged code (production v1.3.0 @ 07077b6) with REPORTS_GOLDEN_UPDATE=1; later runs compare against it.
 *
 * TRIP_PERFORMANCE / PLANNED_TRIPS (routes & planned trips) were added by hand: the frozen fixture predates the
 * planned-trip tables, so once migration 20261113090000_routes_planned_trips is applied they hold no rows and the
 * entries pin the empty result (zero totals, "[]" rows, the empty CSV of each section). Their computed figures are
 * pinned by trip-performance.spec.ts on hand-made trips instead.
 *
 * Runs only when REPORTS_TEST_DATABASE_URL points at a scratch database whose name ends in "_test" (a frozen copy of
 * the assessment database: seed + synthetic history for 3–9 Nov 2026); skipped in the normal suite.
 */
const URL_ = process.env.REPORTS_TEST_DATABASE_URL ?? '';
const scratch = /\/[a-z0-9_]+_test(\?|$)/i.test(URL_);
const d = scratch ? describe : describe.skip;

const GOLDEN = join(__dirname, '__golden__', 'reports-golden.json');
const USER_EMAIL = process.env.REPORTS_GOLDEN_USER ?? 'demo.admin@veetracer.local';
/** Fixed clock so "now"-based reports (device status, documents, open sessions) are reproducible. */
const NOW = Date.parse('2026-11-09T12:00:00.000Z');
const FROM = '2026-11-03';
const TO = '2026-11-09';

/** Requests per type: defaults plus the report options each type accepts, so option handling is pinned too. */
function requests(type: ReportType, objectId: string): { label: string; req: ReportRequest }[] {
  const scope = { branchIds: [], groupIds: [], objectIds: [] };
  const base: ReportRequest = { type, scope, from: FROM, to: TO };
  switch (type) {
    case 'SUMMARY':
    case 'DISTANCE':
    case 'ENGINE_HOURS':
      return (['DAY', 'WEEK', 'MONTH'] as const).map((period) => ({ label: period, req: { ...base, period } }));
    case 'POSITIONS':
      return [{ label: 'one vehicle', req: { ...base, scope: { ...scope, objectIds: [objectId] }, from: '2026-11-05', to: '2026-11-05' } }];
    case 'HALT':
      return [
        { label: 'default', req: base },
        { label: 'min 10', req: { ...base, options: { minDurationMin: 10 } } },
      ];
    case 'STOPS':
    case 'IDLE':
      return [
        { label: 'default', req: base },
        { label: 'min 5', req: { ...base, options: { minDurationMin: 5 } } },
      ];
    case 'OVERSPEED':
      return [
        { label: 'default', req: base },
        { label: 'min 30 s', req: { ...base, options: { minOverspeedSec: 30 } } },
      ];
    case 'CONTINUOUS_DRIVING':
      return [
        { label: 'default', req: base },
        { label: '60/10', req: { ...base, options: { drivingMin: 60, breakMin: 10 } } },
      ];
    case 'ALERTS':
    case 'EVENT_SUMMARY':
      return [
        { label: 'all', req: base },
        { label: 'overspeed only', req: { ...base, options: { alertTypes: ['OVERSPEED'] } } },
      ];
    case 'DEVICE_STATUS':
      return [
        { label: 'default', req: base },
        { label: 'inactive 60', req: { ...base, options: { inactiveAfterMin: 60 } } },
      ];
    case 'TRIP_PERFORMANCE':
      return (['ROUTE', 'DRIVER', 'VEHICLE'] as const).map((groupBy) => ({ label: groupBy.toLowerCase(), req: { ...base, options: { groupBy } } }));
    default:
      return [{ label: 'default', req: base }];
  }
}

const sha = (v: unknown) => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');

/**
 * GEOFENCE_SUMMARY counts a still-open visit up to the database's now() (SQL, not the faked JS clock), so those
 * figures grow with wall time. They are left out of the comparison; everything else (incl. closed visits) is pinned.
 */
function stable(type: ReportType, rows: unknown[], totals: Record<string, number> | undefined) {
  if (type !== 'GEOFENCE_SUMMARY') return { rows, totals: totals ?? null };
  type G = { lastExit: string | null; insideSec: number; avgVisitSec: number };
  const out = (rows as G[]).map((r) => (r.lastExit === null ? { ...r, insideSec: 'open', avgVisitSec: 'open' } : r));
  const closedInsideSec = (rows as G[]).filter((r) => r.lastExit !== null).reduce((s, r) => s + r.insideSec, 0);
  return { rows: out, totals: { visits: totals?.visits ?? 0, closedInsideSec } };
}

d('reports golden: 33 types return identical rows/totals/exports', () => {
  jest.setTimeout(10 * 60_000);
  const prisma = new PrismaClient({ datasourceUrl: URL_ });
  const redis = { client: { set: async () => 'OK', eval: async () => 0 } };
  const attendance = new AttendanceService(prisma as never, redis as never, new AuditService(prisma as never));
  // No address lookups: they depend on the network and a cache; the golden covers the report rows themselves.
  const noAddresses = { enrichReport: async () => undefined };
  const svc = new ReportDataService(prisma as never, noAddresses as never, undefined, attendance);

  beforeAll(() => {
    jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'] });
  });
  afterAll(async () => {
    jest.useRealTimers();
    await prisma.$disconnect();
  });

  it('matches the golden snapshot', async () => {
    const user = await prisma.user.findFirstOrThrow({ where: { email: USER_EMAIL }, select: { id: true, companyId: true } });
    const ctx = await new AuthContextService(prisma as never, null as never, null as never).forUser(user.id, user.companyId, null);
    const object = await prisma.trackedObject.findFirstOrThrow({ where: { companyId: user.companyId }, orderBy: { name: 'asc' }, select: { id: true } });

    const actual: Record<string, unknown> = {};
    for (const type of REPORT_TYPES) {
      for (const { label, req } of requests(type, object.id)) {
        const data = await svc.generate(ctx, req);
        const s = stable(type, data.rows, data.totals);
        // The CSV of a section with open geofence visits embeds the same now()-based seconds; pin it via the stable rows.
        const csvData =
          type === 'GEOFENCE_SUMMARY'
            ? { ...data, rows: (data.rows as { lastExit: string | null }[]).filter((r) => r.lastExit !== null), totals: { visits: 0, insideSec: (s.totals as { closedInsideSec: number }).closedInsideSec } }
            : data;
        const csv = (await renderReport([csvData], 'CSV', NOW)).buffer.toString('utf8');
        actual[`${type} · ${label}`] = {
          rows: data.rows.length,
          totalRows: data.totalRows,
          truncated: data.truncated,
          period: data.period ?? null,
          totals: s.totals,
          rowsSha256: sha(s.rows),
          csvSha256: sha(csv),
        };
      }
    }
    expect(Object.keys(actual).filter((k) => REPORT_TYPES.includes(k.split(' · ')[0] as ReportType)).map((k) => k.split(' · ')[0]).filter((v, i, a) => a.indexOf(v) === i)).toHaveLength(33);

    if (process.env.REPORTS_GOLDEN_UPDATE === '1' || !existsSync(GOLDEN)) {
      mkdirSync(join(__dirname, '__golden__'), { recursive: true });
      writeFileSync(GOLDEN, `${JSON.stringify({ fixture: { from: FROM, to: TO, now: new Date(NOW).toISOString(), user: USER_EMAIL }, results: actual }, null, 2)}\n`);
    }
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as { results: Record<string, unknown> };
    expect(actual).toEqual(golden.results);
  });
});
