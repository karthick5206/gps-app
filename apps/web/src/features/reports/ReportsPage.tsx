import { useMutation } from '@tanstack/react-query';
import {
  PERIOD_REPORT_TYPES,
  POSITIONS_REPORT_MAX_DAYS,
  SINGLE_OBJECT_REPORT_TYPES,
  type ReportFormat,
  type ReportOptions,
  type ReportPeriod,
  type ReportRequest,
  type ReportResponse,
  type ReportScope,
  type ReportType,
  type SummaryReportRow,
} from '@veetracer/shared';
import { CalendarClockIcon, DownloadIcon, FileSpreadsheetIcon, FileTextIcon, PlayIcon, TableIcon } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
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
import { REPORT_CATEGORIES, REPORT_DEF_MAP, REPORT_DEFS, type Row } from './report-columns';
import { daySpan, periodLabel, toDateInput } from './report-format';
import { optionsFor, ReportOptionsFields } from './ReportOptionsFields';
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

/** Ranges end today by default: fleets look at today's activity first (today's figures grow until midnight). */
const DATE_PRESETS: { label: string; range: () => [string, string] }[] = [
  { label: 'Today', range: () => [toDateInput(new Date()), toDateInput(new Date())] },
  { label: 'Yesterday', range: () => [toDateInput(addDays(new Date(), -1)), toDateInput(addDays(new Date(), -1))] },
  { label: 'Last 7 days', range: () => [toDateInput(addDays(new Date(), -6)), toDateInput(new Date())] },
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
  const [[from, to], setDates] = useState<[string, string]>(DATE_PRESETS[2].range);
  const [period, setPeriod] = useState<ReportPeriod>('DAY');
  const [exporting, setExporting] = useState<ReportFormat | null>(null);
  const [options, setOptions] = useState<ReportOptions>({});

  const usesPeriod = PERIOD_REPORT_TYPES.includes(type);
  const singleVehicle = SINGLE_OBJECT_REPORT_TYPES.includes(type);
  const typeOptions = optionsFor(type, options);
  const request: ReportRequest = { type, scope, from, to, ...(usesPeriod ? { period } : {}), ...(typeOptions ? { options: typeOptions } : {}) };
  const rangeError =
    !from || !to
      ? 'Choose a start and end date'
      : from > to
        ? 'The end date must be on or after the start date'
        : singleVehicle && daySpan(from, to) > POSITIONS_REPORT_MAX_DAYS
          ? `This report covers at most ${POSITIONS_REPORT_MAX_DAYS} days`
          : null;
  const scopeError = singleVehicle && (scope.objectIds.length !== 1 || scope.branchIds.length > 0 || scope.groupIds.length > 0) ? 'Choose exactly one vehicle (and no branches or groups) for this report' : null;
  const inputError = rangeError ?? scopeError;

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

  const current = REPORT_DEF_MAP[type];
  const CurrentIcon = current.icon;
  const scheduleLink = can('report_schedules') && (
    <Button variant="outline" size="sm" asChild>
      <Link to="/reports/schedules">
        <CalendarClockIcon /> Scheduled reports
      </Link>
    </Button>
  );

  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
      {/* Report types: a sidebar on large screens, a drop-down on small ones. */}
      <aside aria-label="Report types" className="hidden w-64 shrink-0 flex-col border-r bg-card lg:flex">
        <div className="border-b px-4 py-4">
          <h1 className="text-lg font-semibold tracking-tight">Reports</h1>
          <p className="text-xs text-muted-foreground">Run, view and download fleet reports.</p>
        </div>
        <nav role="radiogroup" aria-label="Report type" className="min-h-0 flex-1 space-y-4 overflow-y-auto p-2">
          {REPORT_CATEGORIES.map((category) => (
            <div key={category} className="space-y-0.5">
              <p className="px-2 pb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{category}</p>
              {REPORT_DEFS.filter((d) => d.category === category).map((d) => {
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
                      'flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm transition-colors outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/40',
                      active && 'bg-accent font-medium text-accent-foreground hover:bg-accent',
                    )}
                  >
                    <Icon className={cn('size-4 shrink-0', active ? 'text-primary' : 'text-muted-foreground')} />
                    {d.label}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
        {scheduleLink && <div className="border-t p-3 [&_a]:w-full">{scheduleLink}</div>}
      </aside>

      <div className="min-w-0 flex-1 space-y-4 overflow-y-auto p-4 sm:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span className="hidden size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground sm:flex">
              <CurrentIcon className="size-5" />
            </span>
            <div className="min-w-0">
              <h2 className="text-xl font-semibold tracking-tight">{current.label} report</h2>
              <p className="text-sm text-muted-foreground">{current.description}</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 lg:hidden">
            <Select value={type} onValueChange={(v) => setType(v as ReportType)}>
              <SelectTrigger className="w-56" aria-label="Report type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REPORT_DEFS.map((d) => (
                  <SelectItem key={d.type} value={d.type}>
                    {d.category} · {d.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {scheduleLink}
          </div>
        </div>

        <Card className="gap-0 p-0">
          <div className="space-y-4 p-4">
            <ScopePicker value={scope} onChange={setScope} />
            <div role="group" aria-label="Date presets" className="flex flex-wrap gap-1.5">
              {DATE_PRESETS.map((p) => {
                const [a, b] = p.range();
                const on = a === from && b === to;
                return (
                  <Button key={p.label} type="button" size="sm" variant={on ? 'secondary' : 'outline'} aria-pressed={on} onClick={() => setDates([a, b])} className={cn(on && 'border-primary/40 text-primary')}>
                    {p.label}
                  </Button>
                );
              })}
            </div>
            <div className="grid grid-cols-2 gap-3 sm:flex sm:flex-wrap sm:items-end">
              <Field label="From" htmlFor="r-from">
                <Input id="r-from" type="date" value={from} max={to || undefined} onChange={(e) => setDates([e.target.value, to])} className="sm:w-40" aria-invalid={!!rangeError} />
              </Field>
              <Field label="To" htmlFor="r-to">
                <Input id="r-to" type="date" value={to} min={from || undefined} max={toDateInput(new Date())} onChange={(e) => setDates([from, e.target.value])} className="sm:w-40" aria-invalid={!!rangeError} />
              </Field>
              {usesPeriod && (
                <Field label="Group by" htmlFor="r-period" className="col-span-2 sm:w-44">
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
            </div>
            <ReportOptionsFields type={type} value={options} onChange={setOptions} />
          </div>
          <div className="flex flex-col gap-2 border-t bg-muted/30 px-4 py-3 sm:flex-row sm:items-center">
            <p className={cn('flex-1 text-xs', inputError ? 'text-destructive' : 'text-muted-foreground')}>
              {inputError ?? 'Leave branches, groups and vehicles empty to include every vehicle you can access.'}
            </p>
            <Button onClick={() => run.mutate(request)} disabled={!!inputError || run.isPending} className="sm:w-36">
              {run.isPending ? <Spinner /> : <PlayIcon />} Run report
            </Button>
          </div>
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
            <EmptyState icon={TableIcon} title="Press Run report" description="Results appear here. You can then download them as Excel, PDF or CSV." />
          </Card>
        )}
      </div>
    </div>
  );
}
