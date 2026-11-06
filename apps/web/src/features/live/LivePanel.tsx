import { OBJECT_TYPES, STATUS_META, displayStatus, displayStatusLabel, personActivity, VEHICLE_TYPES, type LiveObject, type MovementStatus, type VehicleDayStatsDto } from '@veetracer/shared';
import { ChevronDownIcon, ChevronUpIcon, DoorOpenIcon, LockIcon, SearchIcon, SearchXIcon, SnowflakeIcon, XIcon } from 'lucide-react';
import { memo, useState } from 'react';
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
import { storage } from '@/lib/storage';
import { cn } from '@/lib/utils';
import { useAllCompaniesView, useCompanyNames } from '@/features/platform/all-companies';
import { ChargeIcon, RowDayLine, useDayStats } from './day-stats';
import type { LiveFilters } from './filters';
import { StatusCards } from './StatusCards';
import { VirtualList } from './VirtualList';

const ROW_HEIGHT = 64;
/** Rows with the address and today's figures (List → "Today's figures"). */
const ROW_HEIGHT_DETAILED = 92;
const DETAILS_KEY = 'vt.live.rowDetails';

function readDetails(): boolean {
  try {
    return localStorage.getItem(DETAILS_KEY) !== '0';
  } catch {
    return true;
  }
}
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
  company,
  stats,
  details,
}: {
  o: LiveObject;
  now: number;
  /** Today's figures (shown when `details`). */
  stats?: VehicleDayStatsDto;
  details: boolean;
  /** Company name, shown while the Super Admin views all companies. */
  company?: string;
  active: boolean;
  checked: boolean;
  onPick: (id: string) => void;
  onToggle: (id: string) => void;
}) {
  const { t } = useTranslation();
  // People show their activity (from speed) without a duration: the stored status changes don't match activity changes.
  const activity = personActivity(o);
  const shown = displayStatus(o);
  const since = activity ? null : timeInStatus(t(STATUS_META[o.status].label), o.statusSince, now);
  return (
    <div
      className={cn(
        'mx-2 flex items-center gap-2.5 rounded-lg px-2 transition-colors',
        details ? 'h-[88px]' : 'h-[60px]',
        active ? 'bg-accent ring-1 ring-primary/30' : 'hover:bg-muted/70',
      )}
    >
      <Checkbox checked={checked} onCheckedChange={() => onToggle(o.objectId)} aria-label={t('Select {{name}}', { name: o.name })} />
      <button type="button" onClick={() => onPick(o.objectId)} className="flex min-w-0 flex-1 items-center gap-2.5 text-left outline-none focus-visible:underline">
        <StatusDot status={shown} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{o.name}</span>
          <span className="block truncate text-xs text-muted-foreground">
            {company && <span className="font-medium text-foreground/80">{company} · </span>}
            {o.shared && <span className="font-medium text-foreground/80">{t('Shared')} · </span>}
            {o.plateNumber ?? o.uniqueId ?? '—'}
            {o.status !== 'NO_DATA' && <> · <span className="tabular-nums">{Math.round(o.speedKph)} km/h</span></>}
            {o.acOn ? <SnowflakeIcon className="ms-1.5 inline size-3 text-info" aria-label={t('AC on')} /> : null}
            {o.doorOpen ? <DoorOpenIcon className="ms-1 inline size-3 text-warning" aria-label={t('Door open')} /> : null}
            <ChargeIcon o={o} />
          </span>
          {details && !o.licenceLocked && <RowDayLine o={o} s={stats} />}
        </span>
        {o.licenceLocked ? (
          <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-destructive" title={t('Licence expired — renew to view')}>
            <LockIcon className="size-3.5" />
            {t('Licence expired')}
          </span>
        ) : (
          <span className={cn('shrink-0 text-right', details && 'self-start pt-2')}>
            <span className="block text-xs font-medium" style={{ color: statusColor(shown) }}>
              {since ?? t(displayStatusLabel(o))}
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
  const allCompanies = useAllCompaniesView();
  const companyNames = useCompanyNames(allCompanies);
  const [details, setDetailsState] = useState(readDetails);
  const setDetails = (on: boolean) => {
    setDetailsState(on);
    try {
      localStorage.setItem(DETAILS_KEY, on ? '1' : '0');
    } catch {
      /* private window: the choice lasts for this page only */
    }
  };
  // Folded down to the search bar and a one-line summary, so the map gets the space; remembered in this browser.
  const [collapsed, setCollapsedState] = useState(() => storage.get('vt.live.panelCollapsed') === '1');
  const setCollapsed = (v: boolean) => {
    storage.set('vt.live.panelCollapsed', v ? '1' : '0');
    setCollapsedState(v);
  };
  const dayStats = useDayStats(details && !collapsed);
  const toggleStatus = (s: MovementStatus) =>
    onFiltersChange({ statuses: filters.statuses.includes(s) ? filters.statuses.filter((x) => x !== s) : [...filters.statuses, s] });

  return (
    <div className={cn('flex min-h-0 flex-col overflow-hidden rounded-xl border bg-card/95 shadow-lg backdrop-blur', className, collapsed && 'bottom-auto md:bottom-auto')}>
      <div className={cn('space-y-3 p-3', !collapsed && 'border-b')}>
        <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={filters.q}
            onChange={(e) => {
              onFiltersChange({ q: e.target.value });
              if (collapsed && e.target.value) setCollapsed(false);
            }}
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
          <button
            type="button"
            onClick={() => setCollapsed(!collapsed)}
            aria-expanded={!collapsed}
            aria-label={collapsed ? t('Show status, filters and list') : t('Hide the list for more map')}
            title={collapsed ? t('Show status, filters and list') : t('Hide the list for more map')}
            className={cn('flex size-9 shrink-0 items-center justify-center rounded-md border', collapsed ? 'border-primary bg-primary text-primary-foreground hover:bg-primary/90' : 'hover:bg-accent')}
          >
            {collapsed ? <ChevronDownIcon className="size-4" /> : <ChevronUpIcon className="size-4" />}
          </button>
        </div>

        {collapsed ? (
          <button type="button" onClick={() => setCollapsed(false)} className="flex w-full items-center gap-2 text-left text-xs text-muted-foreground hover:text-foreground">
            <span className="min-w-0 flex-1 truncate tabular-nums">
              {t('{{n}} shown', { n: formatNumber(items.length) })}
              {(['RUNNING', 'IDLE', 'OFF', 'OVERSPEED', 'OFFLINE'] as const)
                .filter((st) => counts[st] > 0)
                .map((st) => (
                  <span key={st}>
                    {' · '}
                    <span style={{ color: statusColor(st) }}>{formatNumber(counts[st])}</span> {t(STATUS_META[st].label).toLowerCase()}
                  </span>
                ))}
            </span>
            <span className="shrink-0 font-medium text-primary">{t('Expand')}</span>
          </button>
        ) : (
        <>
        <StatusCards counts={counts} statuses={filters.statuses} onToggle={toggleStatus} onAll={() => onFiltersChange({ statuses: [] })} />

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
          {selected.size === 0 && (
            <label className="flex items-center gap-1.5">
              <Switch checked={details} onCheckedChange={setDetails} className="scale-90" aria-label={t("Show address and today's figures")} />
              {t("Today's figures")}
            </label>
          )}
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
        </>
        )}
      </div>

      {collapsed ? null : loading ? (
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
          rowHeight={details ? ROW_HEIGHT_DETAILED : ROW_HEIGHT}
          getKey={(o) => o.objectId}
          className="min-h-0 flex-1 py-1"
          renderRow={(o) => (
            <ObjectRow o={o} now={now} active={o.objectId === activeId} checked={selected.has(o.objectId)} onPick={onPick} onToggle={onToggleSelected} company={allCompanies ? companyNames.get(o.companyId) : undefined} details={details} stats={dayStats.data?.[o.objectId]} />
          )}
        />
      )}
    </div>
  );
}
