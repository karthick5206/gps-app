import { useMutation } from '@tanstack/react-query';
import type { ReportFormat, ReportPeriod, ReportRequest, ReportResponse, ReportScope, ReportType, SummaryReportRow } from '@veetracer/shared';
import { CalendarClockIcon, DownloadIcon, FileSpreadsheetIcon, FileTextIcon, PlayIcon, TableIcon } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { useAuth } from '@/features/auth/auth-context';
import { api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { downloadFile } from './download';
import { REPORT_DEF_MAP, REPORT_DEFS, type Row } from './report-columns';
import { periodLabel, toDateInput } from './report-format';
import { ReportTable } from './ReportTable';
import { EMPTY_SCOPE, ScopePicker } from './ScopePicker';
import { SummaryCharts } from './SummaryCharts';

export const PERIOD_OPTIONS: { value: ReportPeriod; label: string }[] = [
  { value: 'DAY', label: 'Daily' },
  { value: 'WEEK', label: 'Weekly (Mon–Sun)' },
  { value: 'MONTH', label: 'Monthly' },
];

const FORMATS: { format: ReportFormat; label: string; icon: typeof FileTextIcon }[] = [
  { format: 'XLSX', label: 'Excel', icon: FileSpreadsheetIcon },
  { format: 'PDF', label: 'PDF', icon: FileTextIcon },
  { format: 'CSV', label: 'CSV', icon: DownloadIcon },
];

function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

const DATE_PRESETS: { label: string; range: () => [string, string] }[] = [
  { label: 'Yesterday', range: () => [toDateInput(addDays(new Date(), -1)), toDateInput(addDays(new Date(), -1))] },
  { label: 'Last 7 days', range: () => [toDateInput(addDays(new Date(), -7)), toDateInput(addDays(new Date(), -1))] },
  {
    label: 'This month',
    range: () => {
      const n = new Date();
      return [toDateInput(new Date(n.getFullYear(), n.getMonth(), 1)), toDateInput(n)];
    },
  },
  {
    label: 'Last month',
    range: () => {
      const n = new Date();
      return [toDateInput(new Date(n.getFullYear(), n.getMonth() - 1, 1)), toDateInput(new Date(n.getFullYear(), n.getMonth(), 0))];
    },
  },
];

export function ReportsPage() {
  const { can } = useAuth();
  const canExport = can('reports', 'export');
  const [type, setType] = useState<ReportType>('SUMMARY');
  const [scope, setScope] = useState<ReportScope>(EMPTY_SCOPE);
  const [[from, to], setDates] = useState<[string, string]>(DATE_PRESETS[1].range);
  const [period, setPeriod] = useState<ReportPeriod>('DAY');
  const [exporting, setExporting] = useState<ReportFormat | null>(null);

  const request: ReportRequest = { type, scope, from, to, ...(type === 'SUMMARY' ? { period } : {}) };
  const rangeError = !from || !to ? 'Choose a start and end date' : from > to ? 'The end date must be on or after the start date' : null;

  const run = useMutation({
    // The API also returns `truncated` / `totalRows` (beyond the shared ReportResponse) when rows exceed 10,000.
    mutationFn: (req: ReportRequest) => api.post<ReportResponse<Row> & { truncated?: boolean; totalRows?: number }>('/reports/run', req).then((res) => ({ req, res })),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const result = run.data;
  const def = result ? REPORT_DEF_MAP[result.req.type] : null;

  const exportAs = async (format: ReportFormat) => {
    if (!result) return;
    setExporting(format);
    try {
      const name = await downloadFile('/reports/export', {
        method: 'POST',
        body: { ...result.req, format },
        fallbackName: `${result.req.type.toLowerCase()}-${result.req.from}-${result.req.to}.${format.toLowerCase()}`,
      });
      toast.success(`Downloaded ${name}`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setExporting(null);
    }
  };

  return (
    <div className="mx-auto w-full max-w-[1400px] space-y-5 p-4 sm:p-6">
      <PageHeader
        title="Reports"
        description="Run reports for your fleet and download them as Excel, PDF or CSV."
        actions={
          can('report_schedules') && (
            <Button variant="outline" asChild>
              <Link to="/reports/schedules">
                <CalendarClockIcon /> Scheduled reports
              </Link>
            </Button>
          )
        }
      />

      <div role="radiogroup" aria-label="Report type" className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        {REPORT_DEFS.map((d) => {
          const active = d.type === type;
          const Icon = d.icon;
          return (
            <button
              key={d.type}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setType(d.type)}
              className={cn(
                'flex items-center gap-2.5 rounded-xl border bg-card p-2.5 text-left sm:flex-col sm:items-start sm:gap-2 sm:p-3 shadow-xs transition-[border-color,box-shadow,background-color] outline-none hover:border-primary/50 focus-visible:ring-[3px] focus-visible:ring-ring/40',
                active && 'border-primary bg-accent/60 ring-1 ring-primary',
              )}
            >
              <span className={cn('flex size-8 items-center justify-center rounded-lg', active ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground')}>
                <Icon className="size-4" />
              </span>
              <span className="text-sm font-semibold">{d.label}</span>
              <span className="line-clamp-2 hidden text-xs text-muted-foreground sm:block">{d.description}</span>
            </button>
          );
        })}
      </div>

      <Card className="space-y-4 p-4">
        <ScopePicker value={scope} onChange={setScope} />
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
          <div className="grid grid-cols-2 gap-3 sm:flex sm:items-end">
            <Field label="From" htmlFor="r-from">
              <Input id="r-from" type="date" value={from} max={to || undefined} onChange={(e) => setDates([e.target.value, to])} className="sm:w-40" aria-invalid={!!rangeError} />
            </Field>
            <Field label="To" htmlFor="r-to">
              <Input id="r-to" type="date" value={to} min={from || undefined} onChange={(e) => setDates([from, e.target.value])} className="sm:w-40" aria-invalid={!!rangeError} />
            </Field>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {DATE_PRESETS.map((p) => {
              const [a, b] = p.range();
              return (
                <Button key={p.label} size="sm" variant={a === from && b === to ? 'secondary' : 'ghost'} onClick={() => setDates([a, b])}>
                  {p.label}
                </Button>
              );
            })}
          </div>
          {type === 'SUMMARY' && (
            <Field label="Group by" htmlFor="r-period" className="lg:w-48">
              <Select value={period} onValueChange={(v) => setPeriod(v as ReportPeriod)}>
                <SelectTrigger id="r-period">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PERIOD_OPTIONS.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          <span className="flex-1" />
          <Button onClick={() => run.mutate(request)} disabled={!!rangeError || run.isPending} className="lg:w-36">
            {run.isPending ? <Spinner /> : <PlayIcon />} Run report
          </Button>
        </div>
        {rangeError && <p className="text-xs text-destructive">{rangeError}</p>}
      </Card>

      {run.isError && <FormError message={errorMessage(run.error)} />}

      {run.isPending && !result && (
        <Card className="space-y-3 p-4">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-64 w-full" />
        </Card>
      )}

      {result && def && (
        <div className={cn('space-y-4', run.isPending && 'opacity-60 transition-opacity')}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold">{def.label} report</h2>
              <p className="text-sm text-muted-foreground">
                {periodLabel(result.res.from)} – {periodLabel(result.res.to)}
                {result.res.period ? ` · ${PERIOD_OPTIONS.find((p) => p.value === result.res.period)?.label}` : ''} · {(result.res.totalRows ?? result.res.rows.length).toLocaleString()} rows
              </p>
            </div>
            {canExport && (
              <div className="flex flex-wrap gap-2" role="group" aria-label="Download">
                {FORMATS.map((f) => (
                  <Button key={f.format} variant="outline" size="sm" onClick={() => exportAs(f.format)} disabled={!!exporting}>
                    {exporting === f.format ? <Spinner /> : <f.icon />} {f.label}
                  </Button>
                ))}
              </div>
            )}
          </div>
          {result.req.type === 'SUMMARY' && <SummaryCharts rows={result.res.rows as unknown as SummaryReportRow[]} />}
          <Card className="overflow-hidden">
            {result.res.rows.length ? (
              <ReportTable key={`${result.req.type}-${run.submittedAt}`} columns={def.columns} rows={result.res.rows} totals={result.res.totals} />
            ) : (
              <EmptyState icon={TableIcon} title="No data for this selection" description="Try a longer period or a wider scope." />
            )}
          </Card>
          {(result.res.truncated || (result.res.totalRows === undefined && result.res.rows.length >= 10_000)) && (
            <p className="text-xs text-warning">
              Showing the first {result.res.rows.length.toLocaleString()} rows{result.res.totalRows ? ` of ${result.res.totalRows.toLocaleString()}` : ''}; totals cover every row. Download the report or narrow the selection for the rest.
            </p>
          )}
        </div>
      )}

      {!result && !run.isPending && (
        <Card>
          <EmptyState icon={TableIcon} title="Choose a report and press Run" description="Leave branches, groups and vehicles empty to include every vehicle you can access." />
        </Card>
      )}
    </div>
  );
}
