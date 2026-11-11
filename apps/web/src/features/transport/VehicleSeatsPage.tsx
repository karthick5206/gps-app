import { TRANSPORT_VEHICLE_CATEGORIES, type TransportVehicleCategory, type TransportVehicleProfileDto, type TransportVehicleRowDto } from '@veetracer/shared';
import { BusIcon, ChevronLeftIcon, ChevronRightIcon, SaveIcon, SearchIcon } from 'lucide-react';
import { useDeferredValue, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useAuth } from '@/features/auth/auth-context';
import { ForbiddenPage } from '@/features/errors/ErrorPages';
import { errorMessage } from '@/lib/api';
import { humanize } from '@/lib/format';
import { ToneBadge } from './passenger-ui';
import { parseSeats, SEATS_MAX, SEATS_MIN } from './people-format';
import { useSaveVehicleProfile, useTransportVehicles } from './use-people';

const PAGE_SIZE = 50;
const NONE = '__none';
const ALL = '__all';

/**
 * Vehicle seats (doc 05 §2.3, 15 §4.3): the company's own vehicles with their passenger seat capacity (1–100, driver
 * excluded), wheelchair spaces and category, edited in place. One source: GET /transport/vehicles lists every own
 * vehicle in the caller's branch scope with its seat profile, or null ("Seats not set").
 */
export function VehicleSeatsPage() {
  const { t } = useTranslation();
  const { can, me } = useAuth();
  const enabled = can('objects') && !!me?.company.features.includes('etms');
  const canEdit = can('objects', 'edit');
  const [search, setSearch] = useState('');
  const q = useDeferredValue(search.trim());
  const [seatsFilter, setSeatsFilter] = useState<string>(ALL);
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [q, seatsFilter]);

  const vehicles = useTransportVehicles(
    { q: q || undefined, page, pageSize: PAGE_SIZE, sort: 'name', order: 'asc', ...(seatsFilter === ALL ? {} : { seats: seatsFilter as 'set' | 'unset' }) },
    enabled,
  );

  if (!enabled) return <ForbiddenPage />;
  const total = vehicles.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const rows = vehicles.data?.items ?? [];

  return (
    <div className="flex w-full min-w-0 flex-col gap-4 p-4 sm:p-6">
      <PageHeader title={t('Vehicle seats')} description={t('Passenger seats per vehicle (driver not counted). Route planning never puts more passengers in a vehicle than this.')} />
      <Card className="gap-0 overflow-hidden py-0">
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <div className="relative min-w-[12rem] flex-1 sm:max-w-sm">
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('Search vehicles…')} aria-label={t('Search')} className="h-9 pl-8" />
          </div>
          <Select value={seatsFilter} onValueChange={setSeatsFilter}>
            <SelectTrigger className="h-9 w-40" aria-label={t('Seats')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{t('All vehicles')}</SelectItem>
              <SelectItem value="unset">{t('Seats not set')}</SelectItem>
              <SelectItem value="set">{t('Seats set')}</SelectItem>
            </SelectContent>
          </Select>
          <span className="flex-1" />
          <span className="text-sm text-muted-foreground tabular-nums">{vehicles.isFetching ? <Spinner className="inline" /> : t('{{n}} vehicles', { n: total.toLocaleString() })}</span>
        </div>
        {vehicles.isError && (
          <div className="p-4">
            <FormError message={errorMessage(vehicles.error)} />
          </div>
        )}
        <Table>
          <TableHeader className="bg-muted">
            <TableRow className="hover:bg-transparent">
              <TableHead>{t('Vehicle')}</TableHead>
              <TableHead className="w-20">{t('Seats')}</TableHead>
              <TableHead className="w-20">{t('Wheelchair')}</TableHead>
              <TableHead className="hidden w-44 md:table-cell">{t('Category')}</TableHead>
              <TableHead className="w-12 sm:w-28">
                <span className="sr-only">{t('Actions')}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {vehicles.isPending &&
              Array.from({ length: 5 }, (_, i) => (
                <TableRow key={i} className="hover:bg-transparent">
                  <TableCell colSpan={5}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ))}
            {!vehicles.isPending &&
              rows.map((v) => <SeatRow key={v.objectId} vehicle={v} profile={v.profile} canEdit={canEdit} />)}
            {vehicles.isSuccess && rows.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5}>
                  <EmptyState icon={BusIcon} title={q ? t('No matching records') : t('No vehicles yet')} description={q ? t('Try a different search or clear the filters.') : t('Add vehicles under Masters → Objects first.')} />
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        <div className="flex items-center justify-end gap-2 border-t px-3 py-2.5 text-sm">
          <span className="px-1 text-muted-foreground tabular-nums">
            {page} / {pageCount}
          </span>
          <Button variant="outline" size="icon-sm" aria-label={t('Previous page')} disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            <ChevronLeftIcon />
          </Button>
          <Button variant="outline" size="icon-sm" aria-label={t('Next page')} disabled={page >= pageCount} onClick={() => setPage((p) => p + 1)}>
            <ChevronRightIcon />
          </Button>
        </div>
      </Card>
    </div>
  );
}

