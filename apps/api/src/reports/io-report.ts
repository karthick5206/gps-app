import { PrismaClient } from '@prisma/client';
import { IoDailyReportRow, IoSensorKind, IoSessionReportRow } from '@veetracer/shared';
import { aggregateIoDays } from './io-aggregate';
import { ObjInfo } from './report-queries';

interface Range {
  gte: Date;
  lt: Date;
}

/** AC / door periods overlapping the range (open ones included). */
function overlapping(prisma: PrismaClient, companyId: string, ids: string[], range: Range, take?: number) {
  return prisma.ioSession.findMany({
    where: { companyId, objectId: { in: ids }, startTime: { lt: range.lt }, OR: [{ endTime: null }, { endTime: { gte: range.gte } }] },
    orderBy: { startTime: 'asc' },
    ...(take ? { take } : {}),
  });
}

/** AC_DOOR: every AC on / off and door open / closed period, like the old platform's "AC / Door" report. */
export async function ioSessionsReport(
  prisma: PrismaClient,
  companyId: string,
  objects: Map<string, ObjInfo>,
  range: Range,
  maxRows: number,
  now: number,
): Promise<{ rows: IoSessionReportRow[]; totals: Record<string, number>; totalRows: number }> {
  const ids = [...objects.keys()];
  const zero = { count: 0, acOnSec: 0, acOnEngineOffSec: 0, doorOpenCount: 0, doorOpenSec: 0 };
  if (!ids.length) return { rows: [], totals: zero, totalRows: 0 };
  const sessions = await overlapping(prisma, companyId, ids, range);
  const all: IoSessionReportRow[] = sessions.map((s) => {
    const o = objects.get(s.objectId);
    const durationSec = s.endTime ? s.durationSec : Math.max(0, Math.round((now - s.startTime.getTime()) / 1000));
    return {
      id: s.id,
      objectId: s.objectId,
      objectName: o?.name ?? 'Unknown object',
      plateNumber: o?.plateNumber ?? null,
      kind: s.kind as IoSensorKind,
      on: s.on,
      startTime: s.startTime.toISOString(),
      endTime: s.endTime?.toISOString() ?? null,
      durationSec,
      distanceKm: Math.round(s.distanceKm * 100) / 100,
      engineOffSec: s.engineOffSec,
      startLat: s.startLat,
      startLng: s.startLng,
      endLat: s.endLat,
      endLng: s.endLng,
      startAddress: null,
      endAddress: null,
    };
  });
  all.sort((a, b) => a.objectName.localeCompare(b.objectName) || a.startTime.localeCompare(b.startTime));
  const on = (k: IoSensorKind) => all.filter((r) => r.kind === k && r.on);
  return {
    rows: all.slice(0, maxRows),
    totals: {
      count: all.length,
      acOnSec: on('AC').reduce((t, r) => t + r.durationSec, 0),
      acOnEngineOffSec: on('AC').reduce((t, r) => t + r.engineOffSec, 0),
      doorOpenCount: on('DOOR').length,
      doorOpenSec: on('DOOR').reduce((t, r) => t + r.durationSec, 0),
    },
    totalRows: all.length,
  };
}

/** AC_DOOR_DAILY: per vehicle per day totals. */
export async function ioDailyReport(
  prisma: PrismaClient,
  companyId: string,
  objects: Map<string, ObjInfo>,
  range: Range,
  from: string,
  to: string,
  tz: string,
  maxRows: number,
  now: number,
): Promise<{ rows: IoDailyReportRow[]; totals: Record<string, number>; totalRows: number }> {
  const ids = [...objects.keys()];
  const sessions = ids.length ? await overlapping(prisma, companyId, ids, range) : [];
  const days = aggregateIoDays(
    sessions.map((s) => ({ objectId: s.objectId, kind: s.kind, on: s.on, startTime: s.startTime.getTime(), endTime: s.endTime?.getTime() ?? null, distanceKm: s.distanceKm, engineOffSec: s.engineOffSec })),
    from,
    to,
    tz,
    now,
  );
  const all: IoDailyReportRow[] = days
    .map((d) => ({ ...d, objectName: objects.get(d.objectId)?.name ?? 'Unknown object', plateNumber: objects.get(d.objectId)?.plateNumber ?? null }))
    .sort((a, b) => a.objectName.localeCompare(b.objectName) || a.day.localeCompare(b.day));
  const sum = (f: (r: IoDailyReportRow) => number) => all.reduce((t, r) => t + f(r), 0);
  return {
    rows: all.slice(0, maxRows),
    totals: {
      vehicles: new Set(all.map((r) => r.objectId)).size,
      acOnSec: sum((r) => r.acOnSec),
      acOnEngineOffSec: sum((r) => r.acOnEngineOffSec),
      acOnCount: sum((r) => r.acOnCount),
      acDistanceKm: Math.round(sum((r) => r.acDistanceKm) * 100) / 100,
      doorOpenCount: sum((r) => r.doorOpenCount),
      doorOpenSec: sum((r) => r.doorOpenSec),
    },
    totalRows: all.length,
  };
}
