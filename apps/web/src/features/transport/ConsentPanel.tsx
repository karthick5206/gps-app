import { CONSENT_EVIDENCE_REF_MAX, CONSENT_NOTE_MAX, type ConsentPurpose, type PassengerConsentStateDto } from '@veetracer/shared';
import { CheckCircle2Icon, CircleAlertIcon, ExternalLinkIcon, FileTextIcon, HistoryIcon, ShieldCheckIcon, XCircleIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useAuth } from '@/features/auth/auth-context';
import { ApiError, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { currentLocale } from '@/lib/i18n';
import { ToneBadge } from './passenger-ui';
import { canGrantWithNotice, CONSENT_PURPOSE_META, consentChannelLabel, consentPurposeLabel, consentRows, consentStatus, consentTimeline, noticeFor, peopleErrorKind } from './people-format';
import { useConsentNotices, usePassengerConsents, useRecordConsent } from './use-people';

type Pending = { purpose: ConsentPurpose; granted: boolean; state: PassengerConsentStateDto | null };

/** Where the notices are edited (Transport settings, consent notice section). */
export const CONSENT_NOTICE_SETTINGS_PATH = '/transport/settings#consent-notices';

/**
 * Consent per purpose (doc 10 §4.2): current state, the corporate admin's actions on the passenger's behalf and the full
 * evidence history. Security review M2: the admin may withdraw (channel ADMIN_ON_BEHALF), or record a consent the
 * passenger gave offline, with the form reference and a note (channel ADMIN_RECORDED_OFFLINE); any other grant comes from
 * the passenger's own app / web session. Either way the passenger gets an in-app notice. A grant first shows the
 * company's current notice text; the server records that notice's version. Without a published notice no grant is possible.
 */
export function ConsentPanel({ passengerId, canRecord }: { passengerId: string; canRecord: boolean }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const uid = useId();
  const consents = usePassengerConsents(passengerId, true);
  const notices = useConsentNotices();
  const record = useRecordConsent(passengerId);
  const [pending, setPending] = useState<Pending | null>(null);
  const [evidenceRef, setEvidenceRef] = useState('');
  const [note, setNote] = useState('');

  if (consents.isPending || notices.isPending) return <Skeleton className="h-64" />;
  if (consents.isError) return <FormError message={errorMessage(consents.error)} />;

  const rows = consentRows(consents.data.current);
  const history = consentTimeline(consents.data.history);
  const pendingNotice = pending ? noticeFor(notices.data, pending.purpose).notice : null;
  const noticeError = record.error instanceof ApiError && peopleErrorKind(record.error.code) === 'notice';

  const open = (p: Pending) => {
    record.reset();
    setEvidenceRef('');
    setNote('');
    setPending(p);
  };
  const evidenceMissing = !!pending?.granted && (!evidenceRef.trim() || !note.trim());
  const confirm = () => {
    if (!pending || (pending.granted && (!pendingNotice || evidenceMissing))) return;
    record.mutate(
      {
        purpose: pending.purpose,
        granted: pending.granted,
        ...(pending.granted && pendingNotice ? { noticeVersion: pendingNotice.version, evidenceRef: evidenceRef.trim(), note: note.trim() } : {}),
        locale: currentLocale(),
      },
      {
        onSuccess: () => {
          toast.success(pending.granted ? t('Offline consent recorded. The passenger is notified in the app.') : t('Consent withdrawn. The passenger is notified in the app.'));
          setPending(null);
        },
        // The notice changed since it was loaded: reload it so the admin sees the new text before confirming again.
        onError: (e) => {
          if (e instanceof ApiError && peopleErrorKind(e.code) === 'notice') void notices.refetch();
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
          {t('Employees give or withdraw consent themselves in the app or on the web. Here you can withdraw it, or record a consent the employee gave offline (for example on a signed form) with its reference. The employee is told in the app.')}
        </p>
        {notices.isError && <FormError message={errorMessage(notices.error)} />}
        <ul className="divide-y rounded-lg border">
          {rows.map(({ purpose, state }) => {
            const s = consentStatus(state);
            const meta = CONSENT_PURPOSE_META[purpose];
            const { notice } = noticeFor(notices.data, purpose);
            return (
              <li key={purpose} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-start">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{t(meta.label)}</span>
                    <ToneBadge tone={s.tone} icon={state?.active ? CheckCircle2Icon : state?.revokedAt ? XCircleIcon : CircleAlertIcon}>
                      {t(s.label)}
                    </ToneBadge>
                    {state?.active && notice && state.noticeVersion !== notice.version && <ToneBadge tone="info">{t('Older notice version')}</ToneBadge>}
                  </div>
                  <p className="text-xs text-muted-foreground">{t(meta.description)}</p>
                  {state && (
                    <p className="text-xs text-muted-foreground tabular-nums">
                      {state.active
                        ? t('Given {{date}} · notice {{version}} · {{channel}}', { date: formatDateTime(state.grantedAt), version: state.noticeVersion ?? '—', channel: t(consentChannelLabel(state.channel)) })
                        : t('Withdrawn {{date}} · {{channel}}', { date: formatDateTime(state.revokedAt), channel: t(consentChannelLabel(state.channel)) })}
                    </p>
                  )}
                  {!notice && !state?.active && <p className="text-xs text-muted-foreground">{t('No notice published for this purpose yet, so consent cannot be recorded.')}</p>}
                </div>
                {canRecord && (
                  <div className="flex shrink-0 gap-2">
                    {state?.active ? (
                      <Button variant="outline" size="sm" onClick={() => open({ purpose, granted: false, state })}>
                        {t('Withdraw')}
                      </Button>
                    ) : (
                      <Button size="sm" onClick={() => open({ purpose, granted: true, state })} disabled={!canGrantWithNotice(notice)}>
                        {t('Record offline consent')}
                      </Button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        {canRecord && can('etms_settings', 'edit') && (
          <Button variant="link" size="sm" asChild className="h-auto px-0">
            <Link to={CONSENT_NOTICE_SETTINGS_PATH}>
              <ExternalLinkIcon /> {t('Edit the consent notices in Transport settings')}
            </Link>
          </Button>
        )}
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
                {h.channel === 'ADMIN_RECORDED_OFFLINE' && (
                  <p className="text-xs break-words">
                    <span className="text-muted-foreground">{t('Evidence')}: </span>
                    <span className="font-mono">{h.evidenceRef ?? '—'}</span>
                    {h.note ? <span className="text-muted-foreground"> · {h.note}</span> : null}
                  </p>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>

      <Dialog open={!!pending} onOpenChange={(o) => !record.isPending && !o && setPending(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{pending?.granted ? t('Record a consent given offline?') : t('Withdraw consent?')}</DialogTitle>
            <DialogDescription>
              {pending && t(consentPurposeLabel(pending.purpose))}
              {' — '}
              {pending?.granted
                ? t('Only for a consent the employee gave outside VeeTrax, for example on a signed paper form. Your name, the time, the notice version and the form reference are kept as evidence, and the employee is told in the app.')
                : pending?.purpose === 'TRANSPORT_PROFILE'
                  ? t('From the next planning run, no location of this employee is used for routing.')
                  : t('The change applies from the next request. It is kept in the history.')}
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-3">
            <FormError message={record.error ? errorMessage(record.error) : null} />
            {noticeError && pendingNotice && <p className="text-xs text-muted-foreground">{t('The notice below is the current one. Check it with the employee before confirming.')}</p>}
            {pending?.granted &&
              (pendingNotice ? (
                <section aria-labelledby={`${uid}-notice`} className="space-y-2 rounded-lg border bg-muted/40 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <FileTextIcon className="size-4 text-muted-foreground" aria-hidden />
                    <h4 id={`${uid}-notice`} className="text-sm font-semibold">
                      {pendingNotice.title}
                    </h4>
                    <ToneBadge tone="neutral">{t('Version {{version}}', { version: pendingNotice.version })}</ToneBadge>
                  </div>
                  <p className="text-xs text-muted-foreground">{t('In force since {{date}}', { date: formatDateTime(pendingNotice.effectiveFrom) })}</p>
                  <div
                    tabIndex={0}
                    aria-label={t('Notice text')}
                    className="max-h-60 overflow-y-auto rounded-md bg-card p-3 text-sm whitespace-pre-wrap focus-visible:ring-[3px] focus-visible:ring-ring/30 focus-visible:outline-none"
                  >
                    {pendingNotice.body}
                  </div>
                </section>
              ) : (
                <p className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">{t('No notice published for this purpose yet, so consent cannot be recorded.')}</p>
              ))}
            {pending?.granted && pendingNotice && (
              <div className="space-y-3">
                <Field label={t('Form reference')} htmlFor={`${uid}-evidence`} hint={t('For example the paper form number or the HR file reference.')} required>
                  <Input id={`${uid}-evidence`} value={evidenceRef} maxLength={CONSENT_EVIDENCE_REF_MAX} onChange={(e) => setEvidenceRef(e.target.value)} autoComplete="off" />
                </Field>
                <Field label={t('Note')} htmlFor={`${uid}-note`} hint={t('How and when the employee agreed.')} required>
                  <Textarea id={`${uid}-note`} value={note} maxLength={CONSENT_NOTE_MAX} onChange={(e) => setNote(e.target.value)} rows={3} />
                </Field>
              </div>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPending(null)} disabled={record.isPending}>
              {t('Cancel')}
            </Button>
            <Button variant={pending?.granted ? 'default' : 'destructive'} onClick={confirm} disabled={record.isPending || (!!pending?.granted && (!pendingNotice || evidenceMissing))}>
              {record.isPending && <Spinner />}
              {pending?.granted ? t('Record offline consent') : t('Withdraw')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
