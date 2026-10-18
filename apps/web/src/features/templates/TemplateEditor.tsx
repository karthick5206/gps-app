import { useMutation, useQuery } from '@tanstack/react-query';
import type { AlertDto, Paginated, TemplateApproval } from '@veetracer/shared';
import { AlertTriangleIcon, BracesIcon, CodeIcon, EyeIcon, InfoIcon, SmartphoneIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input, Textarea } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { useAuth } from '@/features/auth/auth-context';
import { useInvalidateMaster } from '@/features/masters/FormDialog';
import type { MasterFormProps } from '@/features/masters/types';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { APPROVAL_LABEL, APPROVAL_VARIANT, CHANNEL_NAME, isAlertPurpose, LANGUAGE_NAME, needsApproval, purposeLabel, type PreviewResponse, type TemplateRow } from './labels';
import { countSms, extractPlaceholders, insertAt, toDltText } from './sms';

export const TEMPLATES_ENDPOINT = '/templates';
const APPROVALS: TemplateApproval[] = ['DRAFT', 'PENDING', 'APPROVED', 'REJECTED'];

function SmsCounter({ text, label }: { text: string; label?: string }) {
  const { t } = useTranslation();
  const c = countSms(text);
  const over = c.parts > 3;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs" aria-live="polite">
      <span className="font-medium">{label ?? t('Message')}:</span>
      <Badge variant={c.encoding === 'UNICODE' ? 'warning' : 'secondary'}>{c.encoding === 'UNICODE' ? 'Unicode' : 'GSM 7-bit'}</Badge>
      <span className="tabular-nums">
        {c.units} / {c.parts <= 1 ? c.perPart : c.parts * c.perPart} {c.encoding === 'UNICODE' ? t('units') : t('chars')}
      </span>
      <span className={cn('tabular-nums', over && 'font-semibold text-destructive')}>
        {c.parts === 1 ? t('1 part') : t('{{count}} parts', { count: c.parts })}
      </span>
      <span className="text-muted-foreground tabular-nums">{t('{{count}} left in this part', { count: c.remaining })}</span>
      {c.encoding === 'UNICODE' && c.unicodeChars.length > 0 && (
        <span className="text-warning">
          {t('Unicode because of:')} <span className="font-mono">{c.unicodeChars.map((ch) => (ch === ' ' ? '␠' : ch)).join(' ')}</span>
        </span>
      )}
    </div>
  );
}

/** Sandboxed render of email HTML (no scripts, no same-origin access). */
function HtmlFrame({ html, title, className }: { html: string; title: string; className?: string }) {
  return <iframe title={title} sandbox="" srcDoc={html} className={cn('h-full min-h-[320px] w-full rounded-lg border bg-white', className)} />;
}

