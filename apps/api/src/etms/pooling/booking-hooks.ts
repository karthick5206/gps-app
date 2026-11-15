import { Prisma } from '@prisma/client';
import type { DispatchTrigger, RoutePlanStatus } from '@veetracer/shared';
import { planSnapshot } from '../planning/plan-view';
import { poolingSettingsOf, liveDispatchOn } from './pooling-settings';

/**
 * Booking lifecycle hooks of pooling, called inside the booking's own transaction (the booking row is locked; lock order
 * bookings → trips → plans, as consent withdrawal / erasure / publish take them):
 *  - a new / approved booking waiting for a seat is queued for live dispatch (a QUEUED TransportDispatchRequest, the
 *    worker decides; only while the company switch is on and the env kill switch is not set);
 *  - a cancelled booking leaves every unpublished plan (its stops go, the plan version + 1 with a version row, so a
 *    review / publish of the old content is refused as stale) and is logged as a CANCEL request. A published trip's seat
 *    is released by the caller (unchanged E3 behaviour); nobody else's stop times move.
 */

type Tx = Prisma.TransactionClient;
const EDITABLE: RoutePlanStatus[] = ['DRAFT', 'PLANNED', 'OPTIMIZING'];

async function liveOn(tx: Tx, companyId: string): Promise<boolean> {
  const c = await tx.company.findUnique({ where: { id: companyId }, select: { settings: true } });
  return liveDispatchOn(poolingSettingsOf(c?.settings));
}

/** Idempotent per trigger fact (unique companyId + idempotencyKey). Returns the request id, or null when live dispatch is off. */
export async function enqueueDispatch(tx: Tx, input: { companyId: string; bookingId: string | null; tripId?: string | null; trigger: DispatchTrigger; key: string; userId: string | null; status?: 'QUEUED' | 'APPLIED' | 'PROPOSED'; reasons?: string[] }): Promise<string | null> {
  if (!(await liveOn(tx, input.companyId))) return null;
  const existing = await tx.transportDispatchRequest.findFirst({ where: { companyId: input.companyId, idempotencyKey: input.key }, select: { id: true } });
  if (existing) return existing.id;
  const row = await tx.transportDispatchRequest.create({
    data: { companyId: input.companyId, bookingId: input.bookingId, tripId: input.tripId ?? null, trigger: input.trigger, status: input.status ?? 'QUEUED', idempotencyKey: input.key, createdById: input.userId, reasons: (input.reasons ?? []) as Prisma.InputJsonValue, ...(input.status && input.status !== 'QUEUED' ? { decidedAt: new Date() } : {}) },
    select: { id: true },
  });
  return row.id;
}

/** A booking now waiting for a seat (created PENDING_ASSIGNMENT, or approved): live dispatch looks for a vehicle. */
export function onBookingWaiting(tx: Tx, b: { id: string; customerCompanyId: string; version: number }, userId: string | null): Promise<string | null> {
  return enqueueDispatch(tx, { companyId: b.customerCompanyId, bookingId: b.id, trigger: 'NEW_BOOKING', key: `booking:${b.id}:v${b.version}`, userId });
}

/** Cancellation: unpublished plans drop the booking's stops (version + 1, version row); a CANCEL request is logged. Returns the plans changed. */
export async function onBookingCancelled(tx: Tx, b: { id: string; customerCompanyId: string }, userId: string | null): Promise<string[]> {
  const stops = await tx.routePlanStop.findMany({ where: { bookingId: b.id, plan: { status: { in: EDITABLE } } }, select: { id: true, planId: true, assignmentId: true } });
  const planIds = [...new Set(stops.map((s) => s.planId))].sort();
  const changed: string[] = [];
  for (const planId of planIds) {
    await tx.$queryRaw`SELECT id FROM "RoutePlan" WHERE id = ${planId}::uuid FOR UPDATE`;
    const plan = await tx.routePlan.findUnique({ where: { id: planId }, select: { id: true, companyId: true, status: true, version: true, transportTrips: { select: { routeAssignmentId: true } } } });
    if (!plan || !EDITABLE.includes(plan.status as RoutePlanStatus)) continue;
    // Stops on an already published route stay (that route is immutable; its seat was released by the caller).
    const published = new Set(plan.transportTrips.map((t) => t.routeAssignmentId).filter((x): x is string => !!x));
    const gone = stops.filter((s) => s.planId === planId && !(s.assignmentId && published.has(s.assignmentId))).map((s) => s.id);
    if (!gone.length) continue;
    await tx.routePlanStop.deleteMany({ where: { id: { in: gone }, planId } });
    const next = plan.version + 1;
    await tx.routePlan.update({ where: { id: planId }, data: { version: next } });
    const [assignments, rest] = await Promise.all([
      tx.routeAssignment.findMany({ where: { planId }, select: { id: true, vehicleLabel: true, objectId: true, driverId: true, seq: true } }),
      tx.routePlanStop.findMany({ where: { planId }, select: { id: true, ref: true, assignmentId: true, sequence: true, etaS: true, unassignedReason: true } }),
    ]);
    const snapshot = planSnapshot(plan.status as RoutePlanStatus, assignments, rest);
    await tx.routePlanVersion.create({ data: { planId, companyId: plan.companyId, version: next, changeType: 'EDITED', snapshot: { ...snapshot, bookingCancelled: b.id } as unknown as Prisma.InputJsonValue, changedById: userId } });
    changed.push(planId);
  }
  await enqueueDispatch(tx, { companyId: b.customerCompanyId, bookingId: b.id, trigger: 'CANCEL', key: `cancel:${b.id}`, userId, status: 'APPLIED' });
  return changed;
}
