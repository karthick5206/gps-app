import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { HistoryArchiveInfo, HistoryRestoreResult } from '@veetracer/shared';
import { ArchiveIcon, ArchiveRestoreIcon } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useAuth } from '@/features/auth/auth-context';
import { api, errorMessage } from '@/lib/api';

const OFFLINE = new Set(['ARCHIVED', 'RESTORING']);

/** Days of the period whose points are archived, the restore request and its progress (polled while restoring). */
export function useArchiveRestore(objectId: string | null, archive: HistoryArchiveInfo | undefined) {
  const { can, me } = useAuth();
  const qc = useQueryClient();
  const days = useMemo(() => (archive?.days ?? []).filter((d) => OFFLINE.has(d.status) || ((d.status === 'CLAIMED' || d.status === 'FAILED') && d.archivedAt)), [archive]);
  const from = days[0]?.day ?? null;
  const to = days[days.length - 1]?.day ?? null;
  const restoringFromServer = days.some((d) => d.status === 'RESTORING');

  const progress = useQuery({
    queryKey: ['object-archive', objectId, from, to],
    queryFn: ({ signal }) => api.get<HistoryArchiveInfo>(`/objects/${objectId}/archive`, { from: from!, to: to! }, signal),
    enabled: !!objectId && !!from && restoringFromServer,
    refetchInterval: 5_000,
  });
  const restoring = progress.data ? progress.data.restoring > 0 : restoringFromServer;
  const restoredSoFar = progress.data ? progress.data.days.filter((d) => d.status === 'RESTORED').length : 0;

  // When the last day is back, reload the track.
  const wasRestoring = useRef(false);
  useEffect(() => {
    if (wasRestoring.current && !restoring) void qc.invalidateQueries({ queryKey: ['object-history', objectId] });
    wasRestoring.current = restoring;
  }, [restoring, objectId, qc]);

  const restore = useMutation({
    mutationFn: () => api.post<HistoryRestoreResult>('/history-archive/restore', { objectId, from, to }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['object-history', objectId] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return {
    days: days.length,
    from,
    to,
    restoring: restoring || restore.isPending,
    restoredSoFar,
    canRestore: !!me?.user.isSuperAdmin || can('history', 'command'),
    restore: () => restore.mutate(),
  };
}

type ArchiveState = ReturnType<typeof useArchiveRestore>;

/** Body of the map overlay when the whole period is archived ("Archived — Restore" instead of an empty map). */
export function ArchivedOverlayBody({ a }: { a: ArchiveState }) {
  const { t } = useTranslation();
  return (
    <>
      <ArchiveIcon className="mx-auto size-8 text-primary" />
      <p className="mt-2 font-medium">{t('Archived')}</p>
      <p className="mt-1 text-sm text-muted-foreground">{t('The GPS points of {{n}} day(s) in this period were moved to the archive. Trips and daily summaries are still available in Reports.', { n: a.days })}</p>
      <RestoreAction a={a} className="mt-3" />
    </>
  );
}

/** Thin banner above the map when only part of the period is archived. */
export function ArchivedBanner({ a }: { a: ArchiveState }) {
  const { t } = useTranslation();
  return (
    <div role="status" className="flex flex-wrap items-center gap-2 border-b bg-warning/10 px-4 py-2 text-xs text-warning sm:text-sm">
      <ArchiveIcon className="size-4 shrink-0" />
      <span className="flex-1">{t('{{n}} day(s) of this period are archived, so the track is incomplete.', { n: a.days })}</span>
      <RestoreAction a={a} compact />
    </div>
  );
}

function RestoreAction({ a, compact, className }: { a: ArchiveState; compact?: boolean; className?: string }) {
  const { t } = useTranslation();
  if (a.restoring) {
    return (
      <span className={`inline-flex items-center gap-2 text-sm ${className ?? ''}`}>
        <Spinner /> {a.restoredSoFar ? t('Restoring… {{done}} of {{total}} days back', { done: a.restoredSoFar, total: a.days }) : t('Restoring archived history…')}
      </span>
    );
  }
  if (!a.canRestore) return <p className={`text-xs text-muted-foreground ${className ?? ''}`}>{t('Ask your administrator to restore it.')}</p>;
  return (
    <Button size={compact ? 'sm' : 'default'} variant={compact ? 'outline' : 'default'} className={className} onClick={a.restore}>
      <ArchiveRestoreIcon /> {t('Restore')}
    </Button>
  );
}
