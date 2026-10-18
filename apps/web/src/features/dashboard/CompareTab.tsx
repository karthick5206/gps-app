import { useMutation } from '@tanstack/react-query';
import type { DashboardCompare, ReportScope } from '@veetracer/shared';
import { BarChart3Icon, PlayIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormError } from '@/components/form-error';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { REPORT_DEF_MAP, type Row } from '@/features/reports/report-columns';
import { toDateInput } from '@/features/reports/report-format';
import { ReportTable } from '@/features/reports/ReportTable';
import { EMPTY_SCOPE, ScopePicker } from '@/features/reports/ScopePicker';
import { api, errorMessage } from '@/lib/api';
import { formatDuration } from '@/lib/format';
import { BarList } from './charts';

const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return toDateInput(d);
};
const PRESETS: { label: string; range: () => [string, string] }[] = [
  { label: 'Today', range: () => [day(0), day(0)] },
  { label: 'Yesterday', range: () => [day(-1), day(-1)] },
  { label: 'Last 7 days', range: () => [day(-7), day(-1)] },
  { label: 'Last 30 days', range: () => [day(-30), day(-1)] },
];

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <Card className="p-4">
      <p className="text-sm text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-semibold tracking-tight tabular-nums">{value}</p>
    </Card>
  );
}

const km = (v: number) => `${v.toLocaleString(undefined, { maximumFractionDigits: 1 })} km`;

/** Compare board: consolidated totals per vehicle for any range, ranked by distance. */
export function CompareTab() {
  const { t } = useTranslation();
  const [[from, to], setRange] = useState<[string, string]>(PRESETS[0].range);
  const [scope, setScope] = useState<ReportScope>(EMPTY_SCOPE);
  const run = useMutation({ mutationFn: () => api.post<DashboardCompare>('/dashboard/compare', { from, to, scope }) });
  const d = run.data;
  const totals = d?.totals ?? {};
  const invalid = !from || !to || from > to;
  return (
    <div className="space-y-4">
      <Card className="space-y-4 p-4">
        <ScopePicker value={scope} onChange={setScope} />
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
          <div className="grid grid-cols-2 gap-3 sm:flex">
            <Field label={t('From')} htmlFor="c-from">
              <Input id="c-from" type="date" value={from} max={to} onChange={(e) => setRange([e.target.value, to])} className="sm:w-40" />
            </Field>
            <Field label={t('To')} htmlFor="c-to">
              <Input id="c-to" type="date" value={to} min={from} onChange={(e) => setRange([from, e.target.value])} className="sm:w-40" />
            </Field>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((p) => {
              const [a, b] = p.range();
              return (
                <Button key={p.label} size="sm" variant={a === from && b === to ? 'secondary' : 'ghost'} onClick={() => setRange([a, b])}>
                  {t(p.label)}
                </Button>
              );
            })}
          </div>
          <span className="flex-1" />
          <Button onClick={() => run.mutate()} disabled={invalid || run.isPending} className="lg:w-36">
            {run.isPending ? <Spinner /> : <PlayIcon />} {t('Compare')}
          </Button>
        </div>
      </Card>

      {run.isError && <FormError message={errorMessage(run.error)} />}

      {d ? (
        <>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
            <Tile label={t('Vehicles')} value={(totals.vehicles ?? 0).toLocaleString()} />
            <Tile label={t('Trips')} value={(totals.tripCount ?? 0).toLocaleString()} />
            <Tile label={t('Distance')} value={km(totals.distanceKm ?? 0)} />
            <Tile label={t('Moving time')} value={formatDuration(totals.runningSec ?? 0)} />
            <Tile label={t('Idle time')} value={formatDuration(totals.idleSec ?? 0)} />
            <Tile label={t('Engine on')} value={formatDuration(totals.engineSec ?? 0)} />
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="space-y-3 p-4">
              <h2 className="text-sm font-semibold">{t('Distance ranking')}</h2>
              <BarList items={[...d.rows].sort((a, b) => b.distanceKm - a.distanceKm).slice(0, 15).map((r) => ({ key: r.objectId, label: r.objectName, sub: r.plateNumber, value: r.distanceKm }))} format={km} empty={t('No vehicles in this selection.')} />
            </Card>
            <Card className="space-y-3 p-4">
              <h2 className="text-sm font-semibold">{t('Idle time ranking')}</h2>
              <BarList items={[...d.rows].sort((a, b) => b.idleSec - a.idleSec).slice(0, 15).filter((r) => r.idleSec > 0).map((r) => ({ key: r.objectId, label: r.objectName, sub: r.plateNumber, value: r.idleSec }))} format={formatDuration} empty={t('No idling in this period.')} color="var(--warning)" />
            </Card>
            <Card className="space-y-3 p-4">
              <h2 className="text-sm font-semibold">{t('Alerts ranking')}</h2>
              <BarList items={[...d.rows].sort((a, b) => b.alertCount - a.alertCount).slice(0, 15).filter((r) => r.alertCount > 0).map((r) => ({ key: r.objectId, label: r.objectName, sub: r.plateNumber, value: r.alertCount }))} format={(v) => v.toLocaleString()} empty={t('No alerts in this period.')} color="var(--destructive)" />
            </Card>
          </div>
          <Card className="overflow-hidden">
            <ReportTable columns={REPORT_DEF_MAP.CONSOLIDATED.columns} rows={d.rows as unknown as Row[]} totals={d.totals} />
          </Card>
        </>
      ) : (
        !run.isPending && (
          <Card>
            <EmptyState icon={BarChart3Icon} title={t('Pick a period and press Compare')} description={t('Leave branches, groups and vehicles empty to compare every vehicle you can access.')} />
          </Card>
        )
      )}
    </div>
  );
}
