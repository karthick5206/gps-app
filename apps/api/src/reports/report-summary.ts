import {
  ALERT_TYPE_MAP,
  AlertTypeCode,
  buildInsight,
  formatInsightValue,
  Insight,
  InsightChart,
  interpolate,
  Kpi,
  REPORT_OPTION_KEYS,
  ReportOptions,
  Segment,
  ValueFormat,
} from '@veetracer/shared';
import type ExcelJS from 'exceljs';
import type { Content, TableCell } from 'pdfmake/interfaces';
import type { ReportData } from './report-data.service';

/**
 * Export cover (RP-7, batch 2): the PDF cover page and the XLSX "Summary" sheet of an on-demand export — logo, period,
 * time zone, the selection (scope, options, filtered view), the KPI block and the charts. KPI and chart figures come
 * from the shared insight builder (@veetracer/shared report-insights.ts) over the rows/totals of the export itself:
 * the same code the Reports page uses, so the file shows the figures the screen shows. Nothing here changes a report's
 * rows, totals or table; the CSV format never gets a cover.
 */

export interface ReportLogo {
  data: Buffer;
  mime: string;
}

export interface SummaryFilter {
  label: string;
  value: string;
}

export interface ReportSummary {
  logo: ReportLogo | null;
  /** The selection behind the report (scope, grouping, report options, filtered view). */
  filters: SummaryFilter[];
  insight: Insight | null;
  /** True when more rows matched than the file holds, so row-based figures (marked *) are partial. */
  partial: boolean;
  /** Rows the row-based figures were computed from. */
  rowsUsed: number;
  totalRows: number;
  /** Set when the table is a filtered view: the figures still cover the whole report. */
  viewNote?: string;
}

export const alertLabel = (code: string) => ALERT_TYPE_MAP[code as AlertTypeCode]?.label ?? code;

/** KPI block and charts for a report section (null insight for types without one). */
export function buildSummary(data: ReportData, filters: SummaryFilter[], logo: ReportLogo | null): ReportSummary {
  const insight = buildInsight({ type: data.type, rows: data.rows as Record<string, unknown>[], totals: data.totals, from: data.from, to: data.to, tz: data.tz, alertLabel });
  return { logo, filters, insight, partial: data.truncated, rowsUsed: data.rows.length, totalRows: data.totalRows };
}

/** Human-readable report options ("Minimum duration: 45 min"), only those the report type uses. */
export function describeOptions(type: ReportData['type'], options: ReportOptions | undefined): SummaryFilter[] {
  if (!options) return [];
  const keys = REPORT_OPTION_KEYS[type] ?? [];
  const out: SummaryFilter[] = [];
  for (const k of keys) {
    const v = options[k];
    if (v === undefined || v === null || (Array.isArray(v) && !v.length)) continue;
    switch (k) {
      case 'minDurationMin':
        out.push({ label: 'Minimum duration', value: `${v} min` });
        break;
      case 'alertTypes':
        out.push({ label: 'Alert types', value: (v as string[]).map(alertLabel).join(', ') });
        break;
      case 'drivingMin':
        out.push({ label: 'Driving without a break', value: `${v} min or more` });
        break;
      case 'breakMin':
        out.push({ label: 'A break is', value: `${v} min or more` });
        break;
      case 'minOverspeedSec':
        out.push({ label: 'Minimum over-speed', value: `${v} s` });
        break;
      case 'inactiveAfterMin':
        out.push({ label: 'Inactive after', value: `${v} min without data` });
        break;
    }
  }
  return out;
}

/** "Asia/Kolkata (GMT+05:30)". */
export function zoneLine(tz: string, at = Date.now()): string {
  try {
    const off = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' }).formatToParts(at).find((p) => p.type === 'timeZoneName')?.value;
    return off ? `${tz} (${off === 'GMT' ? 'GMT+00:00' : off})` : tz;
  } catch {
    return tz;
  }
}

// ---------------------------------------------------------------- shared formatting

