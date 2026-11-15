/**
 * Transport compliance (Daily transport): a vehicle or driver may carry employees only while its required documents
 * (VeeTrax Documents: RC, insurance, fitness, permit, PUC; driving licence, police verification) are valid on the trip
 * date. Company setting `etms.compliance`: OFF (not checked), WARN (default: flagged on the board, Allocate vehicles
 * prefers compliant vehicles) or BLOCK (Allocate skips them and the server refuses them when a trip is created or the
 * vehicle / driver is changed).
 */
import { documentTypeLabel } from './documents';

export const TRANSPORT_COMPLIANCE_MODES = ['OFF', 'WARN', 'BLOCK'] as const;
export type TransportComplianceMode = (typeof TRANSPORT_COMPLIANCE_MODES)[number];
export const DEFAULT_COMPLIANCE_MODE: TransportComplianceMode = 'WARN';

/** Documents a vehicle carrying employees must have (Indian commercial passenger vehicle). */
export const TRANSPORT_VEHICLE_DOCS = ['RC', 'INSURANCE', 'FITNESS', 'PERMIT', 'PUC'] as const;
/** Documents its driver must have. POLICE_VERIFICATION is a company document type (Masters → Lookups). */
export const TRANSPORT_DRIVER_DOCS = ['DRIVING_LICENCE', 'POLICE_VERIFICATION'] as const;

export interface ComplianceIssue {
  type: string;
  label: string;
  state: 'EXPIRED' | 'MISSING';
  /** YYYY-MM-DD of the latest document of that type (EXPIRED). */
  expiresOn: string | null;
}

/**
 * Issues of one vehicle / driver on `onDate` (YYYY-MM-DD): per required type the latest document counts; no document =
 * MISSING, an expiry before the date = EXPIRED. A document without an expiry date counts as valid.
 */
export function complianceIssues(docs: readonly { type: string; expiresOn: string | null }[], required: readonly string[], onDate: string): ComplianceIssue[] {
  const out: ComplianceIssue[] = [];
  for (const type of required) {
    const mine = docs.filter((d) => d.type === type);
    if (!mine.length) {
      out.push({ type, label: documentTypeLabel(type), state: 'MISSING', expiresOn: null });
      continue;
    }
    if (mine.some((d) => !d.expiresOn)) continue;
    const latest = mine.map((d) => d.expiresOn!).sort().at(-1)!;
    if (latest < onDate) out.push({ type, label: documentTypeLabel(type), state: 'EXPIRED', expiresOn: latest });
  }
  return out;
}

/** "Insurance expired 2026-10-01, Permit missing" */
export function complianceText(issues: readonly ComplianceIssue[]): string {
  return issues.map((i) => (i.state === 'EXPIRED' ? `${i.label} expired ${i.expiresOn}` : `${i.label} missing`)).join(', ');
}

export function complianceModeOf(v: unknown): TransportComplianceMode {
  return typeof v === 'string' && (TRANSPORT_COMPLIANCE_MODES as readonly string[]).includes(v) ? (v as TransportComplianceMode) : DEFAULT_COMPLIANCE_MODE;
}
