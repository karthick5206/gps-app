/**
 * Pure helpers of the ETMS agreement screens (no React / DOM / aliases, so `node --test` runs them): status and grant
 * labels, the server's `allowedActions` → buttons, draft validation that mirrors `agreements.service.ts` /
 * `agreements.dto.ts`, validity days ↔ ISO in the company zone, and the status timeline.
 * Docs: docs/employee-transport/05 §2.1, 07 §3, 10 §2.2.
 */
import {
  TRANSPORT_GRANTS,
  TRANSPORT_WRITE_GRANTS,
  type TransportAgreementAction,
  type TransportAgreementDto,
  type TransportAgreementSide,
  type TransportAgreementStatus,
  type TransportDataProfile,
  type TransportGrant,
} from '@veetracer/shared';
import { dayKeyInZone } from '../reports/report-time.ts';
import { fromZonedWall } from '../planned-trips/trip-format.ts';

export type Tone = 'success' | 'warning' | 'destructive' | 'info' | 'neutral' | 'muted';

export const AGREEMENT_STATUS_LABEL: Record<TransportAgreementStatus, string> = {
  DRAFT: 'Draft',
  PROPOSED: 'Awaiting approval',
  ACTIVE: 'Active',
  SUSPENDED: 'Suspended',
  ENDED: 'Ended',
};

export const AGREEMENT_STATUS_TONE: Record<TransportAgreementStatus, Tone> = {
  DRAFT: 'neutral',
  PROPOSED: 'info',
  ACTIVE: 'success',
  SUSPENDED: 'warning',
  ENDED: 'muted',
};

export const AGREEMENT_STATUS_HINT: Record<TransportAgreementStatus, string> = {
  DRAFT: 'Terms can still be changed. Propose it when both companies agree on them.',
  PROPOSED: 'Terms are frozen. The agreement starts once both companies have approved it.',
  ACTIVE: 'Both companies approved it. Grants apply inside the validity period.',
  SUSPENDED: 'Grants are paused until the customer resumes the agreement.',
  ENDED: 'Closed for good. Create a new agreement to work together again.',
};

export const SIDE_LABEL: Record<TransportAgreementSide, string> = { PROVIDER: 'Provider', CUSTOMER: 'Customer' };

export const GRANT_META: Record<TransportGrant, { label: string; description: string }> = {
  VIEW_BOOKINGS: { label: 'View bookings', description: 'See the customer’s transport bookings.' },
  MANAGE_DISPATCH: { label: 'Manage dispatch', description: 'Assign vehicles and drivers and run trips.' },
  VIEW_PASSENGER_MINIMAL: { label: 'View passengers (minimal)', description: 'Name and pickup point only.' },
  VIEW_PASSENGER_CONTACT: { label: 'View passenger contact', description: 'Phone number for pickups.' },
  MANAGE_SCHEDULES: { label: 'Manage schedules', description: 'Change shifts and recurring schedules.' },
  RECEIVE_INCIDENTS: { label: 'Receive incidents', description: 'Get SOS and incident alerts.' },
  MANAGE_INCIDENTS: { label: 'Manage incidents', description: 'Acknowledge, escalate and close incidents.' },
  VIEW_REPORTS: { label: 'View reports', description: 'Transport reports for this customer.' },
  OVERRIDE_SAFETY_WARN: { label: 'Override safety warnings', description: 'Proceed past a safety-policy warning (logged).' },
};

export const isWriteGrant = (g: TransportGrant): boolean => TRANSPORT_WRITE_GRANTS.includes(g);

/** Grants in catalogue order, view grants first, then those that allow changes. */
export function orderedGrants(grants: readonly TransportGrant[] = TRANSPORT_GRANTS): TransportGrant[] {
  const set = new Set(grants);
  const all = TRANSPORT_GRANTS.filter((g) => set.has(g));
  return [...all.filter((g) => !isWriteGrant(g)), ...all.filter(isWriteGrant)];
}

export const DATA_PROFILE_META: Record<TransportDataProfile, { label: string; description: string }> = {
  MINIMAL: { label: 'Minimal', description: 'The smallest passenger view the provider needs to run trips.' },
  STANDARD: { label: 'Standard', description: 'A wider passenger view, for example contact details for pickups.' },
};

// ───────────────────────────── Actions → buttons ─────────────────────────────

export interface ActionMeta {
  label: string;
  /** Confirm dialog title / body / confirm button. */
  title: string;
  body: string;
  confirm: string;
  variant: 'default' | 'outline' | 'destructive';
  /** Suspend and end need a reason (server: 1–500 characters). */
  needsReason: boolean;
}

