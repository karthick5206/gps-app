import type { TransportAccessLogEntryDto } from '@veetracer/shared';
import { ArrowLeftIcon, ShieldAlertIcon } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DateCell } from '@/features/masters/cells';
import { MasterPage } from '@/features/masters/MasterPage';
import type { MasterColumn, MasterFilter } from '@/features/masters/types';
import { i18n } from '@/lib/i18n';
import { ACCESS_ACTOR_LABEL, accessActorText, accessWhatLabel } from './fleet-format';

export const ACCESS_LOG_PATH = '/transport/partners/access-log';
const ACTOR_VARIANT = { OWN: 'muted', PROVIDER: 'info', SUPPORT: 'warning' } as const;

const FILTERS: MasterFilter[] = [
  {
    key: 'actor',
    label: 'Who',
    options: [
      { value: 'external', label: 'Providers and VeeTrax support' },
      { value: 'all', label: 'Everyone, including our staff' },
    ],
  },
  { kind: 'date', key: 'from', label: 'From', bound: 'start' },
  { kind: 'date', key: 'to', label: 'To', bound: 'end' },
];

/**
 * Sensitive-access log (ETMS 10 §2.2 item 8, §2.3 last row): every read of this company's passenger data by a transport
 * provider or by VeeTrax support (and, on request, by its own staff), with the reason given. Read-only.
 */
export function AccessLogPage() {
  const { t } = useTranslation();
  const columns = useMemo<MasterColumn<TransportAccessLogEntryDto>[]>(
    () => [
      { id: 'at', header: 'When', hideable: false, cell: (r) => <DateCell value={r.at} /> },
      {
        id: 'actor',
        header: 'Who',
        hideable: false,
        cell: (r) => (
          <span className="inline-flex min-w-0 flex-wrap items-center gap-1.5">
            <Badge variant={ACTOR_VARIANT[r.actorKind]}>{i18n.t(ACCESS_ACTOR_LABEL[r.actorKind])}</Badge>
            <span className="break-words">{r.actorKind === 'SUPPORT' && !r.actorName ? i18n.t('VeeTrax support') : accessActorText(r)}</span>
          </span>
        ),
      },
      {
        id: 'what',
        header: 'What',
        cell: (r) => (
          <span>
            {i18n.t(accessWhatLabel(r.what))}
            {r.homeLocation && (
              <Badge variant="warning" className="ml-1.5 align-middle">
                {i18n.t('Home location')}
              </Badge>
            )}
          </span>
        ),
      },
      { id: 'subject', header: 'Passenger', cell: (r) => r.subjectName ?? <span className="text-muted-foreground">—</span> },
      { id: 'rows', header: 'Rows', cell: (r) => (r.rows === null ? <span className="text-muted-foreground">—</span> : <span className="tabular-nums">{r.rows}</span>) },
      { id: 'reason', header: 'Reason', cell: (r) => (r.reason ? <span className="break-words">{r.reason}</span> : <span className="text-muted-foreground">—</span>) },
    ],
    [],
  );

  return (
    <MasterPage<TransportAccessLogEntryDto>
      menu="etms_partners"
      title="Sensitive-access log"
      description="Who opened your passengers' personal data: transport providers under an agreement and VeeTrax support, with the reason they gave."
      endpoint="/transport/access-log"
      columns={columns}
      rowLabel={(r) => `${accessActorText(r)} ${r.at}`}
      filters={FILTERS}
      statusFilter={false}
      bulkActions={false}
      readOnly
      history={false}
      emptyIcon={ShieldAlertIcon}
      headerActions={
        <Button variant="outline" asChild>
          <Link to="/transport/partners">
            <ArrowLeftIcon /> {t('All agreements')}
          </Link>
        </Button>
      }
    />
  );
}
