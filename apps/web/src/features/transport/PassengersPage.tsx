import type { BranchDto, PassengerDto, PoiDto } from '@veetracer/shared';
import { ArchiveIcon, ArchiveRestoreIcon, BusIcon, PencilIcon, UploadIcon, UsersRoundIcon } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import type { Option } from '@/components/ui/multi-select';
import { useAuth } from '@/features/auth/auth-context';
import { Dash, DateCell, Muted } from '@/features/masters/cells';
import { MasterPage } from '@/features/masters/MasterPage';
import type { MasterColumn, MasterFilter, MasterFormProps } from '@/features/masters/types';
import { named, useEntityOptions } from '@/features/masters/use-options';
import { errorMessage } from '@/lib/api';
import { i18n } from '@/lib/i18n';
import { AppAccessBadge, LocationBadge, RoutingConsentBadge, ToneBadge } from './passenger-ui';
import { PassengerEditor } from './PassengerEditor';
import { PassengerImportDialog } from './PassengerImportDialog';
import { PASSENGERS_ENDPOINT, useArchivePassenger, VEHICLE_SEATS_PATH } from './use-people';

function PassengerForm(props: MasterFormProps<PassengerDto>) {
  return <PassengerEditor {...props} />;
}

const poiOption = (p: PoiDto): Option => ({ value: p.id, label: p.name });

const YES_NO = (yes: string, no: string): Option[] => [
  { value: 'true', label: yes },
  { value: 'false', label: no },
];

/**
 * Passengers (menu `etms_passengers`, doc 07 §6.1): MasterPage list with site / branch / needs-location / app-access /
 * routing-consent filters and CSV export (server-side, audited). Row badges show location and consent state; the editor
 * opens full screen. DELETE on the API archives (never deletes), so the row action says Archive.
 */
