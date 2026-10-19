import { PrismaClient } from '@prisma/client';
import { AlertTypeCode, DocumentStatus, ServiceStatus } from '@veetracer/shared';

/** What the reminders job does with one row: move its notified state (and raise `alert` when set). */
export interface ReminderTransition {
  next: string | null;
  alert: AlertTypeCode | null;
}

/**
 * Document / licence reminders: one DOCUMENT_EXPIRING when the reminder window opens, one DOCUMENT_EXPIRED the day
 * after expiry. Back to valid (renewed, reminder window shortened) clears the state silently. null = nothing to do.
 */
export function documentTransition(status: DocumentStatus, notified: string | null): ReminderTransition | null {
  if (status === 'EXPIRED') return notified === 'EXPIRED' ? null : { next: 'EXPIRED', alert: 'DOCUMENT_EXPIRED' };
  if (status === 'EXPIRING') return notified === 'EXPIRING' || notified === 'EXPIRED' ? null : { next: 'EXPIRING', alert: 'DOCUMENT_EXPIRING' };
  return notified === null ? null : { next: null, alert: null };
}

/** Service reminders: one SERVICE_DUE when it becomes due soon and one more when it becomes overdue, per due point. */
export function serviceTransition(status: ServiceStatus, notified: string | null): ReminderTransition | null {
  if (status === 'OVERDUE') return notified === 'OVERDUE' ? null : { next: 'OVERDUE', alert: 'SERVICE_DUE' };
  if (status === 'DUE_SOON') return notified === 'DUE_SOON' || notified === 'OVERDUE' ? null : { next: 'DUE_SOON', alert: 'SERVICE_DUE' };
  return notified === null ? null : { next: null, alert: null };
}

const r1 = (v: number) => Math.round(v * 10) / 10;

/**
 * Odometer per vehicle, the same figure as the dashboard: distance recorded by VeeTrax (daily summaries) plus the
 * vehicle's odometer offset.
 */
export async function odometers(prisma: Pick<PrismaClient, 'dailySummary' | 'trackedObject'>, objectIds: string[]): Promise<Map<string, number>> {
  const ids = [...new Set(objectIds)];
  if (!ids.length) return new Map();
  const [sums, objects] = await Promise.all([
    prisma.dailySummary.groupBy({ by: ['objectId'], where: { objectId: { in: ids } }, _sum: { distanceKm: true } }),
    prisma.trackedObject.findMany({ where: { id: { in: ids } }, select: { id: true, odometerOffsetKm: true } }),
  ]);
  const distance = new Map(sums.map((s) => [s.objectId, s._sum.distanceKm ?? 0]));
  return new Map(objects.map((o) => [o.id, r1((distance.get(o.id) ?? 0) + o.odometerOffsetKm)]));
}

/** YYYY-MM-DD of a @db.Date column. */
export const ymd = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);
/** @db.Date value of a YYYY-MM-DD string. */
export const dateOf = (v: string): Date => new Date(`${v.slice(0, 10)}T00:00:00Z`);
