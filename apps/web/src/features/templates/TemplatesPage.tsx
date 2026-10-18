import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ALERT_TYPES, SYSTEM_TEMPLATE_PURPOSES } from '@veetracer/shared';
import { CopyIcon, EyeIcon, GitCompareIcon, MailIcon, PowerIcon, PowerOffIcon, RotateCcwIcon, SendIcon, UndoIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { FormError } from '@/components/form-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import type { Option } from '@/components/ui/multi-select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useAuth, useMe } from '@/features/auth/auth-context';
import { isEmail, normalizeMobile } from '@/features/alerting/recipients';
import { DateCell, Muted } from '@/features/masters/cells';
import { useInvalidateMaster } from '@/features/masters/FormDialog';
import { MasterPage } from '@/features/masters/MasterPage';
import type { MasterColumn, MasterFilter, MasterFormProps } from '@/features/masters/types';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { APPROVAL_LABEL, APPROVAL_VARIANT, CHANNEL_NAME, LANGUAGE_NAME, needsApproval, purposeLabel, type TemplateRow, type TemplateVersionDto } from './labels';
import { TemplateEditor, TEMPLATES_ENDPOINT } from './TemplateEditor';

const PURPOSE_OPTIONS: Option[] = [...ALERT_TYPES.map((t) => ({ value: t.code, label: t.label })), ...SYSTEM_TEMPLATE_PURPOSES.map((p) => ({ value: p, label: purposeLabel(p) }))];
const CHANNEL_OPTIONS: Option[] = (['EMAIL', 'SMS', 'PUSH', 'WHATSAPP'] as const).map((c) => ({ value: c, label: CHANNEL_NAME[c] }));

