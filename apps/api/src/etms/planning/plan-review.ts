import type { RoutePlanRouteChange, RoutePlanRouteError, RoutePlanVersionSnapshot } from '@veetracer/shared';
import { findBusy, type BusyTrip } from '../dispatch/trip-overlap';
import { requestHash } from '../dispatch/e3-common';
import { routeStops, type RuleStop, type StopPlacement } from './plan-rules';

/**
 * WP-B pure rules of the route plans API: the review hash of a publish selection, the manual-change diff against a
 * version snapshot, the restore (undo / redo) placements with their conflict check, and the availability pre-check of
 * routes against existing trips. No database, no engine: unit-tested in plan-review.spec.ts. Ids, sequences and times
 * only (never coordinates or names).
 */

const MIN = 60_000;

// ───────────────────────────── review hash ─────────────────────────────

/** What the review hash binds of one selected route. */
export interface ReviewRoute {
  id: string;
  objectId: string | null;
  driverId: string | null;
  /** The route's stops in order, with their ETAs. */
  stops: { id: string; etaS: number | null; /** Pooling: AREA trip index (the hash covers the trip split). */ tripIndex?: number }[];
}

/**
 * Stable hash of a publish selection: the plan version and, per selected route (sorted by id, so the selection order
 * does not matter), its vehicle, driver and ordered stops with ETAs, plus the soft-warning fingerprint publish would ask
 * to acknowledge. Any edit of a selected route (or any other version bump) changes it: publish then answers
 * PLAN_REVIEW_STALE and the user must confirm the fresh review.
 */
export function reviewHashOf(input: { version: number; routes: ReviewRoute[]; fingerprint: string | null }): string {
  const routes = [...input.routes].sort((a, b) => a.id.localeCompare(b.id)).map((r) => ({ id: r.id, objectId: r.objectId, driverId: r.driverId, stops: r.stops.map((s) => (s.tripIndex ? [s.id, s.etaS, s.tripIndex] : [s.id, s.etaS])) }));
  return `r1-${requestHash({ v: input.version, routes, fingerprint: input.fingerprint }).slice(0, 32)}`;
}

// ───────────────────────────── manual changes ─────────────────────────────

/** A route's current state (ids only). */
export interface RouteState {
  id: string;
  objectId: string | null;
  driverId: string | null;
  stopIds: string[];
}

/** The ordered stop ids of every route of a snapshot (assignments[].stopIds, else the stops' sequences). */
export function snapshotRoutes(snap: RoutePlanVersionSnapshot): Map<string, RouteState> {
  const out = new Map<string, RouteState>();
  for (const a of snap.assignments ?? []) {
    const listed = Array.isArray(a.stopIds) ? a.stopIds : null;
    const stopIds = listed ?? (snap.stops ?? []).filter((s) => s.assignmentId === a.id).sort((x, y) => (x.sequence ?? 1e9) - (y.sequence ?? 1e9) || x.ref.localeCompare(y.ref)).map((s) => s.id);
    out.set(a.id, { id: a.id, objectId: a.objectId ?? null, driverId: a.driverId ?? null, stopIds });
  }
  return out;
}

/** True when the stops both lists hold come in another relative order. */
function reorderedCommon(before: string[], after: string[]): boolean {
  const inAfter = new Set(after);
  const inBefore = new Set(before);
  const a = before.filter((x) => inAfter.has(x));
  const b = after.filter((x) => inBefore.has(x));
  return a.some((x, i) => x !== b[i]);
}