function PreviewPane({ channel, preview, loading, error }: { channel: TemplateRow['channel']; preview: PreviewResponse | undefined; loading: boolean; error: unknown }) {
  const { t } = useTranslation();
  if (error) return <FormError message={errorMessage(error)} />;
  if (!preview) return <Skeleton className="h-64 w-full" />;
  return (
    <div className={cn('space-y-3 transition-opacity', loading && 'opacity-60')}>
      {(preview.unknown.length > 0 || preview.missing.length > 0) && (
        <div className="space-y-1 rounded-lg border border-warning/40 bg-warning/8 px-3 py-2 text-xs text-warning">
          {preview.unknown.length > 0 && (
            <p className="flex items-start gap-1.5">
              <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" /> {t('Unknown placeholders:')} {preview.unknown.map((u) => `{{${u}}}`).join(', ')}
            </p>
          )}
          {preview.missing.length > 0 && <p>{t('No sample value for:')} {preview.missing.join(', ')}</p>}
        </div>
      )}
      {channel === 'EMAIL' && (
        <div className="space-y-2">
          <p className="rounded-md bg-muted px-3 py-2 text-sm">
            <span className="text-muted-foreground">{t('Subject:')} </span>
            <span className="font-medium">{preview.subject ?? '—'}</span>
          </p>
          <HtmlFrame html={preview.body} title={t('Email preview')} className="h-[calc(100dvh-16rem)] min-h-[420px]" />
        </div>
      )}
      {channel === 'SMS' && preview.sms && (
        <div className="space-y-3">
          <div className="mx-auto max-w-xs rounded-[1.75rem] border-4 border-foreground/80 bg-muted p-3">
            <div className="flex items-center gap-1.5 px-1 pb-2 text-[11px] text-muted-foreground">
              <SmartphoneIcon className="size-3" /> SMS
            </div>
            <div className="rounded-2xl rounded-tl-sm bg-card px-3 py-2 text-sm whitespace-pre-wrap shadow-xs">{preview.text}</div>
          </div>
          <SmsCounter text={preview.text} label={t('Rendered')} />
          <div className="space-y-1 text-xs">
            <p className="font-medium">{t('DLT text')}</p>
            <p className="rounded-md bg-muted px-2 py-1.5 font-mono break-words">{preview.sms.dltText}</p>
            {preview.sms.values.length > 0 && (
              <p className="text-muted-foreground">
                {t('Variables in order:')} {preview.sms.values.map((v, i) => <code key={i} className="mr-1 rounded bg-muted px-1">{v || '∅'}</code>)}
              </p>
            )}
          </div>
        </div>
      )}
      {(channel === 'PUSH' || channel === 'WHATSAPP') && (
        <div className="mx-auto max-w-sm rounded-2xl border bg-card p-3 shadow-sm">
          <p className="text-[11px] text-muted-foreground">{channel === 'PUSH' ? `VeeTracer · ${t('now')}` : 'WhatsApp'}</p>
          {preview.subject && <p className="text-sm font-semibold">{preview.subject}</p>}
          <p className="text-sm whitespace-pre-wrap">{preview.text || preview.body}</p>
        </div>
      )}
    </div>
  );
}

