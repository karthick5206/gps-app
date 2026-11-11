import { CONSENT_NOTICE_BODY_MAX, CONSENT_NOTICE_TITLE_MAX, CONSENT_PURPOSES, type ConsentNoticeDto, type ConsentPurpose } from '@veetracer/shared';
import { CalendarClockIcon, FileTextIcon, PencilIcon, PlusIcon } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useAuth } from '@/features/auth/auth-context';
import { Panel } from '@/features/dashboard/refresh/kit';
import { errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { ToneBadge } from './passenger-ui';
import { CONSENT_PURPOSE_META, noticeFor, noticeVersions, validateNoticeDraft, type NoticeDraft } from './people-format';
import { useConsentNotices, usePublishNotice } from './use-people';

/**
 * Consent notices (doc 10 §4.2, E2 gap 2): the company-level text a passenger reads before agreeing to each purpose.
 * Versioned and immutable: "Publish" creates the next version (v1, v2…); consents keep the version they were given
 * against. Editing needs a whole-company role with Transport settings edit (the server enforces it too).
 */
export function ConsentNoticesPanel() {
  const { t } = useTranslation();
  const { can, me } = useAuth();
  const notices = useConsentNotices();
  const canEdit = can('etms_settings', 'edit') && me?.dataScope === 'COMPANY';
  const [editing, setEditing] = useState<ConsentPurpose | null>(null);
  // Deep link from the consent panel (/transport/settings#consent-notices): scroll here once the notices are loaded.
  useEffect(() => {
    if (notices.isSuccess && typeof window !== 'undefined' && window.location.hash === '#consent-notices') document.getElementById('consent-notices')?.scrollIntoView({ block: 'start' });
  }, [notices.isSuccess]);

  return (
    <Panel
      title={t('Consent notices')}
      subtitle={t('What employees read before they agree to each use of their data. Changing a text publishes a new version; consents keep the version they were given for.')}
      id="consent-notices"
    >
      {notices.isPending ? (
        <Skeleton className="h-40" />
      ) : notices.isError ? (
        <FormError message={errorMessage(notices.error)} />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {CONSENT_PURPOSES.map((purpose) => {
            const { notice, scheduled } = noticeFor(notices.data, purpose);
            const versions = noticeVersions(notices.data, purpose);
            return (
              <li key={purpose} className="flex min-w-0 flex-col gap-2 rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <FileTextIcon className="size-4 text-muted-foreground" aria-hidden />
                  <p className="font-medium">{t(CONSENT_PURPOSE_META[purpose].label)}</p>
                  {notice ? <ToneBadge tone="success">{t('Version {{version}}', { version: notice.version })}</ToneBadge> : <ToneBadge tone="warning">{t('Not published')}</ToneBadge>}
                  {scheduled && (
                    <ToneBadge tone="info" icon={CalendarClockIcon}>
                      {t('{{version}} from {{date}}', { version: scheduled.version, date: formatDateTime(scheduled.effectiveFrom) })}
                    </ToneBadge>
                  )}
                </div>
                {notice ? (
                  <>
                    <p className="text-sm font-medium">{notice.title}</p>
                    <p className="line-clamp-3 text-xs whitespace-pre-wrap text-muted-foreground">{notice.body}</p>
                    <p className="text-xs text-muted-foreground">
                      {t('In force since {{date}}', { date: formatDateTime(notice.effectiveFrom) })}
                      {notice.createdByName ? ` · ${notice.createdByName}` : ''}
                    </p>
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">{t('Until a notice is published, consent for this purpose cannot be recorded.')}</p>
                )}
                <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
                  {canEdit && (
                    <Button size="sm" variant={notice ? 'outline' : 'default'} onClick={() => setEditing(purpose)}>
                      {notice ? <PencilIcon /> : <PlusIcon />} {notice ? t('Edit text') : t('Write notice')}
                    </Button>
                  )}
                  {versions.length > 1 && <VersionList versions={versions} />}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {!canEdit && <p className="mt-3 text-xs text-muted-foreground">{t('Only a whole-company role with Transport settings edit can change the notices.')}</p>}
      {editing && <NoticeEditor purpose={editing} current={noticeFor(notices.data, editing).notice} onClose={() => setEditing(null)} />}
    </Panel>
  );
}

function VersionList({ versions }: { versions: ConsentNoticeDto[] }) {
  const { t } = useTranslation();
  return (
    <details className="text-xs">
      <summary className="cursor-pointer rounded font-medium text-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">{t('{{n}} versions', { n: versions.length })}</summary>
      <ol className="mt-2 space-y-2">
        {versions.map((v) => (
          <li key={v.id} className="rounded-md border p-2">
            <p className="font-medium">
              {v.version} · {v.title}
            </p>
            <p className="text-muted-foreground">{t('From {{date}}', { date: formatDateTime(v.effectiveFrom) })}</p>
            <p className="mt-1 line-clamp-4 whitespace-pre-wrap">{v.body}</p>
          </li>
        ))}
      </ol>
    </details>
  );
}

function NoticeEditor({ purpose, current, onClose }: { purpose: ConsentPurpose; current: ConsentNoticeDto | null; onClose: () => void }) {
  const { t } = useTranslation();
  const uid = useId();
  const publish = usePublishNotice();
  const [draft, setDraft] = useState<NoticeDraft>({ title: current?.title ?? t(CONSENT_PURPOSE_META[purpose].label), body: current?.body ?? '', effectiveFrom: '' });
  const [errors, setErrors] = useState<ReturnType<typeof validateNoticeDraft>['errors']>([]);
  useEffect(() => publish.reset(), []); // eslint-disable-line react-hooks/exhaustive-deps
  const errorOf = (field: keyof NoticeDraft) => errors.find((e) => e.field === field)?.message;

  const submit = () => {
    const v = validateNoticeDraft(draft, current);
    setErrors(v.errors);
    if (!v.input) return;
    publish.mutate(
      { purpose, ...v.input },
      {
        onSuccess: (n) => {
          toast.success(t('Notice {{version}} published', { version: n.version }));
          onClose();
        },
      },
    );
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !publish.isPending && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {t('Consent notice')} · {t(CONSENT_PURPOSE_META[purpose].label)}
          </DialogTitle>
          <DialogDescription>
            {current
              ? t('Publishing creates version {{next}}. Version {{version}} stays on record for the consents given against it.', { next: `v${Number(current.version.slice(1)) + 1}`, version: current.version })
              : t('This becomes version v1. Employees read it before they agree.')}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <FormError message={publish.error ? errorMessage(publish.error) : null} />
          <Field label={t('Title')} htmlFor={`${uid}-title`} required error={errorOf('title') ? t(errorOf('title')!) : undefined}>
            <Input id={`${uid}-title`} value={draft.title} maxLength={CONSENT_NOTICE_TITLE_MAX} onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))} aria-invalid={!!errorOf('title') || undefined} />
          </Field>
          <Field
            label={t('Text')}
            htmlFor={`${uid}-body`}
            required
            hint={t('Say what is collected, why, who sees it, how long it is kept and how to withdraw. Plain text; line breaks are kept.')}
            error={errorOf('body') ? t(errorOf('body')!) : undefined}
          >
            <Textarea
              id={`${uid}-body`}
              rows={10}
              value={draft.body}
              maxLength={CONSENT_NOTICE_BODY_MAX}
              onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
              aria-invalid={!!errorOf('body') || undefined}
            />
          </Field>
          <Field label={t('In force from')} htmlFor={`${uid}-from`} hint={t('Leave empty to apply it now.')} error={errorOf('effectiveFrom') ? t(errorOf('effectiveFrom')!) : undefined}>
            <Input id={`${uid}-from`} type="datetime-local" value={draft.effectiveFrom} onChange={(e) => setDraft((d) => ({ ...d, effectiveFrom: e.target.value }))} className="w-full sm:w-64" />
          </Field>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={publish.isPending}>
            {t('Cancel')}
          </Button>
          <Button onClick={submit} disabled={publish.isPending}>
            {publish.isPending && <Spinner />}
            {t('Publish')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