function SeatRow({ vehicle, profile, canEdit }: { vehicle: TransportVehicleRowDto; profile: TransportVehicleProfileDto | null; canEdit: boolean }) {
  const { t } = useTranslation();
  const save = useSaveVehicleProfile();
  const initial = { seats: profile ? String(profile.seats) : '', wheelchair: String(profile?.wheelchairSpaces ?? 0), category: profile?.category ?? NONE };
  const [seats, setSeats] = useState(initial.seats);
  const [wheelchair, setWheelchair] = useState(initial.wheelchair);
  const [category, setCategory] = useState(initial.category);
  useEffect(() => {
    setSeats(initial.seats);
    setWheelchair(initial.wheelchair);
    setCategory(initial.category);
  }, [profile?.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const seatsN = parseSeats(seats);
  const wheelN = /^\s*\d+\s*$/.test(wheelchair) ? Number(wheelchair) : NaN;
  const wheelValid = Number.isInteger(wheelN) && wheelN >= 0 && wheelN <= 20 && (seatsN === null || wheelN <= seatsN);
  const dirty = seats !== initial.seats || wheelchair !== initial.wheelchair || category !== initial.category;
  const seatsError = seats !== '' && seatsN === null;
  const idBase = `seat-${vehicle.objectId}`;

  const submit = () => {
    if (seatsN === null || !wheelValid) return;
    save.mutate(
      {
        objectId: vehicle.objectId,
        input: {
          seats: seatsN,
          wheelchairSpaces: wheelN,
          category: category === NONE ? null : (category as TransportVehicleCategory),
          hasAc: profile?.hasAc ?? null,
          notes: profile?.notes ?? null,
        },
      },
      {
        onSuccess: () => toast.success(t('Seats saved for {{name}}', { name: vehicle.objectName })),
        onError: (e) => toast.error(errorMessage(e)),
      },
    );
  };

  return (
    <TableRow>
      <TableCell>
        <span className="block font-medium">{vehicle.objectName}</span>
        <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          {vehicle.plateNumber && <span className="font-mono">{vehicle.plateNumber}</span>}
          {!profile && <ToneBadge tone="warning">{t('Seats not set')}</ToneBadge>}
          {!vehicle.isActive && <ToneBadge tone="neutral">{t('Inactive')}</ToneBadge>}
        </span>
        <div className="mt-1.5 md:hidden">
          <CategorySelect value={category} onChange={setCategory} disabled={!canEdit} label={t('Category for {{name}}', { name: vehicle.objectName })} />
        </div>
      </TableCell>
      <TableCell>
        <label htmlFor={`${idBase}-s`} className="sr-only">
          {t('Seats for {{name}}', { name: vehicle.objectName })}
        </label>
        <Input
          id={`${idBase}-s`}
          type="number"
          inputMode="numeric"
          min={SEATS_MIN}
          max={SEATS_MAX}
          value={seats}
          disabled={!canEdit}
          aria-invalid={seatsError || undefined}
          aria-describedby={seatsError ? `${idBase}-err` : undefined}
          onChange={(e) => setSeats(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && dirty && submit()}
          className="h-8 w-16 tabular-nums"
        />
        {seatsError && (
          <p id={`${idBase}-err`} role="alert" className="mt-1 text-xs text-destructive">
            {t('{{min}}–{{max}}', { min: SEATS_MIN, max: SEATS_MAX })}
          </p>
        )}
      </TableCell>
      <TableCell>
        <label htmlFor={`${idBase}-w`} className="sr-only">
          {t('Wheelchair spaces for {{name}}', { name: vehicle.objectName })}
        </label>
        <Input
          id={`${idBase}-w`}
          type="number"
          inputMode="numeric"
          min={0}
          max={20}
          value={wheelchair}
          disabled={!canEdit}
          aria-invalid={!wheelValid || undefined}
          onChange={(e) => setWheelchair(e.target.value)}
          className="h-8 w-16 tabular-nums"
        />
      </TableCell>
      <TableCell className="hidden md:table-cell">
        <CategorySelect value={category} onChange={setCategory} disabled={!canEdit} label={t('Category for {{name}}', { name: vehicle.objectName })} />
      </TableCell>
      <TableCell>
        {canEdit && (
          <Button size="sm" variant={dirty ? 'default' : 'outline'} onClick={submit} disabled={!dirty || seatsN === null || !wheelValid || save.isPending} aria-label={t('Save seats for {{name}}', { name: vehicle.objectName })}>
            {save.isPending ? <Spinner /> : <SaveIcon />}
            <span className="hidden sm:inline">{t('Save')}</span>
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}

function CategorySelect({ value, onChange, disabled, label }: { value: string; onChange: (v: string) => void; disabled: boolean; label: string }) {
  const { t } = useTranslation();
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger className="h-8 w-40" aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NONE}>{t('Not set')}</SelectItem>
        {TRANSPORT_VEHICLE_CATEGORIES.map((c) => (
          <SelectItem key={c} value={c}>
            {t(humanize(c))}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