/** Per route: stops added / removed, kept stops reordered, vehicle / driver changed since the baseline (changed routes only). */
export function manualChanges(baseline: Map<string, RouteState>, current: RouteState[]): RoutePlanRouteChange[] {
  const out: RoutePlanRouteChange[] = [];
  const ids = [...new Set([...current.map((r) => r.id), ...baseline.keys()])];
  const now = new Map(current.map((r) => [r.id, r]));
  for (const id of ids) {
    const was = baseline.get(id) ?? { id, objectId: null, driverId: null, stopIds: [] };
    const is = now.get(id) ?? { id, objectId: was.objectId, driverId: was.driverId, stopIds: [] };
    const before = new Set(was.stopIds);
    const after = new Set(is.stopIds);
    const change: RoutePlanRouteChange = {
      assignmentId: id,
      addedStopIds: is.stopIds.filter((s) => !before.has(s)),
      removedStopIds: was.stopIds.filter((s) => !after.has(s)),
      reordered: reorderedCommon(was.stopIds, is.stopIds),
      vehicleChanged: baseline.has(id) && was.objectId !== is.objectId,
      driverChanged: baseline.has(id) && was.driverId !== is.driverId,
    };
    if (change.addedStopIds.length || change.removedStopIds.length || change.reordered || change.vehicleChanged || change.driverChanged) out.push(change);
  }
  return out;
}

// ───────────────────────────── restore (undo / redo) ─────────────────────────────

export interface RestorePlan {
  /** Stop ids the snapshot has and the plan no longer has / the plan has and the snapshot had not (any → 409). */
  conflict: { removedStopIds: string[]; addedStopIds: string[] } | null;
  /** Stops whose route or place changes. */
  placements: Map<string, StopPlacement>;
  /** Routes whose membership or order changes (to re-time). */
  changed: Set<string>;
  /** Fixed (locked / published) routes the snapshot had otherwise: left as they are. */
  skippedRoutes: string[];
}

/**
 * Placements that put back the snapshot's route membership and order. Only when the plan's stop set is the snapshot's
 * (a stop added or removed since is a conflict: the caller answers 409 PLAN_RESTORE_CONFLICT). Fixed routes (locked or
 * published) keep their stops and order; a stop the snapshot had on a fixed route (or on a route that no longer exists)
 * and that is now elsewhere becomes unassigned. Sequences are numbered from 0 like the manual edits. The caller applies
 * the pin rule (pinnedStopsMoved) and the pickup-before-drop check to the result like any edit.
 */
export function restorePlacements(
  snap: RoutePlanVersionSnapshot,
  current: readonly Pick<RuleStop, 'id' | 'ref' | 'assignmentId' | 'sequence'>[],
  assignmentIds: ReadonlySet<string>,
  fixed: ReadonlySet<string>,
): RestorePlan {
  const snapIds = new Set((snap.stops ?? []).map((s) => s.id));
  const curIds = new Set(current.map((s) => s.id));
  const removed = [...snapIds].filter((s) => !curIds.has(s)).sort();
  const added = [...curIds].filter((s) => !snapIds.has(s)).sort();
  const empty: RestorePlan = { conflict: null, placements: new Map(), changed: new Set(), skippedRoutes: [] };
  if (removed.length || added.length) return { ...empty, conflict: { removedStopIds: removed, addedStopIds: added } };

  const routes = snapshotRoutes(snap);
  const onFixed = new Set(current.filter((s) => s.assignmentId && fixed.has(s.assignmentId)).map((s) => s.id));
  // Target order of every movable route: the snapshot's order of the stops that still exist and are not held by a fixed
  // route. A route is changed only when that ORDER differs (the stored numbers never matter: T2-L3, the optimiser numbers
  // from 1 and the manual edits from 0).
  const placements = new Map<string, StopPlacement>();
  const changed = new Set<string>();
  const targeted = new Set<string>();
  for (const aid of assignmentIds) {
    if (fixed.has(aid)) continue;
    const tgt = (routes.get(aid)?.stopIds ?? []).filter((s) => curIds.has(s) && !onFixed.has(s));
    tgt.forEach((s) => targeted.add(s));
    const cur = routeStops(current as Pick<RuleStop, 'id' | 'ref' | 'assignmentId' | 'sequence'>[], aid).map((s) => s.id);
    if (cur.length === tgt.length && cur.every((x, i) => x === tgt[i])) continue;
    changed.add(aid);
    tgt.forEach((s, i) => placements.set(s, { assignmentId: aid, sequence: i }));
  }
  // A movable stop that no restored route takes (its snapshot route is fixed, gone, or it was unassigned) leaves its route.
  for (const s of current) {
    if (onFixed.has(s.id) || targeted.has(s.id) || !s.assignmentId) continue;
    placements.set(s.id, { assignmentId: null, sequence: null });
    changed.add(s.assignmentId);
  }
  const skippedRoutes = [...fixed].filter((aid) => {
    const was = routes.get(aid)?.stopIds ?? [];
    const is = routeStops(current as Pick<RuleStop, 'id' | 'ref' | 'assignmentId' | 'sequence'>[], aid).map((s) => s.id);
    return was.length !== is.length || was.some((x, i) => x !== is[i]);
  });
  return { conflict: null, placements, changed, skippedRoutes: skippedRoutes.sort() };
}

