/**
 * Report insights (RP-2): the pure KPI / chart builder now lives in @veetracer/shared (report-insights.ts) so the API
 * exports (PDF cover, XLSX Summary sheet) show exactly the figures the page shows. This module keeps the names the
 * page and its tests import.
 */
export {
  buildInsight,
  durationHistogram,
  durationBinLabel,
  fuelKmPerL,
  idlePct,
  INSIGHT_TYPES,
  insightDays as daysBetween,
  rankedFilter,
  reportRowKey,
  rowMatches,
  utilisation,
} from '@veetracer/shared';
export type { BarDatum, HistogramBin, Insight, InsightChart, InsightFilter, InsightInput, InsightRow as Row, Kpi, RankedItem, Segment, ValueFormat } from '@veetracer/shared';
