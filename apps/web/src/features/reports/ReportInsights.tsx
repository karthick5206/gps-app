import { ALERT_TYPE_MAP, type AlertDto, type SummaryReportRow } from '@veetracer/shared';
import { ExternalLinkIcon, InfoIcon } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { isEnabled } from '@/lib/flags';
import { i18n } from '@/lib/i18n';
import { axisValue, BarChart, formatValue, Heatmap, KpiStrip, RankedBars, TONE_COLOR } from './charts';
import { buildInsight, rankedFilter, type InsightChart, type InsightFilter, type Row } from './insights';
import { periodLabel, periodShortLabel } from './report-format';
import { getReportTimeZone } from './report-time';
import { SummaryCharts } from './SummaryCharts';

const alertLabel = (code: string) => {
  const l = ALERT_TYPE_MAP[code as AlertDto['type']]?.label;
  return l ? i18n.t(l) : code;
};

/** Insight panels added in batch 2 (shown with the uiRefresh flag, like the rest of the refreshed Reports page). */
export const BATCH2_INSIGHT_TYPES = ['STOPS', 'HALT', 'IDLE', 'GEOFENCE_VISITS', 'GEOFENCE_SUMMARY', 'GEOFENCE_DISTANCE', 'FUEL', 'FUEL_EVENTS', 'DRIVERS'];

/** Selected key of a filter, to highlight the matching bar / row / cell. */
function selectedKey(f: InsightFilter | null): string | null {
  if (!f) return null;
  switch (f.kind) {
    case 'cell':
      return `${f.objectId}|${f.type}`;
    case 'pair':
      return `${f.from}→${f.to}`;
    case 'bucket':
      return `${f.field}:${f.min}`;
    default:
      return f.value;
  }
}

