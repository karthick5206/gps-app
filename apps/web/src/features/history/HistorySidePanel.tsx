import { ALERT_TYPE_MAP, STATUS_META, type HistoryResponse } from '@veetracer/shared';
import { ChevronDownIcon, ChevronUpIcon, DownloadIcon, PlayIcon } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatDuration } from '@/lib/format';
import { statusColor } from '@/lib/status-tokens';
import { cn } from '@/lib/utils';
import { formatClock, formatKm, severityColor } from './history-format';

export type SideTab = 'trips' | 'stops' | 'alerts' | 'summary';

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-4 py-10 text-center text-sm text-muted-foreground">{children}</p>;
}

function ItemButton({ active, onClick, children, label }: { active: boolean; onClick: () => void; children: ReactNode; label: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      aria-current={active || undefined}
      onClick={onClick}
      className={cn(
        'group flex w-full gap-3 border-b px-4 py-3 text-left text-sm transition-colors outline-none last:border-b-0 hover:bg-muted/50 focus-visible:bg-muted/60',
        active && 'bg-accent/70 hover:bg-accent',
      )}
    >
      {children}
    </button>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums">{value}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

function Summary({ data }: { data: HistoryResponse }) {
  const s = data.summary;
  const total = s.runningSec + s.idleSec + s.stopSec;
  const parts = [
    { key: 'RUNNING' as const, label: 'Running', sec: s.runningSec },
    { key: 'IDLE' as const, label: 'Idle', sec: s.idleSec },
    { key: 'OFF' as const, label: 'Stopped', sec: s.stopSec },
  ];
  return (
    <div className="space-y-4 p-4">
      <div className="grid grid-cols-2 gap-2">
        <Stat label="Distance" value={formatKm(s.distanceKm)} />
        <Stat label="Trips" value={String(data.trips.length)} sub={`${data.stops.length} stops`} />
        <Stat label="Max speed" value={`${Math.round(s.maxSpeedKph)} km/h`} />
        <Stat label="Avg moving speed" value={`${Math.round(s.avgSpeedKph)} km/h`} />
      </div>
      <div className="space-y-2">
        <p className="text-sm font-medium">Time split</p>
        {total > 0 ? (
          <div className="flex h-3 gap-0.5 overflow-hidden rounded-full" role="img" aria-label={parts.map((p) => `${p.label} ${formatDuration(p.sec)}`).join(', ')}>
            {parts.map((p) =>
              p.sec > 0 ? <div key={p.key} style={{ flexGrow: p.sec, backgroundColor: statusColor(p.key) }} title={`${p.label}: ${formatDuration(p.sec)}`} /> : null,
            )}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">No time recorded.</p>
        )}
        <dl className="space-y-1.5 pt-1">
          {parts.map((p) => (
            <div key={p.key} className="flex items-center gap-2 text-sm">
              <span className="size-2.5 rounded-sm" style={{ backgroundColor: statusColor(p.key) }} aria-hidden />
              <dt className="flex-1 text-muted-foreground">{p.label === 'Stopped' ? 'Stopped' : STATUS_META[p.key].label}</dt>
              <dd className="font-medium tabular-nums">{formatDuration(p.sec)}</dd>
              <dd className="w-10 text-right text-xs text-muted-foreground tabular-nums">{total ? `${Math.round((p.sec / total) * 100)}%` : ''}</dd>
            </div>
          ))}
        </dl>
      </div>
      <p className="text-xs text-muted-foreground">
        {data.points.length.toLocaleString()} track points · {data.alerts.length} alerts
      </p>
    </div>
  );
}

export function HistorySidePanel({
  data,
  tab,
  onTabChange,
  activeTrip,
  selected,
  onTrip,
  onStop,
  onAlert,
  multiDay,
  mobile = false,
  expanded = true,
  onExpandedChange,
  onExport,
  className,
}: {
  data: HistoryResponse | undefined;
  tab: SideTab;
  onTabChange: (tab: SideTab) => void;
  activeTrip: number;
  selected: { kind: 'stop' | 'alert'; index: number } | null;
  onTrip: (index: number) => void;
  onStop: (index: number) => void;
  onAlert: (index: number) => void;
  multiDay: boolean;
  mobile?: boolean;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
  /** CSV download of trips/stops (shown only when provided — needs `history:export`). */
  onExport?: (kind: 'trips' | 'stops') => void;
  className?: string;
}) {
  const exportBar = (kind: 'trips' | 'stops', count: number) =>
    onExport && count > 0 ? (
      <div className="flex justify-end border-b px-3 py-1.5">
        <button type="button" onClick={() => onExport(kind)} className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground">
          <DownloadIcon className="size-3.5" /> Download CSV
        </button>
      </div>
    ) : null;
  const t = (iso: string) => formatClock(Date.parse(iso), multiDay, false);
  return (
    <Tabs
      value={tab}
      onValueChange={(v) => {
        onTabChange(v as SideTab);
        if (mobile) onExpandedChange?.(true);
      }}
      className={cn('flex min-h-0 flex-col bg-card', className)}
    >
      <div className="flex items-center gap-1 border-b p-2">
        <TabsList className="w-full">
          <TabsTrigger value="trips">Trips{data ? ` ${data.trips.length}` : ''}</TabsTrigger>
          <TabsTrigger value="stops">Stops{data ? ` ${data.stops.length}` : ''}</TabsTrigger>
          <TabsTrigger value="alerts">Alerts{data ? ` ${data.alerts.length}` : ''}</TabsTrigger>
          <TabsTrigger value="summary">Summary</TabsTrigger>
        </TabsList>
        {mobile && (
          <button
            type="button"
            onClick={() => onExpandedChange?.(!expanded)}
            className="flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent"
            aria-label={expanded ? 'Collapse panel' : 'Expand panel'}
            aria-expanded={expanded}
          >
            {expanded ? <ChevronDownIcon className="size-4" /> : <ChevronUpIcon className="size-4" />}
          </button>
        )}
      </div>
      {expanded && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {!data ? (
            <Empty>Pick a vehicle and period to see trips, stops and alerts.</Empty>
          ) : (
            <>
              <TabsContent value="trips">
                {exportBar('trips', data.trips.length)}
                {data.trips.length === 0 && <Empty>No trips in this period.</Empty>}
                {data.trips.map((trip, i) => (
                  <ItemButton key={trip.id} active={activeTrip === i} onClick={() => onTrip(i)} label={`Play trip ${i + 1}`}>
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/12 text-xs font-semibold text-primary group-hover:bg-primary group-hover:text-primary-foreground">
                      <span className="group-hover:hidden">{i + 1}</span>
                      <PlayIcon className="hidden size-3.5 group-hover:block" />
                    </span>
                    <span className="min-w-0 flex-1 space-y-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="font-medium tabular-nums">
                          {t(trip.startTime)} – {formatClock(Date.parse(trip.endTime), false, false)}
                        </span>
                        <span className="text-xs text-muted-foreground tabular-nums">{formatDuration(trip.durationSec)}</span>
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {trip.startAddress ?? `${trip.startLat.toFixed(4)}, ${trip.startLng.toFixed(4)}`} → {trip.endAddress ?? `${trip.endLat.toFixed(4)}, ${trip.endLng.toFixed(4)}`}
                      </span>
                      <span className="flex gap-3 text-xs tabular-nums">
                        <span>{formatKm(trip.distanceKm)}</span>
                        <span className="text-muted-foreground">max {Math.round(trip.maxSpeedKph)} km/h</span>
                        <span className="text-muted-foreground">avg {Math.round(trip.avgSpeedKph)}</span>
                      </span>
                    </span>
                  </ItemButton>
                ))}
              </TabsContent>
              <TabsContent value="stops">
                {exportBar('stops', data.stops.length)}
                {data.stops.length === 0 && <Empty>No stops in this period.</Empty>}
                {data.stops.map((stop, i) => (
                  <ItemButton key={stop.id} active={selected?.kind === 'stop' && selected.index === i} onClick={() => onStop(i)} label={`Jump to stop at ${t(stop.startTime)}`}>
                    <span
                      className="flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-bold text-white"
                      style={{ backgroundColor: stop.ignitionOn ? 'var(--status-idle)' : '#1d4ed8' }}
                      title={stop.ignitionOn ? 'Idle (engine on)' : 'Parked'}
                    >
                      {stop.ignitionOn ? 'I' : 'P'}
                    </span>
                    <span className="min-w-0 flex-1 space-y-0.5">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="font-medium tabular-nums">
                          {t(stop.startTime)} – {formatClock(Date.parse(stop.endTime), false, false)}
                        </span>
                        <span className="text-xs font-medium tabular-nums">{formatDuration(stop.durationSec)}</span>
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {stop.ignitionOn ? 'Idle · ' : 'Parked · '}
                        {stop.address ?? `${stop.lat.toFixed(5)}, ${stop.lng.toFixed(5)}`}
                      </span>
                    </span>
                  </ItemButton>
                ))}
              </TabsContent>
              <TabsContent value="alerts">
                {data.alerts.length === 0 && <Empty>No alerts in this period.</Empty>}
                {data.alerts.map((a, i) => (
                  <ItemButton key={a.id} active={selected?.kind === 'alert' && selected.index === i} onClick={() => onAlert(i)} label={`Jump to alert ${a.message}`}>
                    <span className="mt-1.5 size-2.5 shrink-0 rounded-full" style={{ backgroundColor: severityColor(a.severity) }} aria-hidden />
                    <span className="min-w-0 flex-1 space-y-0.5">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="truncate font-medium">{ALERT_TYPE_MAP[a.type]?.label ?? a.type}</span>
                        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{t(a.occurredAt)}</span>
                      </span>
                      <span className="line-clamp-2 text-xs text-muted-foreground">{a.message}</span>
                    </span>
                  </ItemButton>
                ))}
              </TabsContent>
              <TabsContent value="summary">
                <Summary data={data} />
              </TabsContent>
            </>
          )}
        </div>
      )}
    </Tabs>
  );
}
