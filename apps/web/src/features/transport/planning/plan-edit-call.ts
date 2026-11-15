/** The API call of one plan edit (E4 WP-W), with the version the user saw. Pure over the client (`node --test`). */
import type { PlannerClient } from './planner-api.ts';
import type { PlanEditResult, PlannerPlan } from './planner-format.ts';
import type { PlanEdit } from './plan-workspace.ts';

export function planEditCall(c: PlannerClient, p: Pick<PlannerPlan, 'id' | 'version'>, e: PlanEdit): Promise<PlanEditResult> {
  const expectedVersion = p.version;
  switch (e.kind) {
    case 'move':
      return c.movePassenger(p.id, {
        expectedVersion,
        bookingId: e.bookingId,
        toAssignmentId: e.toAssignmentId,
        ...(e.pickupIndex !== undefined ? { pickupIndex: e.pickupIndex } : {}),
        ...(e.dropIndex !== undefined ? { dropIndex: e.dropIndex } : {}),
      });
    case 'sequence':
      return c.resequence(p.id, { expectedVersion, assignments: e.assignments });
    case 'vehicle':
      return c.updateAssignment(p.id, e.assignmentId, { expectedVersion, objectId: e.objectId });
    case 'driver':
      return c.updateAssignment(p.id, e.assignmentId, { expectedVersion, driverId: e.driverId });
    case 'lock':
      return c.updateAssignment(p.id, e.assignmentId, { expectedVersion, locked: e.locked });
    case 'pin':
      return c.updateStop(p.id, e.stopId, { expectedVersion, pinned: e.pinned });
    case 'pinBooking':
      return c.pinBooking(p.id, e.bookingId, { expectedVersion, pinned: e.pinned });
    case 'addBooking':
      return c.addBooking(p.id, { expectedVersion, bookingId: e.bookingId });
    case 'removeBooking':
      return c.removeBooking(p.id, e.bookingId, expectedVersion);
    case 'recalculate':
      return c.recalculate(p.id, { expectedVersion, ...(e.assignmentIds?.length ? { assignmentIds: [...e.assignmentIds] } : {}) });
    case 'restore':
      return c.restore(p.id, { expectedVersion, version: e.version });
  }
}
