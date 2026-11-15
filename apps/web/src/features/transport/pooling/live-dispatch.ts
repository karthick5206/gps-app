/**
 * Live dispatch board state (doc 20 §5–7, pure, `node --test`): the "Find a vehicle" flow (dry-run, then apply with an
 * Idempotency-Key that stays the same for retries of the same choice), the decision-log rows and the proposals that
 * wait for the dispatcher. The server decides feasibility, policy (P4) and commitments; this only presents them.
 * No React, DOM or path aliases.
 */
import type { DispatchOptionDto, DispatchReasonCode, DispatchRequestDto, DispatchRequestStatus, DispatchTrigger, LiveDispatchDecisionDto } from '@veetracer/shared';

export const DISPATCH_STATUS_META: Record<DispatchRequestStatus, { label: string; tone: 'info' | 'warning' | 'success' | 'destructive' | 'muted' }> = {
  QUEUED: { label: 'Queued', tone: 'muted' },
  DECIDED: { label: 'Options found', tone: 'info' },
  PROPOSED: { label: 'Needs your approval', tone: 'warning' },
  APPLIED: { label: 'Applied', tone: 'success' },
  REJECTED: { label: 'No vehicle found', tone: 'destructive' },
  FAILED: { label: 'Failed', tone: 'destructive' },
};

export const DISPATCH_TRIGGER_LABEL: Record<DispatchTrigger, string> = { NEW_BOOKING: 'New booking', CANCEL: 'Cancellation', DELAY: 'Delay', BREAKDOWN: 'Breakdown', MANUAL: 'Dispatcher' };

export const DISPATCH_TARGET_LABEL: Record<DispatchOptionDto['target'], string> = { SCHEDULED: 'Scheduled trip', ACTIVE: 'Started trip', IDLE: 'Idle vehicle' };

export const DISPATCH_REASON_LABEL: Record<DispatchReasonCode, string> = {
  NO_CANDIDATE: 'No vehicle in range',
  CAPACITY: 'Not enough seats',
  PICKUP_WINDOW: 'Pickup window cannot be met',
  MAX_RIDE: 'Ride would be too long',
  MAX_DETOUR: 'Detour would be too long',
  COMMITMENT: 'Would break another passenger’s commitment',
  PRIVATE_NEEDS_EMPTY_VEHICLE: 'Private ride needs an empty vehicle',
  PRIVATE_TRIP: 'The trip carries a private ride',
  VEHICLE_BUSY: 'Vehicle busy',
  VEHICLE_UNAVAILABLE: 'Vehicle not available (downtime or outside operating hours)',
  DRIVER_HOURS: 'Driver working hours',
  TRIP_STARTED: 'Trip already started',
  ON_HOLD: 'Booking on hold',
  NOT_ELIGIBLE: 'Passenger not eligible',
  CONSENT_REQUIRED: 'Routing consent missing',
  NEEDS_LOCATION: 'Pickup or drop point missing',
  SOLVER_UNAVAILABLE: 'Optimiser unavailable (fallback used)',
  ONBOARD_TRANSFER: 'Boarded passenger of a broken-down vehicle',
  DISABLED: 'Live dispatch switched off',
};

export const reasonText = (code: string): string => DISPATCH_REASON_LABEL[code as DispatchReasonCode] ?? code;

/** P4/P5: an option on a started trip, or one the policy may not auto-apply, needs an explicit dispatcher choice. */
export function needsDispatcher(o: Pick<DispatchOptionDto, 'target' | 'autoApplicable'>): boolean {
  return o.target === 'ACTIVE' || !o.autoApplicable;
}

/** Options ranked by the server; the first is the best. Kept in the server order (never re-ranked here). */
export function bestOption(d: Pick<LiveDispatchDecisionDto, 'options'> | null | undefined): DispatchOptionDto | null {
  return d?.options[0] ?? null;
}

// ───────────────────────────── Find-a-vehicle flow ─────────────────────────────

export type DecideState =
  | { step: 'idle' }
  | { step: 'finding'; bookingId: string }
  | { step: 'options'; bookingId: string; decision: LiveDispatchDecisionDto; chosen: string | null }
  | { step: 'applying'; bookingId: string; decision: LiveDispatchDecisionDto; chosen: string; key: string }
  | { step: 'applied'; bookingId: string; decision: LiveDispatchDecisionDto }
  | { step: 'error'; bookingId: string; decision: LiveDispatchDecisionDto | null; chosen: string | null; key: string | null; code: string | null; message: string };

export type DecideAction =
  | { type: 'find'; bookingId: string }
  | { type: 'found'; decision: LiveDispatchDecisionDto }
  | { type: 'choose'; optionId: string }
  | { type: 'apply'; newKey: () => string }
  | { type: 'applied'; decision: LiveDispatchDecisionDto }
  | { type: 'failed'; code: string | null; message: string }
  | { type: 'reset' };

