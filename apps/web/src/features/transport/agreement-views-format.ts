/**
 * Pure helpers for the E1a gap screens (no React / DOM / aliases, so `node --test` runs them): partner lookup input,
 * agreement history labels and actors, and the dashboard summary. Docs: docs/employee-transport/05 §2.1, 07, 10 §2.
 */
import {
  TRANSPORT_COMPANY_LOOKUP_MIN_CHARS,
  type TransportAgreementHistoryEntryDto,
  type TransportAgreementStatus,
  type TransportAgreementSummaryDto,
  type TransportAgreementTermField,
  type TransportCompanyLookupDto,
} from '@veetracer/shared';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The lookup text to send, or null while it is shorter than the server minimum (3 characters, trimmed). */
export function lookupQuery(raw: string): string | null {
  const q = raw.trim().replace(/\s+/g, ' ');
  return q.length >= TRANSPORT_COMPANY_LOOKUP_MIN_CHARS ? q : null;
}

/** Pasted company ID (fallback when the partner is not found by name), trimmed; null when it is not a UUID. */
export function pastedCompanyId(raw: string): string | null {
  const s = raw.trim();
  return UUID.test(s) ? s.toLowerCase() : null;
}

/** Picker label for a directory entry: name, with the city as the secondary line. */
export function lookupOption(c: TransportCompanyLookupDto): { value: string; label: string; description?: string } {
  return { value: c.id, label: c.name, ...(c.city ? { description: c.city } : {}) };
}

export const TERM_FIELD_LABEL: Record<TransportAgreementTermField, string> = {
  validFrom: 'first day',
  validTo: 'last day',
  grants: 'grants',
  siteIds: 'sites',
  dataProfile: 'passenger data shared',
};

/** Timeline title of one history entry (an approval that completed both sides says so). */
export function historyLabel(e: Pick<TransportAgreementHistoryEntryDto, 'kind' | 'toStatus'>): string {
  switch (e.kind) {
    case 'CREATED':
      return 'Draft created';
    case 'EDITED':
      return 'Draft changed';
    case 'PROPOSED':
      return 'Proposed for approval';
    case 'APPROVED':
      return e.toStatus === 'ACTIVE' ? 'Approved: agreement active' : 'Approved';
    case 'SUSPENDED':
      return 'Suspended';
    case 'RESUMED':
      return 'Resumed';
    case 'ENDED':
      return 'Ended';
  }
}

export const ACTOR_SIDE_LABEL: Record<'PROVIDER' | 'CUSTOMER' | 'PLATFORM', string> = { PROVIDER: 'Provider', CUSTOMER: 'Customer', PLATFORM: 'VeeTrax support' };

/**
 * Who acted: the person's name when the server shared it (own company), otherwise the side as a translatable label.
 * `side` is added after a name so both are visible ("Priya · Provider").
 */
export function historyActor(e: Pick<TransportAgreementHistoryEntryDto, 'actorName' | 'actorSide'>): { name: string | null; sideLabel: string | null } {
  return { name: e.actorName, sideLabel: e.actorSide ? ACTOR_SIDE_LABEL[e.actorSide] : e.actorName ? null : 'System' };
}

/** Second line: the changed terms for edits, the reason for suspend / end. */
export function historyDetail(e: Pick<TransportAgreementHistoryEntryDto, 'kind' | 'changedFields' | 'reason'>): { fields: string[]; reason: string | null } {
  return { fields: e.kind === 'EDITED' ? e.changedFields.map((f) => TERM_FIELD_LABEL[f]) : [], reason: e.reason };
}

/** Tiles of the dashboard from one summary response (undefined while loading). */
export function summaryCount(s: TransportAgreementSummaryDto | undefined, status: TransportAgreementStatus): number | undefined {
  return s ? (s.byStatus[status] ?? 0) : undefined;
}
