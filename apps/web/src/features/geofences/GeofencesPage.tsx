import type { BranchDto, GeofenceDto, GeofenceMode } from '@veetracer/shared';
import { BellOffIcon, CircleIcon, HexagonIcon, MapIcon, SquareIcon, UploadIcon } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { useAuth } from '@/features/auth/auth-context';
import { ActiveBadge, DateCell, Muted } from '@/features/masters/cells';
import { MasterPage } from '@/features/masters/MasterPage';
import type { MasterColumn, MasterFilter } from '@/features/masters/types';
import { named, useEntityOptions } from '@/features/masters/use-options';
import { GEOFENCES_ENDPOINT, MODE_LABEL, useCategoryOptions } from './api';
import { GeofenceEditor } from './GeofenceEditor';
import { areaM2, formatArea, formatRadius } from './geometry';
import { formatWindows } from './time-windows';
import { ImportDialog } from './ImportDialog';

const MODE_VARIANT: Record<GeofenceMode, 'secondary' | 'destructive' | 'warning'> = { NORMAL: 'secondary', NO_GO: 'destructive', KEEP_IN: 'warning' };

function ShapeCell({ g }: { g: GeofenceDto }) {
  const geo = g.geometry;
  const Icon = geo.type === 'CIRCLE' ? CircleIcon : geo.type === 'RECTANGLE' ? SquareIcon : HexagonIcon;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <Icon className="size-4 shrink-0" style={{ color: g.color }} aria-hidden />
      <span className="text-muted-foreground">{geo.type === 'CIRCLE' ? formatRadius(geo.radiusM) : formatArea(areaM2(geo))}</span>
    </span>
  );
}

function AppliesCell({ g }: { g: GeofenceDto }) {
  const a = g.appliesTo;
  if (a.all) return <Muted>All vehicles</Muted>;
  const parts = [
    a.branchIds.length && `${a.branchIds.length} branch${a.branchIds.length > 1 ? 'es' : ''}`,
    a.groupIds.length && `${a.groupIds.length} group${a.groupIds.length > 1 ? 's' : ''}`,
    a.objectIds.length && `${a.objectIds.length} vehicle${a.objectIds.length > 1 ? 's' : ''}`,
  ].filter(Boolean);
  return <span className="whitespace-nowrap">{parts.join(', ')}</span>;
}

const MODE_FILTER = (['NORMAL', 'NO_GO', 'KEEP_IN'] as GeofenceMode[]).map((m) => ({ value: m, label: MODE_LABEL[m] }));

export function GeofencesPage() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [importOpen, setImportOpen] = useState(false);
  const categories = useCategoryOptions();
  const branches = useEntityOptions<BranchDto>('/branches', named, { enabled: can('branches') });

  const columns: MasterColumn<GeofenceDto>[] = [
    {
      id: 'name',
      header: 'Name',
      sortable: true,
      hideable: false,
      cell: (r) => (
        <span className="flex items-center gap-2 font-medium">
          <span className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: r.color }} aria-hidden />
          {r.name}
        </span>
      ),
    },
    { id: 'shape', header: 'Shape', cell: (r) => <ShapeCell g={r} /> },
    { id: 'category', header: 'Category', sortable: true, cell: (r) => categories.labelOf(r.category) },
    { id: 'mode', header: 'Mode', cell: (r) => <Badge variant={MODE_VARIANT[r.mode]}>{MODE_LABEL[r.mode]}</Badge> },
    {
      id: 'notify',
      header: 'Alerts',
      cell: (r) =>
        !r.notifyEnter && !r.notifyExit ? (
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <BellOffIcon className="size-3.5" /> Off
          </span>
        ) : (
          <span className="whitespace-nowrap">{[r.notifyEnter && 'Entry', r.notifyExit && 'Exit'].filter(Boolean).join(' + ')}</span>
        ),
    },
    { id: 'rules', header: 'Limits', defaultHidden: true, cell: (r) => [r.maxStayMin && `Stay ≤ ${r.maxStayMin} min`, r.speedLimitKph && `≤ ${r.speedLimitKph} km/h`].filter(Boolean).join(' · ') || <Muted>—</Muted> },
    { id: 'timeWindows', header: 'Active hours', defaultHidden: true, cell: (r) => <span className="block max-w-56 truncate">{formatWindows(r.timeWindows)}</span> },
    { id: 'branchName', header: 'Owner', cell: (r) => r.branchName ?? <Muted>Company-wide</Muted> },
    { id: 'appliesTo', header: 'Applies to', cell: (r) => <AppliesCell g={r} /> },
    { id: 'address', header: 'Address', defaultHidden: true, cell: (r) => <span className="block max-w-xs truncate">{r.address ?? '—'}</span> },
    { id: 'isActive', header: 'Status', cell: (r) => <ActiveBadge active={r.isActive} /> },
    { id: 'updatedAt', header: 'Updated', sortable: true, defaultHidden: true, cell: (r) => <DateCell value={r.updatedAt} relative /> },
  ];

  const filters: MasterFilter[] = [
    { key: 'category', label: 'Categories', options: categories.options },
    { key: 'mode', label: 'Modes', options: MODE_FILTER },
    ...(can('branches') ? [{ key: 'branchId', label: 'Owners', options: branches.options }] : []),
  ];

  return (
    <>
      <MasterPage
        menu="geofences"
        title="Geofences"
        description="Zones that raise entry, exit, stay and zone-speed alerts. Draw circles, polygons or rectangles on the map."
        endpoint={GEOFENCES_ENDPOINT}
        columns={columns}
        rowLabel={(r) => r.name}
        filters={filters}
        defaultSort={{ id: 'name', desc: false }}
        Form={GeofenceEditor}
        emptyIcon={HexagonIcon}
        headerActions={
          can('geofences', 'create') ? (
            <Button variant="outline" onClick={() => setImportOpen(true)}>
              <UploadIcon /> Import
            </Button>
          ) : null
        }
        rowActions={(r) =>
          can('live_map') ? (
            <DropdownMenuItem onSelect={() => navigate(`/live?geofence=${r.id}`)}>
              <MapIcon /> Show on live map
            </DropdownMenuItem>
          ) : null
        }
      />
      <ImportDialog open={importOpen} onOpenChange={setImportOpen} />
    </>
  );
}
