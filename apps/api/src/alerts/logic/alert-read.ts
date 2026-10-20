import { Prisma } from '@prisma/client';

/**
 * Per-user "read" state of alerts, separate from acknowledging (which is shared).
 *
 * An alert is read for user U when any of these holds:
 *  - it is no longer NEW (acknowledged / resolved alerts are handled, so read for everyone);
 *  - U opened it or marked it read (an `AlertRead(alertId, U)` row);
 *  - it occurred at or before U's "mark all as read" watermark (`User.alertsReadBefore`).
 *
 * The watermark compares `occurredAt` (timestamptz). `createdAt` would be the better "when did the user first see it"
 * time, but it is a `timestamp` column written in two time zones (UTC by Prisma, the session zone by the rules engine's
 * raw INSERT), so it can't be compared reliably. Trade-off: an alert for buffered data that arrives after "mark all as
 * read" but occurred before it counts as read.
 */
export interface ReadInputs {
  status: string;
  occurredAt: Date;
  /** An AlertRead row exists for this user. */
  explicit: boolean;
  watermark: Date | null;
}

export function isAlertRead({ status, occurredAt, explicit, watermark }: ReadInputs): boolean {
  return status !== 'NEW' || explicit || (watermark !== null && occurredAt.getTime() <= watermark.getTime());
}

/**
 * SQL boolean for "alert `a` is read by `userId`" (never NULL, so `NOT (…)` is safe).
 * The watermark subquery is uncorrelated (evaluated once per statement); the EXISTS probe uses the AlertRead primary key.
 */
export function readSql(userId: string): Prisma.Sql {
  return Prisma.sql`(a."status" <> 'NEW'
    OR a."occurredAt" <= COALESCE((SELECT u."alertsReadBefore" FROM "User" u WHERE u.id = ${userId}::uuid), '-infinity'::timestamptz)
    OR EXISTS (SELECT 1 FROM "AlertRead" r WHERE r."alertId" = a.id AND r."userId" = ${userId}::uuid))`;
}