// ───────────────────────────── availability (before publish) ─────────────────────────────

/**
 * The [start, end) a route's trip will occupy, as buildPlanChangeSet / the E3 publish compute it: planned start = the
 * route's start (planStartAt + startS), clamped to at most an hour before and never after the first stop; end = the
 * last stop's arrival. Null when the plan has no start or the route is not timed (ROUTE_NOT_TIMED is reported apart).
 */
export function routeSpan(planStartMs: number | null, startS: number | null, list: Pick<RuleStop, 'etaS'>[]): { start: Date; end: Date } | null {
  if (planStartMs === null || !list.length || list.some((s) => s.etaS === null)) return null;
  const etas = list.map((s) => planStartMs + (s.etaS as number) * 1000);
  const first = etas[0];
  const wanted = startS !== null ? planStartMs + startS * 1000 : first;
  const start = Math.min(first, Math.max(wanted, first - 60 * MIN));
  return { start: new Date(start), end: new Date(Math.max(...etas)) };
}

/** A route as the availability check needs it. */
export interface AvailabilityRoute {
  id: string;
  vehicleLabel: string;
  objectId: string | null;
  driverId: string | null;
  span: { start: Date; end: Date } | null;
}

/**
 * Blocking route errors before publish (never overridable): an inactive vehicle / driver, and an existing active trip
 * of the route's vehicle / driver overlapping its span (the shared overlap rule, trip-overlap.ts: VEHICLE_BUSY /
 * DRIVER_BUSY, the same codes the E3 publish would answer under its locks). The trip names are the dispatcher's route
 * names (company data, never a passenger's).
 */
export function availabilityErrors(routes: readonly AvailabilityRoute[], trips: readonly BusyTrip[], inactive: { vehicles: ReadonlySet<string>; drivers: ReadonlySet<string> }): RoutePlanRouteError[] {
  const out: RoutePlanRouteError[] = [];
  for (const r of routes) {
    const fail = (code: string, message: string) => out.push({ assignmentId: r.id, vehicleLabel: r.vehicleLabel, code, message: `Route ${r.vehicleLabel}: ${message}` });
    if (r.objectId && inactive.vehicles.has(r.objectId)) fail('VEHICLE_INACTIVE', 'the vehicle is inactive; choose another vehicle');
    if (r.driverId && inactive.drivers.has(r.driverId)) fail('DRIVER_INACTIVE', 'the driver is inactive; choose another driver');
    if (!r.span) continue;
    const hit = findBusy(trips, r, r.span.start, r.span.end);
    if (hit) fail(hit.code, `the ${hit.code === 'VEHICLE_BUSY' ? 'vehicle' : 'driver'} is already planned on "${hit.trip.routeName}" at that time`);
  }
  return out;
}

export const AVAILABILITY_CODES: ReadonlySet<string> = new Set(['VEHICLE_BUSY', 'DRIVER_BUSY', 'VEHICLE_INACTIVE', 'DRIVER_INACTIVE']);
