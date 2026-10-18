import { MOVEMENT_STATUSES, type LiveObject, type MovementStatus } from '@veetracer/shared';

export interface LiveFilters {
  q: string;
  statuses: MovementStatus[]; // empty = all
  branchId: string | null;
  groupId: string | null;
  /** `vt:<VehicleType>` or `ot:<ObjectType>` */
  type: string | null;
  selectedOnly: boolean;
}

export const EMPTY_FILTERS: LiveFilters = { q: '', statuses: [], branchId: null, groupId: null, type: null, selectedOnly: false };

export function parseStatusParam(value: string | null): MovementStatus[] {
  return MOVEMENT_STATUSES.filter((s) => s === value);
}

interface Context {
  groupMembers: Map<string, Set<string>>;
  selected: Set<string>;
}

/** Everything except the status chips (so chips can show counts for the other filters). */
export function baseMatcher(f: LiveFilters, ctx: Context): (o: LiveObject) => boolean {
  const q = f.q.trim().toLowerCase();
  const members = f.groupId ? ctx.groupMembers.get(f.groupId) ?? new Set<string>() : null;
  const [typeKind, typeValue] = f.type ? f.type.split(':') : [null, null];
  return (o) => {
    if (f.selectedOnly && !ctx.selected.has(o.objectId)) return false;
    if (f.branchId && o.branchId !== f.branchId) return false;
    if (members && !members.has(o.objectId)) return false;
    if (typeKind === 'vt' && o.vehicleType !== typeValue) return false;
    if (typeKind === 'ot' && o.type !== typeValue) return false;
    if (q) {
      const hay = `${o.name}\u0000${o.plateNumber ?? ''}\u0000${o.uniqueId ?? ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  };
}

export function fullMatcher(f: LiveFilters, ctx: Context): (o: LiveObject) => boolean {
  const base = baseMatcher(f, ctx);
  const statuses = f.statuses.length ? new Set(f.statuses) : null;
  return (o) => (!statuses || statuses.has(o.status)) && base(o);
}
