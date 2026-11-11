import { Prisma } from '@prisma/client';
import { ROUTE_PLAN_EDITABLE, type RoutePlanStatus } from '@veetracer/shared';

type Tx = Prisma.TransactionClient;

/** 2 decimals (≈ 1.1 km): what is left of a personal point that is kept for statistics (as erasure.ts / consent-withdrawal.ts). */
const COARSE = (v: number) => Math.round(v * 100) / 100;

/** Plans still being worked on: a withdrawn passenger's stops are removed from these (OPTIMIZING too: the job goes stale). */
const OPEN_PLAN: readonly RoutePlanStatus[] = [...ROUTE_PLAN_EDITABLE, 'OPTIMIZING'];

/**
 * The passenger's personal-point stops in routing plans of their company (customer side): stops owned by the profile
 * (profileId), and stops serving one of their bookings that are not at a company place (no poiId; a stop written
 * without profileId is still treated as personal, as `stopOwner` does for planned stops).
 */
async function personalPlanStops(tx: Tx, companyId: string, profileId: string, bookingIds: string[]) {
  const or: Prisma.RoutePlanStopWhereInput[] = [{ profileId }];
  if (bookingIds.length) or.push({ bookingId: { in: bookingIds }, poiId: null });
  const stops = await tx.routePlanStop.findMany({ where: { customerCompanyId: companyId, OR: or }, select: { id: true, planId: true, assignmentId: true, lat: true, lng: true } });
  const planIds = [...new Set(stops.map((s) => s.planId))];
  const plans = new Map((planIds.length ? await tx.routePlan.findMany({ where: { id: { in: planIds } }, select: { id: true, status: true, version: true } }) : []).map((p) => [p.id, p]));
  return stops.map((s) => ({ ...s, plan: plans.get(s.planId)! }));
}

type PlanStopRow = Awaited<ReturnType<typeof personalPlanStops>>[number];

/** Coarsen the points, drop the name and the snapped point, and clear the road geometry of their assignments. */
async function coarsen(tx: Tx, stops: PlanStopRow[]): Promise<void> {
  for (const st of stops)
    await tx.routePlanStop.update({
      where: { id: st.id },
      data: { name: null, lat: COARSE(st.lat), lng: COARSE(st.lng), snappedLat: null, snappedLng: null, snapDistanceM: null, snapGraphVersion: null },
    });
  await clearGeometry(tx, stops);
}

async function clearGeometry(tx: Tx, stops: PlanStopRow[]): Promise<void> {
  const assignments = [...new Set(stops.map((s) => s.assignmentId).filter((a): a is string => !!a))];
  if (assignments.length) await tx.routeAssignment.updateMany({ where: { id: { in: assignments } }, data: { geometry: Prisma.DbNull } });
}

/**
 * Erasure (E2 M5 / L5 default) of the passenger's personal points in routing plans, inside the erasure transaction
 * (called by `eraseTransportData`): every such stop keeps its plan statistics (sequence, times, demand) but its point is
 * coarsened to 2 decimals, its name and snapped point removed, and the road geometry of its assignment cleared (it ran
 * through the home). Version snapshots and job inputs hold no coordinates by contract (shared `RoutePlanVersionSnapshot`,
 * `RoutingJobInput`), so nothing else is touched. Returns the number of stops changed.
 */
export async function eraseRoutingPlanPoints(tx: Tx, companyId: string, profileId: string, bookingIds: string[]): Promise<number> {
  const stops = await personalPlanStops(tx, companyId, profileId, bookingIds);
  await coarsen(tx, stops);
  return stops.length;
}

export interface RoutingPlanWithdrawal {
  /** Stops deleted from plans still being worked on (DRAFT / OPTIMIZING / PLANNED). */
  removed: number;
  /** Stops coarsened in PUBLISHED / CANCELLED plans (read-only history; the published trips are handled by E3). */
  anonymised: number;
  /** Plans whose version was bumped (a running optimise job for them becomes stale). */
  planIds: string[];
}

/**
 * Routing-consent (TRANSPORT_PROFILE) withdrawal in routing plans, inside the withdrawal transaction (called by
 * `applyRoutingConsentWithdrawal`): the passenger's personal stops are deleted from open plans (each touched plan gets
 * version + 1, so a running optimise job is discarded as stale and the dispatcher re-optimises) and coarsened in
 * published / cancelled plans; assignment geometry through them is cleared in both cases.
 */
export async function withdrawRoutingPlanPoints(tx: Tx, companyId: string, profileId: string): Promise<RoutingPlanWithdrawal> {
  const bookingIds = (await tx.transportBooking.findMany({ where: { customerCompanyId: companyId, profileId }, select: { id: true } })).map((b) => b.id);
  const stops = await personalPlanStops(tx, companyId, profileId, bookingIds);
  const open = stops.filter((s) => OPEN_PLAN.includes(s.plan.status));
  const closed = stops.filter((s) => !OPEN_PLAN.includes(s.plan.status));
  await clearGeometry(tx, open);
  if (open.length) await tx.routePlanStop.deleteMany({ where: { id: { in: open.map((s) => s.id) } } });
  const plans = new Map(open.map((s) => [s.planId, s.plan.version]));
  for (const [id, version] of plans) await tx.routePlan.update({ where: { id }, data: { version: version + 1 } });
  await coarsen(tx, closed);
  return { removed: open.length, anonymised: closed.length, planIds: [...plans.keys()] };
}
