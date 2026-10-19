import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RelayTargetDto, RelayTestResult } from '@veetracer/shared';
import { ChevronDownIcon, EyeIcon, PauseCircleIcon, PencilIcon, PlugZapIcon, PlusIcon, ShareIcon, Trash2Icon, TriangleAlertIcon } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { FormError } from '@/components/form-error';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { useAuth } from '@/features/auth/auth-context';
import { SecretBox } from '@/features/developer/shared';
import { DateCell } from '@/features/masters/cells';
import { api, errorMessage } from '@/lib/api';
import { PROTOCOL_LABELS, RELAY_QUERY, RelayTargetDialog } from './RelayTargetDialog';

interface ListResponse {
  /** Master switch: false pauses every target. */
  masterEnabled: boolean;
  items: RelayTargetDto[];
  maxTargets: number;
}

const STATUS_VARIANT = { OK: 'success', FAILING: 'destructive', IDLE: 'muted', DISABLED: 'muted' } as const;
const STATUS_LABEL = { OK: 'Forwarding', FAILING: 'Failing', IDLE: 'Idle', DISABLED: 'Off' } as const;

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

const num = (n: number) => n.toLocaleString('en-IN');

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm font-medium tabular-nums">{value}</span>
    </div>
  );
}

/** Platform → Data forwarding: copies of device data to state backends, other platforms or partners. */
export function DataForwardingPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const editable = can('sa_relay', 'edit');
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<RelayTargetDto | null | 'new'>(null);
  const [deleting, setDeleting] = useState<RelayTargetDto | null>(null);
  const [secret, setSecret] = useState<{ name: string; value: string } | null>(null);
  const [tests, setTests] = useState<Record<string, RelayTestResult>>({});
  const [openErrors, setOpenErrors] = useState<Record<string, boolean>>({});
  const [confirmPause, setConfirmPause] = useState(false);
  const list = useQuery({
    queryKey: RELAY_QUERY,
    queryFn: ({ signal }) => api.get<ListResponse>('/admin/relay-targets', undefined, signal),
    refetchInterval: 10_000,
  });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: RELAY_QUERY });
  const onError = (err: unknown) => toast.error(errorMessage(err));

  const toggle = useMutation({
    mutationFn: (r: RelayTargetDto) => api.patch(`/admin/relay-targets/${r.id}`, { enabled: !r.enabled }),
    onSuccess: refresh,
    onError,
  });
  const master = useMutation({
    mutationFn: (enabled: boolean) => api.put<{ enabled: boolean }>('/admin/relay-targets/master', { enabled }),
    onSuccess: (res) => {
      setConfirmPause(false);
      toast.success(res.enabled ? t('Forwarding resumed') : t('All forwarding paused'));
      refresh();
    },
    onError,
  });
  const test = useMutation({
    mutationFn: (r: RelayTargetDto) => api.post<RelayTestResult>(`/admin/relay-targets/${r.id}/test`, {}),
    onSuccess: (res, r) => {
      setTests((s) => ({ ...s, [r.id]: res }));
      if (res.ok) toast.success(t('Connection OK: {{message}}', { message: res.message }));
      else toast.error(t('Connection failed: {{message}}', { message: res.message }));
    },
    onError,
  });
  const reveal = useMutation({
    mutationFn: (r: RelayTargetDto) => api.get<{ secret: string }>(`/admin/relay-targets/${r.id}/secret`).then((s) => ({ name: r.name, value: s.secret })),
    onSuccess: setSecret,
    onError,
  });
  const remove = useMutation({
    mutationFn: (r: RelayTargetDto) => api.delete(`/admin/relay-targets/${r.id}`),
    onSuccess: () => {
      setDeleting(null);
      toast.success(t('Forwarding target deleted'));
      refresh();
    },
    onError,
  });

  const rows = list.data?.items ?? [];
  const masterOn = list.data?.masterEnabled ?? true;
  const full = !!list.data && rows.length >= list.data.maxTargets;
  const scopeText = (r: RelayTargetDto) =>
    r.scope === 'ALL'
      ? t('All devices')
      : r.scope === 'COMPANY'
        ? t('Company: {{name}}', { name: r.companyName ?? '—' })
        : r.scope === 'DEVICES'
          ? t('{{count}} selected devices', { count: r.deviceIds.length })
          : t('Protocol: {{name}}', { name: PROTOCOL_LABELS[r.protocol ?? ''] ?? r.protocol ?? '—' });

  return (
    <div className="w-full space-y-6 p-4 sm:p-6">
      <PageHeader
        title={t('Data forwarding')}
        description={t('Send a copy of the data received from devices to another server: a state AIS-140 backend, another tracking platform or a partner.')}
        actions={
          can('sa_relay', 'create') && (
            <Button onClick={() => setEditing('new')} disabled={full} title={full ? t('At most {{count}} targets', { count: list.data?.maxTargets ?? 0 }) : undefined}>
              <PlusIcon />
              {t('Add target')}
            </Button>
          )
        }
      />
      {list.data && (
        <Card className={masterOn ? 'flex flex-wrap items-center gap-3 p-4' : 'flex flex-wrap items-center gap-3 border-warning/50 bg-warning/10 p-4'}>
          {!masterOn && <PauseCircleIcon className="size-5 shrink-0 text-warning" aria-hidden />}
          <div className="min-w-0 flex-1">
            <p className="font-medium">{masterOn ? t('Forwarding is on') : t('All forwarding is paused')}</p>
            <p className="text-sm text-muted-foreground">
              {masterOn
                ? t('Enabled targets receive data. Turn this off to pause every target at once.')
                : t('No data is sent to any target. Each target keeps its own settings and on / off state.')}
            </p>
          </div>
          <Switch
            checked={masterOn}
            disabled={!editable || master.isPending}
            onCheckedChange={(on) => (on ? master.mutate(true) : setConfirmPause(true))}
            aria-label={t('Forwarding on / off')}
          />
        </Card>
      )}
      {list.isError && <FormError message={errorMessage(list.error)} />}
      {list.isPending ? (
        <Skeleton className="h-36 w-full" />
      ) : !rows.length ? (
        <Card>
          <EmptyState icon={ShareIcon} title={t('No forwarding targets yet')} description={t('Mirror raw device data over TCP, or post decoded positions as JSON over HTTPS.')} />
        </Card>
      ) : (
        <div className="grid gap-3">
          {rows.map((r) => {
            const s = r.stats;
            const lastTest = tests[r.id];
            return (
              <Card key={r.id} className="space-y-3 p-4">
                <div className="flex flex-wrap items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{r.name}</span>
                      {masterOn || !r.enabled ? <Badge variant={STATUS_VARIANT[r.status]}>{t(STATUS_LABEL[r.status])}</Badge> : <Badge variant="warning">{t('Paused')}</Badge>}
                      <Badge variant="secondary">{r.type === 'RAW_TCP' ? t('Raw TCP') : t('HTTP JSON')}</Badge>
                      <Badge variant="outline">{scopeText(r)}</Badge>
                      {r.passDownstream && <Badge variant="warning">{t('Replies passed to device')}</Badge>}
                      {r.includeAlerts && <Badge variant="outline">{t('Alerts')}</Badge>}
                      {r.liveOnly && <Badge variant="outline">{t('Live only')}</Badge>}
                      {r.validOnly && <Badge variant="outline">{t('Valid fixes only')}</Badge>}
                    </div>
                    <code className="mt-1 block truncate font-mono text-xs text-muted-foreground">{r.type === 'RAW_TCP' ? `${r.host}:${r.port}` : r.url}</code>
                  </div>
                  {editable && <Switch checked={r.enabled} disabled={toggle.isPending} onCheckedChange={() => toggle.mutate(r)} aria-label={t('Enabled')} />}
                </div>
                {s && (
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
                    {r.type === 'RAW_TCP' && <Stat label={t('Upstream connections')} value={`${num(s.connected)} / ${num(s.sessions)}`} />}
                    <Stat label={r.type === 'RAW_TCP' ? t('Chunks forwarded') : t('Items forwarded')} value={num(s.frames)} />
                    <Stat label={t('Data sent')} value={bytes(s.bytes)} />
                    <Stat label={t('Queued')} value={r.type === 'RAW_TCP' ? bytes(s.queued) : num(s.queued)} />
                    <Stat label={t('Dropped')} value={num(s.dropped)} />
                    <Stat label={t('Last success')} value={<DateCell value={s.lastSuccessAt} relative />} />
                    <Stat label={t('Failing since')} value={<DateCell value={s.failingSince} relative />} />
                  </div>
                )}
                {s?.lastError && r.status === 'FAILING' && (
                  <p className="flex items-start gap-2 text-xs text-destructive">
                    <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />
                    {s.lastError.message}
                  </p>
                )}
                {lastTest && (
                  <p className={lastTest.ok ? 'text-xs text-success' : 'text-xs text-destructive'}>
                    {t('Test')}: {lastTest.message} ({lastTest.durationMs} ms)
                  </p>
                )}
                {!!s?.recentErrors.length && (
                  <div>
                    <button type="button" className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground" onClick={() => setOpenErrors((o) => ({ ...o, [r.id]: !o[r.id] }))}>
                      <ChevronDownIcon className={openErrors[r.id] ? 'size-3.5 rotate-180' : 'size-3.5'} />
                      {t('Recent errors ({{count}})', { count: s.recentErrors.length })}
                    </button>
                    {openErrors[r.id] && (
                      <ul className="mt-2 space-y-1 rounded-md border bg-muted/40 p-2 text-xs">
                        {s.recentErrors.map((e) => (
                          <li key={`${e.at}-${e.message}`} className="flex gap-2">
                            <span className="shrink-0 text-muted-foreground">
                              <DateCell value={e.at} />
                            </span>
                            <span className="min-w-0 break-words">{e.message}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  {editable && (
                    <>
                      <Button variant="outline" size="sm" disabled={test.isPending} onClick={() => test.mutate(r)}>
                        <PlugZapIcon />
                        {t('Test connection')}
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => setEditing(r)}>
                        <PencilIcon />
                        {t('Edit')}
                      </Button>
                      {r.type === 'HTTP_JSON' && (
                        <Button variant="ghost" size="sm" disabled={reveal.isPending} onClick={() => reveal.mutate(r)}>
                          <EyeIcon />
                          {t('Show secret')}
                        </Button>
                      )}
                    </>
                  )}
                  {can('sa_relay', 'delete') && (
                    <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setDeleting(r)}>
                      <Trash2Icon />
                      {t('Delete')}
                    </Button>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}
      <RelayTargetDialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)} record={editing === 'new' ? null : editing} />
      <Dialog open={!!secret} onOpenChange={(o) => !o && setSecret(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('Signing secret')}</DialogTitle>
            <DialogDescription>{secret?.name}</DialogDescription>
          </DialogHeader>
          <DialogBody>{secret && <SecretBox value={secret.value} />}</DialogBody>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirmPause}
        onOpenChange={setConfirmPause}
        title={t('Pause all forwarding?')}
        description={t('No device data will be sent to any target until you turn forwarding back on. It takes effect within about a minute.')}
        confirmLabel={t('Pause all')}
        destructive
        pending={master.isPending}
        onConfirm={() => master.mutate(false)}
      />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={t('Delete forwarding target?')}
        description={t('Forwarding to “{{name}}” stops at once.', { name: deleting?.name ?? '' })}
        confirmLabel={t('Delete')}
        destructive
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </div>
  );
}
