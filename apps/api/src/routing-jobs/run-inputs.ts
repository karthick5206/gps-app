import type { Prisma, PrismaClient } from '@prisma/client';
import type { AuthContext } from '../access/auth-context';
import type { AuditService } from '../audit/audit.service';
import { storedOverrideOf } from './max-ride';

/** Audit entity of a run that releases locked routes (preserveLocks=false): the plan, with details.change. */
export const PRESERVE_LOCKS_AUDIT_ENTITY = 'RoutePlan';
import type { PlanInputs } from './optimize-problem';
import type { OptimizeRunExtra } from './routing-jobs.service';
import { checkPreferenceMaxRide, detourGuardOf, runMaxRideS, storedPreferencesOf } from './strategies';
import { applyAvailability, availabilityOf, loadBusyTrips, siteSpanOf } from './vehicle-availability';

/**
 * E4 WP-A glue between the plan gateway and the strategy / availability rules (kept out of prisma-plan-gateway.ts so
 * the gateway changes stay two small hunks).
 */

type Db = Pick<PrismaClient | Prisma.TransactionClient, 'plannedTrip' | 'transportTrip'>;

/**
 * Reservation side: the run's strategy, weights source and preferences into RoutePlan.options (`extra` undefined = a
 * caller that predates WP-A: options unchanged). The preference max ride is checked against the plan's effective max
 * ride after any override of this request (400 MAX_RIDE_ABOVE_POLICY). preserveLocks=false (already authorised by the
 * service) is audited when the plan has locked routes or not, with the number of locked routes it releases.
 */
export async function recordRun(
  tx: Prisma.TransactionClient,
  audit: Pick<AuditService, 'record'>,
  ctx: AuthContext,
  plan: { id: string; version: number },
  options: Record<string, unknown>,
  extra: OptimizeRunExtra | undefined,
  policyS: number | null,
): Promise<Record<string, unknown>> {
  if (!extra) return options;
  checkPreferenceMaxRide(extra.preferences, storedOverrideOf(options)?.maxRideS ?? policyS ?? null);
  const out = { ...options };
  if (extra.strategy) out.strategy = extra.strategy;
  else delete out.strategy;
  if (extra.weightsSource) out.weightsSource = extra.weightsSource;
  if (extra.preferences && Object.keys(extra.preferences).length) out.preferences = { ...extra.preferences };
  else delete out.preferences;
  if (extra.preferences?.preserveLocks === false) {
    const locked = Array.isArray(options.lockedAssignmentIds) ? options.lockedAssignmentIds.length : 0;
    await audit.record(ctx, { action: 'UPDATE', entity: PRESERVE_LOCKS_AUDIT_ENTITY, entityId: plan.id, details: { change: 'preserve-locks-released', preserveLocks: false, lockedRoutes: locked, via: 'optimize', version: plan.version } }, tx);
  }
  return out;
}

/** Routes of the plan already published into an E3 trip: never re-solved (even with preserveLocks=false). */
export async function publishedAssignmentIds(db: Pick<PrismaClient | Prisma.TransactionClient, 'transportTrip'>, planId: string): Promise<string[]> {
  const rows = await db.transportTrip.findMany({ where: { routePlanId: planId, routeAssignmentId: { not: null } }, select: { routeAssignmentId: true } });
  return rows.map((r) => r.routeAssignmentId).filter((x): x is string => !!x);
}

/**
 * Worker side, after the gateway built the plan inputs: the run's max ride (the snapshot tightened by the preference),
 * detour guard, vehicle size and each vehicle's free time (busy vehicles left out and reported as unusable).
 */
export async function withRunPreferences(
  db: Db,
  inputs: PlanInputs,
  plan: { options: unknown; planStartAt: Date | null; direction: 'IN' | 'OUT' | null; assignments: { id: string; objectId: string | null; driverId: string | null }[] },
): Promise<PlanInputs> {
  const pref = storedPreferencesOf(plan.options);
  const ids = new Set(inputs.vehicles.map((v) => v.assignmentId));
  const vehicles = plan.assignments.filter((a) => ids.has(a.id)).map((a) => ({ assignmentId: a.id, objectId: a.objectId, driverId: a.driverId }));
  const startMs = plan.planStartAt?.getTime() ?? null;
  const trips = await loadBusyTrips(db, vehicles, startMs);
  const site = inputs.direction && inputs.site ? siteSpanOf(inputs.stops.filter((s) => s.atSite).map((s) => s.timeWindows)) : null;
  const avail = availabilityOf(vehicles, trips, { planStartMs: startMs, direction: inputs.site ? inputs.direction : null, siteSpan: site });
  const { vehicles: kept, unusable } = applyAvailability(inputs.vehicles, avail);
  const detour = detourGuardOf(pref);
  return {
    ...inputs,
    maxRideS: runMaxRideS(inputs.maxRideS, pref),
    vehicles: kept,
    ...(unusable.length ? { unusableVehicles: unusable } : {}),
    ...(detour ? { detourGuard: detour } : {}),
    ...(pref?.vehicleSize && pref.vehicleSize !== 'ANY' ? { vehicleSize: pref.vehicleSize } : {}),
  };
}
