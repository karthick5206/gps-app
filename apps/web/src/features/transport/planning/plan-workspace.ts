/**
 * E4 WP-W plan workspace logic (pure; no React, no path aliases, so `node --test` runs it):
 * - `PlanEdit`: every explicit edit of the plan page (one API call each, with the version the user saw);
 * - undo / redo: an in-memory cursor over the plan's versions, applied as restore(previous / next version);
 * - drag and drop: a dragged stop + drop target → the edit request (or why it is refused before any call);
 * - per-route issues after an edit (stop violations, route violations, publish route errors);
 * - bookings that may be added to a plan (from the dispatch board queue).
 */
import type { RoutePlanRouteError, RoutePlanRouteViolation, RoutePlanStopViolation, RoutePlanVersionDto, TransportBookingDto } from '@veetracer/shared';
import { moveStop, routesOf, routeStops, changedRoutes, type PlannerPlan } from './planner-format.ts';

// ───────────────────────────── edits ─────────────────────────────

export type PlanEdit =
  | { kind: 'move'; bookingId: string; toAssignmentId: string | null; pickupIndex?: number; dropIndex?: number }
  | { kind: 'sequence'; assignments: { assignmentId: string; stopIds: string[] }[] }
  | { kind: 'vehicle'; assignmentId: string; objectId: string }
  | { kind: 'driver'; assignmentId: string; driverId: string | null }
  | { kind: 'lock'; assignmentId: string; locked: boolean }
  | { kind: 'pin'; stopId: string; pinned: boolean }
  | { kind: 'pinBooking'; bookingId: string; pinned: boolean }
  | { kind: 'addBooking'; bookingId: string }
  | { kind: 'removeBooking'; bookingId: string }
  | { kind: 'recalculate'; assignmentIds?: string[] }
  | { kind: 'restore'; version: number };

// ───────────────────────────── undo / redo ─────────────────────────────

/**
 * One step of the timeline: a plan version and its route membership (`key`). Restore only puts back membership and
 * order, so versions with the same membership are one step (a pin / lock / vehicle change is not an undo step), and
 * only versions with the current stop set are offered (restore answers PLAN_RESTORE_CONFLICT otherwise).
 */
export interface UndoStep {
  version: number;
  key: string;
}

export interface UndoCursor {
  steps: UndoStep[];
  /** Index of the step the plan is at now. */
  pos: number;
  /** The plan version the cursor describes (a different plan version means someone else changed it: rebuild). */
  head: number;
  /** Sorted stop ids of the plan: a different set (booking added / removed) starts a new timeline. */
  stopSet: string;
}

type Membership = { assignments: readonly { id: string; stopIds: readonly string[] }[] };

const keyOf = (m: Membership): string =>
  [...m.assignments]
    .map((a) => `${a.id}:${a.stopIds.join(',')}`)
    .sort()
    .join('|');

const stopSetOf = (ids: readonly string[]): string => [...ids].sort().join(',');

/** Membership key and stop set of the plan as loaded. */
export function planMembership(plan: Pick<PlannerPlan, 'assignments' | 'stops'>): { key: string; stopSet: string } {
  const routes = routesOf(plan);
  return { key: keyOf({ assignments: routes.map((r) => ({ id: r.assignmentId, stopIds: r.stopIds })) }), stopSet: stopSetOf(plan.stops.map((s) => s.id)) };
}

const SKIP_TYPES = new Set(['CANCELLED', 'ERASED']);

/** Timeline from the version history (any order) up to the plan's version; the plan itself is the last step. */
export function cursorFromHistory(history: readonly Pick<RoutePlanVersionDto, 'version' | 'changeType' | 'snapshot'>[], plan: Pick<PlannerPlan, 'version' | 'assignments' | 'stops'>): UndoCursor {
  const now = planMembership(plan);
  const steps: UndoStep[] = [];
  for (const v of [...history].sort((a, b) => a.version - b.version)) {
    if (v.version >= plan.version || SKIP_TYPES.has(v.changeType) || !v.snapshot) continue;
    if (stopSetOf(v.snapshot.stops.map((s) => s.id)) !== now.stopSet) continue;
    const key = keyOf(v.snapshot);
    if (steps.length && steps[steps.length - 1].key === key) steps[steps.length - 1] = { version: v.version, key };
    else steps.push({ version: v.version, key });
  }
  if (steps.length && steps[steps.length - 1].key === now.key) steps.pop();
  steps.push({ version: plan.version, key: now.key });
  return { steps, pos: steps.length - 1, head: plan.version, stopSet: now.stopSet };
}

