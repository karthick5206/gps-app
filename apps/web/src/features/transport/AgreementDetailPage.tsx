import type { TransportAgreementDto, TransportAgreementSide } from '@veetracer/shared';
import { ArrowLeftIcon, CheckCircle2Icon, CircleDashedIcon, ClockIcon, HandshakeIcon, MapPinIcon, ShieldCheckIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { FormError } from '@/components/form-error';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { formatReportTime } from '@/features/reports/report-time';
import { ApiError, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  AGREEMENT_STATUS_HINT,
  agreementTimeline,
  approvalState,
  counterpartyName,
  DATA_PROFILE_META,
  GRANT_META,
  isWriteGrant,
  orderedGrants,
  SIDE_LABEL,
} from './agreement-format';
import { AgreementActionButtons, AgreementStatusBadge, useAgreementActions, validityText } from './agreement-ui';
import { historyActor, historyDetail, historyLabel } from './agreement-views-format';
import { useAgreement, useAgreementHistory, useAgreementSites } from './use-agreements';

function BackLink() {
  const { t } = useTranslation();
  return (
    <Button variant="outline" asChild>
      <Link to="/transport/partners">
        <ArrowLeftIcon /> {t('All agreements')}
      </Link>
    </Button>
  );
}

function Section({ title, icon: Icon, children, className }: { title: string; icon: typeof HandshakeIcon; children: ReactNode; className?: string }) {
  const id = `sec-${title.replace(/\W+/g, '-').toLowerCase()}`;
  return (
    <Card className={cn('min-w-0 gap-3 p-4 sm:p-5', className)} aria-labelledby={id} role="region">
      <h2 id={id} className="flex items-center gap-2 text-[15px] leading-6 font-semibold">
        <Icon className="size-4 text-muted-foreground" aria-hidden />
        {title}
      </h2>
      {children}
    </Card>
  );
}

function Term({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium break-words">{children}</dd>
    </div>
  );
}

/**
 * Customer sites named on the agreement: both parties see their names (GET /agreements/:id/sites returns id + name of
 * exactly the scoped sites, nothing else); "all sites" lists none.
 */
function SitesSection({ a }: { a: TransportAgreementDto }) {
  const { t } = useTranslation();
  const q = useAgreementSites(a.id, a.siteIds.length > 0);
  return (
    <Section title={t('Sites')} icon={MapPinIcon}>
      {a.siteIds.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('All customer sites.')}</p>
      ) : q.isPending ? (
        <Skeleton className="h-6 w-48" />
      ) : q.isError ? (
        <p className="text-sm text-muted-foreground">{t('{{n}} customer site(s).', { n: a.siteIds.length })}</p>
      ) : (
        <>
          <ul className="flex flex-wrap gap-1.5">
            {q.data.sites.map((s) => (
              <li key={s.id}>
                <Badge variant="secondary">{s.name}</Badge>
              </li>
            ))}
          </ul>
          {q.data.unavailableCount > 0 && <p className="text-xs text-muted-foreground">{t('{{n}} site(s) no longer active.', { n: q.data.unavailableCount })}</p>}
        </>
      )}
    </Section>
  );
}

/** Full history from the audit log (GET /agreements/:id/history); the summary timeline while it loads or if it fails. */
function TimelineSection({ a }: { a: TransportAgreementDto }) {
  const { t } = useTranslation();
  const q = useAgreementHistory(a.id, a.version);
  const items = q.data
    ? q.data.map((e) => {
        const actor = historyActor(e);
        const detail = historyDetail(e);
        const who = [actor.name, actor.sideLabel && t(actor.sideLabel)].filter(Boolean).join(' · ');
        const lines = [who, detail.fields.length ? t('Changed: {{fields}}', { fields: detail.fields.map((f) => t(f)).join(', ') }) : null, detail.reason ? `${t('Reason')}: ${detail.reason}` : null];
        return { key: e.id, label: historyLabel(e), at: e.at, lines: lines.filter((l): l is string => !!l) };
      })
    : agreementTimeline(a).map((e) => ({ key: e.key, label: e.label, at: e.at, lines: e.detail ? [e.detail] : [] }));
  return (
    <Section title={t('Timeline')} icon={ClockIcon}>
      <ol className="relative grid gap-3 border-l pl-4" aria-busy={q.isPending || undefined}>
        {items.map((e) => (
          <li key={e.key} className="relative">
            <span className="absolute top-1.5 -left-[21px] size-2.5 rounded-full border-2 border-card bg-primary" aria-hidden />
            <p className="text-sm font-medium">{t(e.label)}</p>
            <p className="text-xs text-muted-foreground tabular-nums">{formatReportTime(e.at)}</p>
            {e.lines.map((l, i) => (
              <p key={i} className="text-xs break-words">
                {l}
              </p>
            ))}
          </li>
        ))}
      </ol>
      <p className="text-xs text-muted-foreground">
        {q.isError ? t('The full history could not be loaded; showing the main dates.') : t('People of the other company are shown by their side only.')}
      </p>
    </Section>
  );
}