/** KPI strip and charts above a report's table (RP-2); chart clicks set a table filter (RP-3). */
export function ReportInsights({
  type,
  rows,
  totals,
  from,
  to,
  truncated,
  totalRows,
  filter,
  onFilter,
  alertsLink,
}: {
  type: string;
  rows: Row[];
  totals?: Record<string, number>;
  from: string;
  to: string;
  truncated: boolean;
  totalRows: number;
  filter: InsightFilter | null;
  onFilter: (f: InsightFilter | null) => void;
  /** Event summary: link to the Alerts report for a heatmap cell (batch 2). */
  alertsLink?: (cell: { objectId: string; objectName: string; alertType: string }) => string;
}) {
  const { t } = useTranslation();
  const tz = getReportTimeZone();
  const batch2 = isEnabled('uiRefresh');
  const insight = useMemo(() => buildInsight({ type, rows, totals, from, to, tz, alertLabel }), [type, rows, totals, from, to, tz]);
  if (!insight || !rows.length) return null;
  if (!batch2 && BATCH2_INSIGHT_TYPES.includes(type)) return null;
  const charts = batch2 ? insight.charts : insight.charts.filter((c) => c.kind !== 'histogram');
  const sel = selectedKey(filter);
  const toggle = (f: InsightFilter) => onFilter(selectedKey(f) === sel ? null : f);

  const renderChart = (c: InsightChart, i: number) => {
    if (c.kind === 'bars') {
      if (!c.data.length) return null;
      return (
        <BarChart
          key={i}
          title={t(c.title)}
          data={c.data}
          segments={c.segments.map((s) => ({ key: s.key, label: t(s.label), color: TONE_COLOR[s.tone] }))}
          format={(v) => formatValue(v, c.format)}
          axisFormat={(v) => axisValue(v, c.format)}
          shortLabel={periodShortLabel}
          longLabel={periodLabel}
          onSelect={(key) => toggle(c.select === 'day' ? { kind: 'day', value: key } : { kind: 'period', value: key })}
          selected={filter && (filter.kind === 'day' || filter.kind === 'period') ? filter.value : null}
        />
      );
    }
    if (c.kind === 'histogram') {
      if (!c.bins.length) return null;
      const label = (key: string) => c.bins.find((b) => b.key === key)?.label ?? key;
      return (
        <BarChart
          key={i}
          title={t(c.title)}
          data={c.bins.map((b) => ({ key: b.key, values: b.values }))}
          segments={c.segments.map((s) => ({ key: s.key, label: t(s.label), color: TONE_COLOR[s.tone] }))}
          format={(v) => formatValue(v, 'int')}
          axisFormat={(v) => axisValue(v, 'int')}
          shortLabel={label}
          longLabel={label}
          onSelect={(key) => {
            const b = c.bins.find((x) => x.key === key);
            if (b) toggle({ kind: 'bucket', field: c.field, min: b.min, max: b.max, label: b.label });
          }}
          selected={filter?.kind === 'bucket' && filter.field === c.field ? (c.bins.find((b) => b.min === filter.min)?.key ?? null) : null}
          action={c.skipped > 0 ? <span className="text-xs text-muted-foreground">{t('{{n}} without a duration not shown', { n: c.skipped.toLocaleString() })}</span> : undefined}
        />
      );
    }
    if (c.kind === 'ranked') {
      const rankedSel = filter && (filter.kind === 'vehicle' || filter.kind === 'alertType' || filter.kind === 'field' || filter.kind === 'pair') ? sel : null;
      return (
        <RankedBars
          key={i}
          title={t(c.title)}
          items={c.items}
          total={c.total}
          format={(v) => formatValue(v, c.format)}
          color={type === 'OVERSPEED' || c.title.includes('drained') ? 'var(--destructive)' : undefined}
          onSelect={(item) => toggle(rankedFilter(c.select, item))}
          selected={rankedSel}
        />
      );
    }
    return (
      <Heatmap
        key={i}
        title={t(c.title)}
        rows={c.rows}
        cols={c.cols}
        cells={c.cells}
        max={c.max}
        hiddenRows={c.hiddenRows}
        hiddenCols={c.hiddenCols}
        onSelect={(r, col) => toggle({ kind: 'cell', objectId: r.key, type: col.key, label: `${r.label} · ${col.label}` })}
        selected={filter?.kind === 'cell' ? sel : null}
      />
    );
  };

  // Event summary: the selected heatmap cell can open the Alerts report pre-filtered (vehicle + type + same days).
  const cellLink =
    batch2 && alertsLink && filter?.kind === 'cell'
      ? (() => {
          const heat = charts.find((c): c is Extract<InsightChart, { kind: 'heatmap' }> => c.kind === 'heatmap');
          const row = heat?.rows.find((r) => r.key === filter.objectId);
          const count = heat?.cells[`${filter.objectId}|${filter.type}`]?.count ?? 0;
          return { href: alertsLink({ objectId: filter.objectId, objectName: row?.label ?? '', alertType: filter.type }), count };
        })()
      : null;

  const [primary, ...rest] = charts;
  return (
    <section className="space-y-4" aria-label={t('Report summary')}>
      <KpiStrip kpis={insight.kpis} partial={truncated} />
      {truncated && insight.chartsFromRows && (
        <p className="flex items-start gap-1.5 rounded-lg border border-warning/40 bg-warning-soft px-3 py-2 text-xs text-warning-fg">
          <InfoIcon className="mt-0.5 size-3.5 shrink-0" />
          {t('Charts are based on the first {{shown}} of {{total}} rows; figures without * cover every row.', { shown: rows.length.toLocaleString(), total: totalRows.toLocaleString() })}
        </p>
      )}
      {type === 'SUMMARY' && (
        <SummaryCharts rows={rows as unknown as SummaryReportRow[]} onSelect={(p) => toggle({ kind: 'period', value: p })} selected={filter?.kind === 'period' ? filter.value : null} />
      )}
      {type === 'EVENT_SUMMARY' ? (
        <>
          {primary && renderChart(primary, 0)}
          {cellLink && filter?.kind === 'cell' && (
            <div className="flex flex-col gap-2 rounded-lg border border-primary/30 bg-accent px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between" role="status">
              <span className="text-accent-foreground">
                {t('{{cell}}: {{n}} events. The table below shows this pair.', { cell: filter.label, n: cellLink.count.toLocaleString() })}
              </span>
              <Button size="sm" asChild>
                <Link to={cellLink.href} target="_blank" rel="noreferrer">
                  <ExternalLinkIcon /> {t('Open in Alerts report')}
                </Link>
              </Button>
            </div>
          )}
        </>
      ) : (
        <div className={charts.length >= 3 ? 'grid gap-4 lg:grid-cols-2 2xl:grid-cols-3' : 'grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]'}>
          {primary && renderChart(primary, 0)}
          {rest.map((c, i) => renderChart(c, i + 1))}
        </div>
      )}
    </section>
  );
}

/** Text for the table's filter chip. */
export function filterLabel(f: InsightFilter, t: (k: string, v?: Record<string, string>) => string): string {
  switch (f.kind) {
    case 'day':
    case 'period':
      return periodLabel(f.value);
    case 'vehicle':
      return t('Vehicle: {{name}}', { name: f.label });
    case 'alertType':
      return t('Type: {{name}}', { name: f.label });
    case 'bucket':
      return t('Duration: {{range}}', { range: f.label });
    case 'field':
      return f.prefix ? t('{{prefix}}: {{name}}', { prefix: t(f.prefix), name: f.label }) : f.label;
    case 'cell':
    case 'pair':
      return f.label;
  }
}