const LOCALE = 'en-IN';
const fmt = (v: number | null | undefined, f: ValueFormat) => formatInsightValue(v, f, LOCALE);

export const TONE_HEX: Record<Segment['tone'], string> = {
  primary: '#0e5e57',
  running: '#16a34a',
  idle: '#d97706',
  stopped: '#64748b',
  critical: '#dc2626',
  warning: '#f59e0b',
  info: '#2563eb',
  muted: '#94a3b8',
};
const KPI_TONE: Record<NonNullable<Kpi['tone']>, string> = { default: '#0f172a', warning: '#b45309', danger: '#dc2626' };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Short axis label for a day / week / month key: "3 Nov", "W45", "Nov 26". */
export function shortKey(key: string): string {
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (m) return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}`;
  m = /^\d{4}-W(\d{2})$/.exec(key);
  if (m) return `W${Number(m[1])}`;
  m = /^(\d{4})-(\d{2})$/.exec(key);
  if (m) return `${MONTHS[Number(m[2]) - 1]} ${m[1].slice(2)}`;
  return key;
}

const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const clip = (v: string, max: number) => (v.length > max ? `${v.slice(0, max - 1)}…` : v);

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const x = v / p;
  return (x <= 1 ? 1 : x <= 2 ? 2 : x <= 5 ? 5 : 10) * p;
}

function axis(v: number, f: ValueFormat): string {
  if (f === 'hours') return `${Number.isInteger(v) ? v : v.toFixed(1)}h`;
  if (f === 'hm') return `${Math.round(v / 3600)}h`;
  return v >= 1000 ? `${(v / 1000).toFixed(v % 1000 ? 1 : 0)}k` : String(Math.round(v * 10) / 10);
}

// ---------------------------------------------------------------- SVG charts (pdfmake renders SVG via svg-to-pdfkit)

const TEXT = 'font-family="Roboto"';

/** Stacked vertical bars with a y axis; `labels[i]` under bar i (thinned when crowded). */
export function barsSvg(data: { label: string; values: Record<string, number> }[], segments: Segment[], width: number, height: number, format: ValueFormat): string {
  const pad = { l: 34, r: 6, t: 8, b: 18 };
  const totals = data.map((d) => segments.reduce((s, g) => s + (d.values[g.key] ?? 0), 0));
  const max = niceMax(Math.max(0, ...totals));
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;
  const band = data.length ? plotW / data.length : plotW;
  const barW = Math.max(1.5, Math.min(26, band * 0.7));
  const y = (v: number) => pad.t + plotH - (v / max) * plotH;
  const every = Math.max(1, Math.ceil(data.length / Math.max(1, Math.floor(plotW / 34))));
  const parts: string[] = [];
  for (const f of [0, 0.25, 0.5, 0.75, 1]) {
    const v = f * max;
    parts.push(`<line x1="${pad.l}" x2="${width - pad.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="#e2e8f0" stroke-width="0.6"${f ? ' stroke-dasharray="2 2"' : ''}/>`);
    parts.push(`<text x="${pad.l - 4}" y="${(y(v) + 2.4).toFixed(1)}" text-anchor="end" ${TEXT} font-size="6.5" fill="#64748b">${esc(axis(v, format))}</text>`);
  }
  data.forEach((d, i) => {
    const x = pad.l + i * band + (band - barW) / 2;
    let acc = 0;
    for (const g of segments) {
      const v = d.values[g.key] ?? 0;
      if (v <= 0) continue;
      const top = y(acc + v);
      const h = y(acc) - top;
      acc += v;
      parts.push(`<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(0.5, h).toFixed(1)}" fill="${TONE_HEX[g.tone]}"/>`);
    }
    if (i % every === 0) parts.push(`<text x="${(x + barW / 2).toFixed(1)}" y="${height - 6}" text-anchor="middle" ${TEXT} font-size="6.5" fill="#64748b">${esc(clip(d.label, 12))}</text>`);
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join('')}</svg>`;
}

/** Ranked horizontal bars: label and value on one line, bar below (largest = full width). */
export function rankedSvg(items: { label: string; sub?: string | null; value: number }[], width: number, format: ValueFormat, color = TONE_HEX.primary): string {
  const rowH = 19;
  const height = Math.max(24, items.length * rowH + 4);
  const max = Math.max(0, ...items.map((i) => i.value));
  const parts: string[] = [];
  items.forEach((it, i) => {
    const top = i * rowH + 8;
    const label = clip(it.label, 44) + (it.sub ? `  ${clip(it.sub, 16)}` : '');
    parts.push(`<text x="0" y="${top}" ${TEXT} font-size="7.5" fill="#0f172a">${esc(label)}</text>`);
    parts.push(`<text x="${width}" y="${top}" text-anchor="end" ${TEXT} font-size="7.5" fill="#0f172a">${esc(fmt(it.value, format))}</text>`);
    parts.push(`<rect x="0" y="${top + 3}" width="${width}" height="4" rx="2" fill="#f1f5f9"/>`);
    const w = max ? Math.max((it.value / max) * width, it.value ? 2 : 0) : 0;
    if (w > 0) parts.push(`<rect x="0" y="${top + 3}" width="${w.toFixed(1)}" height="4" rx="2" fill="${color}"/>`);
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${parts.join('')}</svg>`;
}