function ApprovalRow({ a, side }: { a: TransportAgreementDto; side: TransportAgreementSide }) {
  const { t } = useTranslation();
  const state = approvalState(a, side);
  const at = side === 'CUSTOMER' ? a.approvedByCustomerAt : a.approvedByProviderAt;
  const name = side === 'CUSTOMER' ? a.customerCompanyName : a.providerCompanyName;
  const Icon = state === 'approved' ? CheckCircle2Icon : state === 'waiting' ? ClockIcon : CircleDashedIcon;
  return (
    <li className="flex items-start gap-3">
      <Icon className={cn('mt-0.5 size-5 shrink-0', state === 'approved' ? 'text-success' : state === 'waiting' ? 'text-warning' : 'text-muted-foreground')} aria-hidden />
      <div className="min-w-0">
        <p className="text-sm font-medium">
          {t(SIDE_LABEL[side])} · <span className="break-words">{name}</span>
          {a.side === side && <span className="ml-1 text-xs font-normal text-muted-foreground">({t('your company')})</span>}
        </p>
        <p className="text-xs text-muted-foreground">
          {state === 'approved' ? t('Approved {{time}}', { time: formatReportTime(at) }) : state === 'waiting' ? t('Waiting for approval') : t('Asked once the draft is proposed')}
        </p>
      </div>
    </li>
  );
}

/** One agreement: terms, approvals, status timeline and the actions the server allows the caller now. */
export function AgreementDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const query = useAgreement(id);
  const a = query.data;
  const { request, dialogs } = useAgreementActions();

  if (query.isError) {
    const notFound = query.error instanceof ApiError && (query.error.status === 404 || query.error.status === 400);
    return (
      <div className="flex w-full min-w-0 flex-col gap-5 p-4 sm:p-6">
        <div>
          <BackLink />
        </div>
        {notFound ? <EmptyState icon={HandshakeIcon} title={t('Agreement not found')} description={t('It may belong to companies you are not part of.')} /> : <FormError message={errorMessage(query.error)} />}
      </div>
    );
  }
  if (!a) {
    return (
      <div className="flex w-full min-w-0 flex-col gap-4 p-4 sm:p-6" aria-busy>
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-72 w-full" />
      </div>
    );
  }

  const grants = orderedGrants(a.grants);

  return (
    <div className="flex w-full min-w-0 flex-col gap-4 p-4 sm:p-6">
      <PageHeader title={counterpartyName(a)} description={`${a.providerCompanyName} → ${a.customerCompanyName}`} actions={<BackLink />} />

      <Card className="gap-3 p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2">
          <AgreementStatusBadge status={a.status} />
          {a.status === 'ACTIVE' && (a.inForce ? <Badge variant="success">{t('In force now')}</Badge> : <Badge variant="muted">{t('Outside its validity period')}</Badge>)}
          {a.side && <Badge variant="outline">{t('You are the {{side}}', { side: t(SIDE_LABEL[a.side]).toLowerCase() })}</Badge>}
          <span className="text-xs text-muted-foreground tabular-nums">{t('Version {{n}}', { n: a.version })}</span>
        </div>
        <p className="text-sm text-muted-foreground">{t(AGREEMENT_STATUS_HINT[a.status])}</p>
        {a.statusReason && (a.status === 'SUSPENDED' || a.status === 'ENDED') && (
          <p className="text-sm">
            <span className="text-muted-foreground">{t('Reason')}: </span>
            {a.statusReason}
          </p>
        )}
        <AgreementActionButtons agreement={a} onAction={request} className="pt-1 [&>button]:max-sm:flex-1" />
      </Card>

      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-4">
          <Section title={t('Terms')} icon={HandshakeIcon}>
            <dl className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
              <Term label={t('Validity')}>{validityText(a)}</Term>
              <Term label={t('Passenger data shared')}>
                {t(DATA_PROFILE_META[a.dataProfile].label)}
                <span className="block text-xs font-normal text-muted-foreground">{t(DATA_PROFILE_META[a.dataProfile].description)}</span>
              </Term>
            </dl>
          </Section>

          <Section title={t('Grants')} icon={ShieldCheckIcon}>
            {grants.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('No grants yet. Choose at least one before proposing.')}</p>
            ) : (
              <ul className="grid gap-2 sm:grid-cols-2">
                {grants.map((g) => (
                  <li key={g} className="flex items-start gap-2 rounded-lg border p-2.5">
                    <CheckCircle2Icon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                    <span className="min-w-0 text-sm">
                      <span className="font-medium">{t(GRANT_META[g].label)}</span>
                      {isWriteGrant(g) && (
                        <Badge variant="info" className="ml-1.5 align-middle">
                          {t('Changes')}
                        </Badge>
                      )}
                      <span className="block text-xs text-muted-foreground">{t(GRANT_META[g].description)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <SitesSection a={a} />
        </div>

        <div className="flex min-w-0 flex-col gap-4">
          <Section title={t('Approvals')} icon={CheckCircle2Icon}>
            <ul className="grid gap-3">
              <ApprovalRow a={a} side="PROVIDER" />
              <ApprovalRow a={a} side="CUSTOMER" />
            </ul>
          </Section>

          <TimelineSection a={a} />
        </div>
      </div>

      {dialogs}
    </div>
  );
}
