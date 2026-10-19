import { PERIOD_REPORT_TYPES, ReportFormat } from '@veetracer/shared';
import ExcelJS from 'exceljs';
import { dirname } from 'node:path';
import pdfmake from 'pdfmake';
import type { Content, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces';
import { toCsv } from '../common/csv';
import { formatLocal } from '../summarizer/tz';
import { Cell, columnsFor, REPORT_TITLES } from './report-columns';
import { ReportData } from './report-data.service';

/** Row limits per file format (PDF rendering is the slowest). */
export const FILE_MAX_ROWS: Record<ReportFormat, number> = { XLSX: 50_000, CSV: 50_000, PDF: 5_000 };

export const CONTENT_TYPES: Record<ReportFormat, string> = {
  XLSX: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  PDF: 'application/pdf',
  CSV: 'text/csv; charset=utf-8',
};

const EXT: Record<ReportFormat, string> = { XLSX: 'xlsx', PDF: 'pdf', CSV: 'csv' };

export interface RenderedReport {
  buffer: Buffer;
  fileName: string;
  contentType: string;
}

interface Prepared {
  title: string;
  periodLine: string;
  note: string | null;
  headers: string[];
  widths: number[];
  numeric: boolean[];
  rows: Cell[][];
  totals: Cell[] | null;
}

function prepare(data: ReportData): Prepared {
  const cols = columnsFor(data.type);
  const rows = data.rows.map((r) => cols.map((c) => c.value(r as never, data.tz)));
  const hasTotals = cols.some((c) => c.total);
  const periodLabel = PERIOD_REPORT_TYPES.includes(data.type) && data.period ? ` · grouped by ${data.period.toLowerCase()}` : '';
  return {
    title: REPORT_TITLES[data.type],
    periodLine: `Period: ${data.from} to ${data.to} (${data.tz})${periodLabel}`,
    note: data.truncated ? `Showing the first ${data.rows.length} of ${data.totalRows} rows; totals cover all rows.` : null,
    headers: cols.map((c) => c.header),
    widths: cols.map((c) => c.width),
    numeric: cols.map((c) => !!c.numeric),
    rows,
    totals: hasTotals && data.totals ? cols.map((c) => (c.total ? c.total(data.totals!) : '')) : null,
  };
}

export function reportFileName(sections: ReportData[], format: ReportFormat): string {
  const first = sections[0];
  const kind = sections.length === 1 ? first.type.toLowerCase().replace(/_/g, '-') : 'report';
  const span = first.from === first.to ? first.from : `${first.from}_${first.to}`;
  return `${kind}-${span}.${EXT[format]}`;
}

export async function renderReport(sections: ReportData[], format: ReportFormat, now = Date.now()): Promise<RenderedReport> {
  if (!sections.length) throw new Error('No report sections');
  const generated = `Generated: ${formatLocal(now, sections[0].tz)} (${sections[0].tz})`;
  const buffer =
    format === 'XLSX' ? await renderXlsx(sections, generated) : format === 'PDF' ? await renderPdf(sections, generated) : renderCsv(sections, generated);
  return { buffer, fileName: reportFileName(sections, format), contentType: CONTENT_TYPES[format] };
}

async function renderXlsx(sections: ReportData[], generated: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'VeeTrax';
  wb.created = new Date();
  const used = new Set<string>();
  for (const data of sections) {
    const p = prepare(data);
    let name = p.title.replace(/ report$/, '').slice(0, 28);
    while (used.has(name)) name = `${name.slice(0, 26)}_${used.size}`;
    used.add(name);
    const ws = wb.addWorksheet(name, { pageSetup: { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
    ws.addRow([data.companyName]).font = { bold: true, size: 14 };
    ws.addRow([p.title]).font = { bold: true, size: 12 };
    ws.addRow([p.periodLine]);
    ws.addRow([generated]);
    if (p.note) ws.addRow([p.note]).font = { italic: true, color: { argb: 'FFB45309' } };
    ws.addRow([]);
    const header = ws.addRow(p.headers);
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    header.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0E5E57' } };
      cell.alignment = { vertical: 'middle' };
    });
    const headerRow = header.number;
    for (const r of p.rows) ws.addRow(r);
    if (p.totals) {
      const t = ws.addRow(p.totals);
      t.font = { bold: true };
      t.eachCell((cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E8F0' } };
        cell.border = { top: { style: 'thin' } };
      });
    }
    p.widths.forEach((w, i) => {
      const column = ws.getColumn(i + 1);
      column.width = w + 2;
      if (p.numeric[i]) column.alignment = { horizontal: 'right' };
    });
    ws.views = [{ state: 'frozen', ySplit: headerRow }];
    if (p.rows.length) ws.autoFilter = { from: { row: headerRow, column: 1 }, to: { row: headerRow, column: p.headers.length } };
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

let pdfReady = false;
function setupPdf(): void {
  if (pdfReady) return;
  const regular = require.resolve('pdfmake/fonts/Roboto/Roboto-Regular.ttf');
  const fontDir = dirname(regular);
  pdfmake.setFonts({
    Roboto: {
      normal: regular,
      bold: `${fontDir}/Roboto-Medium.ttf`,
      italics: `${fontDir}/Roboto-Italic.ttf`,
      bolditalics: `${fontDir}/Roboto-MediumItalic.ttf`,
    },
  });
  // Report content never references external or local resources besides the bundled fonts.
  pdfmake.setUrlAccessPolicy(() => false);
  pdfmake.setLocalAccessPolicy((path: string) => path.startsWith(fontDir));
  pdfReady = true;
}

/** A4 landscape minus page margins (pt). */
const PDF_TABLE_WIDTH = 842 - 56;
const PDF_CELL_PADDING = 8;
/** Approximate width of one bold 7.5 pt header character (pt). */
const PDF_HEADER_CHAR = 4.4;

/**
 * Column widths (percentages) proportional to the column weights, but never narrower than the longest word of the
 * header, so wide columns such as addresses cannot squeeze short numeric columns until their headers overflow.
 */
export function pdfColumnWidths(weights: number[], headers: string[]): string[] {
  const content = PDF_TABLE_WIDTH - weights.length * PDF_CELL_PADDING;
  const mins = headers.map((h) => Math.max(...h.split(/\s+/).map((w) => w.length)) * PDF_HEADER_CHAR + 2);
  const fixed = new Set<number>();
  let out: number[] = [];
  for (let pass = 0; pass <= weights.length; pass++) {
    const free = content - [...fixed].reduce((s, i) => s + mins[i], 0);
    const weightSum = weights.reduce((s, w, i) => (fixed.has(i) ? s : s + w), 0);
    out = weights.map((w, i) => (fixed.has(i) ? mins[i] : weightSum > 0 ? (w / weightSum) * free : 0));
    const under = out.findIndex((x, i) => !fixed.has(i) && x < mins[i]);
    if (under < 0 || free <= 0) break;
    fixed.add(under);
  }
  const sum = out.reduce((a, b) => a + b, 0) || 1;
  return out.map((x) => `${((x / sum) * 100).toFixed(2)}%`);
}

async function renderPdf(sections: ReportData[], generated: string): Promise<Buffer> {
  setupPdf();
  const content: Content[] = [];
  sections.forEach((data, index) => {
    const p = prepare(data);
    const head: TableCell[] = p.headers.map((h, i) => ({ text: h, style: 'th', alignment: p.numeric[i] ? 'right' : 'left' }));
    const body: TableCell[][] = [head];
    for (const r of p.rows) body.push(r.map((v, i) => ({ text: String(v), alignment: p.numeric[i] ? 'right' : 'left' })));
    if (p.totals) body.push(p.totals.map((v, i) => ({ text: String(v), bold: true, fillColor: '#e2e8f0', alignment: p.numeric[i] ? 'right' : 'left' })));
    if (!p.rows.length) body.push(p.headers.map((_, i) => ({ text: i === 0 ? 'No data for this period' : '', italics: true, color: '#64748b' })));
    content.push(
      { text: data.companyName, style: 'company', pageBreak: index > 0 ? 'before' : undefined },
      { text: p.title, style: 'title' },
      { text: p.periodLine, style: 'meta' },
      { text: generated, style: 'meta', margin: [0, 0, 0, p.note ? 2 : 8] },
      ...(p.note ? [{ text: p.note, style: 'note', margin: [0, 0, 0, 8] } as Content] : []),
      {
        table: { headerRows: 1, dontBreakRows: true, widths: pdfColumnWidths(p.widths, p.headers), body },
        layout: {
          fillColor: (row: number) => (row === 0 ? '#0e5e57' : row % 2 === 0 ? '#f8fafc' : null),
          hLineWidth: (i: number) => (i === 0 || i === 1 ? 0 : 0.5),
          vLineWidth: () => 0,
          hLineColor: () => '#e2e8f0',
          paddingTop: () => 3,
          paddingBottom: () => 3,
          paddingLeft: () => 4,
          paddingRight: () => 4,
        },
      },
    );
  });
  const doc: TDocumentDefinitions = {
    pageSize: 'A4',
    pageOrientation: 'landscape',
    pageMargins: [28, 28, 28, 34],
    info: { title: sections.map((s) => REPORT_TITLES[s.type]).join(', '), creator: 'VeeTrax' },
    defaultStyle: { font: 'Roboto', fontSize: 7.5, color: '#0f172a' },
    styles: {
      company: { fontSize: 13, bold: true, color: '#0e5e57' },
      title: { fontSize: 11, bold: true, margin: [0, 2, 0, 2] },
      meta: { fontSize: 8, color: '#475569' },
      note: { fontSize: 8, italics: true, color: '#b45309' },
      th: { bold: true, color: '#ffffff' },
    },
    footer: (current: number, count: number) => ({
      columns: [
        { text: `${sections[0].companyName} · VeeTrax`, fontSize: 7, color: '#94a3b8' },
        { text: `Page ${current} of ${count}`, alignment: 'right', fontSize: 7, color: '#94a3b8' },
      ],
      margin: [28, 10, 28, 0],
    }),
    content,
  };
  return pdfmake.createPdf(doc).getBuffer();
}

function renderCsv(sections: ReportData[], generated: string): Buffer {
  const parts: string[] = [];
  sections.forEach((data, index) => {
    const p = prepare(data);
    const meta = [[data.companyName], [p.title], [p.periodLine], [generated], ...(p.note ? [[p.note]] : []), []];
    const lines: Cell[][] = [...meta, p.headers, ...p.rows, ...(p.totals ? [p.totals] : [])];
    const width = p.headers.length;
    const csv = toCsv(
      lines,
      Array.from({ length: width }, (_, i) => ({ header: '', value: (row: Cell[]) => row[i] ?? '' })),
    );
    // toCsv emits a BOM + an (empty) header line: keep the BOM once, drop the header line.
    const body = csv.replace(/^﻿/, '').split('\r\n').slice(1).join('\r\n');
    parts.push(index === 0 ? `﻿${body}` : `\r\n${body}`);
  });
  return Buffer.from(parts.join(''), 'utf8');
}
