import { useQuery } from '@tanstack/react-query';
import { INVENTORY_STATUS_LABELS, INVENTORY_STATUSES, STOCK_MOVEMENT_KINDS, type InventoryDashboardDto } from '@veetracer/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { BarList, Donut } from '@/features/dashboard/charts';
import { api } from '@/lib/api';
import { chartMax, formatRupees, percent, shortDay } from './inventory-format';
import { MOVEMENT_KIND_COLOR, MOVEMENT_KIND_LABELS, STOCK_STATUS_COLOR, StatTile } from './shared';

const WINDOWS = [14, 30, 90] as const;

/** Stacked daily columns of movements by kind (SVG, theme tokens). */
function MovementChart({ data }: { data: InventoryDashboardDto['movements'] }) {
  const { t } = useTranslation();
  const max = chartMax(data.map((d) => d.total));
  const w = 640;
  const h = 180;
  const pad = { l: 28, r: 8, t: 8, b: 22 };
  const bw = (w - pad.l - pad.r) / Math.max(1, data.length);
  const y = (v: number) => pad.t + (h - pad.t - pad.b) * (1 - v / max);
  const labelEvery = Math.ceil(data.length / 8);
  const total = data.reduce((s, d) => s + d.total, 0);
  return (
    <figure className="space-y-3">
      <svg viewBox={`0 0 ${w} ${h}`} className="h-48 w-full" role="img" aria-label={t('{{n}} stock movements in the last {{d}} days', { n: total, d: data.length })}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={pad.l} x2={w - pad.r} y1={y(max * f)} y2={y(max * f)} stroke="var(--border)" strokeDasharray={f === 0 ? undefined : '3 3'} />
            <text x={pad.l - 4} y={y(max * f) + 3} textAnchor="end" className="fill-muted-foreground text-[9px] tabular-nums">
              {Math.round(max * f)}
            </text>
          </g>
        ))}
        {data.map((d, i) => {
          let acc = 0;
          const x = pad.l + i * bw + bw * 0.15;
          return (
            <g key={d.day}>
              {STOCK_MOVEMENT_KINDS.map((k) => {
                const v = d.byKind[k] ?? 0;
                if (!v) return null;
                const y0 = y(acc);
                acc += v;
                const y1 = y(acc);
                return (
                  <rect key={k} x={x} width={bw * 0.7} y={y1} height={Math.max(0.5, y0 - y1)} rx={1.5} fill={MOVEMENT_KIND_COLOR[k]}>
                    <title>{`${shortDay(d.day)} · ${t(MOVEMENT_KIND_LABELS[k])}: ${v}`}</title>
                  </rect>
                );
              })}
              {i % labelEvery === 0 && (
                <text x={x + bw * 0.35} y={h - 6} textAnchor="middle" className="fill-muted-foreground text-[9px]">
                  {shortDay(d.day)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <figcaption className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {STOCK_MOVEMENT_KINDS.map((k) => (
          <span key={k} className="inline-flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm" style={{ backgroundColor: MOVEMENT_KIND_COLOR[k] }} aria-hidden />
            {t(MOVEMENT_KIND_LABELS[k])}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

/** Inventory dashboard: totals, status / location / model breakdowns, movements over time and recorded value. */
export function DashboardTab() {
  const { t } = useTranslation();
  const [days, setDays] = useState<number>(30);
  const q = useQuery({ queryKey: ['inventory', 'dashboard', days], queryFn: () => api.get<InventoryDashboardDto>('/inventory/dashboard', { days }) });
  const d = q.data;
  return (
    <div className="w-full space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{t('Inventory overview')}</h2>
          <p className="text-sm text-muted-foreground">{t('From received stock records only. Devices not yet received or backfilled are counted as untracked.')}</p>
        </div>
        <Select value={String(days)} onValueChange={(v) => setDays(Number(v))}>
          <SelectTrigger className="h-9 w-40" aria-label={t('Movement window')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WINDOWS.map((w) => (
              <SelectItem key={w} value={String(w)}>
                {t('Last {{n}} days', { n: w })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {!d ? (
        <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <StatTile label="Tracked devices" value={d.totals.tracked.toLocaleString()} sub={t('{{n}} untracked', { n: d.totals.untracked })} />
            <StatTile label="In stock" value={d.totals.inStock.toLocaleString()} sub={t('In stock + reserved')} />
            <StatTile label="At customers" value={d.totals.atCustomer.toLocaleString()} sub={t('Assigned + active')} tone="success" />
            <StatTile label="Needs attention" value={d.totals.needsAttention.toLocaleString()} sub={t('Faulty, repair, returned')} tone={d.totals.needsAttention ? 'warning' : 'default'} />
            <StatTile label="Assignment check" value={d.totals.mismatches.toLocaleString()} sub={t('Status differs from assignment')} tone={d.totals.mismatches ? 'destructive' : 'default'} />
            <StatTile label="Stock value" value={formatRupees(d.valuation.heldValuePaise, { compact: true })} sub={t('{{c}} costed · {{u}} without cost', { c: d.valuation.costedUnits, u: d.valuation.uncostedUnits })} />
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <Card>
              <CardHeader>
                <CardTitle>{t('By status')}</CardTitle>
              </CardHeader>
              <CardContent>
                <Donut
                  title={t('Devices by stock status')}
                  centerLabel={t('devices')}
                  slices={INVENTORY_STATUSES.map((s) => ({ key: s, label: t(INVENTORY_STATUS_LABELS[s]), value: d.byStatus[s], color: STOCK_STATUS_COLOR[s] }))}
                />
              </CardContent>
            </Card>
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle>{t('Stock movements')}</CardTitle>
                <CardDescription>{t('{{n}} movements in the last {{d}} days', { n: d.movements.reduce((s, m) => s + m.total, 0), d: d.windowDays })}</CardDescription>
              </CardHeader>
              <CardContent>
                <MovementChart data={d.movements} />
              </CardContent>
            </Card>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>{t('By location')}</CardTitle>
                <CardDescription>{t('Devices held and their recorded purchase value')}</CardDescription>
              </CardHeader>
              <CardContent>
                <BarList
                  items={d.byLocation.map((l) => ({ key: l.locationId ?? 'customer', label: l.locationId ? `${l.code} · ${l.name}` : t('At customers (no stock location)'), sub: formatRupees(l.valuePaise, { compact: true }), value: l.count }))}
                  format={(v) => v.toLocaleString()}
                  empty={t('No stock yet')}
                />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>{t('By model')}</CardTitle>
                <CardDescription>{t('Top models: in stock / at customers / needs attention')}</CardDescription>
              </CardHeader>
              <CardContent>
                {d.byModel.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">{t('No stock yet')}</p>
                ) : (
                  <ul className="space-y-2.5">
                    {d.byModel.map((m) => (
                      <li key={m.modelId} className="space-y-1">
                        <div className="flex items-baseline justify-between gap-2 text-sm">
                          <span className="truncate font-medium">{m.name}</span>
                          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                            {m.inStock} / {m.atCustomer} / {m.faulty} · <span className="font-medium text-foreground">{m.total}</span>
                          </span>
                        </div>
                        <div className="flex h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
                          <div style={{ width: percent(m.inStock, m.total), backgroundColor: 'var(--info)' }} />
                          <div style={{ width: percent(m.atCustomer, m.total), backgroundColor: 'var(--success)' }} />
                          <div style={{ width: percent(m.faulty, m.total), backgroundColor: 'var(--destructive)' }} />
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>
          <Card>
            <CardHeader>
              <CardTitle>{t('Valuation by status')}</CardTitle>
              <CardDescription>{t('Sum of recorded unit cost (no accounting valuation, QI-23). Retired units are excluded from the stock value.')}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-8">
                {INVENTORY_STATUSES.map((s) => (
                  <div key={s} className="rounded-lg border p-3">
                    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <span className="size-2 rounded-full" style={{ backgroundColor: STOCK_STATUS_COLOR[s] }} aria-hidden />
                      {t(INVENTORY_STATUS_LABELS[s])}
                    </p>
                    <p className="mt-1 text-sm font-semibold tabular-nums">{formatRupees(d.valuation.byStatus[s] ?? 0, { compact: true })}</p>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
