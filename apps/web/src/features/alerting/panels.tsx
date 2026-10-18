import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ALERT_SEVERITIES,
  ALERT_TYPE_MAP,
  ALERT_TYPES,
  type AlertLevel,
  type AlertPackDto,
  type AlertSeverity,
  type AlertSnoozeDto,
  type AlertTypeCode,
  type AuditLogDto,
  type BranchDto,
  type EffectiveAlertSetting,
  type TrackedObjectDto,
  type VehicleGroupDto,
} from '@veetracer/shared';
import { BellOffIcon, CheckIcon, CopyIcon, HistoryIcon, PackageIcon, SendIcon, Trash2Icon, XIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Combobox, MultiSelect, type Option } from '@/components/ui/multi-select';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAuth } from '@/features/auth/auth-context';
import { SEVERITY_LABEL } from '@/features/alerts/severity';
import { formatWindow } from '@/features/geofences/time-windows';
import { ChangesView } from '@/features/masters/ChangesView';
import { named, useEntityOptions } from '@/features/masters/use-options';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime, humanize } from '@/lib/format';
import { cn } from '@/lib/utils';
import { CHANNEL_LABEL, LEVEL_NAME, type ResolvedRecipientsResponse } from './api';
import { levelLabel, type Source } from './inheritance';
import type { Target } from './LevelTree';

const TYPE_OPTIONS: Option[] = ALERT_TYPES.map((t) => ({ value: t.code, label: t.label }));
const objectOption = (o: TrackedObjectDto): Option => ({ value: o.id, label: o.name, description: o.plateNumber ?? undefined });
const LEVEL_PLURAL: Record<AlertLevel, string> = { COMPANY: 'Companies', BRANCH: 'Branches', GROUP: 'Vehicle groups', OBJECT: 'Vehicles' };

/** Alert type options with translated labels. */
function useTypeOptions(): Option[] {
  const { t } = useTranslation();
  return useMemo(() => TYPE_OPTIONS.map((o) => ({ ...o, label: t(o.label) })), [t]);
}

function SourceTag({ source }: { source: Source | undefined }) {
  const { t } = useTranslation();
  if (!source || source === 'DEFAULT') return <span className="text-[11px] text-muted-foreground">{t('default')}</span>;
  return <span className="text-[11px] text-primary">{t(levelLabel(source)).toLowerCase()}</span>;
}

