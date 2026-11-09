import { ALERT_TYPE_MAP, type AlertDto, type SummaryReportRow } from '@veetracer/shared';
import { InfoIcon } from 'lucide-react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { i18n } from '@/lib/i18n';
import { axisValue, BarChart, formatValue, Heatmap, KpiStrip, RankedBars, TONE_COLOR } from './charts';
import { buildInsight, type InsightChart, type InsightFilter, type Row } from './insights';
import { periodLabel, periodShortLabel } from './report-format';
import { getReportTimeZone } from './report-time';
import { SummaryCharts } from './SummaryCharts';

const alertLabel = (code: string) => {
  const l = ALERT_TYPE_MAP[code as AlertDto['type']]?.label;
  return l ? i18n.t(l) : code;
};

/** Selected key of a filter, to highlight the matching bar / row / cell. */
function selectedKey(f: InsightFilter | null): string | null {
  if (!f) return null;
  return f.kind === 'cell' ? `${f.objectId}|${f.type}` : f.value;
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
}) {
  const { t } = useTranslation();
  const tz = getReportTimeZone();
  const insight = useMemo(() => buildInsight({ type, rows, totals, from, to, tz, alertLabel }), [type, rows, totals, from, to, tz]);
  if (!insight || !rows.length) return null;
  const sel = selectedKey(filter);
  const dayShort = (d: string) => periodShortLabel(d);
  const toggle = (f: InsightFilter) => onFilter(selectedKey(f) === sel ? null : f);

  const renderChart = (c: InsightChart, i: number) => {
    if (c.kind === 'bars') {
      return (
        <BarChart
          key={i}
          title={t(c.title)}
          data={c.data}
          segments={c.segments.map((s) => ({ key: s.key, label: t(s.label), color: TONE_COLOR[s.tone] }))}
          format={(v) => formatValue(v, c.format)}
          axisFormat={(v) => axisValue(v, c.format)}
          shortLabel={c.select === 'day' ? dayShort : periodShortLabel}
          longLabel={periodLabel}
          onSelect={(key) => toggle(c.select === 'day' ? { kind: 'day', value: key } : { kind: 'period', value: key })}
          selected={filter && (filter.kind === 'day' || filter.kind === 'period') ? filter.value : null}
        />
      );
    }
    if (c.kind === 'ranked') {
      return (
        <RankedBars
          key={i}
          title={t(c.title)}
          items={c.items}
          total={c.total}
          format={(v) => formatValue(v, c.format)}
          color={type === 'OVERSPEED' ? 'var(--destructive)' : undefined}
          onSelect={(item) => toggle(c.select === 'vehicle' ? { kind: 'vehicle', value: item.key, label: item.label } : { kind: 'alertType', value: item.key, label: item.label })}
          selected={filter && (filter.kind === 'vehicle' || filter.kind === 'alertType') ? filter.value : null}
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

  const [primary, ...rest] = insight.charts;
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
        renderChart(primary, 0)
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
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
    case 'cell':
      return f.label;
  }
}
