import { useMutation, useQuery } from '@tanstack/react-query';
import type { DocumentDto, DriverDto, ServiceReminderDto, ServiceStatus, TrackedObjectDto } from '@veetracer/shared';
import { CheckCheckIcon, DownloadIcon, FileTextIcon, MoreHorizontalIcon, PencilIcon, PlusIcon, SearchIcon, Trash2Icon, WrenchIcon } from 'lucide-react';
import { useDeferredValue, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAuth } from '@/features/auth/auth-context';
import { Dash, DateCell, Muted } from '@/features/masters/cells';
import { MasterPage } from '@/features/masters/MasterPage';
import type { MasterColumn, MasterFilter } from '@/features/masters/types';
import { named, useEntityOptions } from '@/features/masters/use-options';
import { api, errorMessage } from '@/lib/api';
import { i18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { DocumentForm, downloadDocument, MarkDoneDialog, ServiceForm, useInvalidateCompliance } from './forms';
import { DOCUMENT_STATUS_OPTIONS, DOCUMENTS_ENDPOINT, DocumentStatusBadge, formatKm, SERVICE_STATUS_OPTIONS, SERVICES_ENDPOINT, ServiceStatusBadge, useDocumentTypeOptions } from './status';

type Tab = 'documents' | 'service';

const objectOption = (o: TrackedObjectDto) => ({ value: o.id, label: o.name, description: o.plateNumber ?? undefined });

/** Documents | Service switch shown in both views' headers. */
function TabSwitch({ tab, onChange }: { tab: Tab; onChange: (tab: Tab) => void }) {
  const { t } = useTranslation();
  return (
    <div role="tablist" aria-label={t('View')} className="inline-flex h-9 items-center rounded-lg bg-muted p-0.5">
      {(
        [
          ['documents', 'Documents', FileTextIcon],
          ['service', 'Service', WrenchIcon],
        ] as const
      ).map(([key, label, Icon]) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={tab === key}
          onClick={() => onChange(key)}
          className={cn(
            'inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground [&_svg]:size-4',
            tab === key && 'bg-background text-foreground shadow-xs',
          )}
        >
          <Icon /> {t(label)}
        </button>
      ))}
    </div>
  );
}

function DocumentsView({ tabs }: { tabs: React.ReactNode }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const types = useDocumentTypeOptions();
  const objects = useEntityOptions<TrackedObjectDto>('/objects', objectOption, { enabled: can('objects') });
  const drivers = useEntityOptions<DriverDto>('/drivers', named, { enabled: can('drivers') });
  const columns = useMemo<MasterColumn<DocumentDto>[]>(
    () => [
      { id: 'type', header: 'Document', sortable: true, hideable: false, cell: (r) => <span className="font-medium">{types.labelOf(r.type)}</span> },
      { id: 'number', header: 'Number', sortable: true, cell: (r) => (r.number ? <span className="font-mono text-xs">{r.number}</span> : <Muted>—</Muted>) },
      {
        id: 'objectName',
        header: 'Vehicle / driver',
        sortable: true,
        cell: (r) =>
          r.driverId ? (
            <span className="flex flex-col">
              <span>{r.driverName}</span>
              <span className="text-xs text-muted-foreground">{i18n.t('Driver')}</span>
            </span>
          ) : (
            <span className="flex flex-col">
              <span>{r.objectName}</span>
              {r.plateNumber && <span className="text-xs text-muted-foreground">{r.plateNumber}</span>}
            </span>
          ),
      },
      { id: 'issuedOn', header: 'Issued on', sortable: true, defaultHidden: true, cell: (r) => <Dash value={r.issuedOn} /> },
      { id: 'expiresOn', header: 'Expires on', sortable: true, cell: (r) => <span className="tabular-nums">{r.expiresOn ?? '—'}</span> },
      { id: 'status', header: 'Status', cell: (r) => <DocumentStatusBadge status={r.status} daysLeft={r.daysLeft} /> },
      { id: 'reminderDays', header: 'Remind before', defaultHidden: true, cell: (r) => i18n.t('{{n}} days', { n: r.reminderDays }) },
      {
        id: 'file',
        header: 'File',
        cell: (r) =>
          r.file ? (
            <Button variant="link" size="sm" className="h-auto max-w-48 p-0" title={r.file.name} onClick={() => void downloadDocument(r)}>
              <DownloadIcon /> <span className="truncate">{r.file.name}</span>
            </Button>
          ) : (
            <Muted>—</Muted>
          ),
      },
      { id: 'notes', header: 'Notes', defaultHidden: true, cell: (r) => <span className="block max-w-xs truncate">{r.notes ?? '—'}</span> },
      { id: 'createdAt', header: 'Created', sortable: true, defaultHidden: true, cell: (r) => <DateCell value={r.createdAt} /> },
    ],
    [types],
  );
  const filters = useMemo<MasterFilter[]>(
    () => [
      { key: 'expiry', label: 'Status', options: DOCUMENT_STATUS_OPTIONS },
      { key: 'type', label: 'Document', options: types.options },
      {
        key: 'owner',
        label: 'Belongs to',
        options: [
          { value: 'VEHICLE', label: 'Vehicles' },
          { value: 'DRIVER', label: 'Drivers' },
        ],
      },
      ...(can('objects') ? [{ key: 'objectId', label: 'Vehicle', options: objects.options }] : []),
      ...(can('drivers') ? [{ key: 'driverId', label: 'Driver', options: drivers.options }] : []),
    ],
    [types.options, can, objects.options, drivers.options],
  );
  return (
    <MasterPage
      menu="documents"
      title="Documents"
      description="RC, insurance, PUC, permits, licences… with expiry reminders sent as alerts."
      endpoint={DOCUMENTS_ENDPOINT}
      columns={columns}
      rowLabel={(r) => `${types.labelOf(r.type)} · ${r.objectName ?? r.driverName ?? ''}`}
      filters={filters}
      statusFilter={false}
      defaultSort={{ id: 'expiresOn', desc: false }}
      Form={DocumentForm}
      emptyIcon={FileTextIcon}
      headerActions={tabs}
      rowActions={(r) =>
        r.file ? (
          <DropdownMenuItem onSelect={() => void downloadDocument(r)}>
            <DownloadIcon /> {t('Download file')}
          </DropdownMenuItem>
        ) : null
      }
    />
  );
}

