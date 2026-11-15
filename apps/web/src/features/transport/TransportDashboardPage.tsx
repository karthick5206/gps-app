import type { TransportInsightsDto } from '@veetracer/shared';
import { useQuery } from '@tanstack/react-query';
import { AlarmClockIcon, BusIcon, CircleCheckIcon, FileDownIcon, GaugeIcon, RouteIcon, ShieldAlertIcon, TicketXIcon, UserXIcon, UsersRoundIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { FormError } from '@/components/form-error';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/features/auth/auth-context';
import { EmptyHint, KpiCard, Panel } from '@/features/dashboard/refresh/kit';
import { shiftDay } from '@/features/planned-trips/trip-format';
import { getReportTimeZone, todayInZone } from '@/features/reports/report-time';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';

type Preset = 'today' | 'yesterday' | 'week' | 'month' | 'lastMonth' | 'custom';

function rangeOf(p: Preset, today: string, custom: { from: string; to: string }): { from: string; to: string } {
  const [y, m] = today.split('-').map(Number);
  const first = `${today.slice(0, 7)}-01`;
  switch (p) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday':
      return { from: shiftDay(today, -1), to: shiftDay(today, -1) };
    case 'week':
      return { from: shiftDay(today, -6), to: today };
    case 'month':
      return { from: first, to: today };
    case 'lastMonth': {
      const lm = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
      return { from: `${lm}-01`, to: shiftDay(first, -1) };
    }
    default:
      return custom;
  }
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function downloadCsv(name: string, head: string[], rows: unknown[][]) {
  const text = `﻿${[head, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const fmtPct = (v: number | null) => (v === null ? '—' : `${v}%`);

/**
 * Transport dashboard (v1.16.7): management figures for a date range from GET /transport/insights — trips, people,
 * punctuality (pickups within 10 min of plan), seat use, km (GPS), no-shows, missed bookings, incidents — with a daily
 * trend, a per-vehicle table (trips / km: the basis of trip or km billing) and a per-shift table, each downloadable
 * as CSV. Replaces the E1a agreement-only page.
 */
export function TransportDashboardPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const today = todayInZone(getReportTimeZone());
  const [preset, setPreset] = useState<Preset>('week');
  const [custom, setCustom] = useState({ from: shiftDay(today, -6), to: today });
  const range = rangeOf(preset, today, custom);
  const q = useQuery({
    queryKey: ['transport-insights', range],
    queryFn: ({ signal }) => api.get<TransportInsightsDto>('/transport/insights', range, signal),
    enabled: can('etms_dashboard'),
  });
  const d = q.data;
  const k = d?.kpis;
  const maxTrips = useMemo(() => Math.max(1, ...(d?.days ?? []).map((x) => x.trips)), [d]);
  const presets: [Preset, string][] = [
    ['today', t('Today')],
    ['yesterday', t('Yesterday')],
    ['week', t('Last 7 days')],
    ['month', t('This month')],
    ['lastMonth', t('Last month')],
    ['custom', t('Custom')],
  ];
  const label = `${range.from}${range.to !== range.from ? ` – ${range.to}` : ''}`;

  return (
    <div className="flex w-full min-w-0 flex-col gap-4 p-4 sm:p-6">
      <PageHeader
        title={t('Transport dashboard')}
        description={t('Trips, people, punctuality, seat use and km for the period, per day, vehicle and shift.')}
        actions={
          can('etms_dispatch') && (
            <Button asChild>
              <Link to="/transport/dispatch">
                <RouteIcon /> {t('Daily transport')}
              </Link>
            </Button>
          )
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex flex-wrap rounded-lg border bg-muted p-[3px]" role="radiogroup" aria-label={t('Period')}>
          {presets.map(([p, l]) => (
            <button key={p} type="button" role="radio" aria-checked={preset === p} onClick={() => setPreset(p)} className={cn('h-8 rounded-md px-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring', preset === p ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground')}>
              {l}
            </button>
          ))}
        </div>
        {preset === 'custom' && (
          <div className="flex items-center gap-1">
            <Input type="date" value={custom.from} max={custom.to} onChange={(e) => e.target.value && setCustom((c) => ({ ...c, from: e.target.value }))} className="h-9 w-40" aria-label={t('From')} />
            <span className="text-muted-foreground">–</span>
            <Input type="date" value={custom.to} min={custom.from} onChange={(e) => e.target.value && setCustom((c) => ({ ...c, to: e.target.value }))} className="h-9 w-40" aria-label={t('To')} />
          </div>
        )}
        <span className="text-sm text-muted-foreground tabular-nums">{label}</span>
      </div>

      {q.isError && <FormError message={errorMessage(q.error)} />}

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5" aria-label={t('Key figures')}>
        <KpiCard label={t('Trips')} value={k?.trips} icon={BusIcon} definition={t('Trips planned in the period (cancelled included).')} sub={k ? t('{{c}} done · {{x}} cancelled', { c: k.tripsCompleted, x: k.tripsCancelled }) : undefined} />
        <KpiCard label={t('Employees carried')} value={k?.passengers} icon={UsersRoundIcon} definition={t('Seats taken on trips that were not cancelled.')} sub={k ? t('{{b}} boarded', { b: k.boarded }) : undefined} />
        <KpiCard label={t('On-time pickups')} value={k?.onTimePct ?? undefined} unit="%" decimals={1} icon={AlarmClockIcon} definition={t('Pickup stops reached within 10 minutes of the planned time, of all pickup stops reached (GPS or driver).')} />
        <KpiCard label={t('Seat use')} value={k?.seatUsePct ?? undefined} unit="%" decimals={1} icon={GaugeIcon} definition={t('Seats taken out of seats offered on trips.')} />
        <KpiCard label={t('Km driven')} value={k?.km} decimals={1} icon={RouteIcon} definition={t('Actual km of the trips (GPS, start to end).')} />
        <KpiCard label={t('No-shows')} value={k?.noShows} icon={UserXIcon} definition={t('Employees marked no-show by the driver or desk.')} sub={k?.noShowPct !== null && k?.noShowPct !== undefined ? fmtPct(k.noShowPct) : undefined} subTone={k && k.noShows ? 'destructive' : 'muted'} />
        <KpiCard label={t('Missed bookings')} value={k?.missedBookings} icon={TicketXIcon} definition={t('Bookings whose time passed without a seat.')} subTone="destructive" sub={k ? t('of {{n}} bookings', { n: k.bookings }) : undefined} />
        <KpiCard label={t('Running now')} value={k?.tripsRunning} icon={CircleCheckIcon} definition={t('Trips started and not yet finished.')} sub={k ? t('{{n}} not started', { n: k.tripsNotStarted }) : undefined} />
        <KpiCard label={t('Safety incidents')} value={k?.incidents} icon={ShieldAlertIcon} definition={t('SOS and incidents raised in the period.')} to="/transport/incidents" subTone={k && k.incidents ? 'destructive' : 'muted'} />
      </section>

      <Panel title={t('Trips per day')} subtitle={t('Bar = trips; number under = employees carried')} id="ins-days">
        {d && d.days.length ? (
          <div className="flex h-44 items-end gap-1 overflow-x-auto pb-1">
            {d.days.map((x) => (
              <div key={x.day} className="flex min-w-9 flex-1 flex-col items-center gap-1" title={`${x.day}: ${x.trips} trips, ${x.passengers} employees, ${x.km} km, on time ${fmtPct(x.onTimePct)}`}>
                <span className="text-xs tabular-nums">{x.trips}</span>
                <div className="w-full rounded-t bg-primary/80" style={{ height: `${Math.max(4, (x.trips / maxTrips) * 110)}px` }} />
                <span className="text-[10px] text-muted-foreground tabular-nums">{x.day.slice(5)}</span>
                <span className="text-[10px] text-muted-foreground tabular-nums">{x.passengers}</span>
              </div>
            ))}
          </div>
        ) : (
          <EmptyHint icon={BusIcon} text={q.isPending ? t('Loading…') : t('No trips in this period.')} />
        )}
      </Panel>

      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <Panel
          title={t('Per vehicle')}
          subtitle={t('Trips and km per vehicle: the basis for trip or km billing')}
          id="ins-vehicles"
          action={
            d?.vehicles.length ? (
              <Button size="sm" variant="outline" onClick={() => downloadCsv(`transport-vehicles-${range.from}_${range.to}.csv`, ['Vehicle', 'Plate', 'Trips', 'Completed', 'Km', 'Employees', 'Seat use %', 'On time %'], d.vehicles.map((v) => [v.vehicle, v.plateNumber, v.trips, v.tripsCompleted, v.km, v.passengers, v.seatUsePct, v.onTimePct]))}>
                <FileDownIcon /> CSV
              </Button>
            ) : undefined
          }
        >
          {d?.vehicles.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground uppercase">
                  <tr>
                    <th className="py-1.5 text-left font-medium">{t('Vehicle')}</th>
                    <th className="py-1.5 text-right font-medium">{t('Trips')}</th>
                    <th className="py-1.5 text-right font-medium">{t('Km')}</th>
                    <th className="py-1.5 text-right font-medium">{t('Employees')}</th>
                    <th className="py-1.5 text-right font-medium">{t('Seat use')}</th>
                    <th className="py-1.5 text-right font-medium">{t('On time')}</th>
                  </tr>
                </thead>
                <tbody>
                  {d.vehicles.map((v) => (
                    <tr key={v.objectId} className="border-t">
                      <td className="py-1.5">
                        <span className="font-medium">{v.vehicle}</span>
                        {v.plateNumber && <span className="text-xs text-muted-foreground"> · {v.plateNumber}</span>}
                      </td>
                      <td className="py-1.5 text-right tabular-nums">{v.trips}</td>
                      <td className="py-1.5 text-right tabular-nums">{v.km}</td>
                      <td className="py-1.5 text-right tabular-nums">{v.passengers}</td>
                      <td className="py-1.5 text-right tabular-nums">{fmtPct(v.seatUsePct)}</td>
                      <td className="py-1.5 text-right tabular-nums">{fmtPct(v.onTimePct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyHint icon={BusIcon} text={t('No vehicle trips in this period.')} />
          )}
        </Panel>

        <Panel
          title={t('Per shift')}
          id="ins-shifts"
          action={
            d?.shifts.length ? (
              <Button size="sm" variant="outline" onClick={() => downloadCsv(`transport-shifts-${range.from}_${range.to}.csv`, ['Shift', 'Direction', 'Trips', 'Employees', 'No-shows'], d.shifts.map((s) => [s.shift, s.direction === 'OUT' ? 'Logout' : 'Login', s.trips, s.passengers, s.noShows]))}>
                <FileDownIcon /> CSV
              </Button>
            ) : undefined
          }
        >
          {d?.shifts.length ? (
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground uppercase">
                <tr>
                  <th className="py-1.5 text-left font-medium">{t('Shift')}</th>
                  <th className="py-1.5 text-right font-medium">{t('Trips')}</th>
                  <th className="py-1.5 text-right font-medium">{t('Employees')}</th>
                  <th className="py-1.5 text-right font-medium">{t('No-shows')}</th>
                </tr>
              </thead>
              <tbody>
                {d.shifts.map((s) => (
                  <tr key={`${s.shift}|${s.direction}`} className="border-t">
                    <td className="py-1.5">
                      {s.shift} <span className="text-xs text-muted-foreground">· {s.direction === 'OUT' ? t('Logout') : t('Login')}</span>
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{s.trips}</td>
                    <td className="py-1.5 text-right tabular-nums">{s.passengers}</td>
                    <td className="py-1.5 text-right tabular-nums">{s.noShows}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptyHint icon={UsersRoundIcon} text={t('No shift trips in this period.')} />
          )}
        </Panel>
      </div>

      {d && (
        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              downloadCsv(
                `transport-days-${range.from}_${range.to}.csv`,
                ['Day', 'Trips', 'Employees', 'Km', 'On time %', 'No-shows'],
                d.days.map((x) => [x.day, x.trips, x.passengers, x.km, x.onTimePct, x.noShows]),
              )
            }
          >
            <FileDownIcon /> {t('Daily figures (CSV)')}
          </Button>
        </div>
      )}
    </div>
  );
}
