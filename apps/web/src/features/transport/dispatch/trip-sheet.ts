/**
 * Trip sheets (Dispatch): one printable sheet per published trip — vehicle, driver, stops with planned times, the
 * passenger list with Boarded / Time / Signature columns, and odometer / signature lines for the driver. Download as
 * PDF (one page per trip, jsPDF loaded on demand) or as one CSV for Excel. `toSheet` / `tripSheetsCsv` are pure.
 */
import type { TransportTripDto } from '@veetracer/shared';

export interface SheetTrip {
  title: string;
  vehicle: string;
  driver: string;
  shift: string;
  plannedStart: string;
  stops: { seq: number; time: string; actual: string; name: string; pickups: string[]; drops: string[] }[];
  passengers: { n: number; name: string; code: string; pickup: string; drop: string; seats: number; status: string; boarded: string; time: string }[];
}

/** One trip → sheet rows. `clock` formats an ISO time in the company zone (HH:mm). */
export function toSheet(t: Pick<TransportTripDto, 'name' | 'vehicleName' | 'plateNumber' | 'driverName' | 'shiftName' | 'plannedStart' | 'stops' | 'passengers' | 'direction'>, clock: (iso: string) => string): SheetTrip {
  const stops = [...t.stops].sort((a, b) => a.seq - b.seq);
  const stopName = new Map(stops.map((s) => [s.seq, s.name]));
  const people = t.passengers.filter((p) => p.status !== 'CANCELLED');
  // Passengers in the order they are met: IN by pickup stop, OUT by drop stop.
  const ordered = [...people].sort((a, b) => (t.direction === 'OUT' ? a.dropSeq - b.dropSeq : a.pickupSeq - b.pickupSeq) || a.passenger.displayName.localeCompare(b.passenger.displayName));
  return {
    title: t.name,
    vehicle: [t.vehicleName, t.plateNumber].filter(Boolean).join(' · ') || '—',
    driver: t.driverName ?? '—',
    shift: t.shiftName ?? '—',
    plannedStart: t.plannedStart ? clock(t.plannedStart) : '—',
    stops: stops.map((s) => ({
      seq: s.seq + 1,
      time: clock(s.plannedArrival),
      actual: s.actualArrival ? clock(s.actualArrival) : '',
      name: s.name,
      pickups: people.filter((p) => p.pickupSeq === s.seq).map((p) => p.passenger.displayName),
      drops: people.filter((p) => p.dropSeq === s.seq).map((p) => p.passenger.displayName),
    })),
    passengers: ordered.map((p, i) => ({
      n: i + 1,
      name: p.passenger.displayName,
      code: p.passenger.employeeCode,
      pickup: p.pickupLabel ?? stopName.get(p.pickupSeq) ?? '',
      drop: p.dropLabel ?? stopName.get(p.dropSeq) ?? '',
      seats: p.seats,
      status: p.status,
      boarded: p.status === 'BOARDED' || p.status === 'DROPPED' ? 'Yes' : p.status === 'NO_SHOW' ? 'No-show' : '',
      time: p.boardedAt ? clock(p.boardedAt) : '',
    })),
  };
}