export const undoTarget = (c: UndoCursor | null): number | null => (c && c.pos > 0 ? c.steps[c.pos - 1].version : null);
export const redoTarget = (c: UndoCursor | null): number | null => (c && c.pos < c.steps.length - 1 ? c.steps[c.pos + 1].version : null);

/** After a successful restore (undo: -1, redo: +1) that produced `plan`. */
export function afterRestore(c: UndoCursor, delta: -1 | 1, plan: Pick<PlannerPlan, 'version'>): UndoCursor {
  return { ...c, pos: Math.max(0, Math.min(c.steps.length - 1, c.pos + delta)), head: plan.version };
}

/** After any other successful edit: the redo branch is dropped; a membership change is a new step. */
export function afterEdit(c: UndoCursor | null, plan: Pick<PlannerPlan, 'version' | 'assignments' | 'stops'>): UndoCursor {
  const m = planMembership(plan);
  if (!c || c.stopSet !== m.stopSet) return { steps: [{ version: plan.version, key: m.key }], pos: 0, head: plan.version, stopSet: m.stopSet };
  const kept = c.steps.slice(0, c.pos + 1);
  if (kept[kept.length - 1].key === m.key) kept[kept.length - 1] = { version: plan.version, key: m.key };
  else kept.push({ version: plan.version, key: m.key });
  return { steps: kept, pos: kept.length - 1, head: plan.version, stopSet: m.stopSet };
}

/** PLAN_RESTORE_CONFLICT: the steps before the current one can no longer be restored; keep only what is ahead. */
export function afterRestoreConflict(c: UndoCursor, delta: -1 | 1): UndoCursor {
  if (delta < 0) return { ...c, steps: c.steps.slice(c.pos), pos: 0 };
  return { ...c, steps: c.steps.slice(0, c.pos + 1) };
}

// ───────────────────────────── drag and drop ─────────────────────────────

type DnDStop = PlannerPlan['stops'][number];
type DnDPlan = Pick<PlannerPlan, 'stops' | 'assignments'>;

/** Where a dragged stop was dropped: a route (before its displayed row `before`, null = at the end) or the unassigned list. */
export interface DropTarget {
  assignmentId: string | null;
  before: number | null;
}

export type DropResult = { ok: true; edit: PlanEdit } | { ok: false; reason: string };

const routeOf = (plan: DnDPlan, id: string | null) => (id ? plan.assignments.find((a) => a.id === id) : undefined);
const frozen = (a: { locked?: boolean; published?: boolean } | undefined) => !!a && (!!a.locked || !!a.published);

/** Whether a stop may be dragged at all (its route is not locked or published). */
export function canDrag(plan: DnDPlan, stop: Pick<DnDStop, 'assignmentId'>): boolean {
  return !frozen(routeOf(plan, stop.assignmentId));
}

/**
 * The edit a drop asks for:
 * - same route → its new full order (PUT sequence); a passenger's drop never ahead of its own pickup;
 * - another route → a booking moves with both ends (POST move-passenger with the index of the dragged end in the
 *   target's order, the API's insertion rule); a generic stop through the sequence of both routes;
 * - the unassigned list → "Remove from route" (move-passenger toAssignmentId null).
 * Locked / published routes and pinned passengers are refused here with the API's reason, before any call.
 */
