import type { ConsentPurpose, PassengerConsentStateDto } from '@veetracer/shared';
import { CheckCircle2Icon, CircleAlertIcon, HistoryIcon, ShieldCheckIcon, XCircleIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { currentLocale } from '@/lib/i18n';
import { ToneBadge } from './passenger-ui';
import { CONSENT_PURPOSE_META, consentChannelLabel, consentPurposeLabel, consentRows, consentStatus, consentTimeline, suggestedNoticeVersion } from './people-format';
import { usePassengerConsents, useRecordConsent } from './use-people';

type Pending = { purpose: ConsentPurpose; granted: boolean; state: PassengerConsentStateDto | null };

/**
 * Consent per purpose (doc 10 §4.2): current state, grant / withdraw on the passenger's behalf (corporate admin only,
 * recorded as channel ADMIN_ON_BEHALF after a confirmation) and the full evidence history. History is append-only.
 */
export function ConsentPanel({ passengerId, canRecord }: { passengerId: string; canRecord: boolean }) {
  const { t } = useTranslation();
  const uid = useId();
  const consents = usePassengerConsents(passengerId, true);
  const record = useRecordConsent(passengerId);
  const [pending, setPending] = useState<Pending | null>(null);
  const [version, setVersion] = useState('');

  if (consents.isPending) return <Skeleton className="h-64" />;
  if (consents.isError) return <FormError message={errorMessage(consents.error)} />;

  const rows = consentRows(consents.data.current);
  const history = consentTimeline(consents.data.history);

  const open = (p: Pending) => {
    record.reset();
    setVersion(suggestedNoticeVersion(p.state, history));
    setPending(p);
  };
  const confirm = () => {
    if (!pending || !version.trim()) return;
    record.mutate(
      { purpose: pending.purpose, granted: pending.granted, noticeVersion: version.trim(), locale: currentLocale() },
      {
        onSuccess: () => {
          toast.success(pending.granted ? t('Consent recorded') : t('Consent withdrawn'));
          setPending(null);
        },
      },
    );
  };

  return (
    <div className="space-y-6">
      <section aria-labelledby={`${uid}-current`} className="space-y-3">
        <div className="flex items-center gap-2">
          <ShieldCheckIcon className="size-4 text-muted-foreground" aria-hidden />
          <h3 id={`${uid}-current`} className="text-sm font-semibold">
            {t('Current consent')}
          </h3>
        </div>
        <p className="text-xs text-muted-foreground">
          {t('Employees normally give or withdraw consent themselves in the app. Record it here only when the employee has agreed in another way, for example on a signed form.')}
        </p>
        <ul className="divide-y rounded-lg border">
          {rows.map(({ purpose, state }) => {
            const s = consentStatus(state);
            const meta = CONSENT_PURPOSE_META[purpose];
            return (
              <li key={purpose} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-start">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{t(meta.label)}</span>
                    <ToneBadge tone={s.tone} icon={state?.active ? CheckCircle2Icon : state?.revokedAt ? XCircleIcon : CircleAlertIcon}>
                      {t(s.label)}
                    </ToneBadge>
                  </div>
                  <p className="text-xs text-muted-foreground">{t(meta.description)}</p>
                  {state && (
                    <p className="text-xs text-muted-foreground tabular-nums">
                      {state.active
                        ? t('Given {{date}} · notice {{version}} · {{channel}}', { date: formatDateTime(state.grantedAt), version: state.noticeVersion ?? '—', channel: t(consentChannelLabel(state.channel)) })
                        : t('Withdrawn {{date}} · {{channel}}', { date: formatDateTime(state.revokedAt), channel: t(consentChannelLabel(state.channel)) })}
                    </p>
                  )}
                </div>
                {canRecord && (
                  <div className="flex shrink-0 gap-2">
                    {state?.active ? (
                      <Button variant="outline" size="sm" onClick={() => open({ purpose, granted: false, state })}>
                        {t('Withdraw')}
                      </Button>
                    ) : (
                      <Button size="sm" onClick={() => open({ purpose, granted: true, state })}>
                        {t('Record consent')}
                      </Button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby={`${uid}-history`} className="space-y-3">
        <div className="flex items-center gap-2">
          <HistoryIcon className="size-4 text-muted-foreground" aria-hidden />
          <h3 id={`${uid}-history`} className="text-sm font-semibold">
            {t('History')}
          </h3>
        </div>
        {history.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('No consent has been recorded for this passenger yet.')}</p>
        ) : (
          <ol className="relative space-y-3 border-l pl-4">
            {history.map((h) => (
              <li key={h.id} className="relative">
                <span className={`absolute top-1.5 -left-[21px] size-2.5 rounded-full border-2 border-background ${h.granted ? 'bg-success' : 'bg-destructive'}`} aria-hidden />
                <p className="text-sm">
                  <span className="font-medium">{h.granted ? t('Given') : t('Withdrawn')}</span> · {t(consentPurposeLabel(h.purpose))}
                </p>
                <p className="text-xs text-muted-foreground tabular-nums">
                  {formatDateTime(h.occurredAt)} · {t('notice {{version}}', { version: h.noticeVersion })} · {t(consentChannelLabel(h.channel))}
                  {h.locale ? ` · ${h.locale}` : ''}
                </p>
              </li>
            ))}
          </ol>
        )}
      </section>

      <Dialog open={!!pending} onOpenChange={(o) => !record.isPending && !o && setPending(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{pending?.granted ? t('Record consent on the employee’s behalf?') : t('Withdraw consent?')}</DialogTitle>
            <DialogDescription>
              {pending && t(consentPurposeLabel(pending.purpose))}
              {' — '}
              {pending?.granted
                ? t('Confirm that the employee has agreed. Your name and the time are kept as evidence.')
                : pending?.purpose === 'TRANSPORT_PROFILE'
                  ? t('From the next planning run, no location of this employee is used for routing.')
                  : t('The change applies from the next request. It is kept in the history.')}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-3">
            <FormError message={record.error ? errorMessage(record.error) : null} />
            {pending?.granted && (
              <Field label={t('Notice version')} htmlFor={`${uid}-ver`} hint={t('The version of the privacy notice the employee agreed to.')} required>
                <Input id={`${uid}-ver`} value={version} maxLength={40} onChange={(e) => setVersion(e.target.value)} />
              </Field>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPending(null)} disabled={record.isPending}>
              {t('Cancel')}
            </Button>
            <Button variant={pending?.granted ? 'default' : 'destructive'} onClick={confirm} disabled={record.isPending || !version.trim()}>
              {record.isPending && <Spinner />}
              {pending?.granted ? t('Record consent') : t('Withdraw')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
