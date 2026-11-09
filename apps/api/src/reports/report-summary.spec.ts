import ExcelJS from 'exceljs';
import { reportRowKey } from '@veetracer/shared';
import { ReportData } from './report-data.service';
import { FileSection, renderReport, xlsxSheetName } from './report-files';
import { barsSvg, buildSummary, describeOptions, rankedSvg, shortKey, zoneLine } from './report-summary';
import { applyView } from './reports.controller';

const NOW = Date.parse('2026-11-09T12:00:00Z');

/** A small Stops section (synthetic rows shaped like StopDto). */
function stops(): ReportData {
  const row = (i: number, obj: string, min: number, idle = false) => ({
    id: `s${i}`,
    objectId: obj,
    objectName: obj === 'o1' ? 'Bus 07' : 'Car 01',
    startTime: `2026-11-0${3 + (i % 3)}T0${i % 9}:00:00.000Z`,
    endTime: `2026-11-0${3 + (i % 3)}T0${i % 9}:30:00.000Z`,
    durationSec: min * 60,
    lat: 13,
    lng: 80,
    address: i === 0 ? 'Depot <A&B>' : null,
    ignitionOn: idle,
    poiName: null,
  });
  const rows = [row(0, 'o1', 4), row(1, 'o1', 20), row(2, 'o2', 45, true), row(3, 'o2', 300)];
  return {
    type: 'STOPS',
    from: '2026-11-03',
    to: '2026-11-09',
    rows,
    totals: { count: 4, durationSec: rows.reduce((s, r) => s + r.durationSec, 0) },
    companyName: 'Demo Logistics',
    tz: 'Asia/Kolkata',
    truncated: false,
    totalRows: 4,
  };
}

describe('report export cover (batch 2)', () => {
  it('describes options by name, only those the type uses', () => {
    expect(describeOptions('HALT', { minDurationMin: 45, alertTypes: ['OVERSPEED'] })).toEqual([{ label: 'Minimum duration', value: '45 min' }]);
    expect(describeOptions('ALERTS', { alertTypes: ['OVERSPEED', 'SOS'] })[0].value).toMatch(/^Overspeed, /);
    expect(describeOptions('TRIPS', { minDurationMin: 5 })).toEqual([]);
    expect(describeOptions('STOPS', undefined)).toEqual([]);
  });

  it('labels zones and period keys', () => {
    expect(zoneLine('Asia/Kolkata', NOW)).toBe('Asia/Kolkata (GMT+05:30)');
    expect(zoneLine('UTC', NOW)).toBe('UTC (GMT+00:00)');
    expect(shortKey('2026-11-03')).toBe('3 Nov');
    expect(shortKey('2026-W45')).toBe('W45');
    expect(shortKey('2026-11')).toBe('Nov 26');
  });

  it('builds the KPI block from totals and rows, like the page', () => {
    const s = buildSummary(stops(), [], null);
    const kpi = Object.fromEntries(s.insight!.kpis.map((k) => [k.id, k.value]));
    expect(kpi).toMatchObject({ count: 4, time: (4 + 20 + 45 + 300) * 60, avg: Math.round(((4 + 20 + 45 + 300) * 60) / 4), longest: 300 * 60, vehicles: 2, idleStops: 1 });
    expect(s.insight!.charts[0]).toMatchObject({ kind: 'histogram', field: 'durationSec' });
  });

  it('escapes text in chart SVG', () => {
    expect(rankedSvg([{ label: 'A&B <x>', value: 3 }], 200, 'int')).toContain('A&amp;B &lt;x&gt;');
    const svg = barsSvg([{ label: '3 Nov', values: { a: 2 } }], [{ key: 'a', label: 'A', tone: 'primary' }], 300, 120, 'int');
    expect(svg).toMatch(/^<svg [^>]*width="300"/);
    expect(svg).toContain('<rect');
  });

  it('PDF with a cover renders; without one the PDF has one page fewer', async () => {
    const plain = await renderReport([stops()], 'PDF', NOW);
    const cover = await renderReport([{ ...stops(), summary: buildSummary(stops(), [{ label: 'Vehicles', value: 'Bus 07' }], null) }], 'PDF', NOW);
    const pages = (b: Buffer) => (b.toString('latin1').match(/\/Type \/Page\b/g) ?? []).length;
    expect(cover.buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pages(cover.buffer)).toBe(pages(plain.buffer) + 1);
  });

  it('XLSX with a cover starts with a Summary sheet holding KPIs and chart data', async () => {
    const data = stops();
    const file = await renderReport([{ ...data, summary: buildSummary(data, [{ label: 'Minimum duration', value: '5 min' }], null) }], 'XLSX', NOW);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(file.buffer as never);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Summary', 'Stops']);
    const text: string[] = [];
    wb.worksheets[0].eachRow((r) => text.push((r.values as unknown[]).slice(1, 3).map(String).join(' | ')));
    expect(text).toEqual(expect.arrayContaining(['Minimum duration | 5 min', 'Stops | 4', 'Key figures', 'Stops by duration', '<5 min | 1']));
    // The report sheet is unchanged: header row + 4 rows + totals.
    expect(wb.worksheets[1].getRow(6).values).toContain('Vehicle');
  });

  it('CSV ignores the cover and is byte-identical to a plain export', async () => {
    const data = stops();
    const plain = await renderReport([data], 'CSV', NOW);
    const withCover = await renderReport([{ ...data, summary: buildSummary(data, [], null) }], 'CSV', NOW);
    expect(withCover.buffer.equals(plain.buffer)).toBe(true);
  });

  it('filtered view keeps the named rows in page order, drops totals and hidden columns', async () => {
    const data = stops();
    const keys = [data.rows[3], data.rows[0]].map((r) => reportRowKey(r as never)).join('') + 'zzzzzzzz';
    const section: FileSection = { ...data };
    applyView(section, { rows: keys, hiddenColumns: ['Location', 'POI'], label: 'Vehicle: Car 01' }, 5000);
    expect(section.rows.map((r) => (r as { id: string }).id)).toEqual(['s3', 's0']);
    expect(section.totals).toBeUndefined();
    expect(section.notes?.join(' ')).toMatch(/Filtered view \(Vehicle: Car 01\): 2 of 4 rows.*1 of the selected rows were not found/);
    const csv = (await renderReport([section], 'CSV', NOW)).buffer.toString('utf8');
    const header = csv.split('\r\n').find((l) => l.startsWith('Vehicle'))!;
    expect(header).not.toMatch(/Location|POI/);
    expect(csv).not.toMatch(/^Total/m);
  });

  it('row keys ignore addresses (filled best-effort per run)', () => {
    const r = stops().rows[0] as Record<string, unknown>;
    expect(reportRowKey({ ...r, address: null })).toBe(reportRowKey(r));
    expect(reportRowKey({ ...r, durationSec: 1 })).not.toBe(reportRowKey(r));
  });

  it('sheet names drop characters Excel forbids (Halt / Ignition on/off / AC / Door used to fail)', () => {
    expect(xlsxSheetName('Halt / long stoppage report')).toBe('Halt-long stoppage');
    expect(xlsxSheetName('Ignition on/off report')).toBe('Ignition on-off');
    expect(xlsxSheetName('AC / Door daily totals report')).toBe('AC-Door daily totals');
    expect(xlsxSheetName('Trips report')).toBe('Trips');
  });

  it('HALT exports to XLSX', async () => {
    const file = await renderReport([{ ...stops(), type: 'HALT' }], 'XLSX', NOW);
    expect(file.buffer.length).toBeGreaterThan(1000);
  });
});
