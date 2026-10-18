import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ALERT_SEVERITIES,
  ALERT_TYPES,
  type AlertDto,
  type AlertStatus,
  type BranchDto,
  type Paginated,
  type TrackedObjectDto,
} from '@veetracer/shared';
import { BellIcon, CheckCheckIcon, CheckIcon, ChevronLeftIcon, ChevronRightIcon, DownloadIcon, RefreshCwIcon, SearchIcon, XIcon } from 'lucide-react';
import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Input, Textarea } from '@/components/ui/input';
import { Combobox, type Option } from '@/components/ui/multi-select';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAuth } from '@/features/auth/auth-context';
import { named, useEntityOptions } from '@/features/masters/use-options';
import { api, downloadCsv, errorMessage, type QueryParams } from '@/lib/api';
import { formatDateTime, relativeTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { alertCenter, alertTitle } from './alert-center';
import { AlertDetailSheet } from './AlertDetailSheet';
import { SeverityIcon } from './AlertBell';
import { DateRangePicker, rangeFromPreset, type DateRangeValue } from './DateRangePicker';
import { AlertStatusBadge, SeverityBadge } from './badges';
import { SEVERITY_LABEL, STATUS_LABEL } from './severity';

const ALL = '__all';
const PAGE_SIZES = [25, 50, 100, 200];
const TYPE_OPTIONS: Option[] = ALERT_TYPES.map((t) => ({ value: t.code, label: t.label }));
const objectOption = (o: TrackedObjectDto): Option => ({ value: o.id, label: o.name, description: o.plateNumber ?? undefined });

function FilterSelect({ label, value, onChange, options }: { label: string; value: string | null; onChange: (v: string | null) => void; options: Option[] }) {
  return (
    <Select value={value ?? ALL} onValueChange={(v) => onChange(v === ALL ? null : v)}>
      <SelectTrigger className="h-9 w-auto min-w-[8.5rem]" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>All {label.toLowerCase()}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Note dialog for acknowledging one, several or all alerts. */
export function AckDialog({
  open,
  onOpenChange,
  title,
  description,
  pending,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  description: string;
  pending: boolean;
  onConfirm: (note: string) => void;
}) {
  const [note, setNote] = useState('');
  useEffect(() => {
    if (open) setNote('');
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <Textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Note (optional) — e.g. driver called, false alarm" aria-label="Note" />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={() => onConfirm(note.trim())} disabled={pending}>
            {pending ? <Spinner /> : <CheckIcon />}
            Acknowledge
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function AlertsPage() {
  const { can } = useAuth();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const canAck = can('alerts', 'edit');

  const [range, setRange] = useState<DateRangeValue>(() => rangeFromPreset('7d'));
  const [objectId, setObjectId] = useState<string | null>(params.get('objectId'));
  const [branchId, setBranchId] = useState<string | null>(null);
  const [type, setType] = useState<string | null>(params.get('type'));
  const [severity, setSeverity] = useState<string | null>(params.get('severity'));
  const [status, setStatus] = useState<string | null>(params.get('status'));
  const [search, setSearch] = useState('');
  const q = useDeferredValue(search.trim());
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [ackTarget, setAckTarget] = useState<{ ids?: string[]; label: string } | null>(null);
  const [incoming, setIncoming] = useState(0);
  const detailId = params.get('alertId');

  const [objectQ, setObjectQ] = useState('');
  const objects = useEntityOptions<TrackedObjectDto>('/objects', objectOption, { q: objectQ, enabled: can('objects') });
  const branches = useEntityOptions<BranchDto>('/branches', named, { enabled: can('branches') });

  useEffect(() => {
    setPage(1);
    setSelected(new Set());
  }, [range, objectId, branchId, type, severity, status, q, pageSize]);

  const query: QueryParams = {
    from: range.from.toISOString(),
    to: range.preset === 'custom' || range.preset === 'yesterday' ? range.to.toISOString() : undefined,
    objectId,
    branchId,
    type,
    severity,
    status,
    q,
    page,
    pageSize,
    sort: 'occurredAt',
    order: 'desc',
  };
  const list = useQuery({
    queryKey: ['alerts', 'list', query],
    queryFn: ({ signal }) => api.get<Paginated<AlertDto>>('/alerts', query, signal),
    placeholderData: keepPreviousData,
  });
  const rows = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  // New alerts arrive over the socket: show a banner instead of shifting rows under the user's cursor.
  useEffect(() => alertCenter.onAlert(() => setIncoming((n) => n + 1)), []);
  const refresh = () => {
    setIncoming(0);
    queryClient.invalidateQueries({ queryKey: ['alerts'] });
  };

  const ack = useMutation({
    mutationFn: async ({ ids, note }: { ids?: string[]; note: string }) => {
      if (ids && ids.length === 1) await alertCenter.ack(ids[0], note || undefined);
      else await alertCenter.ackAll(ids, note || undefined);
      return ids?.length;
    },
    onSuccess: (n) => {
      toast.success(n === undefined ? 'All new alerts acknowledged' : `${n} alert(s) acknowledged`);
      setAckTarget(null);
      setSelected(new Set());
      queryClient.invalidateQueries({ queryKey: ['alerts'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const [exporting, setExporting] = useState(false);
  const exportCsv = async () => {
    setExporting(true);
    try {
      await downloadCsv('/alerts', query, `alerts-${new Date().toISOString().slice(0, 10)}.csv`);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setExporting(false);
    }
  };

  const newOnPage = rows.filter((r) => r.status === 'NEW');
  const allNewSelected = newOnPage.length > 0 && newOnPage.every((r) => selected.has(r.id));
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const hasFilters = !!(objectId || branchId || type || severity || status || q || range.preset !== '7d');
  const clearFilters = () => {
    setRange(rangeFromPreset('7d'));
    setObjectId(null);
    setBranchId(null);
    setType(null);
    setSeverity(null);
    setStatus(null);
    setSearch('');
  };
  const openDetail = (id: string | null) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (id) n.set('alertId', id);
        else n.delete('alertId');
        return n;
      },
      { replace: true },
    );

  const detailFromList = useMemo(() => rows.find((r) => r.id === detailId) ?? null, [rows, detailId]);
  const colCount = canAck ? 9 : 8;

  return (
    <div className="mx-auto w-full max-w-[1400px] space-y-5 p-4 sm:p-6">
      <PageHeader
        title="Alerts"
        description="Every alert raised for vehicles in your scope. Acknowledge to clear them from the bell."
        actions={
          <>
            {can('alerts', 'export') && (
              <Button variant="outline" onClick={exportCsv} disabled={exporting}>
                {exporting ? <Spinner /> : <DownloadIcon />}
                Export CSV
              </Button>
            )}
            {canAck && (
              <Button onClick={() => setAckTarget({ label: 'all new alerts in your scope' })}>
                <CheckCheckIcon /> Acknowledge all
              </Button>
            )}
          </>
        }
      />

      <Card className="overflow-hidden">
        <div className="flex flex-col gap-3 border-b p-3 xl:flex-row xl:items-center">
          <div className="relative w-full xl:max-w-xs">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search message, vehicle, plate…" aria-label="Search alerts" className="pl-8" />
          </div>
          <div className="flex flex-1 flex-wrap items-center gap-2">
            <DateRangePicker value={range} onChange={setRange} />
            {can('objects') && (
              <div className="w-48">
                <Combobox value={objectId} onChange={setObjectId} options={objects.options} loading={objects.loading} onSearch={setObjectQ} placeholder="All vehicles" searchPlaceholder="Search vehicles…" />
              </div>
            )}
            {can('branches') && <FilterSelect label="Branches" value={branchId} onChange={setBranchId} options={branches.options} />}
            <FilterSelect label="Types" value={type} onChange={setType} options={TYPE_OPTIONS} />
            <FilterSelect label="Severities" value={severity} onChange={setSeverity} options={ALERT_SEVERITIES.map((s) => ({ value: s, label: SEVERITY_LABEL[s] }))} />
            <FilterSelect label="Statuses" value={status} onChange={setStatus} options={(['NEW', 'ACKNOWLEDGED', 'RESOLVED'] as AlertStatus[]).map((s) => ({ value: s, label: STATUS_LABEL[s] }))} />
            {hasFilters && (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                <XIcon /> Clear
              </Button>
            )}
          </div>
          {list.isFetching && !list.isPending && <Spinner className="text-muted-foreground" />}
        </div>

        {incoming > 0 && (
          <button type="button" onClick={refresh} className="flex w-full items-center justify-center gap-2 border-b bg-primary/8 px-3 py-2 text-sm font-medium text-primary hover:bg-primary/12">
            <RefreshCwIcon className="size-4" /> {incoming} new alert{incoming > 1 ? 's' : ''} — refresh
          </button>
        )}

        {selected.size > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b bg-accent/60 px-3 py-2 text-sm animate-fade-in">
            <span className="font-medium">{selected.size} selected</span>
            <span className="flex-1" />
            <Button size="sm" onClick={() => setAckTarget({ ids: [...selected], label: `${selected.size} selected alert(s)` })}>
              <CheckIcon /> Acknowledge
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          </div>
        )}

        {list.isError && (
          <div className="p-4">
            <FormError message={errorMessage(list.error)} />
          </div>
        )}

        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {canAck && (
                <TableHead className="w-10">
                  <Checkbox
                    aria-label="Select all new alerts on this page"
                    checked={allNewSelected ? true : newOnPage.some((r) => selected.has(r.id)) ? 'indeterminate' : false}
                    disabled={!newOnPage.length}
                    onCheckedChange={(v) => setSelected(v ? new Set(newOnPage.map((r) => r.id)) : new Set())}
                  />
                </TableHead>
              )}
              <TableHead>Time</TableHead>
              <TableHead>Severity</TableHead>
              <TableHead>Alert</TableHead>
              <TableHead>Vehicle</TableHead>
              <TableHead className="hidden lg:table-cell">Message</TableHead>
              <TableHead className="hidden xl:table-cell">Location</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-10">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className={cn(list.isPlaceholderData && 'opacity-60 transition-opacity')}>
            {list.isPending &&
              Array.from({ length: 8 }, (_, i) => (
                <TableRow key={i} className="hover:bg-transparent">
                  {Array.from({ length: colCount }, (_, j) => (
                    <TableCell key={j}>
                      <Skeleton className="h-4 w-full max-w-32" />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            {rows.map((a) => (
              <TableRow key={a.id} data-state={selected.has(a.id) ? 'selected' : undefined} className="cursor-pointer" onClick={() => openDetail(a.id)}>
                {canAck && (
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <Checkbox aria-label={`Select ${alertTitle(a)} for ${a.objectName}`} checked={selected.has(a.id)} disabled={a.status !== 'NEW'} onCheckedChange={() => toggle(a.id)} />
                  </TableCell>
                )}
                <TableCell className="whitespace-nowrap" title={formatDateTime(a.occurredAt)}>
                  <span className="block text-sm">{formatDateTime(a.occurredAt)}</span>
                  <span className="block text-xs text-muted-foreground">{relativeTime(a.occurredAt)}</span>
                </TableCell>
                <TableCell>
                  <SeverityBadge severity={a.severity} />
                </TableCell>
                <TableCell>
                  <span className="flex items-center gap-2 font-medium whitespace-nowrap">
                    <SeverityIcon severity={a.severity} />
                    {alertTitle(a)}
                  </span>
                </TableCell>
                <TableCell>
                  <span className="block font-medium whitespace-nowrap">{a.objectName}</span>
                  {a.plateNumber && a.plateNumber !== a.objectName && <span className="block text-xs text-muted-foreground">{a.plateNumber}</span>}
                </TableCell>
                <TableCell className="hidden lg:table-cell">
                  <span className="line-clamp-2 block max-w-[18rem] min-w-[10rem] text-sm whitespace-normal">{a.message}</span>
                </TableCell>
                <TableCell className="hidden xl:table-cell">
                  <span className="line-clamp-2 block max-w-[15rem] min-w-[9rem] text-xs whitespace-normal text-muted-foreground">{a.geofenceName ? `${a.geofenceName} · ` : ''}{a.address ?? (a.lat !== null ? `${a.lat.toFixed(5)}, ${a.lng?.toFixed(5)}` : '—')}</span>
                </TableCell>
                <TableCell>
                  <AlertStatusBadge status={a.status} />
                  {a.ackByName && <span className="mt-0.5 block text-xs whitespace-nowrap text-muted-foreground">by {a.ackByName}</span>}
                </TableCell>
                <TableCell onClick={(e) => e.stopPropagation()}>
                  {canAck && a.status === 'NEW' && (
                    <Button variant="ghost" size="icon-sm" aria-label={`Acknowledge ${alertTitle(a)}`} onClick={() => setAckTarget({ ids: [a.id], label: `${alertTitle(a)} — ${a.objectName}` })}>
                      <CheckIcon />
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {list.isSuccess && rows.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={colCount}>
                  <EmptyState
                    icon={BellIcon}
                    title={hasFilters ? 'No matching alerts' : 'No alerts in this period'}
                    description={hasFilters ? 'Try a wider date range or clear the filters.' : 'Alerts appear here as soon as vehicles trigger them.'}
                    action={
                      hasFilters ? (
                        <Button variant="outline" size="sm" onClick={clearFilters}>
                          Clear filters
                        </Button>
                      ) : undefined
                    }
                  />
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>

        <div className="flex flex-col gap-3 border-t px-3 py-2.5 text-sm sm:flex-row sm:items-center sm:justify-between">
          <p className="text-muted-foreground tabular-nums">
            {total > 0 ? `Showing ${((page - 1) * pageSize + 1).toLocaleString()}–${Math.min(total, page * pageSize).toLocaleString()} of ${total.toLocaleString()}` : 'No alerts'}
          </p>
          <div className="flex items-center gap-2">
            <Select value={String(pageSize)} onValueChange={(v) => setPageSize(Number(v))}>
              <SelectTrigger className="h-8 w-[4.5rem]" aria-label="Rows per page">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAGE_SIZES.map((s) => (
                  <SelectItem key={s} value={String(s)}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="px-1 text-muted-foreground tabular-nums">
              {page} / {pageCount}
            </span>
            <Button variant="outline" size="icon-sm" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              <ChevronLeftIcon />
            </Button>
            <Button variant="outline" size="icon-sm" aria-label="Next page" disabled={page >= pageCount} onClick={() => setPage((p) => p + 1)}>
              <ChevronRightIcon />
            </Button>
          </div>
        </div>
      </Card>

      <AlertDetailSheet alertId={detailId} initial={detailFromList} onClose={() => openDetail(null)} onAck={(a) => setAckTarget({ ids: [a.id], label: `${alertTitle(a)} — ${a.objectName}` })} />

      <AckDialog
        open={!!ackTarget}
        onOpenChange={(o) => !o && setAckTarget(null)}
        title="Acknowledge alerts"
        description={`Acknowledge ${ackTarget?.label ?? ''}. The note is saved with each alert.`}
        pending={ack.isPending}
        onConfirm={(note) => ackTarget && ack.mutate({ ids: ackTarget.ids, note })}
      />
    </div>
  );
}