/** One chart as pdfmake content (SVG; the heatmap is a coloured table). */
export function chartContent(c: InsightChart, width: number, type: string, height = 150, maxItems = 10): Content | null {
  const title = (text: string, extra?: string): Content => ({ text: [{ text, bold: true }, ...(extra ? [{ text: `  ${extra}`, color: '#64748b', fontSize: 7 }] : [])], fontSize: 9, margin: [0, 0, 0, 4] });
  const legend = (segments: Segment[]): Content[] =>
    segments.length > 1 ? [{ text: segments.flatMap((s) => [{ text: '■ ', color: TONE_HEX[s.tone] }, { text: `${s.label}   `, color: '#475569' }]), fontSize: 7, margin: [0, 2, 0, 0] }] : [];
  if (c.kind === 'bars') {
    if (!c.data.length) return null;
    return { stack: [title(c.title), { svg: barsSvg(c.data.map((d) => ({ label: shortKey(d.key), values: d.values })), c.segments, width, height, c.format), width }, ...legend(c.segments)], unbreakable: true };
  }
  if (c.kind === 'histogram') {
    if (!c.bins.length) return null;
    const note = c.skipped ? `${c.skipped.toLocaleString(LOCALE)} without a duration not shown` : undefined;
    return { stack: [title(c.title, note), { svg: barsSvg(c.bins.map((b) => ({ label: b.label, values: b.values })), c.segments, width, height, 'int'), width }, ...legend(c.segments)], unbreakable: true };
  }
  if (c.kind === 'ranked') {
    if (!c.items.length) return null;
    const items = c.items.slice(0, maxItems);
    const extra = c.total > items.length ? `Top ${items.length} of ${c.total.toLocaleString(LOCALE)}` : undefined;
    return { stack: [title(c.title, extra), { svg: rankedSvg(items, width, c.format, type === 'OVERSPEED' ? TONE_HEX.critical : TONE_HEX.primary), width }], unbreakable: true };
  }
  // Heatmap: vehicle × type counts, one hue from light to dark.
  if (!c.rows.length) return null;
  const shade = (v: number) => {
    if (v <= 0) return null;
    const t = 0.12 + (v / Math.max(1, c.max)) * 0.78;
    const mix = (a: number, b: number) => Math.round(a + (b - a) * t);
    return `#${[mix(255, 0x0e), mix(255, 0x5e), mix(255, 0x57)].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
  };
  const head: TableCell[] = [{ text: '', border: [false, false, false, false] }, ...c.cols.map((col) => ({ text: clip(col.label, 14), fontSize: 6, color: '#475569', alignment: 'center' as const })), { text: 'Total', fontSize: 6, bold: true, alignment: 'right' as const }];
  const body: TableCell[][] = [head];
  for (const r of c.rows) {
    body.push([
      { text: clip(r.label, 24), fontSize: 6.5, bold: true },
      ...c.cols.map((col) => {
        const v = c.cells[`${r.key}|${col.key}`]?.count ?? 0;
        const fill = shade(v);
        return { text: v ? v.toLocaleString(LOCALE) : '·', fontSize: 6.5, alignment: 'center' as const, color: v ? (v / Math.max(1, c.max) > 0.5 ? '#ffffff' : '#0f172a') : '#cbd5e1', ...(fill ? { fillColor: fill } : {}) };
      }),
      { text: r.total.toLocaleString(LOCALE), fontSize: 6.5, bold: true, alignment: 'right' as const },
    ]);
  }
  const more = c.hiddenRows > 0 || c.hiddenCols > 0 ? `Busiest ${c.rows.length} vehicles and ${c.cols.length} event types; the table has every row.` : undefined;
  return {
    stack: [
      title(c.title, more),
      {
        table: { headerRows: 1, widths: [90, ...c.cols.map(() => '*'), 34], body },
        layout: { hLineWidth: () => 0.6, vLineWidth: () => 0.6, hLineColor: () => '#ffffff', vLineColor: () => '#ffffff', paddingTop: () => 2, paddingBottom: () => 2, paddingLeft: () => 2, paddingRight: () => 2 },
      },
    ],
  };
}

/** KPI tiles as a one-row table (wraps to a second row beyond 6 tiles). */
function kpiBlock(kpis: Kpi[], partial: boolean, width: number): Content {
  const perRow = Math.min(6, kpis.length);
  const cells: TableCell[] = kpis.map((k) => ({
    stack: [
      { text: k.label, fontSize: 7.5, color: '#64748b' },
      { text: [{ text: fmt(k.value, k.format) }, ...(k.fromRows && partial ? [{ text: ' *', color: '#b45309', fontSize: 9 }] : [])], fontSize: 15, bold: true, color: KPI_TONE[k.tone ?? 'default'], margin: [0, 1, 0, 0] },
      ...(k.hint ? [{ text: interpolate(k.hint.text, k.hint.vars), fontSize: 6.5, color: '#64748b' }] : []),
    ],
    fillColor: '#f8fafc',
    margin: [4, 3, 4, 3],
  }));
  const rows: TableCell[][] = [];
  for (let i = 0; i < cells.length; i += perRow) {
    const row = cells.slice(i, i + perRow);
    while (row.length < perRow) row.push({ text: '', border: [false, false, false, false] });
    rows.push(row);
  }
  return {
    // Table width = widths + (perRow + 1) vertical lines of 6 pt + 4 pt padding per cell; the -6 margins hide the outer lines.
    table: { widths: Array.from({ length: perRow }, () => (width + 12 - (perRow + 1) * 6 - perRow * 4) / perRow), body: rows },
    layout: { hLineWidth: () => 3, vLineWidth: () => 6, hLineColor: () => '#ffffff', vLineColor: () => '#ffffff', paddingTop: () => 2, paddingBottom: () => 2, paddingLeft: () => 2, paddingRight: () => 2 },
    margin: [-6, 0, -6, 0],
  };
}

export const PDF_CONTENT_WIDTH = 842 - 56;

/** "1,234", "5,000 of 12,345 in this file" or "23 of 450 (filtered view)". */
function rowsLine(data: ReportData, s: ReportSummary): string {
  const f = (v: number) => v.toLocaleString(LOCALE);
  if (s.viewNote) return `${f(data.rows.length)} of ${f(data.totalRows)} (filtered view)`;
  return data.truncated ? `${f(data.rows.length)} of ${f(data.totalRows)} in this file` : f(data.totalRows);
}

/** PDF cover page for one section; the table follows on the next page. */
export function pdfCover(data: ReportData, title: string, generated: string, s: ReportSummary): Content[] {
  const logo: Content[] = s.logo
    ? [s.logo.mime === 'image/svg+xml' ? { svg: s.logo.data.toString('utf8'), fit: [130, 48], width: 140 } : { image: `data:${s.logo.mime};base64,${s.logo.data.toString('base64')}`, fit: [130, 48], width: 140 }]
    : [];
  const meta: TableCell[][] = [
    ['Period', data.from === data.to ? data.from : `${data.from} to ${data.to}`],
    ['Time zone', `${zoneLine(data.tz)} · all times in this file use this zone`],
    ...s.filters.map((f) => [f.label, f.value]),
    ['Rows', rowsLine(data, s)],
    ['Generated', generated.replace(/^Generated: /, '')],
  ].map(([k, v]) => [
    { text: k, color: '#64748b', fontSize: 8 },
    { text: v, fontSize: 8 },
  ]);
  const out: Content[] = [
    {
      columns: [...logo, { stack: [{ text: data.companyName, fontSize: 16, bold: true, color: '#0e5e57' }, { text: title, fontSize: 13, bold: true, margin: [0, 2, 0, 0] }], width: '*' }],
      columnGap: 14,
    },
    { canvas: [{ type: 'line', x1: 0, y1: 0, x2: PDF_CONTENT_WIDTH, y2: 0, lineWidth: 1.2, lineColor: '#0e5e57' }], margin: [0, 8, 0, 8] },
    { table: { widths: [90, '*'], body: meta }, layout: 'noBorders', margin: [0, 0, 0, 10] },
  ];
  if (s.viewNote) out.push({ text: s.viewNote, fontSize: 8, italics: true, color: '#b45309', margin: [0, -4, 0, 8] });
  const ins = s.insight;
  if (ins && (data.rows.length || data.totalRows)) {
    out.push({ text: 'Key figures', fontSize: 10, bold: true, margin: [0, 0, 0, 4] }, kpiBlock(ins.kpis, s.partial, PDF_CONTENT_WIDTH));
    const charts = ins.charts;
    const heat = charts.find((c) => c.kind === 'heatmap');
    const gap = 18;
    const rendered: Content[] = [];
    if (heat) {
      const c = chartContent(heat, PDF_CONTENT_WIDTH, data.type);
      if (c) rendered.push(c);
    } else {
      // One row of up to three charts so the cover stays one page (ranked lists show their top 8).
      const shown = charts.filter((c) => (c.kind === 'bars' ? c.data.length : c.kind === 'histogram' ? c.bins.length : c.kind === 'ranked' ? c.items.length : 0) > 0).slice(0, 3);
      const w = (PDF_CONTENT_WIDTH - gap * (shown.length - 1)) / Math.max(1, shown.length);
      const list = shown.map((c) => chartContent(c, w, data.type, 140, 8)).filter((c): c is Content => !!c);
      if (list.length) rendered.push({ columns: list.map((c) => ({ width: w, stack: [c] })), columnGap: gap });
    }
    if (rendered.length) out.push({ text: 'Charts', fontSize: 10, bold: true, margin: [0, 12, 0, 6] }, ...rendered);
    const notes: string[] = [];
    if (s.partial && ins.kpis.some((k) => k.fromRows)) notes.push(`* From the ${s.rowsUsed.toLocaleString(LOCALE)} rows in this file; other figures cover all ${s.totalRows.toLocaleString(LOCALE)} rows.`);
    if (s.partial && ins.chartsFromRows) notes.push(`Charts are based on the ${s.rowsUsed.toLocaleString(LOCALE)} rows in this file (of ${s.totalRows.toLocaleString(LOCALE)}).`);
    if (notes.length) out.push({ text: notes.join(' '), fontSize: 7.5, italics: true, color: '#b45309', margin: [0, 6, 0, 0] });
  } else if (!data.rows.length) {
    out.push({ text: 'No data for this period.', italics: true, color: '#64748b' });
  }
  return out;
}

// ---------------------------------------------------------------- XLSX Summary sheet

/** Excel number format and value for a KPI (durations as Excel time so they add up). */
function excelValue(v: number | null, f: ValueFormat): { value: number | null; numFmt: string } {
  if (v === null || !Number.isFinite(v)) return { value: null, numFmt: '@' };
  switch (f) {
    case 'km':
      return { value: v, numFmt: '#,##0.0 "km"' };
    case 'hm':
      return { value: v / 86400, numFmt: '[h]:mm' };
    case 'hours':
      return { value: v / 24, numFmt: '[h]:mm' };
    case 'sec':
      return { value: v / 86400, numFmt: '[h]:mm:ss' };
    case 'pct':
      return { value: v / 100, numFmt: '0.0%' };
    case 'kph':
      return { value: v, numFmt: '0 "km/h"' };
    case 'litres':
      return { value: v, numFmt: '#,##0.0 "L"' };
    case 'kmpl':
      return { value: v, numFmt: '0.00 "km/L"' };
    default:
      return { value: v, numFmt: '#,##0' };
  }
}

const HEAD_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0E5E57' } };
const SOFT_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };

/** First sheet of the workbook: cover facts, KPI table and the data behind each chart. */
export function addXlsxSummary(wb: ExcelJS.Workbook, data: ReportData, title: string, generated: string, s: ReportSummary): ExcelJS.Worksheet {
  const ws = wb.addWorksheet('Summary', { properties: { tabColor: { argb: 'FF0E5E57' } }, pageSetup: { orientation: 'portrait', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  ws.getColumn(1).width = 34;
  ws.getColumn(2).width = 22;
  ws.getColumn(3).width = 22;
  ws.getColumn(4).width = 22;
  for (let c = 5; c <= 14; c++) ws.getColumn(c).width = 14;
  // Logo (PNG / JPEG only: Excel cannot show SVG) above the company name.
  if (s.logo && (s.logo.mime === 'image/png' || s.logo.mime === 'image/jpeg')) {
    const id = wb.addImage({ buffer: s.logo.data as unknown as ExcelJS.Buffer, extension: s.logo.mime === 'image/png' ? 'png' : 'jpeg' });
    ws.addImage(id, { tl: { col: 0, row: 0 }, ext: { width: 150, height: 56 }, editAs: 'oneCell' });
    for (let i = 0; i < 4; i++) ws.addRow([]);
  }
  ws.addRow([data.companyName]).font = { bold: true, size: 14, color: { argb: 'FF0E5E57' } };
  ws.addRow([title]).font = { bold: true, size: 12 };
  ws.addRow([]);
  const fact = (k: string, v: string) => {
    const r = ws.addRow([k, v]);
    r.getCell(1).font = { color: { argb: 'FF64748B' } };
    ws.mergeCells(r.number, 2, r.number, 6);
  };
  fact('Period', data.from === data.to ? data.from : `${data.from} to ${data.to}`);
  fact('Time zone', `${zoneLine(data.tz)} (all times in this workbook)`);
  for (const f of s.filters) fact(f.label, f.value);
  fact('Rows', rowsLine(data, s));
  fact('Generated', generated.replace(/^Generated: /, ''));
  if (s.viewNote) ws.addRow([s.viewNote]).font = { italic: true, color: { argb: 'FFB45309' } };
  const ins = s.insight;
  if (!ins) {
    ws.addRow([]);
    ws.addRow(['The report table is on the next sheet.']).font = { italic: true, color: { argb: 'FF64748B' } };
    return ws;
  }
  const header = (cells: string[]) => {
    const r = ws.addRow(cells);
    r.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    r.eachCell((c) => (c.fill = HEAD_FILL));
    return r;
  };
  const section = (text: string) => {
    ws.addRow([]);
    ws.addRow([text]).font = { bold: true, size: 12 };
  };

  section('Key figures');
  header(['Figure', 'Value', 'As shown', 'Note']);
  for (const k of ins.kpis) {
    const ev = excelValue(k.value, k.format);
    const notes = [k.hint ? interpolate(k.hint.text, k.hint.vars) : '', k.fromRows && s.partial ? `From the ${s.rowsUsed} rows in this file` : ''].filter(Boolean).join(' · ');
    const r = ws.addRow([k.label, ev.value, fmt(k.value, k.format), notes]);
    r.getCell(2).numFmt = ev.numFmt;
    r.getCell(2).alignment = { horizontal: 'right' };
    r.getCell(3).alignment = { horizontal: 'right' };
    if (k.tone === 'danger') r.getCell(3).font = { color: { argb: 'FFDC2626' }, bold: true };
  }

  for (const c of ins.charts) {
    if (c.kind === 'bars') {
      if (!c.data.length) continue;
      section(c.title);
      const extras = c.data[0]?.extra?.map((e) => e.label) ?? [];
      header([c.select === 'day' ? 'Day' : 'Period', ...c.segments.map((g) => g.label), ...extras]);
      for (const d of c.data) {
        const r = ws.addRow([d.key, ...c.segments.map((g) => d.values[g.key] ?? 0), ...(d.extra ?? []).map((e) => e.value)]);
        if (c.format === 'hours') c.segments.forEach((_, i) => (r.getCell(i + 2).numFmt = '0.0 "h"'));
        (d.extra ?? []).forEach((e, i) => (r.getCell(c.segments.length + 2 + i).numFmt = excelValue(e.value, e.format).numFmt));
      }
    } else if (c.kind === 'histogram') {
      if (!c.bins.length) continue;
      section(c.title);
      header(['Duration', ...c.segments.map((g) => g.label)]);
      for (const b of c.bins) ws.addRow([b.label, ...c.segments.map((g) => b.values[g.key] ?? 0)]);
      if (c.skipped) ws.addRow([`${c.skipped} without a duration not counted`]).font = { italic: true, color: { argb: 'FF64748B' } };
    } else if (c.kind === 'ranked') {
      if (!c.items.length) continue;
      section(c.total > c.items.length ? `${c.title} (top ${c.items.length} of ${c.total})` : c.title);
      header(['#', 'Name', 'Detail', 'Value', 'As shown']);
      c.items.forEach((it, i) => {
        const ev = excelValue(it.value, c.format);
        const r = ws.addRow([i + 1, it.label, it.sub ?? '', ev.value, fmt(it.value, c.format)]);
        r.getCell(4).numFmt = ev.numFmt;
      });
    } else {
      if (!c.rows.length) continue;
      section(c.title);
      header(['Vehicle', ...c.cols.map((col) => col.label), 'Total']);
      for (const r of c.rows) {
        const row = ws.addRow([r.label, ...c.cols.map((col) => c.cells[`${r.key}|${col.key}`]?.count ?? 0), r.total]);
        c.cols.forEach((col, i) => {
          if ((c.cells[`${r.key}|${col.key}`]?.count ?? 0) > 0) row.getCell(i + 2).fill = SOFT_FILL;
        });
      }
      if (c.hiddenRows || c.hiddenCols) ws.addRow([`Busiest ${c.rows.length} vehicles and ${c.cols.length} event types; the report sheet has every row.`]).font = { italic: true, color: { argb: 'FF64748B' } };
    }
  }
  ws.addRow([]);
  const foot = [
    'Figures come from the same rows and totals as the report sheet. Excel charts are not embedded: the data behind each on-screen chart is listed above.',
    ...(s.partial ? [`More rows matched (${s.totalRows}) than this file holds (${s.rowsUsed}): figures marked as from the rows in this file, and the chart data, cover those rows only.`] : []),
  ];
  for (const f of foot) ws.addRow([f]).font = { italic: true, color: { argb: 'FF64748B' } };
  return ws;
}
