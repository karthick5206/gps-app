import type { BranchDto, PoiDto } from '@veetracer/shared';
import { MapIcon, MapPinIcon, UploadIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { useAuth } from '@/features/auth/auth-context';
import { formatRadius } from '@/features/geofences/geometry';
import { ActiveBadge, DateCell, Muted } from '@/features/masters/cells';
import { MasterPage } from '@/features/masters/MasterPage';
import type { MasterColumn, MasterFilter } from '@/features/masters/types';
import { named, useEntityOptions } from '@/features/masters/use-options';
import { POIS_ENDPOINT, usePoiCategoryOptions } from './api';
import { ExportMenu } from './ExportMenu';
import { PoiEditor } from './PoiEditor';
import { PoiImportDialog } from './PoiImportDialog';

export function PoisPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const navigate = useNavigate();
  const [importOpen, setImportOpen] = useState(false);
  const categories = usePoiCategoryOptions();
  const branches = useEntityOptions<BranchDto>('/branches', named, { enabled: can('branches') });

  const columns: MasterColumn<PoiDto>[] = [
    {
      id: 'name',
      header: t('Name'),
      sortable: true,
      hideable: false,
      cell: (r) => (
        <span className="flex items-center gap-2 font-medium">
          <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: r.color }} aria-hidden />
          {r.name}
        </span>
      ),
    },
    { id: 'category', header: t('Category'), sortable: true, cell: (r) => categories.labelOf(r.category) },
    { id: 'radiusM', header: t('Radius'), sortable: true, cell: (r) => <span className="whitespace-nowrap tabular-nums">{formatRadius(r.radiusM)}</span> },
    { id: 'coordinates', header: t('Coordinates'), cell: (r) => <span className="font-mono text-xs whitespace-nowrap text-muted-foreground">{`${r.lat.toFixed(5)}, ${r.lng.toFixed(5)}`}</span> },
    { id: 'address', header: t('Address'), cell: (r) => (r.address ? <span className="block max-w-xs truncate" title={r.address}>{r.address}</span> : <Muted>—</Muted>) },
    { id: 'branchName', header: t('Owner'), cell: (r) => r.branchName ?? <Muted>{t('Company-wide')}</Muted> },
    { id: 'description', header: t('Description'), defaultHidden: true, cell: (r) => <span className="block max-w-xs truncate">{r.description ?? '—'}</span> },
    { id: 'isActive', header: t('Status'), cell: (r) => <ActiveBadge active={r.isActive} /> },
    { id: 'updatedAt', header: t('Updated'), sortable: true, defaultHidden: true, cell: (r) => <DateCell value={r.updatedAt} relative /> },
  ];

  const filters: MasterFilter[] = [
    { key: 'category', label: t('Categories'), options: categories.options },
    ...(can('branches') ? [{ key: 'branchId', label: t('Owners'), options: branches.options }] : []),
  ];

  return (
    <>
      <MasterPage
        menu="pois"
        title={t('Points of Interest')}
        description={t('Customer sites, depots, fuel stations and other places. A stop within the radius counts as a visit.')}
        endpoint={POIS_ENDPOINT}
        columns={columns}
        rowLabel={(r) => r.name}
        filters={filters}
        defaultSort={{ id: 'name', desc: false }}
        Form={PoiEditor}
        emptyIcon={MapPinIcon}
        headerActions={
          <>
            {can('pois', 'create') && (
              <Button variant="outline" onClick={() => setImportOpen(true)}>
                <UploadIcon /> {t('Import')}
              </Button>
            )}
            {can('pois', 'export') && <ExportMenu includes={can('geofences') ? ['pois', 'all'] : ['pois']} />}
          </>
        }
        rowActions={(r) =>
          can('live_map') ? (
            <DropdownMenuItem onSelect={() => navigate(`/live?poi=${r.id}`)}>
              <MapIcon /> {t('Show on live map')}
            </DropdownMenuItem>
          ) : null
        }
      />
      <PoiImportDialog open={importOpen} onOpenChange={setImportOpen} />
    </>
  );
}
