import { Breadcrumb } from '@/components/page-header';
import { useMutation } from '@tanstack/react-query';
import {
  PERIOD_REPORT_TYPES,
  POSITIONS_REPORT_MAX_DAYS,
  REPORT_OPTION_KEYS,
  SINGLE_OBJECT_REPORT_TYPES,
  type ReportFormat,
  type ReportOptions,
  type ReportPeriod,
  type ReportRequest,
  type ReportResponse,
  type ReportScope,
  type ReportType,
} from '@veetracer/shared';
import { CalendarClockIcon, CalendarPlusIcon, DownloadIcon, FileSpreadsheetIcon, FileTextIcon, GlobeIcon, PlayIcon, TableIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
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
import { DatePresets } from './DatePresets';
import { presetRange } from './date-presets';
import { downloadFile } from './download';
import { rowMatches, type InsightFilter } from './insights';
import { PERIOD_OPTIONS } from './period-options';
import { CatalogList, CatalogSheetButton, useCatalogPrefs } from './ReportCatalog';
import { REPORT_DEF_MAP, REPORT_DEFS, type ReportTypeDef, type Row } from './report-columns';
import { daySpan, periodLabel } from './report-format';
import { getReportTimeZone, reportZoneLabel, todayInZone } from './report-time';
import { filterLabel, ReportInsights } from './ReportInsights';
import { optionsFor, ReportOptionsFields } from './ReportOptionsFields';
import { ReportTable } from './ReportTable';
import { prefillFromRun } from './schedule-options';
import { ScheduleForm, type SchedulePrefill } from './ScheduledReportsPage';
import { EMPTY_SCOPE, ScopePicker } from './ScopePicker';

export { PERIOD_OPTIONS };

const FORMATS: { format: ReportFormat; label: string; icon: typeof FileTextIcon }[] = [
  { format: 'XLSX', label: 'Excel', icon: FileSpreadsheetIcon },
  { format: 'PDF', label: 'PDF', icon: FileTextIcon },
  { format: 'CSV', label: 'CSV', icon: DownloadIcon },
];

export function ReportsPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const canExport = can('reports', 'export');
  const [type, setType] = useState<ReportType>(() => {
    const wanted = new URLSearchParams(window.location.search).get('type');
    return REPORT_DEFS.some((d) => d.type === wanted) ? (wanted as ReportType) : 'SUMMARY';
  });
  const [visible] = useState(() => (d: ReportTypeDef) => d.category !== 'Staff attendance' || can('attendance'));
  const prefs = useCatalogPrefs();
  // Report periods are company days, so "today" and the presets use the company's calendar (D-1).
  const today = todayInZone();
  const zoneName = getReportTimeZone();
  const zoneLabel = reportZoneLabel();
  const [scope, setScope] = useState<ReportScope>(EMPTY_SCOPE);
  const [[from, to], setDates] = useState<[string, string]>(() => presetRange('last7', today));
  const [period, setPeriod] = useState<ReportPeriod>('DAY');
  const [exporting, setExporting] = useState<ReportFormat | null>(null);
  const [options, setOptions] = useState<ReportOptions>({});
  const [filter, setFilter] = useState<InsightFilter | null>(null);
  const [schedulePrefill, setSchedulePrefill] = useState<SchedulePrefill | null>(null);

  const usesPeriod = PERIOD_REPORT_TYPES.includes(type);
  const singleVehicle = SINGLE_OBJECT_REPORT_TYPES.includes(type);
  const typeOptions = optionsFor(type, options);
  const request: ReportRequest = { type, scope, from, to, ...(usesPeriod ? { period } : {}), ...(typeOptions ? { options: typeOptions } : {}) };
  const rangeError =
    !from || !to
      ? t('Choose a start and end date')
      : from > to
        ? t('The end date must be on or after the start date')
        : singleVehicle && daySpan(from, to) > POSITIONS_REPORT_MAX_DAYS
          ? t('This report covers at most {{days}} days', { days: POSITIONS_REPORT_MAX_DAYS })
          : null;
  const scopeError = singleVehicle && (scope.objectIds.length !== 1 || scope.branchIds.length > 0 || scope.groupIds.length > 0) ? t('Choose exactly one vehicle (and no branches or groups) for this report') : null;
  const inputError = rangeError ?? scopeError;

  const run = useMutation({
    // The API also returns `truncated` / `totalRows` (beyond the shared ReportResponse) when rows exceed 10,000.
    mutationFn: (req: ReportRequest) => api.post<ReportResponse<Row> & { truncated?: boolean; totalRows?: number }>('/reports/run', req).then((res) => ({ req, res })),
    onMutate: () => setFilter(null),
    onSuccess: ({ req }) => prefs.addRecent({ type: req.type, from: req.from, to: req.to }),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const result = run.data;
  const def = result ? REPORT_DEF_MAP[result.req.type] : null;
  const truncated = !!result && (!!result.res.truncated || (result.res.totalRows === undefined && result.res.rows.length >= 10_000));

  const exportAs = async (format: ReportFormat) => {
    if (!result) return;
    setExporting(format);
    try {
      const name = await downloadFile('/reports/export', {
        method: 'POST',
        body: { ...result.req, format },
        fallbackName: `${result.req.type.toLowerCase()}-${result.req.from}-${result.req.to}.${format.toLowerCase()}`,
      });
      toast.success(t('Downloaded {{name}}', { name }));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setExporting(null);
    }
  };

  const selectType = (next: ReportType, range?: [string, string]) => {
    setType(next);
    if (range) setDates(range);
  };

  const current = REPORT_DEF_MAP[type];
  const CurrentIcon = current.icon;
  const scheduleLink = can('report_schedules') && (
    <Button variant="outline" size="sm" asChild>
      <Link to="/reports/schedules">
        <CalendarClockIcon /> {t('Scheduled reports')}
      </Link>
    </Button>
  );
  const catalogProps = { value: type, onSelect: selectType, visible, favourites: prefs.favourites, recents: prefs.recents, onToggleFavourite: prefs.toggleFav };
  const canSchedule = !!result && can('report_schedules', 'create') && !SINGLE_OBJECT_REPORT_TYPES.includes(result.req.type);
  const zoneText = zoneName ? t('Times in {{zone}} ({{name}}), the company time zone', { zone: zoneLabel, name: zoneName }) : null;

  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
      {/* Report types: a searchable rail on large screens, a button + sheet on small ones. */}
      <aside aria-label={t('Report types')} className="hidden w-72 shrink-0 flex-col border-r bg-card lg:flex">
        <div className="border-b px-4 py-4">
          <Breadcrumb className="mb-1" />
          <h1 className="text-lg font-bold tracking-tight">{t('Reports')}</h1>
          <p className="text-xs text-muted-foreground">{t('Run, view and download fleet reports.')}</p>
        </div>
        <CatalogList {...catalogProps} />
        {scheduleLink && <div className="border-t p-3 [&_a]:w-full">{scheduleLink}</div>}
      </aside>

      <div className="min-w-0 flex-1 space-y-4 overflow-y-auto p-4 sm:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span className="hidden size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground sm:flex">
              <CurrentIcon className="size-5" />
            </span>
            <div className="min-w-0">
              <h2 className="text-xl font-semibold tracking-tight">{t('{{report}} report', { report: t(current.label) })}</h2>
              <p className="text-sm text-muted-foreground">{t(current.description)}</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 lg:hidden">
            <CatalogSheetButton {...catalogProps} />
            {scheduleLink}
          </div>
        </div>

        <Card className="gap-0 p-0">
          <div className="space-y-4 p-4">
            <ScopePicker value={scope} onChange={setScope} />
            <DatePresets from={from} to={to} today={today} onChange={setDates} />
            <div className="grid grid-cols-2 gap-3 sm:flex sm:flex-wrap sm:items-end">
              <Field label={t('From')} htmlFor="r-from">
                <Input id="r-from" type="date" value={from} max={to || undefined} onChange={(e) => setDates([e.target.value, to])} className="sm:w-40" aria-invalid={!!rangeError} />
              </Field>
              <Field label={t('To')} htmlFor="r-to">
                <Input id="r-to" type="date" value={to} min={from || undefined} max={today} onChange={(e) => setDates([from, e.target.value])} className="sm:w-40" aria-invalid={!!rangeError} />
              </Field>
              {usesPeriod && (
                <Field label={t('Group by')} htmlFor="r-period" className="col-span-2 sm:w-44">
                  <Select value={period} onValueChange={(v) => setPeriod(v as ReportPeriod)}>
                    <SelectTrigger id="r-period">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PERIOD_OPTIONS.map((p) => (
                        <SelectItem key={p.value} value={p.value}>
                          {t(p.label)}
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
              {inputError ?? t('Leave branches, groups and vehicles empty to include every vehicle you can access.')}
              {!inputError && zoneName && <span className="block">{t('Dates are company days ({{zone}}).', { zone: zoneLabel })}</span>}
            </p>
            <Button onClick={() => run.mutate(request)} disabled={!!inputError || run.isPending} className="sm:w-36">
              {run.isPending ? <Spinner /> : <PlayIcon />} {t('Run report')}
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
              <div className="min-w-0">
                <h2 className="text-lg font-semibold">{t('{{report}} report', { report: t(def.label) })}</h2>
                <p className="text-sm text-muted-foreground">
                  {periodLabel(result.res.from)} – {periodLabel(result.res.to)}
                  {result.res.period ? ` · ${t(PERIOD_OPTIONS.find((p) => p.value === result.res.period)?.label ?? result.res.period)}` : ''} · {t('{{rows}} rows', { rows: (result.res.totalRows ?? result.res.rows.length).toLocaleString() })}
                </p>
                {zoneText && (
                  <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                    <GlobeIcon className="size-3.5" /> {zoneText}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {canSchedule && (
                  <Button variant="outline" size="sm" onClick={() => setSchedulePrefill(prefillFromRun(result.req, t('{{report}} report', { report: t(def.label) }), REPORT_OPTION_KEYS) as SchedulePrefill)}>
                    <CalendarPlusIcon /> {t('Schedule this')}
                  </Button>
                )}
                {canExport && (
                  <div className="flex flex-wrap gap-2" role="group" aria-label={t('Download')}>
                    {FORMATS.map((f) => (
                      <Button key={f.format} variant="outline" size="sm" onClick={() => exportAs(f.format)} disabled={!!exporting}>
                        {exporting === f.format ? <Spinner /> : <f.icon />} {f.label}
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <ReportInsights
              key={`insights-${run.submittedAt}`}
              type={result.req.type}
              rows={result.res.rows}
              totals={result.res.totals}
              from={result.res.from}
              to={result.res.to}
              truncated={truncated}
              totalRows={result.res.totalRows ?? result.res.rows.length}
              filter={filter}
              onFilter={setFilter}
            />
            <Card className="gap-0 overflow-hidden p-0">
              {result.res.rows.length ? (
                <ReportTable
                  key={`${result.req.type}-${run.submittedAt}`}
                  type={result.req.type}
                  columns={def.columns}
                  rows={result.res.rows}
                  totals={result.res.totals}
                  drill={def.drill}
                  filter={filter ? { label: filterLabel(filter, t), test: (r) => rowMatches(result.req.type, r, filter, getReportTimeZone()), onClear: () => setFilter(null) } : null}
                />
              ) : (
                <EmptyState icon={TableIcon} title={t('No data for this selection')} description={t('Try a longer period or a wider scope.')} />
              )}
            </Card>
            {truncated && (
              <p className="text-xs text-warning">
                {result.res.totalRows
                  ? t('Showing the first {{shown}} rows of {{total}}; totals cover every row. Download the report or narrow the selection for the rest.', {
                      shown: result.res.rows.length.toLocaleString(),
                      total: result.res.totalRows.toLocaleString(),
                    })
                  : t('Showing the first {{shown}} rows; totals cover every row. Download the report or narrow the selection for the rest.', { shown: result.res.rows.length.toLocaleString() })}
              </p>
            )}
          </div>
        )}

        {!result && !run.isPending && (
          <Card>
            <EmptyState icon={TableIcon} title={t('Press Run report')} description={t('Results appear here. You can then download them as Excel, PDF or CSV.')} />
          </Card>
        )}
      </div>
      {schedulePrefill && <ScheduleForm record={null} open prefill={schedulePrefill} onOpenChange={(o) => !o && setSchedulePrefill(null)} />}
    </div>
  );
}
