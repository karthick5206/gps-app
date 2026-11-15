import type { BranchDto, TransportVendorDto, VendorStatementDto } from '@veetracer/shared';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangleIcon, FileDownIcon, ReceiptIndianRupeeIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormError } from '@/components/form-error';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/features/auth/auth-context';
import { EmptyHint, Panel } from '@/features/dashboard/refresh/kit';
import { named, useEntityOptions } from '@/features/masters/use-options';
import { getReportTimeZone, todayInZone } from '@/features/reports/report-time';
import { api, errorMessage } from '@/lib/api';

const inr = (n: number) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function statementCsv(s: VendorStatementDto, tz: string): string {
  const time = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('en-IN', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }) : '');
  const head = ['Date', 'Vehicle', 'Plate', 'Driver', 'Trip', 'Direction', 'Start', 'End', 'Km', 'Employees', 'Night', 'Rate card', 'Basis', 'Base ₹', 'Add-ons ₹', 'Add-on detail', 'Amount ₹', 'Issue'];
  const rows = s.lines.map((l) => [l.day, l.vehicle, l.plateNumber, l.driver, l.trip, l.direction === 'OUT' ? 'Logout' : 'Login', time(l.start), time(l.end), l.km, l.passengers, l.night ? 'Yes' : '', l.rateCard, l.basis, l.base, l.addons, l.addonText.join('; '), l.amount, l.issue]);
  const veh = s.vehicles.filter((v) => v.monthly).map((v) => ['', v.vehicle, v.plateNumber, '', 'Monthly charge', '', '', '', v.km, '', '', '', v.monthly!.basis, v.monthly!.amount, '', '', v.monthly!.amount, '']);
  const tot = [[], ['', '', '', '', '', '', '', 'Total', s.totals.km, s.totals.passengers, '', '', '', '', '', 'Subtotal', s.totals.subtotal], ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', 'GST', s.totals.gst], ['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', 'Total', s.totals.total]];
  return `﻿${[head, ...rows, ...veh, ...tot].map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

async function statementPdf(s: VendorStatementDto, company: string, tz: string) {
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ unit: 'pt', format: 'a4', orientation: 'landscape', compress: true });
  const W = pdf.internal.pageSize.getWidth();
  const H = pdf.internal.pageSize.getHeight();
  const M = 30;
  let y = M;
  pdf.setFont('helvetica', 'bold').setFontSize(15).setTextColor(15, 95, 168).text('Vendor statement', M, y + 10);
  pdf.setFont('helvetica', 'normal').setFontSize(9).setTextColor(60, 60, 70);
  pdf.text(`${company} · ${s.month}`, W - M, y + 10, { align: 'right' });
  y += 26;
  pdf.setTextColor(20, 25, 35).setFontSize(10).text(`Vendor: ${s.vendor.name}${s.vendor.gstin ? `   GSTIN: ${s.vendor.gstin}` : ''}`, M, y);
  y += 16;
  const cols = [
    { t: 'Date', w: 60 },
    { t: 'Vehicle', w: 110 },
    { t: 'Driver', w: 80 },
    { t: 'Trip', w: 120 },
    { t: 'Km', w: 40 },
    { t: 'Emp', w: 30 },
    { t: 'Basis', w: 220 },
    { t: 'Add-ons', w: 60 },
    { t: 'Amount', w: W - 2 * M - 720 },
  ];
  const head = () => {
    pdf.setFont('helvetica', 'bold').setFontSize(8).setFillColor(234, 240, 248).rect(M, y, W - 2 * M, 15, 'F');
    let x = M;
    for (const c of cols) {
      pdf.text(c.t, x + 3, y + 10);
      x += c.w;
    }
    y += 15;
    pdf.setFont('helvetica', 'normal');
  };
  head();
  const row = (cells: string[], bold = false) => {
    if (y > H - M - 20) {
      pdf.addPage();
      y = M;
      head();
    }
    pdf.setFont('helvetica', bold ? 'bold' : 'normal').setFontSize(8);
    let x = M;
    cells.forEach((c, i) => {
      pdf.text((pdf.splitTextToSize(c ?? '', cols[i].w - 6) as string[])[0] ?? '', x + 3, y + 10);
      x += cols[i].w;
    });
    pdf.setDrawColor(225, 228, 233).line(M, y + 14, W - M, y + 14);
    y += 14;
  };
  void tz;
  for (const l of s.lines) row([l.day, `${l.vehicle}${l.plateNumber ? ` ${l.plateNumber}` : ''}`, l.driver ?? '', l.trip, String(l.km), String(l.passengers), l.issue ? `! ${l.issue}` : l.basis, l.addons ? l.addons.toFixed(2) : '', l.amount.toFixed(2)]);
  for (const v of s.vehicles.filter((x) => x.monthly)) row(['', `${v.vehicle}${v.plateNumber ? ` ${v.plateNumber}` : ''}`, '', 'Monthly charge', String(v.km), '', v.monthly!.basis, '', v.monthly!.amount.toFixed(2)]);
  y += 6;
  row(['', '', '', `Trips ${s.totals.trips}`, String(s.totals.km), String(s.totals.passengers), '', 'Subtotal', s.totals.subtotal.toFixed(2)], true);
  row(['', '', '', '', '', '', '', 'GST', s.totals.gst.toFixed(2)], true);
  row(['', '', '', '', '', '', '', 'Total', s.totals.total.toFixed(2)], true);
  pdf.save(`vendor-statement-${s.vendor.name.replace(/[^\w-]+/g, '_')}-${s.month}.pdf`);
}

/**
 * Transport → Vendor billing (menu etms_billing, v1.16.9): the month's statement for one vendor (optionally one branch),
 * priced from the actual trips (GPS km, times, employees carried) and the vendor's rate cards; per trip and per
 * vehicle, with GST, as CSV or PDF. Comparing with the vendor's own bill and approving payment come later.
 */
export function VendorBillingPage() {
  const { t } = useTranslation();
  const { can, me } = useAuth();
  const tz = getReportTimeZone() ?? 'Asia/Kolkata';
  const today = todayInZone(tz);
  const [month, setMonth] = useState(today.slice(0, 7));
  const [vendorId, setVendorId] = useState('');
  const [branchId, setBranchId] = useState('');
  const vendors = useEntityOptions<TransportVendorDto>('/transport/vendors', named, { enabled: can('etms_vendors') || can('etms_billing') });
  const branches = useEntityOptions<BranchDto>('/branches', named, { enabled: can('branches') });
  const q = useQuery({
    queryKey: ['vendor-statement', month, vendorId, branchId],
    enabled: !!vendorId && /^\d{4}-\d{2}$/.test(month),
    queryFn: ({ signal }) => api.get<VendorStatementDto>('/transport/billing/statement', { month, vendorId, branchId: branchId || undefined }, signal),
  });
  const s = q.data;
  const sel = 'h-9 rounded-md border border-input bg-card px-2 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none';
  return (
    <div className="flex w-full min-w-0 flex-col gap-4 p-4 sm:p-6">
      <PageHeader title={t('Vendor billing')} description={t('Monthly statement per vendor from the actual trips and the vendor’s rate cards: per trip and per vehicle, with GST.')} />
      <div className="flex flex-wrap items-end gap-2">
        <label className="grid gap-1 text-xs">
          <span className="text-muted-foreground">{t('Month')}</span>
          <Input type="month" value={month} max={today.slice(0, 7)} onChange={(e) => setMonth(e.target.value)} className="h-9 w-40" />
        </label>
        <label className="grid gap-1 text-xs">
          <span className="text-muted-foreground">{t('Vendor')}</span>
          <select className={`${sel} w-56`} value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
            <option value="">{t('Choose a vendor')}</option>
            {vendors.options.map((v) => (
              <option key={v.value} value={v.value}>
                {v.label}
              </option>
            ))}
          </select>
        </label>
        {can('branches') && (
          <label className="grid gap-1 text-xs">
            <span className="text-muted-foreground">{t('Branch')}</span>
            <select className={`${sel} w-48`} value={branchId} onChange={(e) => setBranchId(e.target.value)}>
              <option value="">{t('All branches')}</option>
              {branches.options.map((b) => (
                <option key={b.value} value={b.value}>
                  {b.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {s && (
          <div className="flex gap-2 sm:ml-auto">
            <Button variant="outline" size="sm" onClick={() => download(`vendor-statement-${s.vendor.name.replace(/[^\w-]+/g, '_')}-${s.month}.csv`, statementCsv(s, tz), 'text/csv;charset=utf-8')}>
              <FileDownIcon /> CSV
            </Button>
            <Button variant="outline" size="sm" onClick={() => void statementPdf(s, me?.company.name ?? '', tz)}>
              <FileDownIcon /> PDF
            </Button>
          </div>
        )}
      </div>

      {q.isError && <FormError message={errorMessage(q.error)} />}
      {!vendorId && <EmptyHint icon={ReceiptIndianRupeeIcon} text={t('Choose a month and a vendor to see the statement.')} />}

      {s && (
        <>
          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-6">
            {(
              [
                ['Trips', String(s.totals.trips)],
                ['Km', String(s.totals.km)],
                ['Employees carried', String(s.totals.passengers)],
                ['Subtotal', inr(s.totals.subtotal)],
                ['GST', inr(s.totals.gst)],
                ['Total', inr(s.totals.total)],
              ] as const
            ).map(([label, v]) => (
              <div key={label} className="rounded-lg border bg-card px-3 py-2">
                <p className="text-xs text-muted-foreground">{t(label)}</p>
                <p className="text-lg font-semibold tabular-nums">{v}</p>
              </div>
            ))}
          </section>
          {s.totals.unpriced > 0 && (
            <p className="flex items-center gap-2 rounded-lg border border-warning/50 bg-warning/10 px-3 py-2 text-sm">
              <AlertTriangleIcon className="size-4 text-warning-fg" aria-hidden /> {t('{{n}} trip(s) could not be priced fully (no rate card, or no GPS km). They are marked below.', { n: s.totals.unpriced })}
            </p>
          )}
          <Panel title={t('Per vehicle')} id="bill-vehicles">
            {s.vehicles.length ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs text-muted-foreground uppercase">
                    <tr>
                      <th className="py-1.5 text-left font-medium">{t('Vehicle')}</th>
                      <th className="py-1.5 text-right font-medium">{t('Trips')}</th>
                      <th className="py-1.5 text-right font-medium">{t('Km')}</th>
                      <th className="py-1.5 text-right font-medium">{t('Employees')}</th>
                      <th className="py-1.5 text-left font-medium">{t('Monthly charge')}</th>
                      <th className="py-1.5 text-right font-medium">{t('Amount')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.vehicles.map((v) => (
                      <tr key={v.objectId} className="border-t">
                        <td className="py-1.5">
                          {v.vehicle}
                          {v.plateNumber && <span className="text-xs text-muted-foreground"> · {v.plateNumber}</span>}
                        </td>
                        <td className="py-1.5 text-right tabular-nums">{v.trips}</td>
                        <td className="py-1.5 text-right tabular-nums">{v.km}</td>
                        <td className="py-1.5 text-right tabular-nums">{v.passengers}</td>
                        <td className="py-1.5 text-xs text-muted-foreground">{v.monthly?.basis ?? '—'}</td>
                        <td className="py-1.5 text-right font-medium tabular-nums">{inr(v.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyHint icon={ReceiptIndianRupeeIcon} text={t('No finished trips of this vendor’s vehicles in the month.')} />
            )}
          </Panel>
          <Panel title={t('Per trip')} subtitle={t('Finished trips priced from GPS km, times and employees carried')} id="bill-trips">
            {s.lines.length ? (
              <div className="max-h-[60dvh] overflow-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-card text-xs text-muted-foreground uppercase">
                    <tr>
                      <th className="py-1.5 text-left font-medium">{t('Date')}</th>
                      <th className="py-1.5 text-left font-medium">{t('Vehicle')}</th>
                      <th className="py-1.5 text-left font-medium">{t('Trip')}</th>
                      <th className="py-1.5 text-right font-medium">{t('Km')}</th>
                      <th className="py-1.5 text-right font-medium">{t('Emp')}</th>
                      <th className="py-1.5 text-left font-medium">{t('Basis')}</th>
                      <th className="py-1.5 text-right font-medium">{t('Amount')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.lines.map((l) => (
                      <tr key={l.tripId} className="border-t align-top">
                        <td className="py-1.5 tabular-nums">{l.day}</td>
                        <td className="py-1.5">{l.vehicle}</td>
                        <td className="py-1.5">
                          {l.trip}
                          <span className="block text-xs text-muted-foreground">
                            {l.direction === 'OUT' ? t('Logout') : t('Login')}
                            {l.driver ? ` · ${l.driver}` : ''}
                            {l.night ? ` · ${t('Night')}` : ''}
                          </span>
                        </td>
                        <td className="py-1.5 text-right tabular-nums">{l.km}</td>
                        <td className="py-1.5 text-right tabular-nums">{l.passengers}</td>
                        <td className="py-1.5 text-xs">
                          {l.issue ? <span className="text-warning-fg">⚠ {t(l.issue)}</span> : l.basis}
                          {l.addonText.length > 0 && <span className="block text-muted-foreground">+ {l.addonText.join(', ')}</span>}
                          {l.rateCard && <span className="block text-muted-foreground">{l.rateCard}</span>}
                        </td>
                        <td className="py-1.5 text-right font-medium tabular-nums">{inr(l.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyHint icon={ReceiptIndianRupeeIcon} text={t('No finished trips in this month.')} />
            )}
          </Panel>
        </>
      )}
    </div>
  );
}
