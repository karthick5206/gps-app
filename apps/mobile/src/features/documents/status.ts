import { DOCUMENT_TYPES, documentTypeLabel, type DocumentDto, type ServiceReminderDto } from '@veetracer/shared';
import { i18n } from '@/lib/i18n';

const STATUS = { destructive: '#dc2626', warning: '#d97706', success: '#16a34a', muted: '#64748b' };

export const documentTypeOptions = (owner?: 'VEHICLE' | 'DRIVER') =>
  DOCUMENT_TYPES.filter((d) => !owner || d.owner === owner).map((d) => ({ value: d.code as string, label: i18n.t(d.label) }));

export const docTypeLabel = (code: string) => i18n.t(documentTypeLabel(code));

const km = (v: number) => `${Math.round(v).toLocaleString()} km`;
export const formatKm = (v: number | null | undefined) => (v === null || v === undefined ? '—' : km(v));

/** Valid / Expiring in N days / Expired chip. */
export function documentChip(d: Pick<DocumentDto, 'status' | 'daysLeft'>): { label: string; color: string } {
  if (d.status === 'EXPIRED') return { label: i18n.t('Expired'), color: STATUS.destructive };
  if (d.status === 'EXPIRING')
    return {
      label: d.daysLeft === 0 ? i18n.t('Expires today') : d.daysLeft === 1 ? i18n.t('Expires tomorrow') : i18n.t('Expiring in {{n}} days', { n: d.daysLeft ?? 0 }),
      color: STATUS.warning,
    };
  if (d.status === 'NO_EXPIRY') return { label: i18n.t('No expiry date'), color: STATUS.muted };
  return { label: i18n.t('Valid'), color: STATUS.success };
}

/** OK / Due soon · … / Overdue chip. */
export function serviceChip(s: Pick<ServiceReminderDto, 'status' | 'daysLeft' | 'kmLeft' | 'isActive'>): { label: string; color: string } {
  if (!s.isActive) return { label: i18n.t('Inactive'), color: STATUS.muted };
  if (s.status === 'OVERDUE') return { label: i18n.t('Overdue'), color: STATUS.destructive };
  if (s.status === 'DUE_SOON') {
    const parts = [
      s.kmLeft !== null ? i18n.t('{{km}} left', { km: km(s.kmLeft) }) : null,
      s.daysLeft !== null ? (s.daysLeft === 0 ? i18n.t('today') : i18n.t('{{n}} d left', { n: s.daysLeft })) : null,
    ].filter(Boolean);
    return { label: parts.length ? i18n.t('Due soon · {{when}}', { when: parts.join(' · ') }) : i18n.t('Due soon'), color: STATUS.warning };
  }
  return { label: i18n.t('OK'), color: STATUS.success };
}
