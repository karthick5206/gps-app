/**
 * Pure helpers for the ETMS E1b fleet allocation panel and the sensitive-access log (no React / DOM / aliases, so
 * `node --test` runs them). Docs: docs/employee-transport/12 §6, 15 §10, 10 §2.2 item 8.
 */
import type { CreateTransportFleetAllocationInput, TransportAccessActorKind, TransportAccessLogEntryDto, TransportFleetAllocationDto } from '@veetracer/shared';

/** "Bus 12 (TN 01 AB 1234) · Driver One" style label; parts the row lacks are left out. */
export function allocationLabel(a: Pick<TransportFleetAllocationDto, 'vehicle' | 'driver'>): string {
  const vehicle = a.vehicle ? (a.vehicle.plateNumber && a.vehicle.plateNumber !== a.vehicle.name ? `${a.vehicle.name} (${a.vehicle.plateNumber})` : a.vehicle.name) : null;
  return [vehicle, a.driver?.name ?? null].filter((x): x is string => !!x).join(' · ');
}

export type AllocationState = 'active' | 'scheduled' | 'ended' | 'inactive';

/** Badge state: active now, starts later, already over, or open but not in force (agreement not in force). */
export function allocationState(a: Pick<TransportFleetAllocationDto, 'active' | 'validFrom' | 'validTo'>, now: Date = new Date()): AllocationState {
  if (a.active) return 'active';
  if (a.validTo && new Date(a.validTo) <= now) return 'ended';
  if (new Date(a.validFrom) > now) return 'scheduled';
  return 'inactive';
}

export const ALLOCATION_STATE_LABEL: Record<AllocationState, string> = {
  active: 'In force',
  scheduled: 'Starts later',
  ended: 'Ended',
  inactive: 'Not in force',
};

/** Active first, then scheduled, then the rest; newest start first inside each group. */
export function sortAllocations<T extends Pick<TransportFleetAllocationDto, 'active' | 'validFrom' | 'validTo'>>(rows: T[], now: Date = new Date()): T[] {
  const rank: Record<AllocationState, number> = { active: 0, scheduled: 1, inactive: 2, ended: 3 };
  return [...rows].sort((x, y) => rank[allocationState(x, now)] - rank[allocationState(y, now)] || y.validFrom.localeCompare(x.validFrom));
}

/** Local `datetime-local` value → ISO, '' → undefined; unparsable → null. */
export function localInputToIso(v: string): string | undefined | null {
  if (!v.trim()) return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Validates the allocate form; returns the request body or an English error key. */
export function allocationInput(v: {
  objectId: string | null;
  driverId: string | null;
  validFrom: string;
  validTo: string;
  note: string;
}): { ok: true; input: CreateTransportFleetAllocationInput } | { ok: false; error: string } {
  if (!v.objectId && !v.driverId) return { ok: false, error: 'Choose a vehicle, a driver or both.' };
  const from = localInputToIso(v.validFrom);
  const to = localInputToIso(v.validTo);
  if (from === null || to === null) return { ok: false, error: 'Invalid date' };
  if (from && to && to <= from) return { ok: false, error: '"Valid to" must be after "valid from"' };
  const note = v.note.trim();
  return {
    ok: true,
    input: { objectId: v.objectId, driverId: v.driverId, ...(from ? { validFrom: from } : {}), ...(to ? { validTo: to } : {}), ...(note ? { note } : {}) },
  };
}

/** Friendly English text for fleet API error codes (translated by the caller). */
export function fleetErrorText(code: string | null): string | null {
  switch (code) {
    case 'ALLOCATION_OVERLAP':
      return 'This vehicle or driver is already allocated to this customer for an overlapping period.';
    case 'INVALID_STATE':
      return 'The agreement has ended: no new allocations.';
    case 'FORBIDDEN_GRANT':
      return 'Only the provider can allocate its vehicles and drivers.';
    case 'SCOPE_REQUIRED':
      return 'Only users with whole-company access can change allocations.';
    default:
      return null;
  }
}

// ───────────────────────────── Sensitive-access log ─────────────────────────────

export const ACCESS_ACTOR_LABEL: Record<TransportAccessActorKind, string> = {
  OWN: 'Our staff',
  PROVIDER: 'Provider',
  SUPPORT: 'VeeTrax support',
};

/** What was read, in words. Unknown values pass through. */
export function accessWhatLabel(what: string): string {
  switch (what) {
    case 'detail':
      return 'Opened passenger details';
    case 'list':
      return 'Listed passengers';
    case 'csv-export':
      return 'Exported passengers (CSV)';
    case 'consent-history':
      return 'Viewed consent records';
    case 'history':
      return 'Viewed passenger history';
    case 'incident-detail':
      return 'Opened an SOS incident';
    case 'transport-records':
      return 'Opened bookings, trips or route plans';
    default:
      return what;
  }
}

/** "Name · Company" of who read the data; VeeTrax support (translated with `tr`, QA B7) when no name is given. */
export function accessActorText(e: Pick<TransportAccessLogEntryDto, 'actorKind' | 'actorName' | 'actorCompanyName'>, tr: (s: string) => string = (s) => s): string {
  const parts = [e.actorName, e.actorKind === 'PROVIDER' ? e.actorCompanyName : null].filter((x): x is string => !!x);
  return parts.length ? parts.join(' · ') : e.actorKind === 'SUPPORT' ? tr('VeeTrax support') : '—';
}