function TestDialog({ template, onClose }: { template: TemplateRow | null; onClose: () => void }) {
  const { t } = useTranslation();
  const me = useMe();
  const channel = template?.channel;
  const [to, setTo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const reset = () => {
    setTo(channel === 'EMAIL' ? (me.user.email ?? '') : channel === 'SMS' || channel === 'WHATSAPP' ? (me.user.mobile ?? '') : (me.user.email ?? ''));
    setError(null);
  };
  const [lastId, setLastId] = useState<string | null>(null);
  if (template && lastId !== template.id) {
    setLastId(template.id);
    reset();
  }
  const send = useMutation({
    mutationFn: (recipient: string) => api.post<{ logIds: string[] }>(`${TEMPLATES_ENDPOINT}/${template!.id}/test`, { to: recipient }),
    onSuccess: () => {
      toast.success(t('Test message queued — check var/mail (email) or the SMS log'));
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const submit = () => {
    let recipient = to.trim();
    if (channel === 'EMAIL' && !isEmail(recipient)) return setError(t('Enter a valid email address'));
    if (channel === 'SMS' || channel === 'WHATSAPP') {
      const m = normalizeMobile(recipient);
      if (!m) return setError(t('Enter an Indian mobile number'));
      recipient = m;
    }
    setError(null);
    send.mutate(recipient);
  };
  return (
    <Dialog open={!!template} onOpenChange={(o) => !o && !send.isPending && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('Send test')}</DialogTitle>
          <DialogDescription>{template ? t('Sends “{{name}}” with sample data, marked [TEST].', { name: template.name }) : ''}</DialogDescription>
        </DialogHeader>
        <Field label={channel === 'EMAIL' ? t('Email address') : channel === 'PUSH' ? t('Recipient') : t('Mobile number')} htmlFor="tpl-test-to" error={error ?? undefined}>
          <Input id="tpl-test-to" value={to} onChange={(e) => setTo(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} placeholder={channel === 'EMAIL' ? 'you@company.in' : '+91 98765 43210'} />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={send.isPending}>
            {t('Cancel')}
          </Button>
          <Button onClick={submit} disabled={send.isPending || !to.trim()}>
            {send.isPending ? <Spinner /> : <SendIcon />}
            {t('Send')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function VersionsSheet({ template, onClose }: { template: TemplateRow | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const invalidate = useInvalidateMaster();
  const qc = useQueryClient();
  const [openVersion, setOpenVersion] = useState<number | null>(null);
  const versions = useQuery({
    queryKey: ['templates', 'versions', template?.id],
    queryFn: ({ signal }) => api.get<TemplateVersionDto[]>(`${TEMPLATES_ENDPOINT}/${template!.id}/versions`, undefined, signal),
    enabled: !!template,
  });
  const restore = useMutation({
    mutationFn: (version: number) => api.post<TemplateRow>(`${TEMPLATES_ENDPOINT}/${template!.id}/restore/${version}`),
    onSuccess: (_, v) => {
      toast.success(t('Version {{version}} restored as a new version', { version: v }));
      invalidate(TEMPLATES_ENDPOINT);
      qc.invalidateQueries({ queryKey: ['templates', 'versions'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Sheet open={!!template} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>{t('Version history')}</SheetTitle>
          <SheetDescription className="truncate">{template?.name}</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-5">
          {versions.isPending && <Skeleton className="h-24 w-full" />}
          {versions.isError && <FormError message={errorMessage(versions.error)} />}
          {versions.data?.length === 0 && <p className="text-sm text-muted-foreground">{t('No versions recorded yet.')}</p>}
          {versions.data?.map((v) => (
            <div key={v.version} className="rounded-lg border">
              <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                <Badge variant={v.current ? 'default' : 'secondary'}>v{v.version}</Badge>
                {v.current && <span className="text-xs font-medium text-primary">{t('Current')}</span>}
                <span className="text-xs text-muted-foreground">
                  {v.changedByName ?? t('System')} · {formatDateTime(v.createdAt)}
                </span>
                <span className="flex-1" />
                <Button size="sm" variant="ghost" onClick={() => setOpenVersion(openVersion === v.version ? null : v.version)}>
                  <GitCompareIcon /> {openVersion === v.version ? t('Hide') : t('Show')}
                </Button>
                {!v.current && can('message_templates', 'edit') && (
                  <Button size="sm" variant="outline" onClick={() => restore.mutate(v.version)} disabled={restore.isPending}>
                    <UndoIcon /> {t('Restore')}
                  </Button>
                )}
              </div>
              {openVersion === v.version && (
                <div className="space-y-1 border-t bg-muted/40 px-3 py-2 text-xs">
                  {v.subject && (
                    <p>
                      <span className="text-muted-foreground">{t('Subject:')}</span> {v.subject}
                    </p>
                  )}
                  <pre className="max-h-64 overflow-auto font-mono text-[11px] whitespace-pre-wrap">{v.body}</pre>
                </div>
              )}
            </div>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function StatusCell({ r }: { r: TemplateRow }) {
  const { t } = useTranslation();
  return (
    <span className="flex items-center gap-1">
      <Badge variant={r.isActive ? 'success' : 'muted'}>{r.isActive ? t('Active') : t('Inactive')}</Badge>
      {needsApproval(r.channel) && <Badge variant={APPROVAL_VARIANT[r.approvalStatus]}>{t(APPROVAL_LABEL[r.approvalStatus])}</Badge>}
    </span>
  );
}

/** Editor opened from the master (Form slot). */
function EditForm(props: MasterFormProps<TemplateRow>) {
  return props.record ? <TemplateEditor {...props} /> : null;
}

export function TemplatesPage() {
  const { t } = useTranslation();
  const { can, me } = useAuth();
  const invalidate = useInvalidateMaster();
  const isSuperAdmin = !!me?.user.isSuperAdmin;
  const canEdit = can('message_templates', 'edit');
  const [previewRow, setPreviewRow] = useState<TemplateRow | null>(null);
  const [testRow, setTestRow] = useState<TemplateRow | null>(null);
  const [versionsRow, setVersionsRow] = useState<TemplateRow | null>(null);
  const [resetRow, setResetRow] = useState<TemplateRow | null>(null);

  const action = useMutation({
    mutationFn: ({ kind, row }: { kind: 'duplicate' | 'reset' | 'activate' | 'deactivate'; row: TemplateRow }) => {
      if (kind === 'duplicate') return api.post<TemplateRow>(`${TEMPLATES_ENDPOINT}/${row.id}/duplicate`, { name: `${row.name} (copy)` });
      if (kind === 'reset') return api.post<TemplateRow>(`${TEMPLATES_ENDPOINT}/${row.id}/reset`);
      return api.patch<TemplateRow>(`${TEMPLATES_ENDPOINT}/${row.id}`, { isActive: kind === 'activate' });
    },
    onSuccess: (_, { kind }) => {
      toast.success({ duplicate: t('Template duplicated'), reset: t('Reset to the system default'), activate: t('Template activated'), deactivate: t('Template deactivated') }[kind]);
      setResetRow(null);
      invalidate(TEMPLATES_ENDPOINT);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const columns: MasterColumn<TemplateRow>[] = [
    {
      id: 'name',
      header: t('Name'),
      sortable: true,
      hideable: false,
      cell: (r) => (
        <span className="flex items-center gap-2">
          <span className="font-medium">{r.name}</span>
          {r.overridesId && <Badge variant="default">{t('Overridden')}</Badge>}
        </span>
      ),
    },
    { id: 'purpose', header: t('Purpose / alert'), sortable: true, cell: (r) => t(purposeLabel(r.purpose)) },
    { id: 'channel', header: t('Channel'), sortable: true, cell: (r) => <Badge variant="secondary">{t(CHANNEL_NAME[r.channel])}</Badge> },
    { id: 'level', header: t('Level'), sortable: true, cell: (r) => <Badge variant={r.level === 'SYSTEM' ? 'muted' : 'default'}>{r.level === 'SYSTEM' ? t('System') : t('Company')}</Badge> },
    { id: 'language', header: t('Language'), cell: (r) => (LANGUAGE_NAME[r.language] ? t(LANGUAGE_NAME[r.language]) : r.language) },
    { id: 'status', header: t('Status'), cell: (r) => <StatusCell r={r} /> },
    { id: 'dltTemplateId', header: t('DLT / Meta ID'), cell: (r) => (r.dltTemplateId ? <span className="font-mono text-xs">{r.dltTemplateId}</span> : <Muted>—</Muted>) },
    { id: 'usedByRules', header: t('Used by'), cell: (r) => (r.usedByRules ? <span className="tabular-nums">{t('{{count}} rule(s)', { count: r.usedByRules })}</span> : <Muted>—</Muted>) },
    ...(isSuperAdmin
      ? [{ id: 'overrideCount', header: t('Company overrides'), cell: (r: TemplateRow) => (r.level === 'SYSTEM' ? <span className="tabular-nums">{r.overrideCount}</span> : <Muted>—</Muted>) }]
      : []),
    {
      id: 'updatedAt',
      header: t('Last changed'),
      sortable: true,
      cell: (r) => (
        <span className="block whitespace-nowrap">
          <DateCell value={r.updatedAt} relative />
          {r.updatedByName && <span className="block text-xs text-muted-foreground">{r.updatedByName}</span>}
        </span>
      ),
    },
    { id: 'subject', header: t('Subject'), defaultHidden: true, cell: (r) => <span className="block max-w-xs truncate">{r.subject ?? '—'}</span> },
  ];

  const filters: MasterFilter[] = [
    { key: 'channel', label: t('Channels'), options: CHANNEL_OPTIONS.map((o) => ({ ...o, label: t(o.label) })) },
    { key: 'purpose', label: t('Purposes'), options: PURPOSE_OPTIONS.map((o) => ({ ...o, label: t(o.label) })) },
    { key: 'level', label: t('Levels'), options: [{ value: 'SYSTEM', label: t('System') }, { value: 'COMPANY', label: t('Company') }] },
    { key: 'language', label: t('Languages'), options: Object.entries(LANGUAGE_NAME).map(([value, label]) => ({ value, label: t(label) })) },
    { key: 'overridden', label: t('Overrides'), options: [{ value: 'true', label: t('Overridden by my company') }] },
    { key: 'notApproved', label: t('Approval'), options: [{ value: 'true', label: t('Not approved') }] },
  ];

  return (
    <>
      <MasterPage
        menu="message_templates"
        title={t('Message Templates')}
        description={t('Email, SMS, push and WhatsApp wording for every alert and system message. Company versions override the system defaults.')}
        endpoint={TEMPLATES_ENDPOINT}
        columns={columns}
        rowLabel={(r) => r.name}
        filters={filters}
        defaultSort={{ id: 'purpose', desc: false }}
        Form={EditForm}
        allowCreate={false}
        bulkActions={false}
        emptyIcon={MailIcon}
        canDeleteRow={(r) => r.level === 'COMPANY' && !r.overridesId}
        rowActions={(r: TemplateRow) => (
          <>
            <DropdownMenuItem onSelect={() => setPreviewRow(r)}>
              <EyeIcon /> {t('Preview')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setTestRow(r)}>
              <SendIcon /> {t('Send test')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setVersionsRow(r)}>
              <GitCompareIcon /> {t('Versions')}
            </DropdownMenuItem>
            {can('message_templates', 'create') && (
              <DropdownMenuItem onSelect={() => action.mutate({ kind: 'duplicate', row: r })}>
                <CopyIcon /> {t('Duplicate')}
              </DropdownMenuItem>
            )}
            {canEdit && (
              <>
                <DropdownMenuSeparator />
                {r.isActive ? (
                  <DropdownMenuItem onSelect={() => action.mutate({ kind: 'deactivate', row: r })}>
                    <PowerOffIcon /> {t('Deactivate')}
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem
                    disabled={needsApproval(r.channel) && r.approvalStatus !== 'APPROVED'}
                    onSelect={() => action.mutate({ kind: 'activate', row: r })}
                  >
                    <PowerIcon /> {t('Activate')}
                    {needsApproval(r.channel) && r.approvalStatus !== 'APPROVED' ? ` ${t('(needs approval)')}` : ''}
                  </DropdownMenuItem>
                )}
                {r.level === 'COMPANY' && r.overridesId && (
                  <DropdownMenuItem onSelect={() => setResetRow(r)}>
                    <RotateCcwIcon /> {t('Reset to default')}
                  </DropdownMenuItem>
                )}
              </>
            )}
          </>
        )}
      />
      {previewRow && <TemplateEditor record={previewRow} open onOpenChange={(o) => !o && setPreviewRow(null)} initialTab="preview" />}
      <TestDialog template={testRow} onClose={() => setTestRow(null)} />
      <VersionsSheet template={versionsRow} onClose={() => setVersionsRow(null)} />
      <ConfirmDialog
        open={!!resetRow}
        onOpenChange={(o) => !o && setResetRow(null)}
        title={t('Reset to the system default?')}
        description={
          <>
            {t("Your company's version of")} <span className="font-medium text-foreground">{resetRow?.name}</span> {t('will be deleted and the system default used again.')}
          </>
        }
        confirmLabel={t('Reset')}
        destructive
        pending={action.isPending}
        onConfirm={() => resetRow && action.mutate({ kind: 'reset', row: resetRow })}
      />
    </>
  );
}