/** Edit a template: subject/body with placeholder picker, live preview (API), SMS counter, DLT/approval fields. */
export function TemplateEditor({ record, open, onOpenChange, initialTab = 'edit' }: MasterFormProps<TemplateRow> & { initialTab?: 'edit' | 'preview' }) {
  // `t` is the template record below, so the translator is `tr` here.
  const { t: tr } = useTranslation();
  const { can, me, companyId } = useAuth();
  const invalidate = useInvalidateMaster();
  const t = record!;
  const canEdit = can('message_templates', 'edit');
  // Super Admin without a selected company edits the system rows themselves.
  const platform = !!me?.user.isSuperAdmin && !companyId;
  const createsOverride = t.level === 'SYSTEM' && !platform;
  const [name, setName] = useState(t.name);
  const [subject, setSubject] = useState(t.subject ?? '');
  const [body, setBody] = useState(t.body);
  const [dltTemplateId, setDltTemplateId] = useState(t.dltTemplateId ?? '');
  const [senderId, setSenderId] = useState(t.senderId ?? '');
  const [approval, setApproval] = useState<TemplateApproval>(t.approvalStatus);
  const [isActive, setIsActive] = useState(t.isActive);
  const [htmlView, setHtmlView] = useState<'code' | 'preview'>('code');
  const [mobileTab, setMobileTab] = useState<'edit' | 'preview'>(initialTab);
  const [alertId, setAlertId] = useState<string>('sample');
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  const lastFocus = useRef<'subject' | 'body'>('body');
  const hasSubject = t.channel === 'EMAIL' || t.channel === 'PUSH';
  const approvalNeeded = needsApproval(t.channel);

  const placeholders = useQuery({
    queryKey: ['templates', 'placeholders', t.purpose],
    queryFn: ({ signal }) => api.get<string[]>(`${TEMPLATES_ENDPOINT}/placeholders`, { purpose: t.purpose }, signal),
    staleTime: Infinity,
  });
  const recentAlerts = useQuery({
    queryKey: ['templates', 'sample-alerts', t.purpose],
    queryFn: ({ signal }) => api.get<Paginated<AlertDto>>('/alerts', { type: t.purpose, page: 1, pageSize: 10, sort: 'occurredAt', order: 'desc' }, signal),
    enabled: open && isAlertPurpose(t.purpose) && can('alerts'),
    staleTime: 60_000,
  });

  const [debounced, setDebounced] = useState({ subject, body, alertId });
  useEffect(() => {
    const id = setTimeout(() => setDebounced({ subject, body, alertId }), 350);
    return () => clearTimeout(id);
  }, [subject, body, alertId]);
  const preview = useQuery({
    queryKey: ['templates', 'preview', t.id, debounced],
    queryFn: () =>
      api.post<PreviewResponse>(`${TEMPLATES_ENDPOINT}/preview`, {
        templateId: t.id,
        purpose: t.purpose,
        channel: t.channel,
        subject: hasSubject ? debounced.subject : null,
        body: debounced.body || ' ',
        ...(debounced.alertId !== 'sample' ? { alertId: debounced.alertId } : {}),
      }),
    enabled: open,
    placeholderData: (prev) => prev,
  });

  const used = useMemo(() => new Set(extractPlaceholders(`${subject} ${body}`)), [subject, body]);
  const known = useMemo(() => new Set(placeholders.data ?? []), [placeholders.data]);
  const unknownUsed = [...used].filter((u) => placeholders.data && !known.has(u.toLowerCase()));

  const insert = (name: string) => {
    const token = `{{${name}}}`;
    if (lastFocus.current === 'subject' && hasSubject && subjectRef.current) {
      const el = subjectRef.current;
      const r = insertAt(subject, el.selectionStart ?? subject.length, el.selectionEnd ?? subject.length, token);
      setSubject(r.value);
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(r.caret, r.caret);
      });
      return;
    }
    const el = bodyRef.current;
    const r = insertAt(body, el?.selectionStart ?? body.length, el?.selectionEnd ?? body.length, token);
    setBody(r.value);
    setHtmlView('code');
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      el.setSelectionRange(r.caret, r.caret);
    });
  };

  const dirty =
    name !== t.name ||
    subject !== (t.subject ?? '') ||
    body !== t.body ||
    dltTemplateId !== (t.dltTemplateId ?? '') ||
    senderId !== (t.senderId ?? '') ||
    approval !== t.approvalStatus ||
    isActive !== t.isActive;

  const activationBlocked = approvalNeeded && isActive && approval !== 'APPROVED';

  const save = useMutation({
    mutationFn: () =>
      api.patch<TemplateRow>(`${TEMPLATES_ENDPOINT}/${t.id}`, {
        name: name.trim(),
        ...(hasSubject ? { subject: subject.trim() || null } : {}),
        body,
        ...(approvalNeeded ? { dltTemplateId: dltTemplateId.trim() || null, senderId: senderId.trim() || null, approvalStatus: approval } : {}),
        isActive,
      }),
    onSuccess: (res) => {
      toast.success(createsOverride && res.level === 'COMPANY' ? tr('Saved as your company override') : tr('Template saved'));
      invalidate(TEMPLATES_ENDPOINT);
      onOpenChange(false);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const dlt = t.channel === 'SMS' ? toDltText(body) : null;

  return (
    <Dialog open={open} onOpenChange={(o) => !save.isPending && onOpenChange(o)}>
      <DialogContent className="top-0 left-0 h-dvh max-h-none w-screen max-w-none translate-x-0 translate-y-0 gap-0 rounded-none p-0 sm:top-1/2 sm:left-1/2 sm:h-[calc(100dvh-3rem)] sm:max-w-6xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-xl">
        <header className="flex flex-wrap items-center gap-3 border-b px-4 py-3 pr-12">
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate">{t.name}</DialogTitle>
            <DialogDescription className="flex flex-wrap items-center gap-1.5 pt-1 text-xs">
              <Badge variant="secondary">{tr(CHANNEL_NAME[t.channel])}</Badge>
              <Badge variant="outline">{tr(purposeLabel(t.purpose))}</Badge>
              <Badge variant={t.level === 'SYSTEM' ? 'muted' : 'default'}>{t.level === 'SYSTEM' ? tr('System default') : tr('Company')}</Badge>
              {approvalNeeded && <Badge variant={APPROVAL_VARIANT[t.approvalStatus]}>{tr(APPROVAL_LABEL[t.approvalStatus])}</Badge>}
              <span>{LANGUAGE_NAME[t.language] ? tr(LANGUAGE_NAME[t.language]) : t.language}</span>
              <span>· v{t.version}</span>
              {t.updatedAt && <span>· {t.updatedByName ? `${t.updatedByName}, ` : ''}{formatDateTime(t.updatedAt)}</span>}
            </DialogDescription>
          </div>
          <div className="flex rounded-lg bg-muted p-0.5 md:hidden" role="tablist" aria-label={tr('Editor view')}>
            {(['edit', 'preview'] as const).map((k) => (
              <button key={k} type="button" role="tab" aria-selected={mobileTab === k} onClick={() => setMobileTab(k)} className={cn('rounded-md px-3 py-1 text-sm font-medium', mobileTab === k ? 'bg-card shadow-sm' : 'text-muted-foreground')}>
                {k === 'edit' ? tr('Edit') : tr('Preview')}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={save.isPending}>
              {canEdit ? tr('Cancel') : tr('Close')}
            </Button>
            {canEdit && (
              <Button onClick={() => save.mutate()} disabled={!dirty || save.isPending || !body.trim() || !name.trim() || activationBlocked}>
                {save.isPending && <Spinner />}
                {tr('Save')}
              </Button>
            )}
          </div>
        </header>

        <div className="grid min-h-0 flex-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className={cn('min-h-0 space-y-4 overflow-y-auto p-4 sm:p-5 md:border-r', mobileTab !== 'edit' && 'hidden md:block')}>
            {createsOverride && canEdit && (
              <p className="flex items-start gap-2 rounded-lg border border-primary/30 bg-primary/6 px-3 py-2 text-xs">
                <InfoIcon className="mt-0.5 size-3.5 shrink-0 text-primary" />
                {tr('This is the system default. Saving creates your company\'s own version; "Reset to default" removes it again.')}
              </p>
            )}
            <fieldset disabled={!canEdit} className="min-w-0 space-y-4">
              <Field label={tr('Name')} htmlFor="tpl-name" required>
                <Input id="tpl-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={150} />
              </Field>
              {hasSubject && (
                <Field label={t.channel === 'PUSH' ? tr('Title') : tr('Subject')} htmlFor="tpl-subject">
                  <Input id="tpl-subject" ref={subjectRef} value={subject} onChange={(e) => setSubject(e.target.value)} onFocus={() => (lastFocus.current = 'subject')} maxLength={300} />
                </Field>
              )}

              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label htmlFor="tpl-body" className="text-sm font-medium">
                    {t.channel === 'EMAIL' ? tr('Body (HTML)') : tr('Message')}
                  </label>
                  {t.channel === 'EMAIL' && (
                    <div className="flex rounded-md bg-muted p-0.5" role="group" aria-label={tr('Body view')}>
                      <button type="button" aria-pressed={htmlView === 'code'} onClick={() => setHtmlView('code')} className={cn('flex items-center gap-1 rounded px-2 py-0.5 text-xs', htmlView === 'code' ? 'bg-card shadow-xs' : 'text-muted-foreground')}>
                        <CodeIcon className="size-3.5" /> HTML
                      </button>
                      <button type="button" aria-pressed={htmlView === 'preview'} onClick={() => setHtmlView('preview')} className={cn('flex items-center gap-1 rounded px-2 py-0.5 text-xs', htmlView === 'preview' ? 'bg-card shadow-xs' : 'text-muted-foreground')}>
                        <EyeIcon className="size-3.5" /> {tr('Preview')}
                      </button>
                    </div>
                  )}
                </div>
                {t.channel === 'EMAIL' && htmlView === 'preview' ? (
                  <HtmlFrame html={body} title={tr('Email HTML (placeholders not filled)')} className="h-[340px]" />
                ) : (
                  <Textarea
                    id="tpl-body"
                    ref={bodyRef}
                    value={body}
                    onChange={(e) => setBody(e.target.value)}
                    onFocus={() => (lastFocus.current = 'body')}
                    spellCheck={t.channel !== 'EMAIL'}
                    className={cn('resize-y', t.channel === 'EMAIL' ? 'min-h-[340px] font-mono text-xs leading-relaxed' : 'min-h-36')}
                  />
                )}
                {t.channel === 'SMS' && <SmsCounter text={body} label={tr('Template')} />}
                {unknownUsed.length > 0 && <p className="text-xs text-destructive">{tr('Not a placeholder for this message:')} {unknownUsed.map((u) => `{{${u}}}`).join(', ')}</p>}
              </div>

              <div className="space-y-1.5">
                <p className="flex items-center gap-1.5 text-sm font-medium">
                  <BracesIcon className="size-4 text-muted-foreground" /> {tr('Placeholders')}
                </p>
                <p className="text-xs text-muted-foreground">{hasSubject ? tr('Click to insert at the cursor (subject or body, whichever you used last).') : tr('Click to insert at the cursor.')}</p>
                <div className="flex flex-wrap gap-1.5">
                  {placeholders.isPending && <Skeleton className="h-6 w-64" />}
                  {placeholders.data?.map((p) => (
                    <button
                      key={p}
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => insert(p)}
                      className={cn(
                        'rounded-md border px-2 py-0.5 font-mono text-[11px] transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none',
                        used.has(p) ? 'border-primary/40 bg-primary/8 text-primary' : 'text-muted-foreground',
                      )}
                    >
                      {`{{${p}}}`}
                    </button>
                  ))}
                </div>
              </div>

              {approvalNeeded && (
                <div className="space-y-3 rounded-lg border p-3">
                  <p className="text-sm font-medium">{t.channel === 'SMS' ? tr('DLT registration') : tr('Meta approval')}</p>
                  {dlt && (
                    <div className="space-y-1 text-xs">
                      <p className="text-muted-foreground">{tr('Text to register (each placeholder is one {#var#} slot):')}</p>
                      <p className="rounded-md bg-muted px-2 py-1.5 font-mono break-words">{dlt.text}</p>
                    </div>
                  )}
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Field label={t.channel === 'SMS' ? tr('DLT template ID') : tr('Meta template ID')} htmlFor="tpl-dlt">
                      <Input id="tpl-dlt" value={dltTemplateId} onChange={(e) => setDltTemplateId(e.target.value)} maxLength={50} />
                    </Field>
                    <Field label={tr('Sender ID')} htmlFor="tpl-sender" hint={t.channel === 'SMS' ? tr('6 letters, e.g. VEETRC') : undefined}>
                      <Input id="tpl-sender" value={senderId} onChange={(e) => setSenderId(e.target.value.toUpperCase())} maxLength={20} />
                    </Field>
                    <Field label={tr('Approval')}>
                      <Select value={approval} onValueChange={(v) => setApproval(v as TemplateApproval)}>
                        <SelectTrigger aria-label={tr('Approval status')}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {APPROVALS.map((a) => (
                            <SelectItem key={a} value={a}>
                              {tr(APPROVAL_LABEL[a])}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                  </div>
                  {body !== t.body && t.approvalStatus === 'APPROVED' && <p className="text-xs text-warning">{tr('Changing approved wording requires registering it again with the operator.')}</p>}
                </div>
              )}

              <label className="flex items-center justify-between gap-4 rounded-lg border px-3 py-2.5">
                <span>
                  <span className="block text-sm font-medium">{tr('Active')}</span>
                  <span className="block text-xs text-muted-foreground">
                    {approvalNeeded ? tr('Only approved templates can be activated.') : tr('Inactive templates fall back to the system default.')}
                  </span>
                </span>
                <Switch checked={isActive} onCheckedChange={setIsActive} />
              </label>
              {activationBlocked && <FormError message={tr('Set the approval status to Approved before activating this {{channel}} template.', { channel: tr(CHANNEL_NAME[t.channel]) })} />}
            </fieldset>
          </div>

          <div className={cn('min-h-0 space-y-3 overflow-y-auto bg-muted/30 p-4 sm:p-5', mobileTab !== 'preview' && 'hidden md:block')}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="flex items-center gap-2 text-sm font-semibold">
                {tr('Live preview')} {preview.isFetching && <Spinner className="text-muted-foreground" />}
              </p>
              {isAlertPurpose(t.purpose) && can('alerts') && (
                <Select value={alertId} onValueChange={setAlertId}>
                  <SelectTrigger className="h-8 w-auto max-w-[16rem] text-xs" aria-label={tr('Preview data')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="sample">{tr('Sample data')}</SelectItem>
                    {recentAlerts.data?.items.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.objectName} · {formatDateTime(a.occurredAt)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <PreviewPane channel={t.channel} preview={preview.data} loading={preview.isFetching} error={preview.error} />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
