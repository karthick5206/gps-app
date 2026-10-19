import { useQuery } from '@tanstack/react-query';
import { DOCUMENT_TYPES, documentTypeLabel, type DocumentStatus, type LookupDto, type Paginated, type ServiceStatus } from '@veetracer/shared';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import type { Option } from '@/components/ui/multi-select';
import { useAuth } from '@/features/auth/auth-context';
import { api } from '@/lib/api';

export const DOCUMENTS_ENDPOINT = '/documents';
export const SERVICES_ENDPOINT = '/service-reminders';

export const DOCUMENT_STATUS_OPTIONS: Option[] = [
  { value: 'VALID', label: 'Valid' },
  { value: 'EXPIRING', label: 'Expiring soon' },
  { value: 'EXPIRED', label: 'Expired' },
  { value: 'NO_EXPIRY', label: 'No expiry date' },
];

export const SERVICE_STATUS_OPTIONS: { value: ServiceStatus; label: string }[] = [
  { value: 'OVERDUE', label: 'Overdue' },
  { value: 'DUE_SOON', label: 'Due soon' },
  { value: 'OK', label: 'OK' },
];

/** Valid / Expiring in N days / Expired chip. */
export function DocumentStatusBadge({ status, daysLeft }: { status: DocumentStatus; daysLeft: number | null }) {
  const { t } = useTranslation();
  if (status === 'EXPIRED') return <Badge variant="destructive">{t('Expired')}</Badge>;
  if (status === 'EXPIRING')
    return <Badge variant="warning">{daysLeft === 0 ? t('Expires today') : daysLeft === 1 ? t('Expires tomorrow') : t('Expiring in {{n}} days', { n: daysLeft ?? 0 })}</Badge>;
  if (status === 'NO_EXPIRY') return <Badge variant="muted">{t('No expiry date')}</Badge>;
  return <Badge variant="success">{t('Valid')}</Badge>;
}

const km = (v: number) => `${Math.round(v).toLocaleString()} km`;

/** OK / Due in … / Overdue chip (date and / or km). */
export function ServiceStatusBadge({ status, daysLeft, kmLeft }: { status: ServiceStatus; daysLeft: number | null; kmLeft: number | null }) {
  const { t } = useTranslation();
  if (status === 'OVERDUE') return <Badge variant="destructive">{t('Overdue')}</Badge>;
  const parts = [kmLeft !== null ? t('{{km}} left', { km: km(kmLeft) }) : null, daysLeft !== null ? (daysLeft === 0 ? t('today') : t('{{n}} d left', { n: daysLeft })) : null].filter(Boolean);
  if (status === 'DUE_SOON') return <Badge variant="warning">{parts.length ? t('Due soon · {{when}}', { when: parts.join(' · ') }) : t('Due soon')}</Badge>;
  return <Badge variant="success">{t('OK')}</Badge>;
}

export function formatKm(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : km(v);
}

/** DOCUMENT_TYPE lookup options (company values included); seeded codes when the user can't read lookups. */
export function useDocumentTypeOptions(owner?: 'VEHICLE' | 'DRIVER') {
  const { t } = useTranslation();
  const { can } = useAuth();
  const q = useQuery({
    queryKey: ['options', '/lookups', 'DOCUMENT_TYPE'],
    queryFn: ({ signal }) => api.get<Paginated<LookupDto>>('/lookups', { type: 'DOCUMENT_TYPE', pageSize: 100, status: 'ACTIVE', sort: 'sortOrder', order: 'asc' }, signal),
    enabled: can('lookups'),
    staleTime: 5 * 60_000,
  });
  return useMemo(() => {
    const known = new Map<string, string>(DOCUMENT_TYPES.map((d) => [d.code, d.label]));
    const items = q.data?.items?.length ? q.data.items.map((l) => ({ code: l.code, label: known.get(l.code) ?? l.label })) : DOCUMENT_TYPES.map((d) => ({ code: d.code, label: d.label }));
    const ownerOf = (code: string) => DOCUMENT_TYPES.find((d) => d.code === code)?.owner;
    const options: Option[] = items.filter((i) => !owner || !ownerOf(i.code) || ownerOf(i.code) === owner).map((i) => ({ value: i.code, label: t(i.label) }));
    const labelOf = (code: string) => {
      const l = items.find((i) => i.code === code)?.label ?? documentTypeLabel(code);
      return t(l);
    };
    return { options, labelOf };
  }, [q.data, owner, t]);
}