function ServiceView({ tabs }: { tabs: React.ReactNode }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const invalidate = useInvalidateCompliance();
  const [search, setSearch] = useState('');
  const q = useDeferredValue(search.trim());
  const [due, setDue] = useState<ServiceStatus | null>(null);
  const [form, setForm] = useState<ServiceReminderDto | null | undefined>(undefined);
  const [doneFor, setDoneFor] = useState<ServiceReminderDto | null>(null);
  const [deleting, setDeleting] = useState<ServiceReminderDto | null>(null);
  const list = useQuery({
    queryKey: ['service-reminders', 'all', q],
    queryFn: ({ signal }) => api.get<ServiceReminderDto[]>(SERVICES_ENDPOINT, { q }, signal),
  });
  const counts = useMemo(() => {
    const c: Record<ServiceStatus, number> = { OK: 0, DUE_SOON: 0, OVERDUE: 0 };
    for (const r of list.data ?? []) if (r.isActive) c[r.status]++;
    return c;
  }, [list.data]);
  const rows = (list.data ?? []).filter((r) => !due || (r.isActive && r.status === due));
  const remove = useMutation({
    mutationFn: (r: ServiceReminderDto) => api.delete(`${SERVICES_ENDPOINT}/${r.id}`),
    onSuccess: () => {
      toast.success(t('Service reminder deleted'));
      setDeleting(null);
      invalidate();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <div className="flex h-full min-h-[560px] w-full flex-col gap-4 p-4 sm:p-6">
      <PageHeader
        title={t('Service reminders')}
        description={t('Periodic maintenance by date and / or odometer. Mark a service done to log it and roll the reminder forward.')}
        actions={
          <>
            {tabs}
            {can('documents', 'create') && (
              <Button onClick={() => setForm(null)}>
                <PlusIcon /> {t('Add')}
              </Button>
            )}
          </>
        }
      />
      <Card className="flex min-h-0 flex-1 flex-col gap-0 overflow-hidden py-0">
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <div className="relative min-w-[12rem] flex-1 sm:max-w-sm">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('Search vehicle or service…')} aria-label={t('Search')} className="h-9 pl-8" />
          </div>
          <div role="radiogroup" aria-label={t('Status')} className="inline-flex h-9 items-center rounded-lg bg-muted p-0.5">
            {[{ value: null, label: 'All' } as const, ...SERVICE_STATUS_OPTIONS].map((o) => (
              <button
                key={o.label}
                type="button"
                role="radio"
                aria-checked={due === o.value}
                onClick={() => setDue(o.value)}
                className={cn('h-8 rounded-md px-3 text-sm font-medium text-muted-foreground hover:text-foreground', due === o.value && 'bg-background text-foreground shadow-xs')}
              >
                {t(o.label)}
                {o.value && counts[o.value] > 0 && <span className="ml-1 tabular-nums">({counts[o.value]})</span>}
              </button>
            ))}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {list.isLoading ? (
            <Skeleton className="m-4 h-40" />
          ) : list.isError ? (
            <p className="p-4 text-sm text-destructive">{errorMessage(list.error)}</p>
          ) : !rows.length ? (
            <EmptyState icon={WrenchIcon} title={t('No service reminders')} description={can('documents', 'create') ? t('Add reminders such as engine oil every 10,000 km or 6 months.') : undefined} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('Vehicle')}</TableHead>
                  <TableHead>{t('Service')}</TableHead>
                  <TableHead>{t('Interval')}</TableHead>
                  <TableHead>{t('Last done')}</TableHead>
                  <TableHead>{t('Next due')}</TableHead>
                  <TableHead>{t('Odometer')}</TableHead>
                  <TableHead>{t('Status')}</TableHead>
                  <TableHead className="w-10">
                    <span className="sr-only">{t('Actions')}</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell>
                      <span className="flex flex-col">
                        <span className="font-medium">{r.objectName}</span>
                        {r.plateNumber && <span className="text-xs text-muted-foreground">{r.plateNumber}</span>}
                        {r.inMaintenance && (
                          <Badge variant="warning" className="mt-1">
                            {t('In maintenance')}
                          </Badge>
                        )}
                      </span>
                    </TableCell>
                    <TableCell>{r.title}</TableCell>
                    <TableCell className="text-sm tabular-nums">
                      {[r.intervalKm ? formatKm(r.intervalKm) : null, r.intervalDays ? t('{{n}} days', { n: r.intervalDays }) : null].filter(Boolean).join(' / ')}
                    </TableCell>
                    <TableCell className="text-sm tabular-nums">{[r.lastDoneAt, r.lastDoneOdometerKm !== null ? formatKm(r.lastDoneOdometerKm) : null].filter(Boolean).join(' · ') || '—'}</TableCell>
                    <TableCell className="text-sm tabular-nums">{[r.dueAt, r.dueOdometerKm !== null ? formatKm(r.dueOdometerKm) : null].filter(Boolean).join(' · ') || '—'}</TableCell>
                    <TableCell className="text-sm tabular-nums">{formatKm(r.odometerKm)}</TableCell>
                    <TableCell>{r.isActive ? <ServiceStatusBadge status={r.status} daysLeft={r.daysLeft} kmLeft={r.kmLeft} /> : <Badge variant="muted">{t('Inactive')}</Badge>}</TableCell>
                    <TableCell>
                      {(can('documents', 'edit') || can('documents', 'delete')) && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon-sm" aria-label={t('Actions')}>
                              <MoreHorizontalIcon />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            {can('documents', 'edit') && (
                              <>
                                <DropdownMenuItem onSelect={() => setDoneFor(r)}>
                                  <CheckCheckIcon /> {t('Mark done')}
                                </DropdownMenuItem>
                                <DropdownMenuItem onSelect={() => setForm(r)}>
                                  <PencilIcon /> {t('Edit')}
                                </DropdownMenuItem>
                              </>
                            )}
                            {can('documents', 'delete') && (
                              <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(r)}>
                                <Trash2Icon /> {t('Delete')}
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </Card>
      {form !== undefined && <ServiceForm record={form} open onOpenChange={(o) => !o && setForm(undefined)} />}
      <MarkDoneDialog reminder={doneFor} onOpenChange={(o) => !o && setDoneFor(null)} />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        title={t('Delete service reminder?')}
        description={t('Its service history is kept.')}
        confirmLabel={t('Delete')}
        destructive
        pending={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </div>
  );
}

export function DocumentsPage() {
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('tab') === 'service' ? 'service' : 'documents';
  const tabs = <TabSwitch tab={tab} onChange={(next) => setParams(next === 'service' ? { tab: 'service' } : {}, { replace: true })} />;
  return tab === 'service' ? <ServiceView tabs={tabs} /> : <DocumentsView tabs={tabs} />;
}