export const ACTION_META: Record<TransportAgreementAction, ActionMeta> = {
  edit: { label: 'Edit draft', title: 'Edit draft', body: '', confirm: 'Save', variant: 'outline', needsReason: false },
  propose: {
    label: 'Propose',
    title: 'Propose this agreement?',
    body: 'The terms are frozen and both companies are asked to approve them. To change anything afterwards, end it and create a new draft.',
    confirm: 'Propose',
    variant: 'default',
    needsReason: false,
  },
  approve: {
    label: 'Approve',
    title: 'Approve for your company?',
    body: 'You approve the terms shown for your side. The agreement starts once the other company approves too.',
    confirm: 'Approve',
    variant: 'default',
    needsReason: false,
  },
  suspend: {
    label: 'Suspend',
    title: 'Suspend this agreement?',
    body: 'The provider loses every grant until the agreement is resumed. The reason is shown to both companies.',
    confirm: 'Suspend',
    variant: 'outline',
    needsReason: true,
  },
  resume: {
    label: 'Resume',
    title: 'Resume this agreement?',
    body: 'The grants apply again from now (inside the validity period).',
    confirm: 'Resume',
    variant: 'default',
    needsReason: false,
  },
  end: {
    label: 'End agreement',
    title: 'End this agreement?',
    body: 'This is final: the grants stop and the agreement can’t be reopened. The reason is shown to both companies.',
    confirm: 'End agreement',
    variant: 'destructive',
    needsReason: true,
  },
};

/** Display order: the main step forward first, the destructive one last. */
const ACTION_ORDER: TransportAgreementAction[] = ['approve', 'propose', 'resume', 'edit', 'suspend', 'end'];

/**
 * Buttons for an agreement: exactly the server's `allowedActions` (never computed locally), in display order, and only
 * when the user's role may edit agreements (every command needs `etms_partners:edit`).
 */
export function agreementButtons(allowed: readonly TransportAgreementAction[], canEdit: boolean): TransportAgreementAction[] {
  if (!canEdit) return [];
  const set = new Set(allowed);
  return ACTION_ORDER.filter((a) => set.has(a));
}

/** What still stops a proposal (the server refuses the same with VALIDATION_FAILED). */
export function proposeBlockers(a: Pick<TransportAgreementDto, 'grants' | 'validTo'>, now: Date = new Date()): string[] {
  const out: string[] = [];
  if (!a.grants.length) out.push('Choose at least one grant before proposing the agreement');
  if (a.validTo && Date.parse(a.validTo) <= now.getTime()) out.push('The agreement would already be over: change "valid to" first');
  return out;
}

export const REASON_MAX = 500;

/** Reason for suspend / end: required, at most 500 characters after trimming. */
export function reasonError(reason: string): string | null {
  const r = reason.trim();
  if (!r) return 'Give a reason';
  if (r.length > REASON_MAX) return 'At most 500 characters';
  return null;
}

// ───────────────────────────── Validity days ─────────────────────────────

/** Start of a calendar day (YYYY-MM-DD) in `tz` as ISO; null when malformed. */
export function dayStartIso(day: string, tz: string | undefined): string | null {
  const ms = fromZonedWall(`${day}T00:00`, tz);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** Next calendar day of YYYY-MM-DD. */
export function nextDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return dt.toISOString().slice(0, 10);
}

/**
 * The UI asks for the **last day** the agreement applies (inclusive); the server stores `validTo` as an exclusive
 * instant. Last day D ↔ validTo = start of D + 1 in the company zone.
 */
export function lastDayToValidTo(day: string, tz: string | undefined): string | null {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? dayStartIso(nextDay(day), tz) : null;
}

/** validTo (exclusive) → the last day it covers, in `tz`. */
export function validToLastDay(iso: string, tz: string | undefined): string {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? '' : dayKeyInZone(ms - 1, tz);
}

// ───────────────────────────── Draft validation ─────────────────────────────

export interface AgreementDraft {
  providerCompanyId: string;
  customerCompanyId: string;
  /** YYYY-MM-DD in the company zone. */
  validFrom: string;
  /** Last day (inclusive), '' = open-ended. */
  lastDay: string;
  grants: TransportGrant[];
  siteIds: string[];
  dataProfile: TransportDataProfile;
}

export type DraftErrors = Partial<Record<'providerCompanyId' | 'customerCompanyId' | 'validFrom' | 'lastDay' | 'grants' | 'siteIds', string>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_SITES = 500;

/**
 * Client checks that mirror the server (`CreateAgreementDto` / `UpdateAgreementDto`, `AgreementsService.create /
 * validity / checkSites`). The server stays the authority; this only saves a round trip. `create` checks the parties.
 */
