import { useQuery } from '@tanstack/react-query';
import type { ReportRunDto } from '@veetracer/shared';
import { DownloadIcon, HistoryIcon, RefreshCwIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { FormError } from '@/components/form-error';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime, formatDuration } from '@/lib/format';
import { downloadFile } from './download';
import { REPORT_DEF_MAP } from './report-columns';

const STATUS_VARIANT = { RUNNING: 'default', SUCCEEDED: 'success', FAILED: 'destructive' } as const;

export const runsQueryKey = (scheduleId: string | undefined) => ['report-runs', scheduleId] as const;

export function RunsSheet({ target, onClose }: { target: { id: string; name: string } | null; onClose: () => void }) {
  const { t } = useTranslation();
  const runs = useQuery({
    queryKey: runsQueryKey(target?.id),
    queryFn: ({ signal }) => api.get<ReportRunDto[]>('/report-runs', { scheduleId: target!.id }, signal),
    enabled: !!target,
    // Poll while a run is in progress.
    refetchInterval: (q) => (q.state.data?.some((r) => r.status === 'RUNNING') ? 3000 : false),
  });
  const [downloading, setDownloading] = useState<string | null>(null);

  const download = async (run: ReportRunDto) => {
    setDownloading(run.id);
    try {
      await downloadFile(`/report-runs/${run.id}/file`, { fallbackName: run.fileName ?? `report-${run.id}` });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setDownloading(null);
    }
  };

  return (
    <Sheet open={!!target} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{t('Run history')}</SheetTitle>
          <SheetDescription>{target?.name}</SheetDescription>
        </SheetHeader>
        <div className="flex items-center justify-end border-b px-5 py-2">
          <Button size="sm" variant="ghost" onClick={() => runs.refetch()} disabled={runs.isFetching}>
            {runs.isFetching ? <Spinner /> : <RefreshCwIcon />} {t('Refresh')}
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {runs.isError && (
            <div className="p-4">
              <FormError message={errorMessage(runs.error)} />
            </div>
          )}
          {runs.isPending && (
            <div className="space-y-3 p-5">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          )}
          {runs.data?.length === 0 && <EmptyState icon={HistoryIcon} title={t('No runs yet')} description={t('Runs appear here after the schedule fires or you use Run now.')} />}
          <ul>
            {runs.data?.map((r) => (
              <li key={r.id} className="flex items-start gap-3 border-b px-5 py-3 text-sm">
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={STATUS_VARIANT[r.status]}>
                      {r.status === 'RUNNING' && <Spinner className="size-3" />}
                      {r.status === 'SUCCEEDED' ? t('Succeeded') : r.status === 'FAILED' ? t('Failed') : t('Running')}
                    </Badge>
                    <span className="tabular-nums">{formatDateTime(r.startedAt)}</span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {r.reportTypes.map((rt) => (REPORT_DEF_MAP[rt] ? t(REPORT_DEF_MAP[rt].label) : rt)).join(', ')}
                    {r.finishedAt && ` · ${t('took {{duration}}', { duration: formatDuration((Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000) })}`}
                  </p>
                  {r.error && <p className="text-xs break-words text-destructive">{r.error}</p>}
                </div>
                {r.status === 'SUCCEEDED' && r.fileName && (
                  <Button size="sm" variant="outline" onClick={() => download(r)} disabled={downloading === r.id} aria-label={t('Download {{file}}', { file: r.fileName })}>
                    {downloading === r.id ? <Spinner /> : <DownloadIcon />}
                    <span className="hidden sm:inline">{t('Download')}</span>
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      </SheetContent>
    </Sheet>
  );
}
