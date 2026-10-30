import { useQuery } from '@tanstack/react-query';
import { SCORE_MIN_KM, type DriverScoreRow, type DriverScoresDto, type ScoreBy, type ScoreGrade, type ScorePeriod } from '@veetracer/shared';
import { InfoIcon, MedalIcon, TrophyIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PageHeader } from '@/components/page-header';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api } from '@/lib/api';
import { formatNumber } from '@/lib/format';
import { cn } from '@/lib/utils';

const PERIODS: { value: ScorePeriod; label: string }[] = [
  { value: 'week', label: 'This week' },
  { value: 'lastWeek', label: 'Last week' },
  { value: 'month', label: 'This month' },
  { value: 'lastMonth', label: 'Last month' },
];

const GRADE_CLASS: Record<ScoreGrade, string> = {
  A: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  B: 'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  C: 'bg-amber-500/15 text-amber-800 dark:text-amber-300',
  D: 'bg-rose-500/15 text-rose-700 dark:text-rose-300',
};
const MEDAL = ['text-amber-500', 'text-slate-400', 'text-orange-600'];

function ScoreBadge({ r }: { r: DriverScoreRow }) {
  const { t } = useTranslation();
  if (r.score === null) return <span className="text-xs text-muted-foreground">{t('Under {{km}} km', { km: SCORE_MIN_KM })}</span>;
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-sm font-semibold tabular-nums', GRADE_CLASS[r.grade!])} title={t('Lost: {{e}} events · {{i}} idling · {{n}} night', { e: r.penalties.events, i: r.penalties.idle, n: r.penalties.night })}>
      {r.score} <span className="text-xs font-bold opacity-80">{r.grade}</span>
    </span>
  );
}

/** Driver scorecard: safety score per driver (or vehicle) with a leaderboard. */
export function DriverScoresPage() {
  const { t } = useTranslation();
  const [period, setPeriod] = useState<ScorePeriod>('week');
  const [by, setBy] = useState<ScoreBy>('driver');
  const q = useQuery({ queryKey: ['driver-scores', period, by], queryFn: ({ signal }) => api.get<DriverScoresDto>('/driver-scores', { period, by }, signal) });
  const rows = q.data?.rows ?? [];
  const scored = rows.filter((r) => r.score !== null);

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <PageHeader
        title={t('Driver scorecard')}
        description={t('Safety score out of 100 from overspeeding, harsh driving, dashcam events, idling and night driving, per 100 km driven.')}
        actions={
          <div className="flex gap-2">
            <div className="flex rounded-md border p-0.5" role="group" aria-label={t('Score by')}>
              {(['driver', 'vehicle'] as ScoreBy[]).map((b) => (
                <button key={b} type="button" aria-pressed={by === b} onClick={() => setBy(b)} className={cn('rounded px-3 py-1 text-sm', by === b ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')}>
                  {b === 'driver' ? t('Drivers') : t('Vehicles')}
                </button>
              ))}
            </div>
            <Select value={period} onValueChange={(v) => setPeriod(v as ScorePeriod)}>
              <SelectTrigger className="w-36" aria-label={t('Period')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PERIODS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {t(p.label)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        }
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <Card className="p-4">
          <div className="text-xs text-muted-foreground">{t('Fleet average')}</div>
          <div className="mt-1 text-3xl font-bold tabular-nums">{q.data?.average ?? '—'}</div>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <TrophyIcon className="size-3.5 text-amber-500" /> {t('Best')}
          </div>
          <div className="mt-1 truncate font-semibold">{scored[0] ? `${scored[0].name} · ${scored[0].score}` : '—'}</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted-foreground">{t('Needs attention')}</div>
          <div className="mt-1 truncate font-semibold">{scored.length > 1 ? `${scored[scored.length - 1].name} · ${scored[scored.length - 1].score}` : '—'}</div>
        </Card>
      </div>

      <Card className="overflow-hidden p-0">
        {q.isPending ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : !rows.length ? (
          <EmptyState icon={TrophyIcon} title={t('No driving in this period')} description={t('Scores appear once vehicles have made trips.')} />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-12">#</TableHead>
                <TableHead>{by === 'driver' ? t('Driver') : t('Vehicle')}</TableHead>
                <TableHead>{t('Score')}</TableHead>
                <TableHead className="text-right">{t('Distance')}</TableHead>
                <TableHead className="text-right">{t('Overspeed')}</TableHead>
                <TableHead className="text-right">{t('Harsh')}</TableHead>
                <TableHead className="hidden text-right md:table-cell">{t('Dashcam')}</TableHead>
                <TableHead className="hidden text-right md:table-cell">{t('Idle %')}</TableHead>
                <TableHead className="hidden text-right lg:table-cell">{t('Night km')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r, i) => (
                <TableRow key={`${r.kind}:${r.id}`}>
                  <TableCell className="tabular-nums">{r.score !== null && i < 3 ? <MedalIcon className={cn('size-5', MEDAL[i])} aria-label={`#${i + 1}`} /> : r.score !== null ? i + 1 : '—'}</TableCell>
                  <TableCell>
                    <div className="font-medium">{r.name}</div>
                    {r.detail && <div className="max-w-xs truncate text-xs text-muted-foreground">{t(r.detail)}</div>}
                  </TableCell>
                  <TableCell>
                    <ScoreBadge r={r} />
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{`${formatNumber(r.km)} km`}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.overspeed}</TableCell>
                  <TableCell className="text-right tabular-nums">{r.harsh}</TableCell>
                  <TableCell className="hidden text-right tabular-nums md:table-cell">{r.dms + r.adas + r.crash}</TableCell>
                  <TableCell className="hidden text-right tabular-nums md:table-cell">{r.idlePct}%</TableCell>
                  <TableCell className="hidden text-right tabular-nums lg:table-cell">{r.nightKm}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
      <p className="flex items-start gap-2 text-xs text-muted-foreground">
        <InfoIcon className="mt-0.5 size-3.5 shrink-0" />
        {t('A = 90+, B = 75–89, C = 60–74, D = below 60. Each overspeed costs 3 points per 100 km, harsh driving 2, phone use or distraction 4, fatigue 5, a crash 20; idling over 20% of engine time and night driving over 30% of the distance cost a few points more. Trips without a driver assigned count for the vehicle.')}
      </p>
    </div>
  );
}
