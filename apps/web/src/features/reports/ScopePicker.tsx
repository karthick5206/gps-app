import type { BranchDto, LiveObject, ReportScope, TrackedObjectDto, VehicleGroupDto } from '@veetracer/shared';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Field } from '@/components/ui/field';
import { MultiSelect, type Option } from '@/components/ui/multi-select';
import { useAuth } from '@/features/auth/auth-context';
import { liveStore } from '@/features/live/live-store';
import { named, useEntityOptions } from '@/features/masters/use-options';
import { cn } from '@/lib/utils';

const objectOption = (o: TrackedObjectDto): Option => ({ value: o.id, label: o.name, description: o.plateNumber ?? undefined });
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Vehicles: `/objects` search when the user has the Objects master, else the live snapshot (all objects in scope). */
function useScopeVehicles(q: string) {
  const { can } = useAuth();
  const viaMaster = can('objects');
  const viaLive = !viaMaster && can('live_map');
  const remote = useEntityOptions<TrackedObjectDto>('/objects', objectOption, { q, enabled: viaMaster });
  const version = useSyncExternalStore((cb) => liveStore.subscribe(() => cb()), () => liveStore.getVersion());
  useEffect(() => {
    if (viaLive && !liveStore.snapshotLoaded) liveStore.loadSnapshot().catch(() => undefined);
  }, [viaLive]);
  const live = useMemo(() => {
    void version;
    return liveStore
      .all()
      .map((o: LiveObject): Option => ({ value: o.objectId, label: o.name, description: o.plateNumber ?? undefined }))
      .sort((a, b) => collator.compare(a.label, b.label));
  }, [version]);
  if (viaMaster) return { available: true, options: remote.options, loading: remote.loading, onSearch: true };
  if (viaLive) return { available: true, options: live, loading: !liveStore.snapshotLoaded, onSearch: false };
  return { available: false, options: [] as Option[], loading: false, onSearch: false };
}

export const EMPTY_SCOPE: ReportScope = { branchIds: [], groupIds: [], objectIds: [] };

/** Branches / vehicle groups / vehicles multi-selects (each shown only if the user may list it). Empty = all in scope. */
export function ScopePicker({
  value,
  onChange,
  className,
  knownObjects,
}: {
  value: ReportScope;
  onChange: (scope: ReportScope) => void;
  className?: string;
  knownObjects?: Option[];
}) {
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const branches = useEntityOptions<BranchDto>('/branches', named, { enabled: can('branches') });
  const groups = useEntityOptions<VehicleGroupDto>('/vehicle-groups', named, { enabled: can('vehicle_groups') });
  const vehicles = useScopeVehicles(q);
  return (
    <div className={cn('grid gap-3 sm:grid-cols-3', className)}>
      {can('branches') && (
        <Field label="Branches">
          <MultiSelect value={value.branchIds} onChange={(branchIds) => onChange({ ...value, branchIds })} options={branches.options} loading={branches.loading} placeholder="All branches" />
        </Field>
      )}
      {can('vehicle_groups') && (
        <Field label="Vehicle groups">
          <MultiSelect value={value.groupIds} onChange={(groupIds) => onChange({ ...value, groupIds })} options={groups.options} loading={groups.loading} placeholder="All groups" />
        </Field>
      )}
      {vehicles.available && (
        <Field label="Vehicles">
          <MultiSelect
            value={value.objectIds}
            onChange={(objectIds) => onChange({ ...value, objectIds })}
            options={vehicles.options}
            loading={vehicles.loading}
            onSearch={vehicles.onSearch ? setQ : undefined}
            selectedOptions={knownObjects}
            placeholder="All vehicles"
            searchPlaceholder="Search name or plate…"
          />
        </Field>
      )}
    </div>
  );
}