export function dropToEdit(plan: DnDPlan, stopId: string, target: DropTarget): DropResult {
  const stop = plan.stops.find((s) => s.id === stopId);
  if (!stop) return { ok: false, reason: 'That stop is no longer on the plan.' };
  const from = routeOf(plan, stop.assignmentId);
  const to = routeOf(plan, target.assignmentId);
  if (from?.published || to?.published) return { ok: false, reason: 'Published routes cannot change.' };
  if (from?.locked || to?.locked) return { ok: false, reason: 'That route is locked. Unlock it first.' };
  const group = stop.bookingId ? plan.stops.filter((s) => s.bookingId === stop.bookingId) : [stop];
  const pinned = group.some((s) => s.pinned);

  // Same route: reorder.
  if (target.assignmentId !== null && target.assignmentId === stop.assignmentId) {
    const routes = routesOf(plan);
    const list = routes.find((r) => r.assignmentId === target.assignmentId)?.stopIds ?? [];
    const fromIdx = list.indexOf(stopId);
    const raw = target.before ?? list.length;
    const index = raw > fromIdx ? raw - 1 : raw;
    if (index === fromIdx) return { ok: false, reason: 'The stop is already there.' };
    const next = moveStop(routes, stopId, target.assignmentId, index);
    const order = next.find((r) => r.assignmentId === target.assignmentId)?.stopIds ?? [];
    if (stop.bookingId) {
      const p = group.find((s) => s.stopKind === 'PICKUP');
      const d = group.find((s) => s.stopKind === 'DROP');
      if (p && d && order.indexOf(d.id) >= 0 && order.indexOf(p.id) >= 0 && order.indexOf(d.id) < order.indexOf(p.id)) return { ok: false, reason: 'The drop must come after the pickup.' };
    }
    return { ok: true, edit: { kind: 'sequence', assignments: changedRoutes(routes, next) } };
  }

  if (pinned) return { ok: false, reason: 'That stop is pinned to its vehicle. Unpin it first.' };

  // Off every route.
  if (target.assignmentId === null) {
    if (!stop.assignmentId) return { ok: false, reason: 'The stop is already there.' };
    if (stop.bookingId) return { ok: true, edit: { kind: 'move', bookingId: stop.bookingId, toAssignmentId: null } };
    const routes = routesOf(plan);
    return { ok: true, edit: { kind: 'sequence', assignments: changedRoutes(routes, moveStop(routes, stopId, null)) } };
  }
  if (!to) return { ok: false, reason: 'That route is no longer on the plan.' };

  // Another route.
  const order = routeStops(plan.stops, to.id).filter((s) => !group.some((g) => g.id === s.id));
  const at = Math.max(0, Math.min(target.before ?? order.length, order.length));
  if (!stop.bookingId) {
    const routes = routesOf(plan);
    return { ok: true, edit: { kind: 'sequence', assignments: changedRoutes(routes, moveStop(routes, stopId, to.id, at)) } };
  }
  if (stop.stopKind === 'DROP') {
    // The pickup goes where the API puts it by default (before the target's first drop), then the drop at `at`.
    const hasPickup = group.some((s) => s.stopKind === 'PICKUP');
    const firstDrop = order.findIndex((s) => s.stopKind === 'DROP');
    const pickupAt = firstDrop >= 0 ? firstDrop : order.length;
    const dropIndex = hasPickup ? Math.max(at + (pickupAt <= at ? 1 : 0), pickupAt + 1) : at;
    return { ok: true, edit: { kind: 'move', bookingId: stop.bookingId, toAssignmentId: to.id, dropIndex } };
  }
  return { ok: true, edit: { kind: 'move', bookingId: stop.bookingId, toAssignmentId: to.id, pickupIndex: at } };
}

// ───────────────────────────── issues per route ─────────────────────────────

export interface RouteIssues {
  /** Block publishing (route errors, route violations, hard stop issues that cannot be overridden). */
  errors: { code: string; message: string }[];
  /** Stop warnings on this route (counted per kind). */
  warnings: { kind: RoutePlanStopViolation['kind']; n: number }[];
}

const BLOCKING_KINDS = new Set(['over_capacity', 'unreachable']);

