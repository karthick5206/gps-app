import { useMutation } from '@tanstack/react-query';
import type { BranchDto, RouteDto, RouteSummaryDto } from '@veetracer/shared';
import { ArchiveIcon, ArchiveRestoreIcon, CopyIcon, RouteIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { useAuth } from '@/features/auth/auth-context';
import { DateCell, Muted } from '@/features/masters/cells';
import { useInvalidateMaster } from '@/features/masters/FormDialog';
import { MasterPage } from '@/features/masters/MasterPage';
import type { MasterColumn, MasterFilter } from '@/features/masters/types';
import { named, useEntityOptions } from '@/features/masters/use-options';
import { api, errorMessage } from '@/lib/api';
import { formatDuration } from '@/lib/format';
import { ROUTES_ENDPOINT } from './api';
import { RouteEditor } from './RouteEditor';

/** Masters → Routes (docs/routes-trips/SPEC.md §4.1, §4.5). */
export function RoutesPage() {
  const { t } = useTranslation();
  const { can, me } = useAuth();
  const invalidate = useInvalidateMaster();
  const branches = useEntityOptions<BranchDto>('/branches', named, { enabled: can('branches') });
  // ASSIGNED users can't change company-wide routes (the API answers 403); hide those actions.
  const writable = (r: RouteSummaryDto) => !(me?.dataScope === 'ASSIGNED' && r.branchId === null);

  const copy = useMutation({
    mutationFn: (r: RouteSummaryDto) => api.post<RouteDto>(`${ROUTES_ENDPOINT}/${r.id}/copy`),
    onSuccess: (created) => {
      toast.success(t('Copied as {{name}}', { name: created.name }));
      invalidate(ROUTES_ENDPOINT);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const setActive = useMutation({
    mutationFn: ({ r, isActive }: { r: RouteSummaryDto; isActive: boolean }) => api.patch<RouteDto>(`${ROUTES_ENDPOINT}/${r.id}`, { isActive }),
    onSuccess: (_, { r, isActive }) => {
      toast.success(isActive ? t('{{name}} restored', { name: r.name }) : t('{{name}} archived', { name: r.name }));
      invalidate(ROUTES_ENDPOINT);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const columns: MasterColumn<RouteSummaryDto>[] = [
    { id: 'name', header: t('Name'), sortable: true, hideable: false, cell: (r) => <span className="font-medium">{r.name}</span> },
    { id: 'code', header: t('Code'), sortable: true, cell: (r) => r.code ?? <Muted>—</Muted> },
    { id: 'stops', header: t('Stops'), className: 'tabular-nums', cell: (r) => r.stopCount },
    {
      id: 'distanceM',
      header: t('Distance (km)'),
      sortable: true,
      className: 'tabular-nums',
      cell: (r) =>
        r.distanceM === null ? (
          <Muted>{t('Straight lines')}</Muted>
        ) : (
          <span className="whitespace-nowrap" title={r.durationSec === null ? undefined : t('Drive time {{time}}', { time: formatDuration(r.durationSec) })}>
            {(r.distanceM / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })}
          </span>
        ),
    },
    { id: 'durationSec', header: t('Drive time'), defaultHidden: true, cell: (r) => (r.durationSec === null ? <Muted>—</Muted> : formatDuration(r.durationSec)) },
    { id: 'corridorM', header: t('Corridor (m)'), defaultHidden: true, className: 'tabular-nums', cell: (r) => r.corridorM },
    { id: 'schedules', header: t('Schedules'), className: 'tabular-nums', cell: (r) => (r.scheduleCount ? r.scheduleCount : <Muted>0</Muted>) },
    { id: 'isActive', header: t('Status'), cell: (r) => <Badge variant={r.isActive ? 'success' : 'muted'}>{r.isActive ? t('Active') : t('Archived')}</Badge> },
    { id: 'branchName', header: t('Owner'), cell: (r) => r.branchName ?? <Muted>{t('Company-wide')}</Muted> },
    { id: 'description', header: t('Description'), defaultHidden: true, cell: (r) => <span className="block max-w-xs truncate">{r.description ?? '—'}</span> },
    { id: 'updatedAt', header: t('Updated'), sortable: true, defaultHidden: true, cell: (r) => <DateCell value={r.updatedAt} relative /> },
  ];

  const filters: MasterFilter[] = can('branches') ? [{ key: 'branchId', label: t('Owners'), options: branches.options }] : [];

  return (
    <MasterPage
      menu="routes"
      title={t('Routes')}
      description={t('Reusable routes with ordered stops, road path, corridor and schedules that create planned trips.')}
      endpoint={ROUTES_ENDPOINT}
      columns={columns}
      rowLabel={(r) => r.name}
      filters={filters}
      defaultSort={{ id: 'name', desc: false }}
      Form={RouteEditor}
      emptyIcon={RouteIcon}
      bulkActions={false}
      canEditRow={writable}
      canDeleteRow={writable}
      rowActions={(r) => (
        <>
          {can('routes', 'create') && (
            <DropdownMenuItem onSelect={() => copy.mutate(r)} disabled={copy.isPending}>
              <CopyIcon /> {t('Copy')}
            </DropdownMenuItem>
          )}
          {can('routes', 'edit') && writable(r) && (
            <DropdownMenuItem onSelect={() => setActive.mutate({ r, isActive: !r.isActive })} disabled={setActive.isPending}>
              {r.isActive ? (
                <>
                  <ArchiveIcon /> {t('Archive')}
                </>
              ) : (
                <>
                  <ArchiveRestoreIcon /> {t('Restore')}
                </>
              )}
            </DropdownMenuItem>
          )}
        </>
      )}
    />
  );
}
