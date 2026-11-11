import type { TransportAgreementStatus } from '@veetracer/shared';
import { CalendarRangeIcon, ChevronRightIcon, HandshakeIcon, InboxIcon, TicketIcon, UsersRoundIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { FormError } from '@/components/form-error';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { useAuth } from '@/features/auth/auth-context';
import { EmptyHint, KpiCard, Panel } from '@/features/dashboard/refresh/kit';
import { errorMessage } from '@/lib/api';
import { AGREEMENT_STATUS_HINT, AGREEMENT_STATUS_LABEL, counterpartyName } from './agreement-format';
import { STATUS_ICON } from './agreement-ui';
import { agreementPath, useAgreementCounts, useAgreementsAwaitingMe } from './use-agreements';

const TILES: TransportAgreementStatus[] = ['ACTIVE', 'PROPOSED', 'DRAFT', 'SUSPENDED', 'ENDED'];

/** Later phases that fill this dashboard (doc 12, D8). Text only, no numbers until the data exists. */
const NEXT: { icon: typeof UsersRoundIcon; title: string; text: string }[] = [
  { icon: UsersRoundIcon, title: 'Employees and vehicles', text: 'Employee transport profiles, home pickup points, offices and shuttle stops, and seats per vehicle.' },
  { icon: TicketIcon, title: 'Bookings and trips', text: 'Shifts, recurring and one-off bookings, cut-off times and the daily trip list with passengers.' },
  { icon: CalendarRangeIcon, title: 'Dispatch and live status', text: 'Assigning vehicles and drivers, and live trip progress on this dashboard.' },
];

/**
 * Transport dashboard, E1a: agreement counts by status and what needs the caller's approval, from the agreements API
 * only. Trip, booking and passenger figures arrive with E2 / E3; until then the page says so instead of showing zeros.
 */
export function TransportDashboardPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const seesAgreements = can('etms_partners');
  const counts = useAgreementCounts(seesAgreements);
  const awaiting = useAgreementsAwaitingMe(seesAgreements && can('etms_partners', 'edit'));
  const total = counts.data ? Object.values(counts.data).reduce((s, n) => s + n, 0) : undefined;

  return (
    <div className="flex w-full min-w-0 flex-col gap-4 p-4 sm:p-6">
      <PageHeader
        title={t('Transport dashboard')}
        description={t('Employee transport for your company. More figures appear here as each part of the module is switched on.')}
        actions={
          seesAgreements && (
            <Button variant="outline" asChild>
              <Link to="/transport/partners">
                <HandshakeIcon /> {t('Agreements')}
              </Link>
            </Button>
          )
        }
      />

      {seesAgreements && counts.isError && <FormError message={errorMessage(counts.error)} />}

      {seesAgreements && (
        <section aria-labelledby="agr-kpis" className="grid min-w-0 gap-3">
          <h2 id="agr-kpis" className="sr-only">
            {t('Agreements by status')}
          </h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5">
            {TILES.map((s) => (
              <KpiCard key={s} label={t(AGREEMENT_STATUS_LABEL[s])} value={counts.data?.[s]} icon={STATUS_ICON[s]} definition={t(AGREEMENT_STATUS_HINT[s])} to="/transport/partners" />
            ))}
          </div>
        </section>
      )}

      {seesAgreements && total === 0 && (
        <Panel>
          <EmptyState
            icon={HandshakeIcon}
            title={t('No transport agreements yet')}
            description={t('A company that runs its own vehicles needs no agreement. Create one when an outside transport provider serves your employees, or when you serve another company.')}
            action={
              can('etms_partners', 'create') && (
                <Button asChild size="sm">
                  <Link to="/transport/partners">{t('Go to agreements')}</Link>
                </Button>
              )
            }
          />
        </Panel>
      )}

      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        {seesAgreements && can('etms_partners', 'edit') && (
          <Panel title={t('Waiting for your approval')} subtitle={t('Proposed agreements your company has not approved yet')} id="agr-awaiting">
            {awaiting.isPending ? (
              <p className="py-4 text-sm text-muted-foreground">{t('Loading…')}</p>
            ) : awaiting.data?.length ? (
              <ul className="-mx-2 divide-y">
                {awaiting.data.map((a) => (
                  <li key={a.id}>
                    <Link to={agreementPath(a.id)} className="flex min-h-11 items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                      <span className="min-w-0 flex-1 truncate font-medium">{counterpartyName(a)}</span>
                      <span className="text-xs text-muted-foreground">{t('Review')}</span>
                      <ChevronRightIcon className="size-4 text-muted-foreground" aria-hidden />
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyHint icon={InboxIcon} text={t('Nothing to approve right now.')} />
            )}
          </Panel>
        )}

        <Panel title={t("What's next")} subtitle={t('Coming in the next updates of employee transport')} id="etms-next" className={seesAgreements && can('etms_partners', 'edit') ? undefined : 'lg:col-span-2'}>
          <ul className="grid gap-3">
            {NEXT.map((n) => (
              <li key={n.title} className="flex items-start gap-3">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent text-primary" aria-hidden>
                  <n.icon className="size-4" />
                </span>
                <span className="min-w-0 text-sm">
                  <span className="font-medium">{t(n.title)}</span>
                  <span className="block text-xs text-muted-foreground">{t(n.text)}</span>
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </div>
  );
}