export const initialDecide: DecideState = { step: 'idle' };

/**
 * The flow: find (dry run) → options (best pre-chosen) → apply (Idempotency-Key per booking + option; a retry after a
 * failure of the same choice reuses the key, so a lost answer never applies twice) → applied. NO_FEASIBLE_OPTION /
 * an option gone stale go back to an error with the last options; "find" again starts a fresh dry run.
 */
export function decideFlow(s: DecideState, a: DecideAction): DecideState {
  switch (a.type) {
    case 'find':
      return { step: 'finding', bookingId: a.bookingId };
    case 'found':
      if (s.step !== 'finding') return s;
      return { step: 'options', bookingId: s.bookingId, decision: a.decision, chosen: bestOption(a.decision)?.optionId ?? null };
    case 'choose':
      if (s.step === 'options') return { ...s, chosen: a.optionId };
      if (s.step === 'error' && s.decision) return { step: 'options', bookingId: s.bookingId, decision: s.decision, chosen: a.optionId };
      return s;
    case 'apply': {
      if (s.step === 'options' && s.chosen) return { step: 'applying', bookingId: s.bookingId, decision: s.decision, chosen: s.chosen, key: a.newKey() };
      // Retry of the same choice after a failure: the same key (the server replays an applied request).
      if (s.step === 'error' && s.decision && s.chosen) return { step: 'applying', bookingId: s.bookingId, decision: s.decision, chosen: s.chosen, key: s.key ?? a.newKey() };
      return s;
    }
    case 'applied':
      if (s.step !== 'applying') return s;
      return { step: 'applied', bookingId: s.bookingId, decision: a.decision };
    case 'failed': {
      if (s.step === 'finding') return { step: 'error', bookingId: s.bookingId, decision: null, chosen: null, key: null, code: a.code, message: a.message };
      if (s.step === 'applying') {
        // A refusal (option gone, conflict) frees the key: the next apply is a new attempt.
        const keep = a.code === null || a.code === 'NETWORK' || a.code === 'SERVER';
        return { step: 'error', bookingId: s.bookingId, decision: s.decision, chosen: s.chosen, key: keep ? s.key : null, code: a.code, message: a.message };
      }
      return s;
    }
    case 'reset':
      return initialDecide;
  }
}

/** The chosen option of the current state (for the confirm text), or null. */
export function chosenOption(s: DecideState): DispatchOptionDto | null {
  if (s.step !== 'options' && s.step !== 'applying' && s.step !== 'error') return null;
  if (!s.decision || !s.chosen) return null;
  return s.decision.options.find((o) => o.optionId === s.chosen) ?? null;
}

// ───────────────────────────── Decision log ─────────────────────────────

/** PROPOSED requests (delay / breakdown / ACTIVE trip / PROPOSE policy) that wait for the dispatcher, oldest first. */
export function proposalsOf(rows: readonly DispatchRequestDto[], dismissed: ReadonlySet<string> = new Set()): DispatchRequestDto[] {
  return rows.filter((r) => r.status === 'PROPOSED' && !dismissed.has(r.id)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** A proposal can be approved (a fresh decide + apply) only while its booking still waits for a seat. */
export function proposalActionable(r: Pick<DispatchRequestDto, 'bookingId' | 'bookingStatus'>): boolean {
  return !!r.bookingId && (r.bookingStatus === 'PENDING_ASSIGNMENT' || r.bookingStatus === null);
}

/** The chosen alternative of a request (the one applied / proposed), or null. */
export function chosenAlternative(r: Pick<DispatchRequestDto, 'chosenOptionId' | 'alternatives'>): DispatchRequestDto['alternatives'][number] | null {
  return r.alternatives.find((a) => a.optionId === r.chosenOptionId) ?? null;
}

/** Counts per status for the board's summary chips. */
export function statusCounts(rows: readonly Pick<DispatchRequestDto, 'status'>[]): Record<DispatchRequestStatus, number> {
  const out: Record<DispatchRequestStatus, number> = { QUEUED: 0, DECIDED: 0, PROPOSED: 0, APPLIED: 0, REJECTED: 0, FAILED: 0 };
  for (const r of rows) out[r.status]++;
  return out;
}

/** Minutes, rounded, of an insertion cost (seconds) — "+4 min". */
export function addedText(addedS: number): string {
  return `+${Math.max(0, Math.round(addedS / 60))} min`;
}

/** The live dispatch board (under the dispatch board; same permission). `?booking=` pre-selects a booking. */
export const LIVE_DISPATCH_PATH = '/transport/dispatch/live';