export function PassengersPage() {
  const { t } = useTranslation();
  const { can, me } = useAuth();
  const [importOpen, setImportOpen] = useState(false);
  const [archiveRow, setArchiveRow] = useState<PassengerDto | null>(null);
  const [editRow, setEditRow] = useState<PassengerDto | null>(null);
  const archive = useArchivePassenger();
  const branches = useEntityOptions<BranchDto>('/branches', named, { enabled: can('branches') });
  const sites = useEntityOptions<PoiDto>('/pois', poiOption, { enabled: can('pois') });
  // Bulk import is whole-company only on the server (FORBIDDEN_GRANT otherwise).
  const canImport = can('etms_passengers', 'create') && me?.dataScope === 'COMPANY';

  const filters = useMemo<MasterFilter[]>(
    () => [
      ...(can('pois') ? [{ key: 'siteId', label: 'Office / site', options: sites.options }] : []),
      ...(can('branches') ? [{ key: 'branchId', label: 'Branches', options: branches.options }] : []),
      { key: 'needsLocation', label: 'Location', options: YES_NO('Needs location', 'Has a location') },
      { key: 'routingConsent', label: 'Routing consent', options: YES_NO('Consent given', 'No consent') },
      { key: 'appAccess', label: 'App access', options: YES_NO('Has a login', 'No login') },
    ],
    [can, sites.options, branches.options],
  );

  const columns = useMemo<MasterColumn<PassengerDto>[]>(
    () => [
      {
        id: 'displayName',
        header: 'Name',
        sortable: true,
        hideable: false,
        cell: (r) => (
          <span className="flex flex-col">
            <span className="font-medium">{r.displayName}</span>
            {r.accessibilityNeeds && <span className="text-xs text-muted-foreground">{i18n.t('Accessibility needs')}</span>}
          </span>
        ),
      },
      { id: 'employeeCode', header: 'Employee code', sortable: true, cell: (r) => <span className="font-mono text-xs">{r.employeeCode}</span> },
      { id: 'office', header: 'Office / site', cell: (r) => <Dash value={r.office?.name} /> },
      { id: 'location', header: 'Location', cell: (r) => <LocationBadge passenger={r} /> },
      { id: 'routingConsent', header: 'Routing consent', cell: (r) => <RoutingConsentBadge active={r.routingConsent} /> },
      { id: 'appAccess', header: 'App access', cell: (r) => (r.projection === 'MINIMAL' ? <Muted>—</Muted> : <AppAccessBadge access={r.appAccess} />) },
      { id: 'mobile', header: 'Mobile', cell: (r) => <Dash value={r.mobile} /> },
      { id: 'branchName', header: 'Branch', defaultHidden: true, cell: (r) => <Dash value={r.branchName} /> },
      { id: 'defaultStop', header: 'Pickup stop', defaultHidden: true, cell: (r) => <Dash value={r.defaultStop?.name} /> },
      {
        id: 'isActive',
        header: 'Status',
        cell: (r) => (r.isActive ? <ToneBadge tone="success">{i18n.t('Active')}</ToneBadge> : <ToneBadge tone="neutral" icon={ArchiveIcon}>{i18n.t('Archived')}</ToneBadge>),
      },
      { id: 'updatedAt', header: 'Updated', sortable: true, defaultHidden: true, cell: (r) => <DateCell value={r.updatedAt} relative /> },
      { id: 'createdAt', header: 'Created', sortable: true, defaultHidden: true, cell: (r) => <DateCell value={r.createdAt} /> },
    ],
    [],
  );

  const rowActions = useCallback(
    (r: PassengerDto) => {
      if (!can('etms_passengers', 'delete') || r.projection === 'MINIMAL') {
        // Providers (MINIMAL) and roles without edit still open the editor read-only from here.
        return can('etms_passengers', 'edit') ? null : (
          <DropdownMenuItem onSelect={() => setEditRow(r)}>
            <PencilIcon /> {t('Open')}
          </DropdownMenuItem>
        );
      }
      return r.isActive ? (
        <DropdownMenuItem variant="destructive" onSelect={() => setArchiveRow(r)}>
          <ArchiveIcon /> {t('Archive')}
        </DropdownMenuItem>
      ) : (
        <DropdownMenuItem onSelect={() => archive.mutate({ id: r.id, restore: true }, { onSuccess: () => toast.success(t('Passenger restored')), onError: (e) => toast.error(errorMessage(e)) })}>
          <ArchiveRestoreIcon /> {t('Restore')}
        </DropdownMenuItem>
      );
    },
    [can, t, archive],
  );

  return (
    <>
      <MasterPage<PassengerDto>
        menu="etms_passengers"
        title="Passengers"
        description="Employees who use company transport: where to pick them up, consent, and their app login."
        endpoint={PASSENGERS_ENDPOINT}
        columns={columns}
        rowLabel={(r) => r.displayName}
        filters={filters}
        defaultSort={{ id: 'displayName', desc: false }}
        Form={PassengerForm}
        bulkActions={false}
        history={false}
        canDeleteRow={() => false}
        rowActions={rowActions}
        emptyIcon={UsersRoundIcon}
        headerActions={
          <>
            {can('objects') && me?.company.features.includes('etms') && (
              <Button variant="outline" asChild>
                <Link to={VEHICLE_SEATS_PATH}>
                  <BusIcon /> <span className="hidden sm:inline">{t('Vehicle seats')}</span>
                </Link>
              </Button>
            )}
            {canImport && (
              <Button variant="outline" onClick={() => setImportOpen(true)}>
                <UploadIcon /> <span className="hidden sm:inline">{t('Import')}</span>
              </Button>
            )}
          </>
        }
      />
      {importOpen && <PassengerImportDialog open onOpenChange={setImportOpen} />}
      {editRow && <PassengerEditor record={editRow} open onOpenChange={(o) => !o && setEditRow(null)} />}
      <ConfirmDialog
        open={!!archiveRow}
        onOpenChange={(o) => !o && setArchiveRow(null)}
        title={t('Archive passenger?')}
        description={
          <>
            <span className="font-medium text-foreground">{archiveRow?.displayName}</span>{' '}
            {t('is kept with their history but no longer planned, and their app login is disabled. You can restore them later.')}
          </>
        }
        confirmLabel={t('Archive')}
        destructive
        pending={archive.isPending}
        onConfirm={() =>
          archiveRow &&
          archive.mutate(
            { id: archiveRow.id },
            {
              onSuccess: () => {
                toast.success(t('Passenger archived'));
                setArchiveRow(null);
              },
              onError: (e) => toast.error(errorMessage(e)),
            },
          )
        }
      />
    </>
  );
}