const csvCell = (v: string | number) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** All sheets as one CSV (one line per passenger, trip columns repeated), with a BOM so Excel reads UTF-8. */
export function tripSheetsCsv(sheets: SheetTrip[], meta: { date: string; direction: string }): string {
  const head = ['Date', 'Direction', 'Trip', 'Vehicle', 'Driver', 'Shift', 'Start', 'No', 'Passenger', 'Employee code', 'Pickup', 'Drop', 'Seats', 'Status', 'Boarded', 'Time', 'Signature'];
  const lines = [head.join(',')];
  for (const s of sheets) {
    for (const p of s.passengers) lines.push([meta.date, meta.direction, s.title, s.vehicle, s.driver, s.shift, s.plannedStart, p.n, p.name, p.code, p.pickup, p.drop, p.seats, p.status, p.boarded, p.time, ''].map(csvCell).join(','));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

/** One A4 page (or more) per trip. */
export async function downloadTripSheetsPdf(sheets: SheetTrip[], meta: { company: string; date: string; direction: string; printedAt: string }, filename: string | null): Promise<{ output: (type: 'arraybuffer') => ArrayBuffer }> {
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ unit: 'pt', format: 'a4', compress: true });
  const W = pdf.internal.pageSize.getWidth();
  const H = pdf.internal.pageSize.getHeight();
  const M = 36;
  let y = M;

  const ensure = (h: number) => {
    if (y + h > H - M) {
      pdf.addPage();
      y = M;
    }
  };
  const table = (cols: { title: string; w: number }[], rows: string[][]) => {
    const pad = 4;
    const lineH = 11;
    const drawHead = () => {
      pdf.setFont('helvetica', 'bold').setFontSize(8.5).setFillColor(234, 240, 248);
      pdf.rect(M, y, W - 2 * M, 16, 'F');
      let x = M;
      for (const c of cols) {
        pdf.text(c.title, x + pad, y + 11);
        x += c.w;
      }
      y += 16;
      pdf.setFont('helvetica', 'normal');
    };
    ensure(32);
    drawHead();
    for (const r of rows) {
      const wrapped = r.map((cell, i) => pdf.splitTextToSize(cell ?? '', cols[i].w - 2 * pad) as string[]);
      const h = Math.max(18, Math.max(...wrapped.map((w) => w.length)) * lineH + 7);
      if (y + h > H - M) {
        pdf.addPage();
        y = M;
        drawHead();
      }
      let x = M;
      pdf.setDrawColor(210, 214, 220);
      for (let i = 0; i < cols.length; i++) {
        pdf.rect(x, y, cols[i].w, h);
        pdf.text(wrapped[i], x + pad, y + 12);
        x += cols[i].w;
      }
      y += h;
    }
    y += 10;
  };

  sheets.forEach((s, i) => {
    if (i > 0) pdf.addPage();
    y = M;
    pdf.setFont('helvetica', 'bold').setFontSize(15).setTextColor(15, 95, 168);
    pdf.text('Trip sheet', M, y + 12);
    pdf.setFontSize(9).setTextColor(90, 100, 115).setFont('helvetica', 'normal');
    pdf.text(`${meta.company} · ${meta.date} · ${meta.direction}`, W - M, y + 12, { align: 'right' });
    y += 26;
    pdf.setTextColor(20, 25, 35).setFontSize(10);
    const facts: [string, string][] = [
      ['Trip', s.title],
      ['Vehicle', s.vehicle],
      ['Driver', s.driver],
      ['Shift', s.shift],
      ['Planned start', s.plannedStart],
      ['Passengers', String(s.passengers.length)],
    ];
    const colW = (W - 2 * M) / 2;
    facts.forEach(([k, v], k2) => {
      const x = M + (k2 % 2) * colW;
      if (k2 % 2 === 0 && k2 > 0) y += 15;
      pdf.setFont('helvetica', 'bold').text(`${k}:`, x, y);
      pdf.setFont('helvetica', 'normal').text(pdf.splitTextToSize(v, colW - 80)[0] ?? '', x + 72, y);
    });
    y += 22;

    pdf.setFont('helvetica', 'bold').setFontSize(11).text('Stops', M, y);
    y += 6;
    const sw = W - 2 * M;
    table(
      [
        { title: '#', w: 24 },
        { title: 'Planned', w: 46 },
        { title: 'Actual', w: 42 },
        { title: 'Stop', w: sw * 0.3 },
        { title: 'Pick up', w: (sw - 112 - sw * 0.3) / 2 },
        { title: 'Drop', w: (sw - 112 - sw * 0.3) / 2 },
      ],
      s.stops.map((st) => [String(st.seq), st.time, st.actual, st.name, st.pickups.join(', '), st.drops.join(', ')]),
    );

    ensure(40);
    pdf.setFont('helvetica', 'bold').setFontSize(11).text('Passengers', M, y);
    y += 6;
    table(
      [
        { title: '#', w: 22 },
        { title: 'Name', w: 100 },
        { title: 'Emp code', w: 74 },
        { title: 'Pickup', w: 105 },
        { title: 'Drop', w: 85 },
        { title: 'Boarded', w: 44 },
        { title: 'Time', w: 40 },
        { title: 'Signature', w: sw - 470 },
      ],
      s.passengers.map((p) => [String(p.n), p.name, p.code, p.pickup, p.drop, p.boarded || '[  ]', p.time, '']),
    );

    ensure(70);
    pdf.setFont('helvetica', 'normal').setFontSize(9.5);
    const line = (label: string, x: number, w: number) => {
      pdf.text(label, x, y);
      pdf.line(x + pdf.getTextWidth(label) + 4, y + 2, x + w, y + 2);
    };
    y += 14;
    line('Odometer start', M, 230);
    line('Odometer end', M + 270, sw - 270);
    y += 26;
    line('Driver signature', M, 230);
    line('Supervisor', M + 270, sw - 270);
    y += 26;
    line('Toll / parking (Rs)', M, 230);
    line('Remarks', M + 270, sw - 270);
    y += 22;
    pdf.setFontSize(7.5).setTextColor(120, 128, 140).text(`Printed ${meta.printedAt}`, M, y);
    pdf.setTextColor(20, 25, 35);
  });
  if (filename) pdf.save(filename);
  return pdf;
}
