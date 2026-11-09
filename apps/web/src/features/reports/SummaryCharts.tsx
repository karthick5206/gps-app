import type { SummaryReportRow } from '@veetracer/shared';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { statusColor } from '@/lib/status-tokens';
import { BarChart, type ChartBar } from './charts';
import { formatHm, periodLabel, periodShortLabel } from './report-format';

/** Distance and running / idle / stopped time per period, all vehicles (same sums as before). */
function aggregate(rows: SummaryReportRow[]): ChartBar[] {
  const map = new Map<string, Record<string, number>>();
  for (const r of rows) {
    const a = map.get(r.period) ?? { distance: 0, running: 0, idle: 0, stop: 0 };
    a.distance += r.distanceKm;
    a.running += r.runningSec / 3600;
    a.idle += r.idleSec / 3600;
    a.stop += r.stopSec / 3600;
    map.set(r.period, a);
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, values]) => ({ key, values }));
}

/** Summary report charts; clicking a period filters the table to it. */
export function SummaryCharts({ rows, onSelect, selected }: { rows: SummaryReportRow[]; onSelect?: (period: string) => void; selected?: string | null }) {
  const { t } = useTranslation();
  const data = useMemo(() => aggregate(rows), [rows]);
  if (!data.length) return null;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <BarChart
        title={t('Distance (km)')}
        data={data}
        segments={[{ key: 'distance', label: t('Distance'), color: 'var(--primary)' }]}
        format={(v) => `${v.toFixed(1)} km`}
        axisFormat={(v) => (v >= 1000 ? `${(v / 1000).toFixed(v % 1000 ? 1 : 0)}k` : String(Math.round(v)))}
        shortLabel={periodShortLabel}
        longLabel={periodLabel}
        onSelect={onSelect}
        selected={selected}
      />
      <BarChart
        title={t('Running / idle / stopped (hh:mm)')}
        data={data}
        segments={[
          { key: 'running', label: t('Running'), color: statusColor('RUNNING') },
          { key: 'idle', label: t('Idle'), color: statusColor('IDLE') },
          { key: 'stop', label: t('Stopped'), color: statusColor('OFF') },
        ]}
        format={(h) => formatHm(h * 3600)}
        axisFormat={(h) => `${Number.isInteger(h) ? h : h.toFixed(1)}h`}
        shortLabel={periodShortLabel}
        longLabel={periodLabel}
        onSelect={onSelect}
        selected={selected}
      />
    </div>
  );
}
