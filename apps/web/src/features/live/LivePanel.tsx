import { MOVEMENT_STATUSES, OBJECT_TYPES, STATUS_META, VEHICLE_TYPES, type LiveObject, type MovementStatus } from '@veetracer/shared';
import { DoorOpenIcon, LockIcon, SearchIcon, SearchXIcon, SnowflakeIcon, XIcon } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { StatusDot } from '@/components/status-badge';
import { Checkbox } from '@/components/ui/checkbox';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import type { Option } from '@/components/ui/multi-select';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { formatNumber, humanize, relativeTime, timeInStatus } from '@/lib/format';
import { statusColor } from '@/lib/status-tokens';
import { cn } from '@/lib/utils';
import type { LiveFilters } from './filters';
import { VirtualList } from './VirtualList';

const ROW_HEIGHT = 64;
const ALL = '__all';

const TYPE_OPTIONS: Option[] = [
  ...VEHICLE_TYPES.map((t) => ({ value: `vt:${t}`, label: humanize(t) })),
  ...OBJECT_TYPES.filter((t) => t !== 'VEHICLE').map((t) => ({ value: `ot:${t}`, label: humanize(t) })),
];

function FilterSelect({
  label,
  allLabel,
  value,
  options,
  onChange,
}: {
  label: string;
  allLabel: string;
  value: string | null;
  options: Option[];
  onChange: (v: string | null) => void;
}) {
  return (
    <Select value={value ?? ALL} onValueChange={(v) => onChange(v === ALL ? null : v)}>
      <SelectTrigger aria-label={label} className="h-8 min-w-0 flex-1 px-2.5 text-xs">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{allLabel}</SelectItem>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

const ObjectRow = memo(function ObjectRow({
  o,
  now,
  active,
  checked,
  onPick,
  onToggle,
}: {
  o: LiveObject;
  now: number;
  active: boolean;
  checked: boolean;
  onPick: (id: string) => void;
  onToggle: (id: string) => void;
}) {
  const { t } = useTranslation();
  const since = timeInStatus(t(STATUS_META[o.status].label), o.statusSince, now);
  return (
    <div
      className={cn(
        'mx-2 flex h-[60px] items-center gap-2.5 rounded-lg px-2 transition-colors',
        active ? 'bg-accent ring-1 ring-primary/30' : 'hover:bg-muted/70',
      )}
    >
      <Checkbox checked={checked} onCheckedChange={() => onToggle(o.objectId)} aria-label={t('Select {{name}}', { name: o.name })} />
      <button type="button" onClick={() => onPick(o.objectId)} className="flex min-w-0 flex-1 items-center gap-2.5 text-left outline-none focus-visible:underline">
        <StatusDot status={o.status} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{o.name}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {o.plateNumber ?? o.uniqueId ?? '—'}
            {o.status !== 'NO_DATA' && <> · <span className="tabular-nums">{Math.round(o.speedKph)} km/h</span></>}
            {o.acOn ? <SnowflakeIcon className="ms-1.5 inline size-3 text-sky-600" aria-label={t('AC on')} /> : null}
            {o.doorOpen ? <DoorOpenIcon className="ms-1 inline size-3 text-amber-600" aria-label={t('Door open')} /> : null}
          </span>
        </span>
        {o.licenceLocked ? (
          <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-destructive" title={t('Licence expired — renew to view')}>
            <LockIcon className="size-3.5" />
            {t('Licence expired')}
          </span>
        ) : (
          <span className="shrink-0 text-right">
            <span className="block text-xs font-medium" style={{ color: statusColor(o.status) }}>
              {since ?? t(STATUS_META[o.status].label)}
            </span>
            <span className="block text-[11px] text-muted-foreground">{relativeTime(o.serverTime, now)}</span>
          </span>
        )}
      </button>
    </div>
  );
});

export function LivePanel({
  loading,
  items,
  counts,
  filters,
  onFiltersChange,
  selected,
  onToggleSelected,
  onClearSelected,
  activeId,
  onPick,
  branchOptions,
  groupOptions,
  now,
  className,
}: {
  loading: boolean;
  items: LiveObject[];
  counts: Record<MovementStatus, number> & { total: number };
  filters: LiveFilters;
  onFiltersChange: (patch: Partial<LiveFilters>) => void;
  selected: Set<string>;
  onToggleSelected: (id: string) => void;
  onClearSelected: () => void;
  activeId: string | null;
  onPick: (id: string) => void;
  branchOptions: Option[] | null;
  groupOptions: Option[] | null;
  now: number;
  className?: string;
}) {
  const { t } = useTranslation();
  const toggleStatus = (s: MovementStatus) =>
    onFiltersChange({ statuses: filters.statuses.includes(s) ? filters.statuses.filter((x) => x !== s) : [...filters.statuses, s] });

  return (
    <div className={cn('flex min-h-0 flex-col overflow-hidden rounded-xl border bg-card/95 shadow-lg backdrop-blur', className)}>
      <div className="space-y-3 border-b p-3">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filters.q}
            onChange={(e) => onFiltersChange({ q: e.target.value })}
            placeholder={t('Search name, plate or IMEI')}
            aria-label={t('Search objects')}
            className="h-9 pr-8 pl-8"
          />
          {filters.q && (
            <button type="button" aria-label={t('Clear search')} onClick={() => onFiltersChange({ q: '' })} className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-accent">
              <XIcon className="size-3.5" />
            </button>
          )}
        </div>

        <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('Filter by status')}>
          <button
            type="button"
            aria-pressed={filters.statuses.length === 0}
            onClick={() => onFiltersChange({ statuses: [] })}
            className={cn(
              'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
              filters.statuses.length === 0 ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-muted',
            )}
          >
            {t('All')} <span className="tabular-nums opacity-80">{formatNumber(counts.total)}</span>
          </button>
          {MOVEMENT_STATUSES.map((s) => {
            const on = filters.statuses.includes(s);
            return (
              <button
                key={s}
                type="button"
                aria-pressed={on}
                onClick={() => toggleStatus(s)}
                className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors', !on && 'hover:bg-muted')}
                style={on ? { borderColor: statusColor(s), backgroundColor: `color-mix(in oklab, ${statusColor(s)} 15%, transparent)` } : undefined}
              >
                <StatusDot status={s} className="size-2" />
                {t(STATUS_META[s].label)}
                <span className="text-muted-foreground tabular-nums">{formatNumber(counts[s])}</span>
              </button>
            );
          })}
        </div>

        <div className="flex gap-2">
          {branchOptions && <FilterSelect label={t('Branches')} allLabel={t('All branches')} value={filters.branchId} options={branchOptions} onChange={(branchId) => onFiltersChange({ branchId })} />}
          {groupOptions && <FilterSelect label={t('Groups')} allLabel={t('All groups')} value={filters.groupId} options={groupOptions} onChange={(groupId) => onFiltersChange({ groupId })} />}
          <FilterSelect
            label={t('Types')}
            allLabel={t('All types')}
            value={filters.type}
            options={TYPE_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))}
            onChange={(type) => onFiltersChange({ type })}
          />
        </div>

        <div className="flex h-6 items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="tabular-nums">
            {t('{{n}} shown', { n: formatNumber(items.length) })}
            {selected.size > 0 && <> · {t('{{n}} selected', { n: formatNumber(selected.size) })}</>}
          </span>
          {selected.size > 0 && (
            <span className="flex items-center gap-2">
              <label className="flex items-center gap-1.5">
                <Switch checked={filters.selectedOnly} onCheckedChange={(selectedOnly) => onFiltersChange({ selectedOnly })} className="scale-90" />
                {t('Selected only')}
              </label>
              <button type="button" onClick={onClearSelected} className="font-medium text-primary hover:underline">
                {t('Clear')}
              </button>
            </span>
          )}
        </div>
      </div>

      {loading ? (
        <div className="space-y-2 p-3" aria-busy>
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState icon={SearchXIcon} title={t('No objects match')} description={t('Try clearing the search or filters.')} className="flex-1" />
      ) : (
        <VirtualList
          label={t('Objects')}
          items={items}
          rowHeight={ROW_HEIGHT}
          getKey={(o) => o.objectId}
          className="min-h-0 flex-1 py-1"
          renderRow={(o) => (
            <ObjectRow o={o} now={now} active={o.objectId === activeId} checked={selected.has(o.objectId)} onPick={onPick} onToggle={onToggleSelected} />
          )}
        />
      )}
    </div>
  );
}