export function validateAgreementDraft(d: AgreementDraft, ctx: { create: boolean; companyId: string; isSuperAdmin: boolean }): DraftErrors {
  const e: DraftErrors = {};
  if (ctx.create) {
    if (!d.providerCompanyId) e.providerCompanyId = 'Required';
    else if (!UUID.test(d.providerCompanyId)) e.providerCompanyId = 'Enter a valid company ID';
    if (!d.customerCompanyId) e.customerCompanyId = 'Required';
    else if (!UUID.test(d.customerCompanyId)) e.customerCompanyId = 'Enter a valid company ID';
    if (!e.providerCompanyId && !e.customerCompanyId) {
      if (d.providerCompanyId.toLowerCase() === d.customerCompanyId.toLowerCase()) {
        e.customerCompanyId = 'Provider and customer must be different companies';
      } else if (!ctx.isSuperAdmin && ctx.companyId !== d.providerCompanyId && ctx.companyId !== d.customerCompanyId) {
        e.customerCompanyId = 'Your company must be the provider or the customer';
      }
    }
  }
  if (!d.validFrom) e.validFrom = 'Required';
  else if (!DAY.test(d.validFrom)) e.validFrom = 'Invalid date';
  if (d.lastDay) {
    if (!DAY.test(d.lastDay)) e.lastDay = 'Invalid date';
    // Last day is inclusive, so the same day as "valid from" is a one-day agreement (validTo > validFrom).
    else if (!e.validFrom && d.lastDay < d.validFrom) e.lastDay = 'The last day must be on or after the first day';
  }
  if (new Set(d.grants).size !== d.grants.length || d.grants.some((g) => !TRANSPORT_GRANTS.includes(g))) e.grants = 'Invalid grants';
  if (d.siteIds.length > MAX_SITES) e.siteIds = 'At most 500 sites';
  else if (d.siteIds.some((s) => !UUID.test(s))) e.siteIds = 'Invalid site';
  return e;
}

/** A blank draft: today, open-ended, no grants, MINIMAL (the server default). */
export function emptyDraft(today: string): AgreementDraft {
  return { providerCompanyId: '', customerCompanyId: '', validFrom: today, lastDay: '', grants: [], siteIds: [], dataProfile: 'MINIMAL' };
}

/** The editable terms of an existing agreement as a draft (days in `tz`). */
export function draftFromAgreement(a: TransportAgreementDto, tz: string | undefined): AgreementDraft {
  return {
    providerCompanyId: a.providerCompanyId,
    customerCompanyId: a.customerCompanyId,
    validFrom: dayKeyInZone(a.validFrom, tz),
    lastDay: a.validTo ? validToLastDay(a.validTo, tz) : '',
    grants: orderedGrants(a.grants),
    siteIds: [...a.siteIds],
    dataProfile: a.dataProfile,
  };
}

// ───────────────────────────── Display helpers ─────────────────────────────

/** The other party's name from the caller's side (Super Admin: "Provider → Customer"). */
export function counterpartyName(a: Pick<TransportAgreementDto, 'side' | 'providerCompanyName' | 'customerCompanyName'>): string {
  if (a.side === 'CUSTOMER') return a.providerCompanyName;
  if (a.side === 'PROVIDER') return a.customerCompanyName;
  return `${a.providerCompanyName} → ${a.customerCompanyName}`;
}

export type ApprovalState = 'approved' | 'waiting' | 'notYet';

/** Per side: approved (with time), waiting (PROPOSED, not yet approved) or not asked yet (DRAFT). */
export function approvalState(a: Pick<TransportAgreementDto, 'status' | 'approvedByCustomerAt' | 'approvedByProviderAt'>, side: TransportAgreementSide): ApprovalState {
  const at = side === 'CUSTOMER' ? a.approvedByCustomerAt : a.approvedByProviderAt;
  if (at) return 'approved';
  return a.status === 'PROPOSED' ? 'waiting' : 'notYet';
}

export interface TimelineEvent {
  key: string;
  label: string;
  at: string;
  detail?: string | null;
}

/**
 * Status timeline from the fields the agreement carries (created, approvals, suspended, ended), oldest first. The API
 * has no per-agreement event history in E1a, so earlier suspend / resume cycles are not shown (only the latest).
 */
export function agreementTimeline(a: TransportAgreementDto): TimelineEvent[] {
  const ev: TimelineEvent[] = [{ key: 'created', label: 'Draft created', at: a.createdAt }];
  if (a.approvedByProviderAt) ev.push({ key: 'approvedProvider', label: 'Approved by the provider', at: a.approvedByProviderAt, detail: a.providerCompanyName });
  if (a.approvedByCustomerAt) ev.push({ key: 'approvedCustomer', label: 'Approved by the customer', at: a.approvedByCustomerAt, detail: a.customerCompanyName });
  if (a.suspendedAt) ev.push({ key: 'suspended', label: 'Suspended', at: a.suspendedAt, detail: a.status === 'SUSPENDED' ? a.statusReason : null });
  if (a.endedAt) ev.push({ key: 'ended', label: 'Ended', at: a.endedAt, detail: a.status === 'ENDED' ? a.statusReason : null });
  return ev.sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
}

/** Error codes the screens explain specially. */
export function agreementErrorKind(code: string | null | undefined): 'conflict' | 'duplicate' | 'state' | 'forbidden' | 'disabled' | 'other' {
  switch (code) {
    case 'VERSION_CONFLICT':
      return 'conflict';
    case 'AGREEMENT_DUPLICATE':
      return 'duplicate';
    case 'INVALID_STATE':
      return 'state';
    case 'FORBIDDEN_GRANT':
      return 'forbidden';
    case 'ETMS_DISABLED':
      return 'disabled';
    default:
      return 'other';
  }
}

export const CONFLICT_MESSAGE = 'This agreement was changed by someone else. Reload it to see the latest version, then try again.';