/**
 * Issues of each route after the last edit: the edit's route violations (VEHICLE_NO_SEATS …), the plan's publish route
 * errors (VEHICLE_BUSY, DRIVER_BUSY, …) and the stop violations on the route (seats / unreachable block; the rest warn).
 */
export function routeIssues(
  plan: Pick<PlannerPlan, 'stops' | 'assignments' | 'violations' | 'publishCheck'>,
  last?: { violations?: readonly RoutePlanStopViolation[]; routeViolations?: readonly RoutePlanRouteViolation[] } | null,
): Map<string, RouteIssues> {
  const out = new Map<string, RouteIssues>();
  const get = (id: string) => {
    let r = out.get(id);
    if (!r) out.set(id, (r = { errors: [], warnings: [] }));
    return r;
  };
  const stopRoute = new Map(plan.stops.map((s) => [s.id, s.assignmentId]));
  for (const v of last?.routeViolations ?? []) get(v.assignmentId).errors.push({ code: v.code, message: v.message });
  for (const e of (plan.publishCheck?.routeErrors ?? []) as RoutePlanRouteError[]) {
    const r = get(e.assignmentId);
    if (!r.errors.some((x) => x.code === e.code)) r.errors.push({ code: e.code, message: e.message });
  }
  const seen = new Set<string>();
  const all = [...(last?.violations ?? []), ...(plan.violations ?? []), ...plan.assignments.flatMap((a) => a.violations ?? [])];
  const counts = new Map<string, Map<RoutePlanStopViolation['kind'], number>>();
  for (const v of all) {
    const k = `${v.stopId}|${v.kind}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const aid = stopRoute.get(v.stopId);
    if (!aid) continue;
    if (BLOCKING_KINDS.has(v.kind)) {
      const r = get(aid);
      const code = v.kind === 'over_capacity' ? 'OVER_CAPACITY' : 'UNREACHABLE';
      if (!r.errors.some((x) => x.code === code)) r.errors.push({ code, message: '' });
      continue;
    }
    const m = counts.get(aid) ?? new Map();
    m.set(v.kind, (m.get(v.kind) ?? 0) + 1);
    counts.set(aid, m);
  }
  for (const [aid, m] of counts) get(aid).warnings = [...m].map(([kind, n]) => ({ kind, n }));
  return out;
}

// ───────────────────────────── bookings that may be added ─────────────────────────────

/**
 * Open bookings of the dispatch board that plan creation would take for this plan (same date and direction from the
 * board query; same shift when the plan has one; waiting for a seat; COMMUTE; with points) and are not on it yet. The
 * server re-checks everything (409 BOOKING_NOT_PLANNABLE with the reason).
 */
export function addableBookings(plan: Pick<PlannerPlan, 'stops' | 'shiftId' | 'direction' | 'planDate'>, queue: readonly TransportBookingDto[], search = ''): TransportBookingDto[] {
  const on = new Set(plan.stops.map((s) => s.bookingId).filter(Boolean));
  const q = search.trim().toLowerCase();
  return queue.filter(
    (b) =>
      b.status === 'PENDING_ASSIGNMENT' &&
      b.journey !== 'POINT_TO_POINT' &&
      !b.needsLocation &&
      !on.has(b.id) &&
      b.serviceDate === plan.planDate &&
      (!plan.direction || b.direction === plan.direction) &&
      (!plan.shiftId || b.shiftId === plan.shiftId) &&
      (!q || b.passenger.displayName.toLowerCase().includes(q) || b.passenger.employeeCode.toLowerCase().includes(q) || b.id.toLowerCase().startsWith(q)),
  );
}

/** Every text of the workspace logic (checked for hi / ta in plan-workspace.test.ts). */
export const WORKSPACE_LOGIC_STRINGS = [
  'That stop is no longer on the plan.',
  'Published routes cannot change.',
  'That route is locked. Unlock it first.',
  'The stop is already there.',
  'The drop must come after the pickup.',
  'That stop is pinned to its vehicle. Unpin it first.',
  'That route is no longer on the plan.',
] as const;
