import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ALERT_TYPES, SYSTEM_TEMPLATE_PURPOSES } from '@veetracer/shared';
import { CopyIcon, EyeIcon, GitCompareIcon, MailIcon, PowerIcon, PowerOffIcon, RotateCcwIcon, SendIcon, UndoIcon } from 'lucide-react';
import { useState } from 'react';
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
      toast.success('Test message queued — check var/mail (email) or the SMS log');
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const submit = () => {
    let recipient = to.trim();
    if (channel === 'EMAIL' && !isEmail(recipient)) return setError('Enter a valid email address');
    if (channel === 'SMS' || channel === 'WHATSAPP') {
      const m = normalizeMobile(recipient);
      if (!m) return setError('Enter an Indian mobile number');
      recipient = m;
    }
    setError(null);
    send.mutate(recipient);
  };
  return (
    <Dialog open={!!template} onOpenChange={(o) => !o && !send.isPending && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Send test</DialogTitle>
          <DialogDescription>{template ? `Sends “${template.name}” with sample data, marked [TEST].` : ''}</DialogDescription>
        </DialogHeader>
        <Field label={channel === 'EMAIL' ? 'Email address' : channel === 'PUSH' ? 'Recipient' : 'Mobile number'} htmlFor="tpl-test-to" error={error ?? undefined}>
          <Input id="tpl-test-to" value={to} onChange={(e) => setTo(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} placeholder={channel === 'EMAIL' ? 'you@company.in' : '+91 98765 43210'} />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={send.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={send.isPending || !to.trim()}>
            {send.isPending ? <Spinner /> : <SendIcon />}
            Send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function VersionsSheet({ template, onClose }: { template: TemplateRow | null; onClose: () => void }) {
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
      toast.success(`Version ${v} restored as a new version`);
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
          <SheetTitle>Version history</SheetTitle>
          <SheetDescription className="truncate">{template?.name}</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-5">
          {versions.isPending && <Skeleton className="h-24 w-full" />}
          {versions.isError && <FormError message={errorMessage(versions.error)} />}
          {versions.data?.length === 0 && <p className="text-sm text-muted-foreground">No versions recorded yet.</p>}
          {versions.data?.map((v) => (
            <div key={v.version} className="rounded-lg border">
              <div className="flex flex-wrap items-center gap-2 px-3 py-2">
                <Badge variant={v.current ? 'default' : 'secondary'}>v{v.version}</Badge>
                {v.current && <span className="text-xs font-medium text-primary">Current</span>}
                <span className="text-xs text-muted-foreground">
                  {v.changedByName ?? 'System'} · {formatDateTime(v.createdAt)}
                </span>
                <span className="flex-1" />
                <Button size="sm" variant="ghost" onClick={() => setOpenVersion(openVersion === v.version ? null : v.version)}>
                  <GitCompareIcon /> {openVersion === v.version ? 'Hide' : 'Show'}
                </Button>
                {!v.current && can('message_templates', 'edit') && (
                  <Button size="sm" variant="outline" onClick={() => restore.mutate(v.version)} disabled={restore.isPending}>
                    <UndoIcon /> Restore
                  </Button>
                )}
              </div>
              {openVersion === v.version && (
                <div className="space-y-1 border-t bg-muted/40 px-3 py-2 text-xs">
                  {v.subject && (
                    <p>
                      <span className="text-muted-foreground">Subject:</span> {v.subject}
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
  return (
    <span className="flex items-center gap-1">
      <Badge variant={r.isActive ? 'success' : 'muted'}>{r.isActive ? 'Active' : 'Inactive'}</Badge>
      {needsApproval(r.channel) && <Badge variant={APPROVAL_VARIANT[r.approvalStatus]}>{APPROVAL_LABEL[r.approvalStatus]}</Badge>}
    </span>
  );
}

/** Editor opened from the master (Form slot). */
function EditForm(props: MasterFormProps<TemplateRow>) {
  return props.record ? <TemplateEditor {...props} /> : null;
}

export function TemplatesPage() {
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
      toast.success({ duplicate: 'Template duplicated', reset: 'Reset to the system default', activate: 'Template activated', deactivate: 'Template deactivated' }[kind]);
      setResetRow(null);
      invalidate(TEMPLATES_ENDPOINT);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const columns: MasterColumn<TemplateRow>[] = [
    {
      id: 'name',
      header: 'Name',
      sortable: true,
      hideable: false,
      cell: (r) => (
        <span className="flex items-center gap-2">
          <span className="font-medium">{r.name}</span>
          {r.overridesId && <Badge variant="default">Overridden</Badge>}
        </span>
      ),
    },
    { id: 'purpose', header: 'Purpose / alert', sortable: true, cell: (r) => purposeLabel(r.purpose) },
    { id: 'channel', header: 'Channel', sortable: true, cell: (r) => <Badge variant="secondary">{CHANNEL_NAME[r.channel]}</Badge> },
    { id: 'level', header: 'Level', sortable: true, cell: (r) => <Badge variant={r.level === 'SYSTEM' ? 'muted' : 'default'}>{r.level === 'SYSTEM' ? 'System' : 'Company'}</Badge> },
    { id: 'language', header: 'Language', cell: (r) => LANGUAGE_NAME[r.language] ?? r.language },
    { id: 'status', header: 'Status', cell: (r) => <StatusCell r={r} /> },
    { id: 'dltTemplateId', header: 'DLT / Meta ID', cell: (r) => (r.dltTemplateId ? <span className="font-mono text-xs">{r.dltTemplateId}</span> : <Muted>—</Muted>) },
    { id: 'usedByRules', header: 'Used by', cell: (r) => (r.usedByRules ? <span className="tabular-nums">{r.usedByRules} rule(s)</span> : <Muted>—</Muted>) },
    ...(isSuperAdmin
      ? [{ id: 'overrideCount', header: 'Company overrides', cell: (r: TemplateRow) => (r.level === 'SYSTEM' ? <span className="tabular-nums">{r.overrideCount}</span> : <Muted>—</Muted>) }]
      : []),
    {
      id: 'updatedAt',
      header: 'Last changed',
      sortable: true,
      cell: (r) => (
        <span className="block whitespace-nowrap">
          <DateCell value={r.updatedAt} relative />
          {r.updatedByName && <span className="block text-xs text-muted-foreground">{r.updatedByName}</span>}
        </span>
      ),
    },
    { id: 'subject', header: 'Subject', defaultHidden: true, cell: (r) => <span className="block max-w-xs truncate">{r.subject ?? '—'}</span> },
  ];

  const filters: MasterFilter[] = [
    { key: 'channel', label: 'Channels', options: CHANNEL_OPTIONS },
    { key: 'purpose', label: 'Purposes', options: PURPOSE_OPTIONS },
    { key: 'level', label: 'Levels', options: [{ value: 'SYSTEM', label: 'System' }, { value: 'COMPANY', label: 'Company' }] },
    { key: 'language', label: 'Languages', options: Object.entries(LANGUAGE_NAME).map(([value, label]) => ({ value, label })) },
    { key: 'overridden', label: 'Overrides', options: [{ value: 'true', label: 'Overridden by my company' }] },
    { key: 'notApproved', label: 'Approval', options: [{ value: 'true', label: 'Not approved' }] },
  ];

  return (
    <>
      <MasterPage
        menu="message_templates"
        title="Message Templates"
        description="Email, SMS, push and WhatsApp wording for every alert and system message. Company versions override the system defaults."
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
              <EyeIcon /> Preview
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setTestRow(r)}>
              <SendIcon /> Send test
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setVersionsRow(r)}>
              <GitCompareIcon /> Versions
            </DropdownMenuItem>
            {can('message_templates', 'create') && (
              <DropdownMenuItem onSelect={() => action.mutate({ kind: 'duplicate', row: r })}>
                <CopyIcon /> Duplicate
              </DropdownMenuItem>
            )}
            {canEdit && (
              <>
                <DropdownMenuSeparator />
                {r.isActive ? (
                  <DropdownMenuItem onSelect={() => action.mutate({ kind: 'deactivate', row: r })}>
                    <PowerOffIcon /> Deactivate
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem
                    disabled={needsApproval(r.channel) && r.approvalStatus !== 'APPROVED'}
                    onSelect={() => action.mutate({ kind: 'activate', row: r })}
                  >
                    <PowerIcon /> Activate{needsApproval(r.channel) && r.approvalStatus !== 'APPROVED' ? ' (needs approval)' : ''}
                  </DropdownMenuItem>
                )}
                {r.level === 'COMPANY' && r.overridesId && (
                  <DropdownMenuItem onSelect={() => setResetRow(r)}>
                    <RotateCcwIcon /> Reset to default
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
        title="Reset to the system default?"
        description={
          <>
            Your company's version of <span className="font-medium text-foreground">{resetRow?.name}</span> will be deleted and the system default used again.
          </>
        }
        confirmLabel="Reset"
        destructive
        pending={action.isPending}
        onConfirm={() => resetRow && action.mutate({ kind: 'reset', row: resetRow })}
      />
    </>
  );
}