/** Object level: fully resolved settings of every alert type with their origin. */
export function EffectivePanel({ objectId }: { objectId: string }) {
  const { t } = useTranslation();
  const q = useQuery({
    queryKey: ['alert-settings', 'effective', objectId],
    queryFn: ({ signal }) => api.get<EffectiveAlertSetting[]>('/alert-settings/effective', { objectId }, signal),
  });
  if (q.isPending) return <Skeleton className="h-64 w-full" />;
  if (q.isError) return <FormError message={errorMessage(q.error)} />;
  return (
    <div className="overflow-hidden rounded-xl border">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>{t('Alert')}</TableHead>
            <TableHead>{t('On')}</TableHead>
            <TableHead>{t('Severity')}</TableHead>
            <TableHead className="hidden md:table-cell">{t('Settings')}</TableHead>
            <TableHead className="hidden lg:table-cell">{t('Channels')}</TableHead>
            <TableHead className="hidden sm:table-cell">{t('Schedule')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {q.data.map((e) => {
            const def = ALERT_TYPE_MAP[e.alertType];
            const params = def.params
              .filter((p) => p.type !== 'geofences')
              .map((p) => ({ p, v: e.params[p.key], s: e.sources[`params.${p.key}`] }))
              .filter((x) => x.v !== null && x.v !== undefined);
            return (
              <TableRow key={e.alertType} className={cn(!e.supported && 'opacity-60')}>
                <TableCell>
                  <span className="block font-medium">{t(def.label)}</span>
                  {!e.supported && <span className="text-xs text-warning">{t('Not supported by device')}</span>}
                  {e.snoozedUntil && <span className="block text-xs text-warning">{t('Snoozed until {{time}}', { time: formatDateTime(e.snoozedUntil) })}</span>}
                </TableCell>
                <TableCell>
                  <span className="flex flex-col">
                    {e.enabled ? <CheckIcon className="size-4 text-success" aria-label={t('On')} /> : <XIcon className="size-4 text-muted-foreground" aria-label={t('Off')} />}
                    <SourceTag source={e.sources.enabled} />
                  </span>
                </TableCell>
                <TableCell>
                  <span className="flex flex-col">
                    <span className="text-sm">{t(SEVERITY_LABEL[e.severity])}</span>
                    <SourceTag source={e.sources.severity} />
                  </span>
                </TableCell>
                <TableCell className="hidden whitespace-normal md:table-cell">
                  <span className="flex max-w-sm min-w-[14rem] flex-wrap gap-x-3 gap-y-0.5 text-xs">
                    {params.map(({ p, v, s }) => (
                      <span key={p.key}>
                        <span className="text-muted-foreground">{t(p.label)}:</span> {String(v)}
                        {p.unit ? ` ${p.unit}` : ''} <SourceTag source={s} />
                      </span>
                    ))}
                    <span>
                      <span className="text-muted-foreground">{t('Cooldown')}:</span> {e.cooldownMin} min <SourceTag source={e.sources.cooldownMin} />
                    </span>
                  </span>
                </TableCell>
                <TableCell className="hidden text-xs whitespace-normal lg:table-cell">
                  {ALERT_SEVERITIES.map((sev) => (
                    <span key={sev} className="block min-w-[9rem]">
                      <span className="text-muted-foreground">{t(SEVERITY_LABEL[sev])}:</span> {e.channels[sev].map((c) => t(CHANNEL_LABEL[c])).join(', ') || '—'}{' '}
                      <SourceTag source={e.sources[`channels.${sev}`]} />
                    </span>
                  ))}
                </TableCell>
                <TableCell className="hidden text-xs whitespace-normal sm:table-cell">{e.schedule ? formatWindow(e.schedule, (k, v) => t(k, v)) : t('Always')}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function untilPreset(kind: '1h' | '4h' | 'tomorrow' | 'week'): string {
  const d = new Date();
  if (kind === '1h') d.setHours(d.getHours() + 1);
  else if (kind === '4h') d.setHours(d.getHours() + 4);
  else if (kind === 'tomorrow') {
    d.setDate(d.getDate() + 1);
    d.setHours(8, 0, 0, 0);
  } else d.setDate(d.getDate() + 7);
  return toLocalInput(d);
}

function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Snoozes (maintenance mode) for the selected target; company level lists every active snooze. */
export function SnoozesPanel({ target, canEdit }: { target: Target; canEdit: boolean }) {
  const { t } = useTranslation();
  const typeOptions = useTypeOptions();
  const qc = useQueryClient();
  const isCompany = target.level === 'COMPANY';
  const [showExpired, setShowExpired] = useState(false);
  const list = useQuery({
    queryKey: ['alert-settings', 'snoozes', target.level, target.id, showExpired],
    queryFn: ({ signal }) =>
      api.get<AlertSnoozeDto[]>('/alert-snoozes', { ...(isCompany ? {} : { level: target.level, targetId: target.id }), includeExpired: showExpired || undefined }, signal),
  });
  const [until, setUntil] = useState(() => untilPreset('4h'));
  const [types, setTypes] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const create = useMutation({
    mutationFn: () =>
      api.post<AlertSnoozeDto>('/alert-snoozes', { level: target.level, targetId: target.id, alertTypes: types, until: new Date(until).toISOString(), reason: reason.trim() || null }),
    onSuccess: () => {
      toast.success(t('Snooze created'));
      setReason('');
      setTypes([]);
      qc.invalidateQueries({ queryKey: ['alert-settings'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.delete<unknown>(`/alert-snoozes/${id}`),
    onSuccess: () => {
      toast.success(t('Snooze ended'));
      qc.invalidateQueries({ queryKey: ['alert-settings'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const now = Date.now();

  return (
    <div className="space-y-5">
      {canEdit && (
        <div className="space-y-3 rounded-xl border p-4">
          <div>
            <h3 className="text-sm font-semibold">{t('Snooze alerts for {{name}}', { name: target.name })}</h3>
            <p className="text-xs text-muted-foreground">{t('Mute alerts (e.g. vehicle in the workshop) until a date and time; they resume automatically. Mandatory alerts (SOS) are never snoozed.')}</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('Until')} htmlFor="snooze-until">
              <Input id="snooze-until" type="datetime-local" value={until} min={toLocalInput(new Date())} onChange={(e) => setUntil(e.target.value)} />
              <div className="flex flex-wrap gap-1">
                {(
                  [
                    ['1h', '1 hour'],
                    ['4h', '4 hours'],
                    ['tomorrow', 'Tomorrow 08:00'],
                    ['week', '1 week'],
                  ] as const
                ).map(([k, l]) => (
                  <Button key={k} size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setUntil(untilPreset(k))}>
                    {t(l)}
                  </Button>
                ))}
              </div>
            </Field>
            <Field label={t('Alert types')} hint={t('Empty = all non-mandatory alerts')}>
              <MultiSelect value={types} onChange={setTypes} options={typeOptions.filter((o) => !ALERT_TYPE_MAP[o.value as AlertTypeCode].mandatory)} placeholder={t('All alerts')} />
            </Field>
          </div>
          <Field label={t('Reason')} htmlFor="snooze-reason">
            <Input id="snooze-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} placeholder={t('Optional, e.g. In workshop for service')} />
          </Field>
          <Button onClick={() => create.mutate()} disabled={create.isPending || !until || new Date(until).getTime() <= now}>
            {create.isPending ? <Spinner /> : <BellOffIcon />}
            {t('Snooze')}
          </Button>
        </div>
      )}

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">{isCompany ? t('All snoozes') : t('Snoozes on this target')}</h3>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input type="checkbox" checked={showExpired} onChange={(e) => setShowExpired(e.target.checked)} /> {t('Show expired')}
          </label>
        </div>
        {list.isError && <FormError message={errorMessage(list.error)} />}
        {list.isPending && <Skeleton className="h-16 w-full" />}
        {list.data?.length === 0 && <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">{t('No snoozes.')}</p>}
        <ul className="space-y-2">
          {list.data?.map((s) => {
            const active = Date.parse(s.until) > now;
            return (
              <li key={s.id} className="flex flex-wrap items-start gap-3 rounded-lg border p-3">
                <BellOffIcon className={cn('mt-0.5 size-4', active ? 'text-warning' : 'text-muted-foreground')} />
                <div className="min-w-0 flex-1 text-sm">
                  <p className="font-medium">
                    {t(LEVEL_NAME[s.level])}: {s.targetName} {!active && <Badge variant="muted">{t('Expired')}</Badge>}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {s.alertTypes.length ? s.alertTypes.map((a) => (ALERT_TYPE_MAP[a] ? t(ALERT_TYPE_MAP[a].label) : a)).join(', ') : t('All non-mandatory alerts')} · {t('until {{time}}', { time: formatDateTime(s.until) })}
                  </p>
                  {s.reason && <p className="text-xs">{s.reason}</p>}
                  <p className="text-[11px] text-muted-foreground">
                    {s.createdByName ?? t('System')} · {formatDateTime(s.createdAt)}
                  </p>
                </div>
                {canEdit && active && (
                  <Button size="sm" variant="ghost" onClick={() => remove.mutate(s.id)} disabled={remove.isPending}>
                    <Trash2Icon /> {t('End now')}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

/** Change history of alert settings, recipient lists and snoozes for the target (from the audit log). */
export function HistoryPanel({ target }: { target: Target }) {
  const { t } = useTranslation();
  const q = useQuery({
    queryKey: ['alert-settings', 'history', target.level, target.id],
    queryFn: ({ signal }) => api.get<AuditLogDto[]>('/alert-settings/history', { level: target.level, targetId: target.id }, signal),
  });
  if (q.isPending) return <Skeleton className="h-40 w-full" />;
  if (q.isError) return <FormError message={errorMessage(q.error)} />;
  if (!q.data.length) return <EmptyState icon={HistoryIcon} title={t('No changes yet')} description={t('Every change to settings, recipients and snoozes at this level is listed here.')} />;
  return (
    <ol className="relative space-y-5 border-l pl-5">
      {q.data.map((h) => (
        <li key={h.id} className="relative space-y-2">
          <span className="absolute top-1.5 -left-[25px] size-2.5 rounded-full border-2 border-card bg-primary" />
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant="secondary">{humanize(h.entity)}</Badge>
            <Badge variant={h.action === 'DELETE' ? 'destructive' : h.action === 'CREATE' ? 'success' : 'warning'}>{h.action}</Badge>
            <span className="font-medium">{h.userName ?? t('System')}</span>
            <span className="text-xs text-muted-foreground">{formatDateTime(h.createdAt)}</span>
          </div>
          <ChangesView changes={h.changes} />
        </li>
      ))}
    </ol>
  );
}

/** Level-aware target multi-picker (branches, groups or vehicles). */
function useTargetOptions(level: AlertLevel, enabled: boolean) {
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const branches = useEntityOptions<BranchDto>('/branches', named, { enabled: enabled && level === 'BRANCH' && can('branches') });
  const groups = useEntityOptions<VehicleGroupDto>('/vehicle-groups', named, { enabled: enabled && level === 'GROUP' && can('vehicle_groups') });
  const objects = useEntityOptions<TrackedObjectDto>('/objects', objectOption, { q, enabled: enabled && level === 'OBJECT' && can('objects') });
  const src = level === 'BRANCH' ? branches : level === 'GROUP' ? groups : objects;
  return { options: src.options, loading: src.loading, onSearch: level === 'OBJECT' ? setQ : undefined };
}

export function PacksDialog({ open, onOpenChange, target }: { open: boolean; onOpenChange: (o: boolean) => void; target: Target }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const packs = useQuery({ queryKey: ['alert-packs'], queryFn: ({ signal }) => api.get<AlertPackDto[]>('/alert-packs', undefined, signal), enabled: open });
  const [packId, setPackId] = useState<string | null>(null);
  const [targetIds, setTargetIds] = useState<string[]>([target.id]);
  useEffect(() => {
    if (open) {
      setTargetIds([target.id]);
      setPackId(null);
    }
  }, [open, target.id]);
  const opts = useTargetOptions(target.level, open && target.level !== 'COMPANY');
  const apply = useMutation({
    mutationFn: () => api.post<{ targets: number; settings: number }>(`/alert-packs/${packId}/apply`, { level: target.level, targetIds }),
    onSuccess: (r) => {
      toast.success(t('Pack applied: {{settings}} setting(s) on {{targets}} target(s)', { settings: r.settings, targets: r.targets }));
      qc.invalidateQueries({ queryKey: ['alert-settings'] });
      onOpenChange(false);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const active = (packs.data ?? []).filter((p) => p.isActive);
  return (
    <Dialog open={open} onOpenChange={(o) => !apply.isPending && onOpenChange(o)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('Apply an alert pack')}</DialogTitle>
          <DialogDescription>{t('A pack writes a ready-made set of alert settings at the {{level}} level. Existing settings for the same alert types are replaced.', { level: t(LEVEL_NAME[target.level]).toLowerCase() })}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {packs.isPending && <Skeleton className="h-32 w-full" />}
          {packs.isError && <FormError message={errorMessage(packs.error)} />}
          <div role="radiogroup" className="grid gap-2 sm:grid-cols-2">
            {active.map((p) => (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={packId === p.id}
                onClick={() => setPackId(p.id)}
                className={cn('rounded-lg border p-3 text-left transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:outline-none', packId === p.id ? 'border-primary bg-primary/6' : 'hover:bg-accent/60')}
              >
                <span className="flex items-center gap-2">
                  <PackageIcon className="size-4 text-primary" />
                  <span className="font-medium">{p.name}</span>
                  {p.isSystem && <Badge variant="muted">{t('System')}</Badge>}
                </span>
                {p.description && <span className="mt-1 block text-xs text-muted-foreground">{p.description}</span>}
                <span className="mt-1.5 flex flex-wrap gap-1">
                  {p.settings.map((s) => (
                    <Badge key={s.alertType} variant={s.enabled === false ? 'muted' : 'secondary'} className="text-[10px]">
                      {ALERT_TYPE_MAP[s.alertType] ? t(ALERT_TYPE_MAP[s.alertType].label) : s.alertType}
                      {s.enabled === false ? ` ${t('off')}` : ''}
                    </Badge>
                  ))}
                </span>
              </button>
            ))}
          </div>
          {target.level !== 'COMPANY' && (
            <Field label={t('Apply to ({{targets}})', { targets: t(LEVEL_PLURAL[target.level]).toLowerCase() })}>
              <MultiSelect value={targetIds} onChange={setTargetIds} options={opts.options} loading={opts.loading} onSearch={opts.onSearch} selectedOptions={[{ value: target.id, label: target.name }]} />
            </Field>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={apply.isPending}>
            {t('Cancel')}
          </Button>
          <Button onClick={() => apply.mutate()} disabled={!packId || !targetIds.length || apply.isPending}>
            {apply.isPending ? <Spinner /> : <PackageIcon />}
            {t('Apply pack')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CopyDialog({ open, onOpenChange, target }: { open: boolean; onOpenChange: (o: boolean) => void; target: Target }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { can } = useAuth();
  const [objectIds, setObjectIds] = useState<string[]>([]);
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const objects = useTargetOptions('OBJECT', open);
  const groups = useTargetOptions('GROUP', open);
  const copy = useMutation({
    mutationFn: () => api.post<{ targets: number; settings: number }>('/alert-settings/copy', { fromObjectId: target.id, toObjectIds: objectIds, toGroupIds: groupIds }),
    onSuccess: (r) => {
      toast.success(t('Copied {{settings}} setting(s) to {{targets}} target(s)', { settings: r.settings, targets: r.targets }));
      qc.invalidateQueries({ queryKey: ['alert-settings'] });
      onOpenChange(false);
      setObjectIds([]);
      setGroupIds([]);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog open={open} onOpenChange={(o) => !copy.isPending && onOpenChange(o)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('Copy settings from {{name}}', { name: target.name })}</DialogTitle>
          <DialogDescription>{t("Copies this vehicle's own overrides (not inherited values) to other vehicles or to vehicle groups.")}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <Field label={t('To vehicles')}>
            <MultiSelect value={objectIds} onChange={setObjectIds} options={objects.options.filter((o) => o.value !== target.id)} loading={objects.loading} onSearch={objects.onSearch} placeholder={t('Pick vehicles…')} />
          </Field>
          {can('vehicle_groups') && (
            <Field label={t('To vehicle groups')}>
              <MultiSelect value={groupIds} onChange={setGroupIds} options={groups.options} loading={groups.loading} placeholder={t('Pick groups…')} />
            </Field>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={copy.isPending}>
            {t('Cancel')}
          </Button>
          <Button onClick={() => copy.mutate()} disabled={copy.isPending || objectIds.length + groupIds.length === 0}>
            {copy.isPending ? <Spinner /> : <CopyIcon />}
            {t('Copy')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function BulkEnableDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation();
  const typeOptions = useTypeOptions();
  const qc = useQueryClient();
  const [level, setLevel] = useState<AlertLevel>('BRANCH');
  const [targetIds, setTargetIds] = useState<string[]>([]);
  const [alertType, setAlertType] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(true);
  const opts = useTargetOptions(level, open);
  const run = useMutation({
    mutationFn: () => api.post<{ updated: number }>('/alert-settings/bulk-enable', { level, targetIds, alertType, enabled }),
    onSuccess: (r) => {
      const type = ALERT_TYPE_MAP[alertType as AlertTypeCode]?.label;
      const vars = { type: type ? t(type) : '', count: r.updated };
      toast.success(enabled ? t('{{type}} enabled on {{count}} target(s)', vars) : t('{{type}} disabled on {{count}} target(s)', vars));
      qc.invalidateQueries({ queryKey: ['alert-settings'] });
      onOpenChange(false);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const mandatory = alertType ? ALERT_TYPE_MAP[alertType as AlertTypeCode]?.mandatory : false;
  return (
    <Dialog open={open} onOpenChange={(o) => !run.isPending && onOpenChange(o)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('Bulk enable / disable')}</DialogTitle>
          <DialogDescription>{t('Switch one alert type on or off across several branches, groups or vehicles at once.')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('Level')}>
              <Select
                value={level}
                onValueChange={(v) => {
                  setLevel(v as AlertLevel);
                  setTargetIds([]);
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(['BRANCH', 'GROUP', 'OBJECT'] as AlertLevel[]).map((l) => (
                    <SelectItem key={l} value={l}>
                      {t(LEVEL_PLURAL[l])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t('Alert type')}>
              <Combobox value={alertType} onChange={setAlertType} options={typeOptions} placeholder={t('Choose…')} />
            </Field>
          </div>
          <Field label={t('Targets')}>
            <MultiSelect value={targetIds} onChange={setTargetIds} options={opts.options} loading={opts.loading} onSearch={opts.onSearch} placeholder={t('Pick targets…')} />
          </Field>
          <Field label={t('Action')}>
            <Select value={enabled ? 'on' : 'off'} onValueChange={(v) => setEnabled(v === 'on')}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="on">{t('Enable')}</SelectItem>
                <SelectItem value="off">{t('Disable')}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {mandatory && !enabled && <FormError message={t("Mandatory alerts can't be disabled below company level.")} />}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={run.isPending}>
            {t('Cancel')}
          </Button>
          <Button onClick={() => run.mutate()} disabled={run.isPending || !alertType || !targetIds.length || (mandatory && !enabled)}>
            {run.isPending && <Spinner />}
            {t('Apply')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Sends a test notification for an alert type through every configured list; previews who would receive it. */
export function SendTestDialog({ open, onOpenChange, target, alertType: initialType }: { open: boolean; onOpenChange: (o: boolean) => void; target: Target; alertType: AlertTypeCode | null }) {
  const { t } = useTranslation();
  const typeOptions = useTypeOptions();
  const [alertType, setAlertType] = useState<string | null>(initialType);
  const [severity, setSeverity] = useState<AlertSeverity | 'AUTO'>('AUTO');
  const [objectId, setObjectId] = useState<string | null>(target.level === 'OBJECT' ? target.id : null);
  const objects = useTargetOptions('OBJECT', open && target.level !== 'OBJECT');
  useEffect(() => {
    if (open) {
      setAlertType(initialType);
      setObjectId(target.level === 'OBJECT' ? target.id : null);
    }
  }, [open, initialType, target]);
  const params = { objectId, alertType, ...(severity === 'AUTO' ? {} : { severity }) };
  const preview = useQuery({
    queryKey: ['alert-settings', 'resolve', params],
    queryFn: ({ signal }) => api.get<ResolvedRecipientsResponse>('/recipient-lists/resolve', params, signal),
    enabled: open && !!objectId && !!alertType,
  });
  const send = useMutation({
    mutationFn: () => api.post<{ logIds: string[] }>('/recipient-lists/test', params),
    onSuccess: (r) => {
      toast.success(r.logIds.length ? t('Test queued: {{count}} notification(s). Check the delivery log on the alert or in var/mail.', { count: r.logIds.length }) : t('No recipients to send to for this alert'));
      onOpenChange(false);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const total = useMemo(() => preview.data?.channels.filter((c) => c.enabled).reduce((n, c) => n + c.recipients.length, 0) ?? 0, [preview.data]);

  return (
    <Dialog open={open} onOpenChange={(o) => !send.isPending && onOpenChange(o)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('Send test notification')}</DialogTitle>
          <DialogDescription>{t('Renders the alert templates with sample data for a vehicle and sends them to everyone on its lists.')}</DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('Alert type')}>
              <Combobox value={alertType} onChange={setAlertType} options={typeOptions} placeholder={t('Choose…')} />
            </Field>
            <Field label={t('Severity')}>
              <Select value={severity} onValueChange={(v) => setSeverity(v as AlertSeverity | 'AUTO')}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="AUTO">{t('Configured severity')}</SelectItem>
                  {ALERT_SEVERITIES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {t(SEVERITY_LABEL[s])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          {target.level !== 'OBJECT' && (
            <Field label={t('Vehicle')} hint={t('Recipients are resolved for one vehicle (its branch, groups and own lists).')}>
              <Combobox value={objectId} onChange={setObjectId} options={objects.options} loading={objects.loading} onSearch={objects.onSearch} placeholder={t('Pick a vehicle…')} />
            </Field>
          )}
          {preview.isFetching && <Skeleton className="h-20 w-full" />}
          {preview.isError && <FormError message={errorMessage(preview.error)} />}
          {preview.data && !preview.isFetching && (
            <div className="space-y-2 rounded-lg border p-3">
              <p className="text-xs font-medium text-muted-foreground">
                {t('Recipients at {{severity}} severity · {{total}} in total', { severity: t(SEVERITY_LABEL[preview.data.severity]), total })}
              </p>
              {preview.data.channels.map((c) => (
                <div key={c.channel} className={cn('text-sm', !c.enabled && 'opacity-60')}>
                  <span className="font-medium">{t(CHANNEL_LABEL[c.channel])}</span>
                  {!c.enabled && <span className="text-xs text-muted-foreground"> {t('(channel off for this severity)')}</span>}
                  <span className="text-xs text-muted-foreground">
                    {' '}
                    · {c.decidedBy ? t('{{level}} list ({{mode}})', { level: t(levelLabel(c.decidedBy.level)), mode: c.mode.toLowerCase() }) : t('default lists')}
                  </span>
                  <p className="text-xs break-words text-muted-foreground">{c.recipients.length ? c.recipients.map((r) => (r.label && r.label !== r.address ? `${r.label} <${r.address}>` : r.address)).join(', ') : t('Nobody')}</p>
                </div>
              ))}
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={send.isPending}>
            {t('Cancel')}
          </Button>
          <Button onClick={() => send.mutate()} disabled={send.isPending || !alertType || !objectId}>
            {send.isPending ? <Spinner /> : <SendIcon />}
            {t('Send test')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
